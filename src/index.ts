import { Claude } from "./claude.ts";
import { validateConfig, type Config } from "./config.ts";
import { Git } from "./git.ts";
import { GitHub } from "./github.ts";
import { Linear } from "./linear.ts";
import { log } from "./log.ts";
import { Pipeline } from "./pipeline.ts";
import { Qa } from "./qa.ts";
import { PAUSE_FILE, Scheduler } from "./scheduler.ts";

async function loadConfig(): Promise<Config> {
    const mod = (await import("../orchestrator.config.ts")) as { default: Config };
    const problems = validateConfig(mod.default);
    if (problems.length) {
        for (const p of problems) log.error("config", p);
        process.exit(1);
    }
    return mod.default;
}

function env(name: string): string {
    const v = process.env[name];
    if (!v) {
        log.error("env", `${name} is not set. Copy .env.example to .env and fill it in.`);
        process.exit(1);
    }
    return v;
}

async function main(): Promise<void> {
    const [command = "start", ...flags] = process.argv.slice(2);
    const config = await loadConfig();
    const linear = new Linear(env("LINEAR_API_KEY"), config.linear.teamKey);

    if (command === "setup-linear") {
        const s = config.linear.statuses;
        const created = await linear.ensureSetup(
            [
                { name: s.ready, type: "unstarted" },
                { name: s.working, type: "started" },
                { name: s.designReview, type: "started" },
                { name: s.designApproved, type: "started" },
                { name: s.inReview, type: "started" },
                { name: s.needsInput, type: "started" },
                { name: s.done, type: "completed" },
            ],
            [config.linear.designLabel, config.linear.holdLabel, config.qa.label, ...config.projects.flatMap((p) => p.labels ?? [])],
            [config.linear.branchLabelGroup],
        );
        log.info("setup", created.length ? `created ${created.join(", ")}` : "everything already exists");
        return;
    }

    const github = new GitHub(env("GITHUB_TOKEN"));
    const claude = new Claude(config);
    const git = new Git(config);
    const humanId = await linear.viewerId();
    const pipeline = new Pipeline(config, linear, github, git, claude, humanId);
    const qa = new Qa(config, linear, github, git, claude, humanId);
    const scheduler = new Scheduler(config, linear, github, claude, pipeline, qa);

    switch (command) {
        case "start":
            log.info("loop", `watching ${config.linear.teamKey} every ${config.loop.pollSeconds}s · max ${config.loop.maxParallel} agents · Ctrl-C to stop · touch ${PAUSE_FILE} to pause`);
            await scheduler.loop();
            break;
        case "once": {
            const dryRun = flags.includes("--dry-run");
            const jobs = await scheduler.tick(dryRun);
            await Promise.allSettled(jobs);
            break;
        }
        case "status": {
            log.info("status", `spent today: $${(await claude.spentToday()).toFixed(2)} of $${config.loop.dailyBudgetUsd}`);
            await scheduler.tick(true);
            break;
        }
        default:
            log.error("cli", `unknown command "${command}". Use start | once [--dry-run] | status | setup-linear`);
            process.exit(1);
    }
}

main().catch((err: unknown) => {
    log.error("fatal", err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
});
