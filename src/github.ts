import { Octokit } from "@octokit/rest";
import { parseMarker, type CiState, type Marker } from "./rules.ts";

export const PR_LABEL = "orchestrator";
const TICKET_TAG = /<!-- orchestrator-ticket ([A-Z]+-\d+) -->/;

export interface AgentPr {
    number: number;
    url: string;
    branch: string;
    /** The branch this PR merges into (dev, or a feature branch). */
    base: string;
    headSha: string;
    ticket: string;
}

export class GitHub {
    private kit: Octokit;

    constructor(token: string) {
        this.kit = new Octokit({ auth: token });
    }

    private split(repo: string) {
        const [owner, name] = repo.split("/") as [string, string];
        return { owner, repo: name };
    }

    async openAgentPrs(repo: string): Promise<AgentPr[]> {
        const prs = await this.kit.paginate(this.kit.pulls.list, { ...this.split(repo), state: "open", per_page: 100 });
        return prs
            .filter((pr) => pr.labels.some((l) => l.name === PR_LABEL))
            .map((pr) => ({ number: pr.number, url: pr.html_url, branch: pr.head.ref, base: pr.base.ref, headSha: pr.head.sha, ticket: pr.body?.match(TICKET_TAG)?.[1] ?? "" }))
            .filter((pr) => pr.ticket);
    }

    async findOpenPr(repo: string, branch: string): Promise<AgentPr | undefined> {
        const { owner, repo: name } = this.split(repo);
        const { data } = await this.kit.pulls.list({ owner, repo: name, state: "open", head: `${owner}:${branch}` });
        const pr = data[0];
        return pr ? { number: pr.number, url: pr.html_url, branch, base: pr.base.ref, headSha: pr.head.sha, ticket: pr.body?.match(TICKET_TAG)?.[1] ?? "" } : undefined;
    }

    async createPr(repo: string, opts: { branch: string; base: string; title: string; body: string; ticket: string }): Promise<AgentPr> {
        const { data } = await this.kit.pulls.create({
            ...this.split(repo),
            head: opts.branch,
            base: opts.base,
            title: opts.title,
            body: `${opts.body}\n\n<!-- orchestrator-ticket ${opts.ticket} -->`,
        });
        await this.kit.issues.addLabels({ ...this.split(repo), issue_number: data.number, labels: [PR_LABEL] });
        return { number: data.number, url: data.html_url, branch: opts.branch, base: opts.base, headSha: data.head.sha, ticket: opts.ticket };
    }

    /** null = GitHub hasn't computed it yet. */
    async mergeable(repo: string, number: number): Promise<{ mergeable: boolean | null; headSha: string }> {
        const { data } = await this.kit.pulls.get({ ...this.split(repo), pull_number: number });
        return { mergeable: data.mergeable, headSha: data.head.sha };
    }

    async ciState(repo: string, sha: string): Promise<CiState> {
        const [checks, statuses] = await Promise.all([
            this.kit.paginate(this.kit.checks.listForRef, { ...this.split(repo), ref: sha, per_page: 100 }),
            this.kit.repos.getCombinedStatusForRef({ ...this.split(repo), ref: sha }),
        ]);
        const legacy = statuses.data.statuses;
        if (checks.length === 0 && legacy.length === 0) return "pending"; // CI hasn't registered yet
        const bad = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
        if (checks.some((c) => c.conclusion && bad.has(c.conclusion)) || legacy.some((s) => s.state === "failure" || s.state === "error")) return "failure";
        if (checks.some((c) => c.status !== "completed") || legacy.some((s) => s.state === "pending")) return "pending";
        return "success";
    }

    /** Names and summaries of failed checks, for the fixer's prompt. */
    async failedChecks(repo: string, sha: string): Promise<string> {
        const checks = await this.kit.paginate(this.kit.checks.listForRef, { ...this.split(repo), ref: sha, per_page: 100 });
        return checks
            .filter((c) => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion))
            .map((c) => `### ${c.name} (${c.conclusion})\n${[c.output.title, c.output.summary, c.output.text].filter(Boolean).join("\n").slice(0, 3000) || "(no output; reproduce with the local gates)"}\n${c.html_url ?? ""}`)
            .join("\n\n");
    }

    async changedFiles(repo: string, number: number): Promise<string[]> {
        const files = await this.kit.paginate(this.kit.pulls.listFiles, { ...this.split(repo), pull_number: number, per_page: 100 });
        return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
    }

    /** The orchestrator's own PR comments, oldest first. They are the PR's memory between runs. */
    async markerComments(repo: string, number: number): Promise<{ marker: Marker; body: string }[]> {
        const comments = await this.kit.paginate(this.kit.issues.listComments, { ...this.split(repo), issue_number: number, per_page: 100 });
        return comments.flatMap((c) => {
            const marker = parseMarker(c.body ?? "");
            return marker ? [{ marker, body: c.body ?? "" }] : [];
        });
    }

    async comment(repo: string, number: number, body: string): Promise<void> {
        await this.kit.issues.createComment({ ...this.split(repo), issue_number: number, body });
    }

    /** Merges only if the head is still the commit that was reviewed and tested. */
    async merge(repo: string, number: number, sha: string, method: "squash" | "merge" | "rebase", title: string): Promise<void> {
        await this.kit.pulls.merge({ ...this.split(repo), pull_number: number, sha, merge_method: method, commit_title: title });
    }

    async deleteBranch(repo: string, branch: string): Promise<void> {
        await this.kit.git.deleteRef({ ...this.split(repo), ref: `heads/${branch}` }).catch(() => undefined);
    }
}
