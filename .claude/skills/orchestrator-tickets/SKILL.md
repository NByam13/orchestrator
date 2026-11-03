---
name: orchestrator-tickets
description: Write Linear tickets and projects (PON team) so the orchestrator in ~/Code/Personal/orchestrator can build them on its own. Use when creating, splitting or editing Linear tickets, projects or milestones for card_sim, kayou_structured (PonyRec), ponyrec_bot or ponyrec_tts, or when the user says "make a ticket", "plan this feature in Linear", "queue this for the agent".
---

# Orchestrator tickets

The orchestrator (`~/Code/Personal/orchestrator`, see its README) pulls PON tickets from **Ready for agent** and
runs design → build → review → fix → merge with headless Claude Code. It has no database: **Linear is its state**.
Statuses, labels, relations and the ticket text decide what it builds, where and in what order. Get them right.

## What the build agent sees

Only: the ticket **title**, **description**, **comments**, and the **project and milestone names**. Not the
project description, not linked docs, not other tickets. So every ticket must stand on its own:

- **Goal**: one or two sentences on the outcome for the player/user.
- **Acceptance criteria**: a checklist the agent can turn into tests. For game rules, give concrete cards and the
  expected result.
- **Pointers**: files, routes, components or the PonyRec code to port from, if known.
- **Out of scope**: what not to touch, when a reasonable agent might drift there.
- **Open decisions**: settle them before queueing. An ambiguous ticket stops at **Needs input**.

Keep it small: one PR a reviewer can read in one sitting. A slice of a feature is a milestone, not a ticket.

## Routing (labels)

Exactly one repo per ticket. A two-repo change is two tickets, the client one *blocked by* the server one.

| Label | Repo |
|---|---|
| **Card Sim repo** (or no repo label) | `card_sim` |
| **PonyRec repo** | `kayou_structured` |
| **Bot repo** | `ponyrec_bot` |
| **TTS repo** | `ponyrec_tts` |
| **Artist Alley repo** | skipped, the orchestrator never touches it |

Other labels:

- **Design**: adds a design pass with screenshots and waits in **Design review** for approval. Use for new UI or
  visible layout changes. Not supported for **Bot repo** (nothing to screenshot).
- **Hold for human**: built and reviewed but never auto-merged. Use for risky or sensitive changes.
- **Branch** group: a label named after a feature branch (e.g. `feature/pvp-rebuild`) sends the PR there instead
  of `dev`. One per ticket. Create the label in the Branch group if it doesn't exist; never `main`/`master`.
  Every ticket of a feature that lives on a branch needs the same Branch label.
- **QA**: reserved for the QA ticket the orchestrator writes. Never add it yourself; it suppresses QA for that project.

## Order and status

- Set order with Linear **blocked by** relations. A ticket waits until all its blockers are Done. After that,
  priority (Urgent first, None last), then board order.
- Create tickets in **Backlog**/**Todo**. Move to **Ready for agent** only when the ticket is complete and the user
  says to queue it. Moving it there starts work.
- The orchestrator owns **Agent working**, **Design review**, **In Review** and **Needs input**. Don't set those.
  The user sets **Design approved** and moves answered tickets back.

## Projects

- Group a feature's tickets in one **Linear project** on the PON team. When the project is **In Progress** and every
  ticket in it is Done, the orchestrator writes a QA ticket and opens the feature-branch → `dev` PR.
- So: set the project to In Progress when its work is queued, and keep unrelated tickets out of it. A stray open
  ticket blocks QA for the whole project.
- Use milestones for slices; the milestone name reaches the agent, so make it descriptive.

## Before you finish

Check each new ticket against this list, then show the user the tickets with their labels and relations:

- [ ] PON team, in a project if it's part of a feature
- [ ] one repo label (or none for card_sim), matching where the code changes
- [ ] Branch label if the feature lives on a branch, same on every sibling ticket
- [ ] Design / Hold for human where they apply
- [ ] blocked-by relations for order and cross-repo dependencies
- [ ] description has goal, acceptance criteria and no open questions
- [ ] status is not Ready for agent unless the user asked to queue it
