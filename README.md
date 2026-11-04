# Orchestrator

Moves Linear tickets through **design → build → review → fix → merge** on its own, using headless Claude Code
for every step that needs thinking. You write tickets, approve designs and answer questions. It does the rest,
then pulls the next ticket.

It doesn't replace Claude Code. Each step is a normal `claude -p` run inside a git worktree, so your
`CLAUDE.md`, skills, hooks and Claude login all apply. The orchestrator is the loop between those runs.

```
                ┌──────────── you ────────────┐
                │ write ticket → Ready for agent│
                └──────────────┬───────────────┘
                               ▼
     has "Design" label? ──yes──► design run ──► screenshots on ticket ──► Design review ⏸ you
               │                                                              │ approve
               no                                                             ▼
               └────────────────────────────► build run ◄──── Design approved
                                                  │  (local gates, retried)
                                                  ▼
                                           PR opened · In Review
                                                  │
                     ┌──── CI red ──── fix run ◄──┤
                     │                            ▼
                     └──────────────────► review run (fresh session, read-only)
                                                  │
                         changes ── fix run ──────┤  (max 3 rounds, then Needs input ⏸ you)
                                                  ▼
                              approved + CI green + head unchanged
                                                  │
                       protected files / hold ────┼──── merge ──► Done ──► next ticket
                       → "ready to merge" ⏸ you
```

## Setup (once)

```bash
cd ~/Code/Personal/orchestrator
nvm use && npm install
cp .env.example .env          # add LINEAR_API_KEY, GITHUB_TOKEN, optional NOTIFY_WEBHOOK_URL
npm run setup-linear          # creates the statuses and labels below in the PON team
npm test                      # checks the config and the decision logic
npm run dry-run               # shows what it would do right now, changes nothing
```

`setup-linear` adds these to the PON team (it never renames or deletes):

| Status | Who moves tickets here |
|---|---|
| **Ready for agent** | You, when a ticket is ready to be built |
| **Agent working** | Orchestrator |
| **Design review** | Orchestrator, after posting screenshots |
| **Design approved** | You, to approve a design |
| **In Review** | Orchestrator, once the PR is open (your existing status) |
| **Needs input** | Orchestrator, when it needs you. It assigns the ticket to you so Linear pings your phone |

Labels: **Design** (adds the design gate), **Hold for human** (never auto-merge this one), **QA**, one **… repo** label per
repo, and an empty **Branch** label group (see below).

Every repo needs a `dev` branch on GitHub before its tickets can run. Cut each one once:

```bash
for r in ~/Code/Personal/card_sim ~/Code/Personal/ponyrec/{kayou_structured,ponyrec_bot,ponyrec_tts}; do
  git -C "$r" fetch origin && git -C "$r" push origin origin/main:refs/heads/dev
done
```

## Daily use

- **Start it:** `npm start` in a terminal (or the launchd job below). It checks Linear every 2 minutes, and
  straight away whenever a job finishes.
- **Queue work:** move tickets to **Ready for agent**. Use Linear's *blocked by* links to set the order inside a
  feature; a ticket waits until its blockers are Done. Priority, then your board order, decides the rest.
- **Which repo:** set by label. **PonyRec repo** → `kayou_structured`, **Bot repo** → `ponyrec_bot`,
  **TTS repo** → `ponyrec_tts`, **Card Sim repo** (or no repo label) → `card_sim`. **Artist Alley repo** is
  skipped. One repo per ticket: a change across two repos is two tickets, linked with *blocked by* so the server
  side lands first.
- **Which branch:** PRs go to `dev`. To send a ticket's PR to a feature branch instead, add a label inside the
  **Branch** group named after the branch, e.g. `feature/pvp-rebuild`. Create one label per feature branch;
  Linear only lets a ticket have one label from a group. The branch is cut from `dev` the first time it's used.
  Merging the finished feature branch into `dev` is yours to do.
- **When a feature is done:** once every ticket in a Linear project (In Progress status) is Done, an agent reads
  the tickets, PRs and diff and writes a **QA** ticket for you in that project: one checklist section per repo,
  with happy paths, edge cases, regressions and the riskiest areas, as tick boxes. For each feature branch it
  also opens the feature → `dev` PR, linked to the QA ticket. That PR is never auto-merged. Do the QA, merge
  the PR(s), then mark the project complete. Projects with no orchestrator-merged PRs are skipped, so older
  hand-built features won't suddenly get QA tickets. Turn this off with `qa.enabled` in the config.
- **Releasing:** nothing the orchestrator does touches `main`. You merge `dev` → `main` when the preview looks right.
  The config refuses to auto-merge into `main`.
- **Answer a question:** reply on the ticket, then move it back to the status the comment names. Your comments
  are passed to the next agent run.
- **Redo a design:** comment what to change and move it back to **Ready for agent**.
- **Pause:** `touch PAUSE` (running jobs finish, nothing new starts). `rm PAUSE` to resume.
- **Stop:** Ctrl-C once waits for running jobs; twice kills them. Restarting re-queues anything that was cut off.
- **See what it thinks:** `npm run status`.

## Safety rails

- **Nothing merges without:** green CI on the exact commit, an approving review of that same commit, no merge
  conflicts, and the merge call pins the commit SHA. Any push after the review means another review.
- **Repos without GitHub CI** (`ponyrec_tts` today) set `ci: false`. Their local gates run before every push and
  are the only gate, so keep them complete.
- **Protected paths** (migrations, config, middleware, providers, workflows, dependency files, `.env*`) always stop
  at "ready for you to merge". Edit `protectedPaths` per repo.
- **`mergeMode: "hold"`** on a repo turns auto-merge off there entirely. Good for the first week.
- **Agents can't push, open PRs, change ticket status, or switch branches.** The orchestrator does those.
- **Only blocker/major findings send a PR back.** Minor ones are noted on the PR and don't loop.
- **Fix rounds are capped** (3), and so are local gate retries (2). After that, it asks you.
- **Usage limit:** when a run hits the subscription's usage limit (5-hour window or weekly), agent runs pause until
  it resets. The ticket goes back to the queue (work so far stays on the branch); non-agent steps keep running.
- **Branch protection:** GitHub's required checks need a paid plan on private repos, so the orchestrator checks CI
  itself before merging. Your `pre-push` hook still blocks direct pushes to main.

Agents run real commands (tests, `npm`, `php`) on this machine, the same as when you run Claude Code yourself.

## Where things live

| | |
|---|---|
| `orchestrator.config.ts` | Repos, gates, setup commands, protected paths, limits |
| `prompts/*.md` | What each agent is told. Tune these as you learn what goes wrong |
| `src/rules.ts` | Every decision (routing, order, the PR state machine). Pure and tested |
| `src/pipeline.ts` | The steps: design, build, review, fix, merge, hold, escalate |
| `src/qa.ts` | The QA checklist step when a project's tickets are all done |
| `src/scheduler.ts` | The loop, parallel limits, pause, usage-limit pause, crash recovery |
| `~/.orchestrator/worktrees/` | One worktree per ticket, removed after merge |
| `~/.orchestrator/state/logs/` | Full prompt and output of every agent run |

The orchestrator keeps no database. Linear statuses and the hidden markers in its PR comments are the whole
state, so it can be stopped, restarted or moved to another machine at any point.

## Adding a repo

Add an entry to `projects` in `orchestrator.config.ts`: path, GitHub name, base branch, a routing label, setup
commands, gates (copy them from that repo's CI), protected paths, and `pathAliases` if its CLAUDE.md links to
folders outside the repo by relative path (`../`). Leave `designHints` out if it has no UI to screenshot. Then run
`npm run setup-linear` to create the new label. If the repo lives in another Linear team, run a second copy with
a different config for now.

## Run it in the background (macOS)

Save as `~/Library/LaunchAgents/dev.nickbyam.orchestrator.plist`, then
`launchctl load ~/Library/LaunchAgents/dev.nickbyam.orchestrator.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.nickbyam.orchestrator</string>
  <key>WorkingDirectory</key><string>/Users/nick/Code/Personal/orchestrator</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>npm start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/nick/.orchestrator/orchestrator.log</string>
  <key>StandardErrorPath</key><string>/Users/nick/.orchestrator/orchestrator.log</string>
</dict></plist>
```

The Mac has to be awake for it to work: `caffeinate -s` or System Settings → Battery → prevent sleep when plugged in.
