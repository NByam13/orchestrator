import { homedir } from "node:os";
import { resolve } from "node:path";

/** Linear status names the orchestrator reads and writes. All must exist on the team (`npm run setup-linear`). */
export interface StatusNames {
    /** You put tickets here when they're ready for an agent to pick up. */
    ready: string;
    /** An agent is designing or building the ticket right now. */
    working: string;
    /** Design screenshots are posted and waiting for your OK. */
    designReview: string;
    /** You move a ticket here to approve its design; the build starts from the design branch. */
    designApproved: string;
    /** A PR is open and in the review/fix loop. Matches your existing status. */
    inReview: string;
    /** The pipeline stopped and wants a decision from you. */
    needsInput: string;
    /** Merged. */
    done: string;
}

export interface ProjectConfig {
    /** Short name used in logs and worktree folders. */
    name: string;
    /** Path to your normal checkout. Worktrees are created from it; it is never modified. */
    repoPath: string;
    /** "owner/repo" on GitHub. */
    github: string;
    /** Branch PRs target unless the ticket has a Branch label. Merging here should NOT deploy to production. */
    baseBranch: string;
    /** Which tickets belong to this repo. A ticket matches if it has any of these labels. */
    labels?: string[];
    /** Tickets with none of the routing labels land here. At most one project may set this. */
    default?: boolean;
    /** Run in a fresh worktree before the agent starts. `{repo}` = repoPath. */
    setup: string[];
    /** Local quality gates. Same checks as CI, run before every push so CI rarely fails. */
    gates: string[];
    /**
     * Files where a change always waits for you to merge by hand, even when review and CI pass.
     * Globs: `**` crosses folders, `*` doesn't.
     */
    protectedPaths: string[];
    /** "merge" = merge automatically when green. "hold" = stop at green and ping you. */
    mergeMode: "merge" | "hold";
    mergeMethod: "squash" | "merge" | "rebase";
    maxParallel: number;
    /** Extra Bash commands agents may run without asking, as Claude Code permission rules. */
    allowedBash: string[];
    /** Free-text tips for the design agent: how to run the app and where pages live. Leave unset if the repo has no UI to screenshot. */
    designHints?: string;
    /**
     * Whether the repo has GitHub CI. Without it, the local gates (run before every push) are the only gate,
     * and the orchestrator doesn't wait for checks that will never come.
     */
    ci: boolean;
    /**
     * Folders outside the repo that its CLAUDE.md refers to by relative path, e.g. `{ "../": "~/Code/Personal/ponyrec" }`.
     * Agents work in a worktree elsewhere, so they're told where these really are and given read access.
     */
    pathAliases?: Record<string, string>;
}

export interface Config {
    linear: {
        teamKey: string;
        statuses: StatusNames;
        /** Tickets with this label get a design step that waits for your approval. */
        designLabel: string;
        /** Tickets with this label never auto-merge. */
        holdLabel: string;
        /** Labels that mean "this belongs to a repo the orchestrator doesn't know". Such tickets are skipped. */
        unmanagedLabels: string[];
        /**
         * Label group whose labels are branch names, e.g. group "Branch" with label "feature/pvp-rebuild".
         * A ticket with one targets that branch instead of the repo's baseBranch. The branch is cut from baseBranch if missing.
         */
        branchLabelGroup: string;
    };
    qa: {
        enabled: boolean;
        /** Label on the QA ticket. Tickets with it don't count toward "the project is done". */
        label: string;
        /** Status the QA ticket is created in. It's yours to work, so not "Ready for agent". */
        status: string;
        /** Linear priority for the QA ticket: 1 urgent … 4 low. */
        priority: number;
        /** Open the feature-branch → base PR alongside the QA ticket (never auto-merged). */
        openFeaturePr: boolean;
    };
    claude: {
        /** Path or name of the Claude Code CLI. */
        bin: string;
        builderModel?: string;
        reviewerModel?: string;
        maxTurns: number;
        timeoutMinutes: number;
    };
    loop: {
        pollSeconds: number;
        maxParallel: number;
        /** Review → fix rounds per PR before it stops and asks you. */
        maxFixRounds: number;
        /** Times the builder may retry failing local gates before giving up. */
        maxGateRetries: number;
        /** Severities that block a merge. Anything else is noted on the PR and left alone. */
        blockingSeverities: Array<"blocker" | "major" | "minor">;
    };
    paths: {
        /** Where worktrees live, outside your repos. */
        worktrees: string;
        /** Run logs. */
        state: string;
    };
    projects: ProjectConfig[];
}

export function expandHome(p: string): string {
    return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export function defineConfig(config: Config): Config {
    return config;
}

export function validateConfig(config: Config): string[] {
    const problems: string[] = [];
    const defaults = config.projects.filter((p) => p.default);
    if (defaults.length > 1) problems.push(`Only one project may be default; found ${defaults.map((p) => p.name).join(", ")}.`);
    const names = new Set<string>();
    for (const p of config.projects) {
        if (names.has(p.name)) problems.push(`Duplicate project name "${p.name}".`);
        names.add(p.name);
        if (!/^[\w.-]+\/[\w.-]+$/.test(p.github)) problems.push(`${p.name}: github must be "owner/repo".`);
        if (!p.default && !p.labels?.length) problems.push(`${p.name}: needs routing labels or default: true.`);
        if (p.gates.length === 0) problems.push(`${p.name}: no gates. Auto-merge without gates is not allowed.`);
        if (["main", "master"].includes(p.baseBranch) && p.mergeMode === "merge") {
            problems.push(`${p.name}: auto-merging into ${p.baseBranch} is not allowed. Use a dev branch or mergeMode "hold".`);
        }
    }
    return problems;
}
