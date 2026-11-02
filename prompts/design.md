Design the UI for Linear ticket {{identifier}} in this repository ({{project}}). A human will review your
screenshots before the full build starts, so this step is about how it looks and feels.

# Ticket: {{title}}
{{url}}
{{context}}

{{description}}

{{comments}}

# How to work

1. Read CLAUDE.md and the frontend skills it lists. Study two or three existing pages/components close to this
   feature and match their look: spacing, type scale, colours, component patterns. New UI should feel native to the app.
2. Build the real UI in the codebase (components, page, routes, and placeholder or seeded data as needed). Keep the
   backend minimal: just enough to render realistic states. It is fine to stub data that the build step will wire up.
3. Run the app and capture screenshots with Playwright (`npx playwright` is available, or write a tiny script under
   .orchestrator/). Capture:
   - desktop at 1440×900 and mobile at 390×844,
   - every meaningful state: default, empty, loading, error, long content, and hover/selected if relevant.
   Save PNGs to `.orchestrator/design/proposed/` with descriptive names like `desktop-default.png`.
4. Look at your own screenshots (Read the PNG files). Fix anything misaligned, cramped, clipped or off-brand, then
   re-capture. Iterate until you'd be happy to show it.
5. Commit the code with messages starting "{{identifier}}: design: ". Stop any server you started.

Hints for this repo: {{designHints}}

In your summary, list each screenshot with one line on what it shows, and any design choices the reviewer
should weigh in on.
