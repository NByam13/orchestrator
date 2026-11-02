import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { LinearClient } from "@linear/sdk";
import type { Ticket } from "./rules.ts";

const TICKET_FIELDS = /* GraphQL */ `
    id identifier title description url branchName priority sortOrder
    state { name }
    project { name }
    projectMilestone { name }
    labels { nodes { name } }
    inverseRelations { nodes { type issue { identifier state { type } } } }
    comments(first: 50) { nodes { body createdAt user { name } } }
`;

interface RawTicket {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    branchName: string;
    priority: number;
    sortOrder: number;
    state: { name: string };
    project: { name: string } | null;
    projectMilestone: { name: string } | null;
    labels: { nodes: { name: string }[] };
    inverseRelations: { nodes: { type: string; issue: { identifier: string; state: { type: string } } }[] };
    comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] };
}

function toTicket(r: RawTicket): Ticket {
    return {
        id: r.id,
        identifier: r.identifier,
        title: r.title,
        description: r.description ?? "",
        url: r.url,
        branchName: r.branchName,
        priority: r.priority,
        sortOrder: r.sortOrder,
        state: r.state.name,
        labels: r.labels.nodes.map((l) => l.name),
        project: r.project?.name,
        milestone: r.projectMilestone?.name,
        openBlockers: r.inverseRelations.nodes
            .filter((rel) => rel.type === "blocks" && !["completed", "canceled", "duplicate"].includes(rel.issue.state.type))
            .map((rel) => rel.issue.identifier),
        comments: r.comments.nodes
            .map((c) => ({ body: c.body, createdAt: c.createdAt, author: c.user?.name ?? "Linear" }))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
}

/** Comments the orchestrator posts start with this, so prompts can tell them apart from yours. */
export const BOT_PREFIX = "🤖 **Orchestrator**";

export class Linear {
    private client: LinearClient;
    private stateIds = new Map<string, string>();
    private teamId?: string;

    constructor(apiKey: string, private teamKey: string) {
        this.client = new LinearClient({ apiKey });
    }

    private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const res = await this.client.client.rawRequest<T, Record<string, unknown>>(query, variables);
        if (!res.data) throw new Error("Linear returned no data");
        return res.data;
    }

    async viewerId(): Promise<string> {
        return (await this.client.viewer).id;
    }

    private async loadTeam(): Promise<void> {
        if (this.teamId) return;
        const data = await this.gql<{ teams: { nodes: { id: string; states: { nodes: { id: string; name: string }[] } }[] } }>(
            `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id name } } } } }`,
            { key: this.teamKey },
        );
        const team = data.teams.nodes[0];
        if (!team) throw new Error(`Linear team "${this.teamKey}" not found`);
        this.teamId = team.id;
        for (const s of team.states.nodes) this.stateIds.set(s.name, s.id);
    }

    async ticketsInStates(states: string[]): Promise<Ticket[]> {
        const data = await this.gql<{ issues: { nodes: RawTicket[] } }>(
            `query($team: String!, $states: [String!]) {
                issues(first: 100, filter: { team: { key: { eq: $team } }, state: { name: { in: $states } } }) { nodes { ${TICKET_FIELDS} } }
            }`,
            { team: this.teamKey, states },
        );
        return data.issues.nodes.map(toTicket);
    }

    async ticket(identifier: string): Promise<Ticket> {
        const data = await this.gql<{ issue: RawTicket }>(`query($id: String!) { issue(id: $id) { ${TICKET_FIELDS} } }`, { id: identifier });
        return toTicket(data.issue);
    }

    async setState(ticket: Pick<Ticket, "id">, stateName: string): Promise<void> {
        await this.loadTeam();
        const stateId = this.stateIds.get(stateName);
        if (!stateId) throw new Error(`Linear status "${stateName}" doesn't exist. Run: npm run setup-linear`);
        await this.client.updateIssue(ticket.id, { stateId });
    }

    async assign(ticket: Pick<Ticket, "id">, userId: string): Promise<void> {
        await this.client.updateIssue(ticket.id, { assigneeId: userId });
    }

    async comment(ticket: Pick<Ticket, "id">, body: string): Promise<void> {
        await this.client.createComment({ issueId: ticket.id, body: `${BOT_PREFIX}\n\n${body}` });
    }

    /** Uploads a PNG to Linear's storage and returns a URL usable in a comment. */
    async uploadImage(path: string): Promise<string> {
        const { size } = await stat(path);
        const payload = await this.client.fileUpload("image/png", basename(path), size);
        const upload = payload.uploadFile;
        if (!upload) throw new Error(`Linear refused the upload of ${path}`);
        const headers: Record<string, string> = { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000" };
        for (const h of upload.headers) headers[h.key] = h.value;
        const res = await fetch(upload.uploadUrl, { method: "PUT", headers, body: await readFile(path) });
        if (!res.ok) throw new Error(`Upload of ${path} failed: ${res.status}`);
        return upload.assetUrl;
    }

    /** Creates any missing statuses and labels the orchestrator needs. Safe to run repeatedly. */
    async ensureSetup(statuses: { name: string; type: "unstarted" | "started" | "completed" }[], labels: string[]): Promise<string[]> {
        await this.loadTeam();
        const created: string[] = [];
        for (const s of statuses) {
            if (this.stateIds.has(s.name)) continue;
            const color = s.type === "unstarted" ? "#4EA7FC" : s.name.toLowerCase().includes("input") ? "#EB5757" : "#F2C94C";
            await this.client.createWorkflowState({ teamId: this.teamId!, name: s.name, type: s.type, color });
            created.push(`status "${s.name}"`);
        }
        const existing = await this.gql<{ issueLabels: { nodes: { name: string }[] } }>(
            `query($team: String!) { issueLabels(first: 250, filter: { or: [{ team: { key: { eq: $team } } }, { team: { null: true } }] }) { nodes { name } } }`,
            { team: this.teamKey },
        );
        const have = new Set(existing.issueLabels.nodes.map((l) => l.name));
        for (const name of labels) {
            if (have.has(name)) continue;
            await this.client.createIssueLabel({ teamId: this.teamId!, name, color: name === "Design" ? "#BB87FC" : "#EB5757" });
            created.push(`label "${name}"`);
        }
        this.teamId = undefined;
        this.stateIds.clear();
        return created;
    }
}
