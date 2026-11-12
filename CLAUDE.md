# Orchestrator

A loop that moves Linear tickets (PON team) through design → build → review → fix → merge with headless
`claude -p` runs in per-ticket git worktrees. The README covers setup, daily use and the safety rails; read it
before changing behaviour.

## Commands

- `npm test`: Vitest. `npm run type-check`: tsc.
- `npm run dry-run`: one planning pass that logs what it would do and changes nothing. Use it to check a change
  against the real Linear and GitHub state.
- Don't run `npm start` or `npm run once` to try a change. They act for real: they post on tickets, push, open
  and merge PRs.

## How it's built

- **No database.** Linear statuses and the hidden markers in PR comments are the whole state. Anything new must
  be derivable from those (or from the worktrees on disk) after a restart.
- **Decisions live in `src/rules.ts`**, as pure functions tested in `tests/rules.test.ts`. The scheduler and
  pipeline gather inputs and act on the answer. Put new branching logic there, with a test.
- `src/scheduler.ts` plans each tick, in this order: open PRs, new tickets, QA, worktree sweep. `src/pipeline.ts`
  runs the steps. A planned job's `key` is a ticket id, or `qa:…` / `sweep:…` for work that isn't one ticket's;
  a failed job with a ticket key escalates that ticket.
- Shell out through `src/shell.ts`: `run` never throws (check `code`), `must` throws with the output tail.
- ESM TypeScript run by tsx: import with the `.ts` extension. Match the existing style (4-space indent, long lines
  are fine).

## Gotchas

- The orchestrator uses the same GitHub token as Nick, so on GitHub its merges and his look identical. Ticket
  comments (`✅ Merged`, `✋ Ready for you to merge`) show which it was.
- Worktrees of one repo share refs; fetches go through the queue in `src/git.ts` so they don't collide.
- The daemon runs from this checkout. Switching branches here while it runs changes the code it runs.
- `.claude/skills/orchestrator-tickets/` is the ticket-writing guide other repos load. Keep it in step with
  labels, statuses and routing when those change.

## Comments

Brief, and only where the code is hard to parse. No rationale or trade-offs in source; those go in the commit
message or PR.
