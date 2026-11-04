import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UsageLimitError, type Claude } from "./claude.ts";
import type { Config, ProjectConfig } from "./config.ts";
import type { AgentPr, GitHub } from "./github.ts";
import type { Linear } from "./linear.ts";
import { log } from "./log.ts";
import { notify } from "./notify.ts";
import type { Pipeline } from "./pipeline.ts";
import type { Qa } from "./qa.ts";
import {
    compareTickets,
    decidePrAction,
    projectReadyForQa,
    projectSignature,
    protectedFilesTouched,
    routeTicket,
    targetBranch,
    type PrAction,
    type Ticket,
} from "./rules.ts";

/** Create this file (`touch PAUSE`) to stop new work without killing runs in progress. */
export const PAUSE_FILE = fileURLToPath(new URL("../PAUSE", import.meta.url));

interface Planned {
    key: string;
    /** Unset for work that spans repos (QA). */
    project?: ProjectConfig;
    describe: string;
    /** Costs agent time (counts against parallel limits and budget). */
    agent: boolean;
    run: () => Promise<void>;
}

export class Scheduler {
    private running = new Map<string, { project: string; describe: string; since: Date }>();
    /** Project id → ticket states last time it was checked for QA, so finished projects aren't re-checked every tick. */
    private qaSeen = new Map<string, string>();
    private stopping = false;

    constructor(
        private config: Config,
        private linear: Linear,
        private github: GitHub,
        private claude: Claude,
        private pipeline: Pipeline,
        private qa: Qa,
    ) {}

    /** Tickets left in "Agent working" by a crash or restart go back to the queue. Work so far stays on the branch. */
    async recover(): Promise<void> {
        const s = this.config.linear.statuses;
        for (const t of await this.linear.ticketsInStates([s.working])) {
            if (this.running.has(t.identifier)) continue;
            log.warn(t.identifier, "was mid-run when the orchestrator stopped; re-queueing");
            await this.requeue(t, "The orchestrator restarted mid-run. Re-queued; work so far is kept on the branch.");
        }
    }

    /** Put a ticket stuck in "Agent working" back where it came from. */
    private async requeue(t: Ticket, why: string): Promise<void> {
        const s = this.config.linear.statuses;
        if (t.state !== s.working) return;
        await this.linear.comment(t, why);
        const lastStart = [...t.comments].reverse().find((c) => c.body.includes("▶️ Started:"));
        await this.linear.setState(t, lastStart?.body.includes("approved design") ? s.designApproved : s.ready);
    }

    async plan(): Promise<Planned[]> {
        const s = this.config.linear.statuses;
        const planned: Planned[] = [];

        // 1. Finish what's open before starting anything new.
        for (const project of this.config.projects) {
            const prs = await this.github.openAgentPrs(project.github);
            for (const pr of prs) {
                if (this.running.has(pr.ticket)) continue;
                const ticket = await this.linear.ticket(pr.ticket);
                const action = await this.prAction(project, ticket, pr);
                const p = this.toPlanned(project, ticket, pr, action);
                if (p) planned.push(p);
                else if (action.do === "wait") log.info(ticket.identifier, `PR #${pr.number}: ${action.why}`);
            }
        }

        // 2. Pick up new tickets in priority order.
        const tickets = (await this.linear.ticketsInStates([s.ready, s.designApproved])).sort(compareTickets);
        for (const ticket of tickets) {
            if (this.running.has(ticket.identifier)) continue;
            if (ticket.openBlockers.length) {
                log.info(ticket.identifier, `blocked by ${ticket.openBlockers.join(", ")}`);
                continue;
            }
            const route = routeTicket(ticket, this.config);
            if ("skip" in route) {
                log.info(ticket.identifier, `skipped: ${route.skip}`);
                continue;
            }
            const project = route.project;
            const target = targetBranch(ticket, project, this.config.linear.branchLabelGroup);
            if ("error" in target) {
                planned.push({
                    key: ticket.identifier,
                    project,
                    agent: false,
                    describe: "escalate bad branch label",
                    run: () => this.pipeline.escalate(ticket, `The ticket ${target.error}.`, `Fix the ${this.config.linear.branchLabelGroup} label, then move it back to Ready for agent.`),
                });
                continue;
            }
            const base = target.branch;
            const needsDesign = ticket.state === s.ready && ticket.labels.includes(this.config.linear.designLabel);
            planned.push({
                key: ticket.identifier,
                project,
                agent: true,
                describe: `${needsDesign ? "design" : "build"} → ${project.name}:${base}`,
                run: () => (needsDesign ? this.pipeline.design(project, ticket, base) : this.pipeline.build(project, ticket, base)),
            });
        }
        // 3. Features whose tickets are all done get a QA checklist for you.
        if (this.config.qa.enabled) {
            for (const proj of await this.linear.activeProjects()) {
                const key = `qa:${proj.id}`;
                const sig = projectSignature(proj.issues);
                if (this.running.has(key) || this.qaSeen.get(proj.id) === sig) continue;
                if (!projectReadyForQa(proj.issues, this.config.qa.label)) {
                    this.qaSeen.set(proj.id, sig);
                    continue;
                }
                planned.push({
                    key,
                    agent: true,
                    describe: `QA checklist for "${proj.name}"`,
                    run: async () => {
                        try {
                            await this.qa.run(proj);
                        } finally {
                            // Success or failure, don't retry until a ticket in the project changes (or a restart).
                            this.qaSeen.set(proj.id, sig);
                        }
                    },
                });
            }
        }
        return planned;
    }

    private async prAction(project: ProjectConfig, ticket: Ticket, pr: AgentPr): Promise<PrAction> {
        const [{ mergeable, headSha }, comments] = await Promise.all([
            this.github.mergeable(project.github, pr.number),
            this.github.markerComments(project.github, pr.number),
        ]);
        pr.headSha = headSha;
        // No GitHub CI: the local gates already passed before this commit was pushed.
        const ci = project.ci ? await this.github.ciState(project.github, headSha) : "success";
        const files = await this.github.changedFiles(project.github, pr.number);
        return decidePrAction({
            headSha,
            ci,
            mergeable,
            markers: comments.map((c) => c.marker),
            protectedTouched: protectedFilesTouched(files, project.protectedPaths),
            holdLabel: ticket.labels.includes(this.config.linear.holdLabel),
            mergeMode: project.mergeMode,
            maxFixRounds: this.config.loop.maxFixRounds,
            ticketState: ticket.state,
            statuses: this.config.linear.statuses,
        });
    }

    private toPlanned(project: ProjectConfig, ticket: Ticket, pr: AgentPr, action: PrAction): Planned | undefined {
        const base = { key: ticket.identifier, project };
        const prRef = { repo: project.github, number: pr.number, url: pr.url, sha: pr.headSha };
        switch (action.do) {
            case "wait":
                return undefined;
            case "review":
                return { ...base, agent: true, describe: `review PR #${pr.number}`, run: () => this.pipeline.review(project, ticket, pr) };
            case "fix":
                return { ...base, agent: true, describe: `fix (${action.reason}) PR #${pr.number}`, run: () => this.pipeline.fix(project, ticket, pr, action.reason) };
            case "merge":
                return { ...base, agent: false, describe: `merge PR #${pr.number}`, run: () => this.pipeline.merge(project, ticket, pr) };
            case "hold":
                return { ...base, agent: false, describe: `hold PR #${pr.number}`, run: () => this.pipeline.hold(project, ticket, pr, action.why) };
            case "escalate":
                return { ...base, agent: false, describe: `escalate PR #${pr.number}`, run: () => this.pipeline.escalate(ticket, action.why, `PR: ${pr.url}`, prRef) };
            case "resume":
                return { ...base, agent: false, describe: `resume PR #${pr.number}`, run: () => this.pipeline.resume(project, ticket, pr) };
        }
    }

    /** One pass: plan, then start whatever fits. Returns the started jobs' promises. */
    async tick(dryRun = false): Promise<Promise<void>[]> {
        if (existsSync(PAUSE_FILE)) {
            log.info("loop", "paused (PAUSE file present)");
            return [];
        }
        const until = this.claude.limitedUntil;
        const limited = !!until && until > new Date();
        if (limited) log.warn("loop", `usage limit reached; agent runs paused until ${until.toLocaleString()}, only non-agent steps run`);

        const started: Promise<void>[] = [];
        for (const job of await this.plan()) {
            if (this.stopping) break;
            if (this.running.has(job.key)) continue;
            if (job.agent) {
                if (limited) continue;
                const agentRuns = [...this.running.values()];
                if (agentRuns.length >= this.config.loop.maxParallel) continue;
                if (job.project && agentRuns.filter((r) => r.project === job.project!.name).length >= job.project.maxParallel) continue;
            }
            if (dryRun) {
                log.info(job.key, `[dry run] would ${job.describe}`);
                continue;
            }
            started.push(this.start(job));
        }
        return started;
    }

    private start(job: Planned): Promise<void> {
        log.info(job.key, `start: ${job.describe}`);
        this.running.set(job.key, { project: job.project?.name ?? "*", describe: job.describe, since: new Date() });
        return job
            .run()
            .catch(async (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (err instanceof UsageLimitError) {
                    log.warn(job.key, msg);
                    if (!job.key.startsWith("qa:")) await this.requeue(await this.linear.ticket(job.key), `⏸️ ${msg}. Re-queued; work so far is kept on the branch.`).catch(() => undefined);
                    return;
                }
                log.error(job.key, msg);
                if (job.key.startsWith("qa:")) {
                    await notify(`QA step failed`, `${job.describe}: ${msg.slice(0, 500)}`);
                    return;
                }
                try {
                    const ticket = await this.linear.ticket(job.key);
                    await this.pipeline.escalate(ticket, `The orchestrator hit an error during "${job.describe}".`, `\`\`\`\n${msg.slice(0, 4000)}\n\`\`\``);
                } catch (inner) {
                    log.error(job.key, `could not escalate: ${String(inner)}`);
                }
            })
            .finally(() => this.running.delete(job.key));
    }

    async loop(): Promise<void> {
        await this.recover();
        const inflight = new Set<Promise<void>>();
        process.on("SIGINT", () => {
            if (this.stopping) process.exit(130);
            this.stopping = true;
            log.warn("loop", `stopping after ${this.running.size} running job(s) finish. Ctrl-C again to kill them.`);
        });
        while (!this.stopping) {
            try {
                for (const p of await this.tick()) {
                    inflight.add(p);
                    void p.finally(() => inflight.delete(p));
                }
            } catch (err) {
                log.error("loop", `tick failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            await sleepOrWake(this.config.loop.pollSeconds * 1000, inflight, () => this.stopping);
        }
        await Promise.allSettled([...inflight]);
    }

    status(): { key: string; project: string; describe: string; since: Date }[] {
        return [...this.running.entries()].map(([key, r]) => ({ key, ...r }));
    }
}

/** Sleeps for the poll interval, but wakes early when a job finishes so the next ticket starts right away. */
async function sleepOrWake(ms: number, inflight: Set<Promise<void>>, stopped: () => boolean): Promise<void> {
    const timer = new Promise<void>((r) => setTimeout(r, ms));
    const anyDone = inflight.size ? Promise.race(inflight).then(() => new Promise<void>((r) => setTimeout(r, 5000))) : timer;
    await Promise.race([timer, anyDone]);
    if (stopped()) return;
}
