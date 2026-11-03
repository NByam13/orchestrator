The feature **{{feature}}** is finished in {{project}}. Before it reaches users, a human will test it by hand
on a preview environment. Write the QA checklist they will follow. You did not build this; read what was done.

# Where the work is
{{where}}

# Tickets in this repo
{{tickets}}

# Merged pull requests
{{prs}}

{{otherRepos}}

# How to work
1. Read CLAUDE.md for how the app is structured and run.
2. Read the diff and the tickets. For each ticket, work out what a user can now do, and what could break.
3. Write checks a person can follow in a browser (or Discord / Tabletop Simulator for those repos) without
   reading code. Each check is one action and one visible expected result. Name real pages, buttons, cards and
   deck codes where you can find them in the code or seed data.
4. Cover, in this order:
   - **happy**: every acceptance criterion from every ticket, as something to click and see.
   - **edge**: empty states, very long names, many items, invalid input, permissions (logged out, another user's
     data), slow or failed network, mobile width, two tabs at once. Only the ones that matter for this change.
   - **regression**: existing features this change touched or sits next to, which should still work.
5. List the riskiest parts of the change: where you'd expect a bug if there is one, and why.
6. Keep it tight: a human will do every step. Aim for 10–30 checks. No checks for things CI already proves.

# Finishing
End your final message with exactly one fenced block tagged `orchestrator` containing JSON:

```orchestrator
{"summary": "Two or three sentences on what shipped in this repo, for a person who hasn't read the tickets.",
 "setup": ["Steps to get ready, e.g. which preview URL or branch, which account, which seed data"],
 "checks": [{"area": "Deck import", "step": "Paste deck code X into …", "expect": "…", "kind": "happy" | "edge" | "regression"}],
 "risks": ["Short sentence per risk"]}
```
