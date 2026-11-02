// Pure decision logic. No network, no disk: everything here is unit tested.

import type { Config, ProjectConfig } from "./config.ts";

// ---------- tickets ----------

export interface Ticket {
    id: string;
    identifier: string;
    title: string;
    description: string;
    url: string;
    branchName: string;
    priority: number;
    sortOrder: number;
    state: string;
    labels: string[];
    project?: string;
    milestone?: string;
    /** Tickets that block this one and aren't finished. */
    openBlockers: string[];
    comments: TicketComment[];
}

export interface TicketComment {
    body: string;
    createdAt: string;
    author: string;
}

export type Route = { project: ProjectConfig } | { skip: string };

export function routeTicket(ticket: Ticket, config: Config): Route {
    const unmanaged = ticket.labels.find((l) => config.linear.unmanagedLabels.includes(l));
    if (unmanaged) return { skip: `labelled "${unmanaged}", which no configured repo handles` };
    const byLabel = config.projects.filter((p) => p.labels?.some((l) => ticket.labels.includes(l)));
    if (byLabel.length > 1) {
        return { skip: `labels match more than one repo (${byLabel.map((p) => p.name).join(", ")}); a cross-repo change needs one ticket per repo` };
    }
    if (byLabel[0]) return { project: byLabel[0] };
    const fallback = config.projects.find((p) => p.default);
    return fallback ? { project: fallback } : { skip: "no repo label and no default repo" };
}

/** Linear priority: 1 urgent … 4 low, 0 none. None sorts last. Ties keep your manual board order. */
export function compareTickets(a: Ticket, b: Ticket): number {
    const pa = a.priority === 0 ? 5 : a.priority;
    const pb = b.priority === 0 ? 5 : b.priority;
    return pa - pb || a.sortOrder - b.sortOrder;
}

// ---------- globs ----------

export function globToRegExp(glob: string): RegExp {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === "*") {
            if (glob[i + 1] === "*") {
                i++;
                if (glob[i + 1] === "/") {
                    i++;
                    re += "(?:.*/)?";
                } else {
                    re += ".*";
                }
            } else {
                re += "[^/]*";
            }
        } else if (c === "?") {
            re += "[^/]";
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp(`^${re}$`);
}

export function protectedFilesTouched(files: string[], globs: string[]): string[] {
    const res = globs.map(globToRegExp);
    return files.filter((f) => res.some((r) => r.test(f)));
}

// ---------- agent output contract ----------

export interface BuildReport {
    status: "done" | "needs_input";
    summary: string;
    question?: string;
}

export interface Finding {
    severity: "blocker" | "major" | "minor";
    file?: string;
    line?: number;
    issue: string;
    fix?: string;
}

export interface ReviewReport {
    verdict: "approve" | "changes" | "needs_input";
    summary: string;
    findings: Finding[];
    question?: string;
}

/** Pulls the last ```orchestrator { … } ``` block out of an agent's final message. */
export function extractReport(text: string): unknown {
    const blocks = [...text.matchAll(/```orchestrator\s*\n([\s\S]*?)```/g)];
    const last = blocks.at(-1)?.[1];
    if (!last) return undefined;
    try {
        return JSON.parse(last);
    } catch {
        return undefined;
    }
}

export function parseBuildReport(text: string): BuildReport {
    const raw = extractReport(text) as Partial<BuildReport> | undefined;
    if (!raw || (raw.status !== "done" && raw.status !== "needs_input")) {
        // No report: assume done and let the gates and the reviewer judge the work.
        return { status: "done", summary: text.trim().slice(-1500) };
    }
    return { status: raw.status, summary: String(raw.summary ?? ""), question: raw.question ? String(raw.question) : undefined };
}

const SEVERITIES = new Set(["blocker", "major", "minor"]);

export function parseReviewReport(text: string): ReviewReport {
    const raw = extractReport(text) as Partial<ReviewReport> | undefined;
    if (!raw || !["approve", "changes", "needs_input"].includes(String(raw.verdict))) {
        return {
            verdict: "needs_input",
            summary: "The reviewer finished without a readable verdict.",
            findings: [],
            question: "Review output was malformed. Look at the PR yourself, or move the ticket back to In Review to re-run the review.",
        };
    }
    const findings = Array.isArray(raw.findings)
        ? raw.findings
              .filter((f): f is Finding => !!f && typeof f.issue === "string")
              .map((f) => ({ ...f, severity: SEVERITIES.has(f.severity) ? f.severity : "major" }))
        : [];
    return {
        verdict: raw.verdict as ReviewReport["verdict"],
        summary: String(raw.summary ?? ""),
        findings,
        question: raw.question ? String(raw.question) : undefined,
    };
}

/** Only blocking findings send the PR back. A "changes" verdict made of nits counts as an approval. */
export function blockingFindings(report: ReviewReport, blocking: Config["loop"]["blockingSeverities"]): Finding[] {
    return report.findings.filter((f) => blocking.includes(f.severity));
}

// ---------- PR comment markers (the PR's memory) ----------

export type Marker =
    | { kind: "review"; sha: string; verdict: "approve" | "changes" | "needs_input" }
    | { kind: "fix"; sha: string; round: number }
    | { kind: "hold"; sha: string }
    | { kind: "escalate"; sha: string }
    | { kind: "resume"; sha: string };

export function markerComment(m: Marker, body: string): string {
    const attrs = Object.entries(m)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    return `<!-- orchestrator ${attrs} -->\n${body}`;
}

export function parseMarker(body: string): Marker | undefined {
    const m = body.match(/<!-- orchestrator ([^>]*?) -->/);
    if (!m) return undefined;
    const attrs = Object.fromEntries(m[1]!.split(/\s+/).map((pair) => pair.split("=") as [string, string]));
    switch (attrs.kind) {
        case "review":
            return { kind: "review", sha: attrs.sha ?? "", verdict: attrs.verdict as "approve" | "changes" | "needs_input" };
        case "fix":
            return { kind: "fix", sha: attrs.sha ?? "", round: Number(attrs.round ?? 0) };
        case "hold":
        case "escalate":
        case "resume":
            return { kind: attrs.kind, sha: attrs.sha ?? "" };
        default:
            return undefined;
    }
}

/** Fix rounds since the last time you resumed the PR. */
export function fixRoundsSinceResume(markers: Marker[]): number {
    let rounds = 0;
    for (const m of markers) {
        if (m.kind === "resume") rounds = 0;
        if (m.kind === "fix") rounds++;
    }
    return rounds;
}

// ---------- the PR state machine ----------

export type CiState = "pending" | "success" | "failure";

export interface PrSnapshot {
    headSha: string;
    ci: CiState;
    /** GitHub's answer: false = conflicts with base. null = still computing. */
    mergeable: boolean | null;
    markers: Marker[];
    protectedTouched: string[];
    holdLabel: boolean;
    mergeMode: "merge" | "hold";
    maxFixRounds: number;
    ticketState: string;
    statuses: { inReview: string; needsInput: string };
}

export type PrAction =
    | { do: "wait"; why: string }
    | { do: "review" }
    | { do: "fix"; reason: "ci" | "review" | "conflict" }
    | { do: "merge" }
    | { do: "hold"; why: string }
    | { do: "escalate"; why: string }
    | { do: "resume" };

export function decidePrAction(s: PrSnapshot): PrAction {
    const last = s.markers.at(-1);

    if (s.ticketState === s.statuses.needsInput) return { do: "wait", why: "waiting on you (Needs input)" };
    if (s.ticketState !== s.statuses.inReview) return { do: "wait", why: `ticket is "${s.ticketState}", not "${s.statuses.inReview}"` };

    // You moved it back to In Review after an escalation: reset the round counter and carry on.
    if (last?.kind === "escalate") return { do: "resume" };

    const atLimit = fixRoundsSinceResume(s.markers) >= s.maxFixRounds;

    if (s.mergeable === false) {
        return atLimit ? { do: "escalate", why: "Merge conflicts with the base branch, and the fix-round limit is used up." } : { do: "fix", reason: "conflict" };
    }
    if (s.ci === "pending") return { do: "wait", why: "CI running" };
    if (s.ci === "failure") {
        return atLimit ? { do: "escalate", why: `CI is still failing after ${s.maxFixRounds} fix rounds.` } : { do: "fix", reason: "ci" };
    }

    // Only look at reviews since your last resume, so your answer gets a fresh review.
    const resumeAt = s.markers.findLastIndex((m) => m.kind === "resume");
    const recent = s.markers.slice(resumeAt + 1);
    const review = [...recent].reverse().find((m) => m.kind === "review" && m.sha === s.headSha) as Extract<Marker, { kind: "review" }> | undefined;
    if (!review) return { do: "review" };

    if (review.verdict === "needs_input") return { do: "escalate", why: "The reviewer raised a question it can't settle alone." };
    if (review.verdict === "changes") {
        return atLimit ? { do: "escalate", why: `Review still has blocking findings after ${s.maxFixRounds} fix rounds.` } : { do: "fix", reason: "review" };
    }

    // Approved and green.
    const holdReasons: string[] = [];
    if (s.mergeMode === "hold") holdReasons.push("this repo is set to hold for a human merge");
    if (s.holdLabel) holdReasons.push("the ticket has the hold label");
    if (s.protectedTouched.length) holdReasons.push(`it touches protected files: ${s.protectedTouched.slice(0, 8).join(", ")}`);
    if (holdReasons.length) {
        if (recent.some((m) => m.kind === "hold" && m.sha === s.headSha)) return { do: "wait", why: "held for your merge" };
        return { do: "hold", why: holdReasons.join("; ") };
    }
    if (s.mergeable === null) return { do: "wait", why: "GitHub is still computing mergeability" };
    return { do: "merge" };
}
