import type { Claude } from "./claude.ts";
import type { Config, ProjectConfig } from "./config.ts";
import type { Git } from "./git.ts";
import type { GitHub } from "./github.ts";
import { BOT_PREFIX, type Linear, type ProjectSummary } from "./linear.ts";
import { log } from "./log.ts";
import { notify } from "./notify.ts";
import { render } from "./prompts.ts";
import { parseQaReport, qaSection, routeTicket, targetBranch, type Ticket } from "./rules.ts";

interface RepoGroup {
    project: ProjectConfig;
    branch: string;
    tickets: Ticket[];
}

/**
 * When every ticket in a Linear project is Done, writes a QA checklist ticket for you and opens the
 * feature-branch PR(s) it covers. Returns false if the project had no orchestrator work (nothing done).
 */
export class Qa {
    constructor(
        private config: Config,
        private linear: Linear,
        private github: GitHub,
        private git: Git,
        private claude: Claude,
        private humanId: string,
    ) {}

    async run(summary: ProjectSummary): Promise<boolean> {
        const qa = this.config.qa;
        const done = summary.issues.filter((i) => i.stateType === "completed" && !i.labels.includes(qa.label));
        const tickets = await Promise.all(done.map((i) => this.linear.ticket(i.identifier)));

        // Group the work by repo and target branch.
        const groups = new Map<string, RepoGroup>();
        const unrouted: Ticket[] = [];
        for (const t of tickets) {
            const route = routeTicket(t, this.config);
            if ("skip" in route) {
                unrouted.push(t);
                continue;
            }
            const target = targetBranch(t, route.project, this.config.linear.branchLabelGroup);
            const branch = "error" in target ? route.project.baseBranch : target.branch;
            const key = `${route.project.name}:${branch}`;
            const g = groups.get(key) ?? { project: route.project, branch, tickets: [] };
            g.tickets.push(t);
            groups.set(key, g);
        }

        // Only projects the orchestrator actually worked on. Stops a QA ticket appearing for old, hand-built features.
        const merged = new Map<string, Awaited<ReturnType<GitHub["mergedAgentPrs"]>>>();
        for (const [key, g] of groups) merged.set(key, await this.github.mergedAgentPrs(g.project.github, new Set(g.tickets.map((t) => t.identifier))));
        const totalPrs = [...merged.values()].reduce((n, prs) => n + prs.length, 0);
        if (totalPrs === 0) {
            log.info("qa", `${summary.name}: all done, but no orchestrator PRs; no QA ticket`);
            return false;
        }

        log.info("qa", `${summary.name}: writing QA checklist (${tickets.length} tickets, ${totalPrs} PRs, ${groups.size} repo/branch)`);
        const sections: string[] = [];
        for (const [key, g] of groups) {
            const prs = merged.get(key) ?? [];
            const feature = g.branch !== g.project.baseBranch;
            const where = feature
                ? `All of it is on the feature branch \`${g.branch}\`, which will merge into \`${g.project.baseBranch}\`. ` +
                  `You are checked out at its tip. See everything with \`git diff origin/${g.project.baseBranch}...HEAD\`.`
                : `It was merged straight into \`${g.branch}\` (you are checked out at its tip). Find each ticket's commits with ` +
                  `\`git log --grep <ticket id>\`, and read the PRs below.`;
            const others = [...groups.values()].filter((o) => o !== g);
            const prompt = await render("qa", {
                feature: summary.name,
                project: g.project.name,
                where,
                tickets: g.tickets.map(ticketBlock).join("\n\n"),
                prs: prs.length ? prs.map((p) => `### #${p.number} ${p.title} (${p.ticket})\n${p.body.slice(0, 2500)}`).join("\n\n") : "(none found; use git log)",
                otherRepos: others.length
                    ? `# Same feature, other repos\nThese shipped alongside. Add checks where this repo talks to them:\n${others
                          .flatMap((o) => o.tickets.map((t) => `- ${o.project.name}: ${t.identifier} ${t.title}`))
                          .join("\n")}`
                    : "",
            });

            const snapshot = `qa-${slug(summary.name)}`;
            const path = await this.git.snapshotWorktree(g.project, snapshot, g.branch);
            try {
                const res = await this.claude.run({ role: "reviewer", project: g.project, cwd: path, prompt, label: `qa-${slug(summary.name)}-${g.project.name}` });
                const report = res.ok ? parseQaReport(res.text) : undefined;
                const heading = `${g.project.name} (${feature ? `\`${g.branch}\` → \`${g.project.baseBranch}\`` : `on \`${g.branch}\``})`;
                sections.push(
                    report
                        ? qaSection(heading, report)
                        : `## ${heading}\n\n⚠ The agent couldn't write this section. Test these tickets by their acceptance criteria:\n${g.tickets.map((t) => `- [ ] ${t.identifier} ${t.title}`).join("\n")}\n\nLog: \`${res.logFile}\``,
                );
            } finally {
                await this.git.removeSnapshot(g.project, snapshot);
            }
        }

        const covered = [...groups.entries()].flatMap(([key, g]) =>
            g.tickets.map((t) => {
                const pr = merged.get(key)?.find((p) => p.ticket === t.identifier);
                return `- ${t.identifier} ${t.title}${pr ? ` ([#${pr.number}](${pr.url}))` : ""}`;
            }),
        );
        const description = [
            `Manual QA for **[${summary.name}](${summary.url})** before it merges. Tick each box as you go; ` +
                `comment on anything that fails and I'll leave it for you to file or fix.`,
            ...sections,
            unrouted.length ? `## Not covered\nThese tickets aren't in a repo the orchestrator knows:\n${unrouted.map((t) => `- ${t.identifier} ${t.title}`).join("\n")}` : "",
            `## Tickets covered\n${covered.join("\n")}`,
        ]
            .filter(Boolean)
            .join("\n\n");

        const issue = await this.linear.createIssue({
            projectId: summary.id,
            title: `QA: ${summary.name}`,
            description,
            labels: [qa.label],
            state: qa.status,
            assigneeId: this.humanId,
            priority: qa.priority,
        });

        if (qa.openFeaturePr) {
            const prLinks: string[] = [];
            for (const g of groups.values()) {
                if (g.branch === g.project.baseBranch) continue;
                const url = await this.github.ensureFeaturePr(g.project.github, {
                    branch: g.branch,
                    base: g.project.baseBranch,
                    title: `${summary.name}: merge ${g.branch} into ${g.project.baseBranch}`,
                    body: `Feature **${summary.name}** is complete. QA checklist: ${issue.url}\n\nMerge once QA passes. The orchestrator never merges this PR.\n\n${covered.join("\n")}`,
                });
                prLinks.push(`- ${g.project.name}: ${url}`);
            }
            if (prLinks.length) await this.linear.comment({ id: issue.id }, `Feature branch PRs, ready for you to merge after QA:\n${prLinks.join("\n")}`);
        }

        await notify(`QA ready: ${summary.name}`, `${issue.identifier} has your checklist.`, issue.url);
        log.info("qa", `${summary.name}: created ${issue.identifier}`);
        return true;
    }
}

function ticketBlock(t: Ticket): string {
    const decisions = t.comments.filter((c) => !c.body.startsWith(BOT_PREFIX)).map((c) => `> ${c.body.replace(/\n/g, "\n> ")}`);
    return `## ${t.identifier}: ${t.title}\n${t.description.slice(0, 3000) || "(no description)"}${decisions.length ? `\n\nComments:\n${decisions.join("\n\n")}` : ""}`;
}

function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
