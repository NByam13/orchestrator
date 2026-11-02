import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandHome, type Config, type ProjectConfig } from "./config.ts";
import { run } from "./shell.ts";

export type AgentRole = "builder" | "reviewer";

export interface AgentResult {
    ok: boolean;
    text: string;
    costUsd: number;
    turns: number;
    logFile: string;
}

const BUILDER_TOOLS = [
    "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "TodoWrite", "Task", "WebSearch", "WebFetch",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git add:*)",
    "Bash(git commit:*)", "Bash(git restore:*)", "Bash(git stash:*)", "Bash(git mv:*)", "Bash(git rm:*)",
    "Bash(git merge --continue:*)", "Bash(git checkout --:*)",
    "Bash(ls:*)", "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "Bash(wc:*)", "Bash(sort:*)",
    "Bash(composer:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(php:*)", "Bash(curl -s http://127.0.0.1:*)",
    "Bash(sleep:*)", "Bash(kill:*)", "Bash(pkill -f \"php artisan serve:*)",
];

const REVIEWER_TOOLS = ["Read", "Glob", "Grep", "Task", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(ls:*)"];

/** Things only the orchestrator does, so the agent can't race it. */
const ALWAYS_DENIED = ["Bash(git push:*)", "Bash(gh:*)", "Bash(git reset --hard:*)", "Bash(git checkout main:*)", "Bash(git switch:*)", "Bash(rm -rf:*)"];

const HOUSE_RULES = `
You are running headless inside an automated pipeline (the "orchestrator"). Nobody is watching this session,
so never wait for confirmation. The orchestrator owns git pushes, pull requests and Linear ticket status:
do not push, do not open PRs, and do not change ticket status, even if CLAUDE.md says to.
Your working directory is a git worktree on the ticket's branch. Stay inside it.
Files under .orchestrator/ are scratch space and are never committed.
`.trim();

export class Claude {
    constructor(private config: Config) {}

    private stateDir(): string {
        return expandHome(this.config.paths.state);
    }

    async spentToday(): Promise<number> {
        const file = join(this.stateDir(), `spend-${today()}.json`);
        if (!existsSync(file)) return 0;
        return (JSON.parse(await readFile(file, "utf8")) as { usd: number }).usd;
    }

    private async addSpend(usd: number): Promise<void> {
        await mkdir(this.stateDir(), { recursive: true });
        const file = join(this.stateDir(), `spend-${today()}.json`);
        await writeFile(file, JSON.stringify({ usd: (await this.spentToday()) + usd }));
    }

    async run(opts: { role: AgentRole; project: ProjectConfig; cwd: string; prompt: string; label: string }): Promise<AgentResult> {
        const c = this.config.claude;
        const builder = opts.role === "builder";
        const model = builder ? c.builderModel : c.reviewerModel;
        const allowed = builder ? [...BUILDER_TOOLS, ...opts.project.allowedBash] : REVIEWER_TOOLS;
        const denied = builder ? ALWAYS_DENIED : [...ALWAYS_DENIED, "Edit", "MultiEdit", "Write", "NotebookEdit"];

        const args = [
            "-p",
            "--output-format", "json",
            "--permission-mode", builder ? "acceptEdits" : "default",
            "--max-turns", String(c.maxTurns),
            "--append-system-prompt", HOUSE_RULES,
            "--allowedTools", allowed.join(","),
            "--disallowedTools", denied.join(","),
            ...(model ? ["--model", model] : []),
        ];

        const r = await run(c.bin, args, { cwd: opts.cwd, input: opts.prompt, timeoutMs: c.timeoutMinutes * 60_000 });

        const logDir = join(this.stateDir(), "logs");
        await mkdir(logDir, { recursive: true });
        const logFile = join(logDir, `${opts.label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        await writeFile(logFile, JSON.stringify({ args, prompt: opts.prompt, exit: r.code, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr }, null, 2));

        let parsed: { is_error?: boolean; result?: string; total_cost_usd?: number; num_turns?: number; subtype?: string } = {};
        try {
            parsed = JSON.parse(r.stdout);
        } catch {
            /* fall through: not JSON means the CLI itself failed */
        }
        const costUsd = parsed.total_cost_usd ?? 0;
        await this.addSpend(costUsd);

        const ok = r.code === 0 && !r.timedOut && !parsed.is_error;
        const why = r.timedOut ? `timed out after ${c.timeoutMinutes} min` : parsed.subtype && parsed.subtype !== "success" ? parsed.subtype : r.stderr.trim().slice(-500);
        return { ok, text: parsed.result ?? (ok ? "" : `Claude Code failed: ${why}`), costUsd, turns: parsed.num_turns ?? 0, logFile };
    }
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}
