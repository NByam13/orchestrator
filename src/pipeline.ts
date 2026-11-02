import { cp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Claude } from "./claude.ts";
import type { Config, ProjectConfig } from "./config.ts";
import { SCRATCH, type Git } from "./git.ts";
import type { AgentPr, GitHub } from "./github.ts";
import type { Linear } from "./linear.ts";
import { log } from "./log.ts";
import { notify } from "./notify.ts";
import { gateList, render, ticketVars } from "./prompts.ts";
import {
    blockingFindings,
    fixRoundsSinceResume,
    markerComment,
    parseBuildReport,
    parseReviewReport,
    type Finding,
    type Ticket,
} from "./rules.ts";
import { sh, tail } from "./shell.ts";

const DESIGN_DIR = join(SCRATCH, "design");

export class Pipeline {
    constructor(
        private config: Config,
        private linear: Linear,
        private github: GitHub,
        private git: Git,
        private claude: Claude,
        private humanId: string,
    ) {}

    private get s() {
        return this.config.linear.statuses;
    }

    // ---------- shared helpers ----------

    private async runGates(project: ProjectConfig, path: string): Promise<{ ok: boolean; report: string }> {
        const failures: string[] = [];
        for (const gate of project.gates) {
            const r = await sh(gate, { cwd: path, timeoutMs: 30 * 60_000 });
            if (r.code !== 0) failures.push(`### \`${gate}\` failed${r.timedOut ? " (timed out)" : ""}\n\`\`\`\n${tail(`${r.stdout}\n${r.stderr}`, 80)}\n\`\`\``);
        }
        return { ok: failures.length === 0, report: failures.join("\n\n") };
    }

    /** Runs the gates; on failure, hands the output to the builder and tries again. */
    private async gateLoop(project: ProjectConfig, ticket: Ticket, path: string, base: string, prUrl = ""): Promise<{ ok: boolean; report: string }> {
        for (let attempt = 0; ; attempt++) {
            const gates = await this.runGates(project, path);
            if (gates.ok) return gates;
            if (attempt >= this.config.loop.maxGateRetries) return gates;
            log.info(ticket.identifier, `local gates failed, retry ${attempt + 1}/${this.config.loop.maxGateRetries}`);
            const prompt = await render("fix", {
                ...ticketVars(ticket),
                project: project.name,
                prUrl: prUrl || "(not opened yet)",
                base,
                round: attempt + 1,
                maxRounds: this.config.loop.maxGateRetries,
                problem: `The local quality gates fail:\n\n${gates.report}`,
                gates: gateList(project.gates),
            });
            await this.claude.run({ role: "builder", project, cwd: path, prompt, label: `${ticket.identifier}-gates` });
            await this.git.commitAll(path, `${ticket.identifier}: fix quality gates`);
        }
    }

    async escalate(ticket: Ticket, why: string, detail: string, pr?: { repo: string; number: number; url: string; sha: string }): Promise<void> {
        log.warn(ticket.identifier, `needs input: ${why}`);
        const resumeTo = pr ? this.s.inReview : this.s.ready;
        if (pr) await this.github.comment(pr.repo, pr.number, markerComment({ kind: "escalate", sha: pr.sha }, `⏸ **Needs input:** ${why}\n\nDetails are on the Linear ticket.`));
        await this.linear.comment(
            ticket,
            `⏸ **Needs your input:** ${why}\n\n${detail}\n\n${pr ? `PR: ${pr.url}\n\n` : ""}Reply here, then move the ticket to **${resumeTo}** to continue. Your comments are passed to the agent.`,
        );
        await this.linear.setState(ticket, this.s.needsInput);
        await this.linear.assign(ticket, this.humanId);
        await notify(`${ticket.identifier} needs input`, why, ticket.url);
    }

    // ---------- ticket jobs ----------

    async design(project: ProjectConfig, ticket: Ticket, base: string): Promise<void> {
        if (!project.designHints) {
            return this.escalate(ticket, `${project.name} has no design step (no designHints in the config).`, `Remove the **${this.config.linear.designLabel}** label to build it without a design review, or add designHints for this repo.`);
        }
        await this.linear.setState(ticket, this.s.working);
        await this.linear.comment(ticket, `▶️ Started: design (${project.name} → ${base})`);
        await this.git.ensureTargetBranch(project, base);
        const path = await this.git.ensureWorktree(project, ticket.identifier, ticket.branchName, base);
        await rm(join(path, DESIGN_DIR, "proposed"), { recursive: true, force: true });

        const prompt = await render("design", { ...ticketVars(ticket), project: project.name, designHints: project.designHints });
        const res = await this.claude.run({ role: "builder", project, cwd: path, prompt, label: `${ticket.identifier}-design` });
        if (!res.ok) return this.escalate(ticket, "The design run failed.", `${res.text}\n\nLog: \`${res.logFile}\``);
        const report = parseBuildReport(res.text);

        await this.git.commitAll(path, `${ticket.identifier}: design: work in progress`);
        if (await this.git.commitsAhead(path, base)) await this.git.push(path, ticket.branchName);
        if (report.status === "needs_input") return this.escalate(ticket, "The designer has a question.", `**Question:** ${report.question}\n\n${report.summary}`);

        const dir = join(path, DESIGN_DIR, "proposed");
        const shots = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".png")).sort() : [];
        if (shots.length === 0) return this.escalate(ticket, "The design run produced no screenshots.", report.summary);

        const images: string[] = [];
        for (const shot of shots.slice(0, 16)) {
            const url = await this.linear.uploadImage(join(dir, shot));
            images.push(`**${shot.replace(/\.png$/, "")}**\n![${shot}](${url})`);
        }
        await this.linear.comment(
            ticket,
            `🎨 **Design ready for review**\n\n${report.summary}\n\n${images.join("\n\n")}\n\n` +
                `**To approve:** move to **${this.s.designApproved}**.\n**To change it:** comment what to change and move back to **${this.s.ready}**.`,
        );
        await this.linear.setState(ticket, this.s.designReview);
        await this.linear.assign(ticket, this.humanId);
        await notify(`${ticket.identifier} design ready`, ticket.title, ticket.url);
        log.info(ticket.identifier, `design posted (${shots.length} screenshots, $${res.costUsd.toFixed(2)})`);
    }

    async build(project: ProjectConfig, ticket: Ticket, base: string): Promise<void> {
        const fromDesign = ticket.state === this.s.designApproved;
        await this.linear.setState(ticket, this.s.working);
        await this.linear.comment(ticket, `▶️ Started: build${fromDesign ? " from approved design" : ""} (${project.name} → ${base})`);
        await this.git.ensureTargetBranch(project, base);
        const path = await this.git.ensureWorktree(project, ticket.identifier, ticket.branchName, base);

        let design = "";
        if (fromDesign) {
            const proposed = join(path, DESIGN_DIR, "proposed");
            const approved = join(path, DESIGN_DIR, "approved");
            if (existsSync(proposed)) {
                await rm(approved, { recursive: true, force: true });
                await cp(proposed, approved, { recursive: true });
            }
            design =
                `# Approved design\nThe human approved the design already on this branch. Screenshots of it are in ` +
                `\`${DESIGN_DIR}/approved/\`; Read them. Keep the look exactly; wire up real data and behaviour. ` +
                `When done, capture the same screens again to \`${DESIGN_DIR}/after/\` with the same file names and compare.`;
        }

        const prompt = await render("implement", { ...ticketVars(ticket), project: project.name, base, design, gates: gateList(project.gates) });
        const res = await this.claude.run({ role: "builder", project, cwd: path, prompt, label: `${ticket.identifier}-build` });
        if (!res.ok) return this.escalate(ticket, "The build run failed.", `${res.text}\n\nLog: \`${res.logFile}\``);
        const report = parseBuildReport(res.text);

        await this.git.commitAll(path, `${ticket.identifier}: work in progress`);
        const ahead = await this.git.commitsAhead(path, base);
        if (ahead) await this.git.push(path, ticket.branchName);
        if (report.status === "needs_input") return this.escalate(ticket, "The builder has a question.", `**Question:** ${report.question}\n\n**So far:** ${report.summary}`);
        if (!ahead) return this.escalate(ticket, "The builder finished without changing anything.", report.summary);

        const gates = await this.gateLoop(project, ticket, path, base);
        await this.git.push(path, ticket.branchName);
        if (!gates.ok) return this.escalate(ticket, "Local quality gates still fail after retries.", gates.report.slice(0, 6000));

        const pr =
            (await this.github.findOpenPr(project.github, ticket.branchName)) ??
            (await this.github.createPr(project.github, {
                branch: ticket.branchName,
                base,
                title: `${ticket.identifier}: ${ticket.title}`,
                ticket: ticket.identifier,
                body: `Linear: ${ticket.url}\n\n## Summary\n${report.summary}\n\n## Files\n\`\`\`\n${await this.git.diffStat(path, base)}\n\`\`\`\n\n🤖 Built by the orchestrator with Claude Code.`,
            }));
        await this.linear.setState(ticket, this.s.inReview);
        await this.linear.comment(ticket, `PR opened: ${pr.url}\n\n${report.summary}`);
        log.info(ticket.identifier, `PR #${pr.number} opened ($${res.costUsd.toFixed(2)})`);
    }

    // ---------- PR jobs ----------

    async review(project: ProjectConfig, ticket: Ticket, pr: AgentPr): Promise<void> {
        const path = await this.git.ensureWorktree(project, ticket.identifier, ticket.branchName, pr.base);
        const local = await this.git.headSha(path);
        if (local !== pr.headSha) {
            log.warn(ticket.identifier, `worktree at ${local.slice(0, 7)} but PR head is ${pr.headSha.slice(0, 7)}; skipping review this tick`);
            return;
        }
        const hasDesign = existsSync(join(path, DESIGN_DIR, "approved")) && existsSync(join(path, DESIGN_DIR, "after"));
        const design = hasDesign
            ? `# Design check\nCompare \`${DESIGN_DIR}/approved/\` (what the human approved) with \`${DESIGN_DIR}/after/\` (what was built). ` +
              `Read both sets of PNGs. A visible departure from the approved design is a major finding.`
            : "";

        const prompt = await render("review", { ...ticketVars(ticket), project: project.name, prUrl: pr.url, base: pr.base, design });
        const res = await this.claude.run({ role: "reviewer", project, cwd: path, prompt, label: `${ticket.identifier}-review` });
        const report = res.ok ? parseReviewReport(res.text) : parseReviewReport("");
        const blocking = blockingFindings(report, this.config.loop.blockingSeverities);
        const verdict = report.verdict === "needs_input" ? "needs_input" : blocking.length ? "changes" : "approve";

        const icon = { approve: "✅ Approved", changes: "🔁 Changes requested", needs_input: "⏸ Needs input" }[verdict];
        const body = `## 🤖 Agent review: ${icon}\n\n${report.summary}\n\n${formatFindings(report.findings, this.config.loop.blockingSeverities)}${report.question ? `\n\n**Question:** ${report.question}` : ""}`;
        await this.github.comment(project.github, pr.number, markerComment({ kind: "review", sha: pr.headSha, verdict }, body));
        log.info(ticket.identifier, `review: ${verdict} (${blocking.length} blocking, $${res.costUsd.toFixed(2)})`);
        // Escalation for needs_input happens on the next tick via decidePrAction, so it's handled in one place.
    }

    async fix(project: ProjectConfig, ticket: Ticket, pr: AgentPr, reason: "ci" | "review" | "conflict"): Promise<void> {
        const path = await this.git.ensureWorktree(project, ticket.identifier, ticket.branchName, pr.base);
        const comments = await this.github.markerComments(project.github, pr.number);
        const round = fixRoundsSinceResume(comments.map((c) => c.marker)) + 1;

        let problem: string;
        if (reason === "conflict") {
            const clean = await this.git.mergeBase(path, pr.base);
            problem = clean
                ? `\`origin/${pr.base}\` was merged into this branch cleanly. Make sure everything still works with the new base code.`
                : `Merging \`origin/${pr.base}\` into this branch left conflicts (see \`git status\`). Resolve each one keeping the intent of both sides, ` +
                  `then \`git add\` the files and \`git commit --no-edit\` to finish the merge.`;
        } else if (reason === "ci") {
            problem = `CI failed on the PR:\n\n${await this.github.failedChecks(project.github, pr.headSha)}`;
        } else {
            const last = [...comments].reverse().find((c) => c.marker.kind === "review");
            problem = `The reviewer requested changes:\n\n${last?.body.replace(/<!--.*?-->\n?/, "") ?? "(review comment not found)"}`;
        }

        const prompt = await render("fix", {
            ...ticketVars(ticket),
            project: project.name,
            prUrl: pr.url,
            base: pr.base,
            round,
            maxRounds: this.config.loop.maxFixRounds,
            problem,
            gates: gateList(project.gates),
        });
        const res = await this.claude.run({ role: "builder", project, cwd: path, prompt, label: `${ticket.identifier}-fix${round}` });
        const report = parseBuildReport(res.text);
        await this.git.commitAll(path, `${ticket.identifier}: fix: ${reason}`);

        const prRef = { repo: project.github, number: pr.number, url: pr.url, sha: pr.headSha };
        if (!res.ok) {
            await this.git.push(path, ticket.branchName).catch(() => undefined);
            return this.escalate(ticket, `The fix run (${reason}) failed.`, `${res.text}\n\nLog: \`${res.logFile}\``, prRef);
        }
        if (report.status === "needs_input") {
            await this.git.push(path, ticket.branchName).catch(() => undefined);
            return this.escalate(ticket, "The fixer has a question.", `**Question:** ${report.question}\n\n${report.summary}`, prRef);
        }

        const gates = await this.gateLoop(project, ticket, path, pr.base, pr.url);
        await this.git.push(path, ticket.branchName);
        const sha = await this.git.headSha(path);
        await this.github.comment(
            project.github,
            pr.number,
            markerComment({ kind: "fix", sha, round }, `🔧 **Fix round ${round}/${this.config.loop.maxFixRounds}** (${reason})\n\n${report.summary}`),
        );
        if (!gates.ok) return this.escalate(ticket, "Local quality gates still fail after a fix round.", gates.report.slice(0, 6000), { ...prRef, sha });
        log.info(ticket.identifier, `fix round ${round} pushed ($${res.costUsd.toFixed(2)})`);
    }

    async merge(project: ProjectConfig, ticket: Ticket, pr: AgentPr): Promise<void> {
        await this.github.merge(project.github, pr.number, pr.headSha, project.mergeMethod, `${ticket.identifier}: ${ticket.title} (#${pr.number})`);
        await this.linear.setState(ticket, this.s.done);
        await this.linear.comment(ticket, `✅ Merged ${pr.url}`);
        await this.git.removeWorktree(project, ticket.identifier, ticket.branchName);
        await this.github.deleteBranch(project.github, pr.branch);
        log.info(ticket.identifier, `merged PR #${pr.number}`);
    }

    async hold(project: ProjectConfig, ticket: Ticket, pr: AgentPr, why: string): Promise<void> {
        await this.github.comment(project.github, pr.number, markerComment({ kind: "hold", sha: pr.headSha }, `✋ **Reviewed and green, holding for a human merge:** ${why}`));
        await this.linear.comment(ticket, `✋ **Ready for you to merge.** Review passed and CI is green, but ${why}.\n\n${pr.url}`);
        await this.linear.assign(ticket, this.humanId);
        await notify(`${ticket.identifier} ready to merge`, why, pr.url);
        log.info(ticket.identifier, `held for human merge: ${why}`);
    }

    async resume(project: ProjectConfig, ticket: Ticket, pr: AgentPr): Promise<void> {
        await this.github.comment(project.github, pr.number, markerComment({ kind: "resume", sha: pr.headSha }, "▶️ Resumed after human input. Fix rounds reset."));
        log.info(ticket.identifier, "resumed");
    }
}

function formatFindings(findings: Finding[], blocking: Finding["severity"][]): string {
    if (!findings.length) return "_No findings._";
    const order = { blocker: 0, major: 1, minor: 2 };
    return [...findings]
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map((f) => {
            const where = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
            const tag = blocking.includes(f.severity) ? `**${f.severity}**` : f.severity;
            return `- ${tag}${where}: ${f.issue}${f.fix ? `\n  - Fix: ${f.fix}` : ""}`;
        })
        .join("\n");
}
