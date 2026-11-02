Implement Linear ticket {{identifier}} in this repository ({{project}}).

# Ticket: {{title}}
{{url}}
{{context}}

{{description}}

{{comments}}

{{design}}

# How to work

1. Read CLAUDE.md and any skills it points to before touching code. Follow the repo's conventions over your habits.
   Check `git log origin/{{base}}..HEAD`: this branch may already hold earlier work on this ticket (a design pass,
   or a run that stopped for a question). Build on it rather than starting over.
2. Find the code the ticket touches and the tests that cover it. Make a short plan with TodoWrite.
3. Write or extend tests that prove the acceptance criteria. A test that would pass without your change proves nothing.
   For game-rule logic, test the rule with concrete cards and a concrete expected result.
4. Implement the smallest change that meets the ticket. Do not refactor unrelated code or fix things the ticket
   doesn't ask for; if you spot something worth doing, mention it in your summary instead.
5. Run every quality gate below and fix what fails. They all must pass before you finish:
{{gates}}
6. Commit your work in focused commits. Start each message with "{{identifier}}: ".

If the ticket is ambiguous in a way that changes what you'd build (not a detail you can sensibly pick), or it
needs a product decision, stop and report `needs_input` with one specific question instead of guessing.
Record decisions you made on your own in your summary so they end up on the PR.
