Pull request {{prUrl}} for Linear ticket {{identifier}} ({{project}}) needs another pass. This is fix round
{{round}} of {{maxRounds}}.

# Ticket: {{title}}
{{description}}

{{comments}}

# What to fix
{{problem}}

# How to work
1. Read CLAUDE.md. Look at `git log origin/{{base}}..HEAD` to see what has been done so far.
2. Fix every listed problem. If you disagree with a review finding, don't silently skip it: either fix it, or
   explain in your summary exactly why it's wrong so the next review can weigh it.
3. Don't expand scope beyond the ticket and these findings.
4. Run every quality gate and make them pass:
{{gates}}
5. Commit with messages starting "{{identifier}}: fix: ".
