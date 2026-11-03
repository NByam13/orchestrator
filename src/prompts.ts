import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BOT_PREFIX } from "./linear.ts";
import type { Ticket } from "./rules.ts";

const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

export type PromptName = "implement" | "design" | "review" | "fix" | "qa";

export async function render(name: PromptName, vars: Record<string, string | number | undefined>): Promise<string> {
    const template = await readFile(`${PROMPTS_DIR}${name}.md`, "utf8");
    const body = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? "")).replace(/\n{3,}/g, "\n\n");
    // The QA prompt carries its own output contract.
    if (name === "qa") return body.trim();
    return `${body.trim()}\n\n${name === "review" ? REVIEW_CONTRACT : BUILD_CONTRACT}`;
}

const BUILD_CONTRACT = `
# Finishing
End your final message with exactly one fenced block tagged \`orchestrator\` containing JSON:

\`\`\`orchestrator
{"status": "done", "summary": "What you changed and why, decisions you made, anything the reviewer should look at."}
\`\`\`

or, if you could not finish without a human decision:

\`\`\`orchestrator
{"status": "needs_input", "summary": "What you did so far.", "question": "The one specific question you need answered."}
\`\`\`
`.trim();

const REVIEW_CONTRACT = `
# Finishing
End your final message with exactly one fenced block tagged \`orchestrator\` containing JSON:

\`\`\`orchestrator
{"verdict": "approve" | "changes" | "needs_input",
 "summary": "Two or three sentences on the change and its quality.",
 "findings": [{"severity": "blocker" | "major" | "minor", "file": "path", "line": 42, "issue": "what is wrong", "fix": "what to do"}],
 "question": "only for needs_input"}
\`\`\`
`.trim();

/** Ticket context the prompts share. */
export function ticketVars(t: Ticket): Record<string, string> {
    const context = [t.project && `Project: ${t.project}`, t.milestone && `Milestone: ${t.milestone}`].filter(Boolean).join(" · ");
    // Your comments carry answers and decisions. The orchestrator's own status chatter is left out.
    const human = t.comments.filter((c) => !c.body.startsWith(BOT_PREFIX));
    const comments = human.length
        ? `# Comments on the ticket (oldest first; later ones override earlier ones)\n${human.map((c) => `**${c.author}** (${c.createdAt.slice(0, 10)}):\n${c.body}`).join("\n\n")}`
        : "";
    return {
        identifier: t.identifier,
        title: t.title,
        url: t.url,
        context,
        description: t.description || "(no description)",
        comments,
    };
}

export function gateList(gates: string[]): string {
    return gates.map((g) => `   - \`${g}\``).join("\n");
}
