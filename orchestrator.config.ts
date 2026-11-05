import { defineConfig } from "./src/config.ts";

const PONYREC_WORKSPACE = "~/Code/Personal/ponyrec";

// Changes that always wait for a human merge, whatever the repo.
const sharedProtected = [".github/**", ".githooks/**", "package.json", "package-lock.json", ".env*"];
const laravelProtected = [
    ...sharedProtected,
    "database/migrations/**",
    "config/**",
    "app/Http/Middleware/**",
    "app/Providers/**",
    "composer.json",
    "composer.lock",
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
        unmanagedLabels: [],
        // Labels inside this group are branch names, e.g. "feature/pvp-rebuild".
        branchLabelGroup: "Branch",
    },
    qa: {
        enabled: true,
        label: "QA",
        status: "Todo",
        priority: 2,
        openFeaturePr: true,
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
    },
    paths: {
        worktrees: "~/.orchestrator/worktrees",
        state: "~/.orchestrator/state",
    },
    // Routing: a ticket goes to the repo whose label it has. No repo label → card_sim.
    projects: [
        {
            name: "kayou_structured",
            repoPath: `${PONYREC_WORKSPACE}/kayou_structured`,
            github: "NByam13/kayou_structured",
            baseBranch: "dev",
            labels: ["PonyRec repo"],
            ci: true,
            pathAliases: { "../": PONYREC_WORKSPACE },
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
            protectedPaths: [...laravelProtected, "pipeline/data/**"],
            mergeMode: "merge",
            mergeMethod: "squash",
            maxParallel: 2,
            allowedBash: ["Bash(php artisan:*)", "Bash(vendor/bin/pint:*)", "Bash(npx tsx:*)"],
            designHints:
                "Laravel + Inertia React + Tailwind. Pages are in resources/js/Pages. " +
                "Run `npm run build` then `php artisan serve --port=8123`, and screenshot with Playwright.",
        },
        {
            name: "ponyrec_bot",
            repoPath: `${PONYREC_WORKSPACE}/ponyrec_bot`,
            github: "NByam13/ponyrec_bot",
            baseBranch: "dev",
            labels: ["Bot repo"],
            ci: true,
            pathAliases: { "../": PONYREC_WORKSPACE },
            setup: ["cp {repo}/.env .env", "git config core.hooksPath .githooks", "npm ci --no-audit --no-fund --silent"],
            // Mirrors .github/workflows/ci.yml (minus the Fly deploy).
            gates: ["npm run lint", "npm run type-check", "npm run test", "npm run build"],
            protectedPaths: [...sharedProtected, "fly.toml", "Dockerfile"],
            mergeMode: "merge",
            mergeMethod: "squash",
            maxParallel: 1,
            allowedBash: [],
            // No designHints: Discord embeds aren't screenshot-able here, so the Design label isn't supported.
        },
        {
            name: "ponyrec_tts",
            repoPath: `${PONYREC_WORKSPACE}/ponyrec_tts`,
            github: "NByam13/ponyrec_tts",
            baseBranch: "dev",
            labels: ["TTS repo"],
            // No GitHub workflow yet, so the local gates below are the only gate.
            ci: false,
            pathAliases: { "../": PONYREC_WORKSPACE },
            setup: ["git config core.hooksPath .githooks", "npm ci --no-audit --no-fund --silent"],
            gates: ["npm run lint", "npm run type-check", "npm run lua:lint", "npm run test", "npm run build"],
            protectedPaths: sharedProtected,
            mergeMode: "merge",
            mergeMethod: "squash",
            maxParallel: 1,
            allowedBash: ["Bash(luacheck:*)", "Bash(busted:*)", "Bash(lua:*)"],
            // No designHints: the table only renders inside Tabletop Simulator.
        },
        {
            name: "card_sim",
            repoPath: "~/Code/Personal/card_sim",
            github: "NByam13/card_sim",
            baseBranch: "dev",
            labels: ["Card Sim repo"],
            default: true,
            ci: true,
            pathAliases: { "../ponyrec/": PONYREC_WORKSPACE },
            setup: [
                "cp {repo}/.env .env",
                "composer install --no-interaction --no-progress --quiet",
                "npm ci --no-audit --no-fund --silent",
            ],
            // Mirrors .github/workflows/tests.yml.
            gates: ["composer ci:check", "npm run build"],
            protectedPaths: laravelProtected,
            mergeMode: "merge",
            mergeMethod: "squash",
            maxParallel: 2,
            allowedBash: ["Bash(php artisan:*)", "Bash(vendor/bin/pint:*)", "Bash(vendor/bin/phpstan:*)"],
            designHints:
                "Laravel + Inertia React + Tailwind. Run `npm run build` then `php artisan serve --port=8124`, " +
                "and screenshot with Playwright. Board UI needs a seeded game; check the seeders.",
        },
        {
            name: "artist_alley",
            repoPath: `${PONYREC_WORKSPACE}/artist_alley`,
            github: "NByam13/artist_alley",
            baseBranch: "main",
            labels: ["Artist Alley repo"],
            ci: true,
            pathAliases: { "../": PONYREC_WORKSPACE },
            setup: [
                "cp {repo}/.env .env",
                "cp {repo}/.env.testing .env.testing",
                "composer install --no-interaction --no-progress --quiet",
                "npm ci --no-audit --no-fund --silent",
            ],
            // Mirrors .github/workflows/tests.yml. Build first: the feature tests render through the Vite manifest.
            gates: ["npm run build", "composer ci:check"],
            protectedPaths: laravelProtected,
            // The orchestrator never auto-merges into main; Nick merges.
            mergeMode: "hold",
            mergeMethod: "squash",
            maxParallel: 1,
            allowedBash: ["Bash(php artisan:*)", "Bash(vendor/bin/pint:*)", "Bash(vendor/bin/phpstan:*)"],
            designHints:
                "Laravel + Inertia React + Tailwind. Run `npm run build` then `php artisan serve --port=8125`, " +
                "and screenshot with Playwright.",
        },
    ],
});
