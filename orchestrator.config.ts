import { defineConfig } from "./src/config.ts";

// Changes that always wait for a human merge, whatever the repo.
const sharedProtected = [
    "database/migrations/**",
    "config/**",
    "app/Http/Middleware/**",
    "app/Providers/**",
    ".github/**",
    ".githooks/**",
    "composer.json",
    "composer.lock",
    "package.json",
    "package-lock.json",
    ".env*",
];

export default defineConfig({
    linear: {
        teamKey: "PON",
        statuses: {
            ready: "Ready for agent",
            working: "Agent working",
            designReview: "Design review",
            designApproved: "Design approved",
            inReview: "In Review",
            needsInput: "Needs input",
            done: "Done",
        },
        designLabel: "Design",
        holdLabel: "Hold for human",
        unmanagedLabels: ["Artist Alley repo"],
    },
    claude: {
        bin: "claude",
        // Leave unset to use your Claude Code default. A different reviewer model catches different mistakes.
        builderModel: undefined,
        reviewerModel: undefined,
        maxTurns: 150,
        timeoutMinutes: 60,
    },
    loop: {
        pollSeconds: 120,
        maxParallel: 3,
        maxFixRounds: 3,
        maxGateRetries: 2,
        blockingSeverities: ["blocker", "major"],
        dailyBudgetUsd: 40,
    },
    paths: {
        worktrees: "~/.orchestrator/worktrees",
        state: "~/.orchestrator/state",
    },
    projects: [
        {
            name: "kayou_structured",
            repoPath: "~/Code/Personal/ponyrec/kayou_structured",
            github: "NByam13/kayou_structured",
            baseBranch: "main",
            labels: ["PonyRec repo"],
            setup: [
                "cp {repo}/.env .env",
                "cp {repo}/.env.testing .env.testing",
                "git config core.hooksPath .githooks",
                "composer install --no-interaction --no-progress --quiet",
                "npm ci --no-audit --no-fund --silent",
            ],
            // Mirrors .github/workflows/ci.yml.
            gates: [
                "vendor/bin/pint --test",
                "php artisan test --compact --parallel",
                "npm run lint",
                "npm run type-check",
                "npm run type-check:pipeline",
                "npm run test",
                "npm run build",
            ],
            protectedPaths: [...sharedProtected, "pipeline/data/**"],
            // Merging to main deploys ponyrec.net.
            mergeMode: "merge",
            mergeMethod: "squash",
            maxParallel: 2,
            allowedBash: ["Bash(php artisan:*)", "Bash(vendor/bin/pint:*)", "Bash(npx tsx:*)"],
            designHints:
                "Laravel + Inertia React + Tailwind. Pages are in resources/js/Pages. " +
                "Run `npm run build` then `php artisan serve --port=8123`, and screenshot with Playwright.",
        },
        {
            name: "card_sim",
            repoPath: "~/Code/Personal/card_sim",
            github: "NByam13/card_sim",
            baseBranch: "main",
            default: true,
            setup: [
                "cp {repo}/.env .env",
                "composer install --no-interaction --no-progress --quiet",
                "npm ci --no-audit --no-fund --silent",
            ],
            // Mirrors .github/workflows/tests.yml.
            gates: ["composer ci:check", "npm run build"],
            protectedPaths: sharedProtected,
            mergeMode: "merge",
            mergeMethod: "squash",
            maxParallel: 2,
            allowedBash: ["Bash(php artisan:*)", "Bash(vendor/bin/pint:*)", "Bash(vendor/bin/phpstan:*)"],
            designHints:
                "Laravel + Inertia React + Tailwind. Run `npm run build` then `php artisan serve --port=8124`, " +
                "and screenshot with Playwright. Board UI needs a seeded game; check the seeders.",
        },
    ],
});
