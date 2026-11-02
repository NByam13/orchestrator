import { describe, expect, it } from "vitest";
import config from "../orchestrator.config.ts";
import {
    blockingFindings,
    compareTickets,
    decidePrAction,
    globToRegExp,
    markerComment,
    parseBuildReport,
    parseMarker,
    parseReviewReport,
    protectedFilesTouched,
    routeTicket,
    type Marker,
    type PrSnapshot,
    type Ticket,
} from "../src/rules.ts";
import { validateConfig } from "../src/config.ts";

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
    id: "1",
    identifier: "PON-1",
    title: "t",
    description: "",
    url: "",
    branchName: "nbyam13/pon-1-t",
    priority: 0,
    sortOrder: 0,
    state: "Ready for agent",
    labels: [],
    openBlockers: [],
    comments: [],
    ...over,
});

const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
    headSha: "abc",
    ci: "success",
    mergeable: true,
    markers: [],
    protectedTouched: [],
    holdLabel: false,
    mergeMode: "merge",
    maxFixRounds: 3,
    ticketState: "In Review",
    statuses: { inReview: "In Review", needsInput: "Needs input" },
    ...over,
});

const approved: Marker = { kind: "review", sha: "abc", verdict: "approve" };

describe("config", () => {
    it("is valid", () => expect(validateConfig(config)).toEqual([]));
});

describe("routing", () => {
    it("sends PonyRec-labelled tickets to kayou_structured", () => {
        expect(routeTicket(ticket({ labels: ["PonyRec repo", "Feature"] }), config)).toMatchObject({ project: { name: "kayou_structured" } });
    });
    it("defaults unlabelled tickets to card_sim", () => {
        expect(routeTicket(ticket({ labels: ["Bug"] }), config)).toMatchObject({ project: { name: "card_sim" } });
    });
    it("skips repos it doesn't manage", () => {
        expect(routeTicket(ticket({ labels: ["Artist Alley repo"] }), config)).toHaveProperty("skip");
    });
});

describe("ticket order", () => {
    it("urgent first, no-priority last, then board order", () => {
        const list = [ticket({ identifier: "none", priority: 0 }), ticket({ identifier: "low", priority: 4 }), ticket({ identifier: "urgent", priority: 1, sortOrder: 5 }), ticket({ identifier: "urgent2", priority: 1, sortOrder: 1 })];
        expect(list.sort(compareTickets).map((t) => t.identifier)).toEqual(["urgent2", "urgent", "low", "none"]);
    });
});

describe("globs", () => {
    it("** crosses folders, * doesn't", () => {
        expect(globToRegExp("database/migrations/**").test("database/migrations/2026_x.php")).toBe(true);
        expect(globToRegExp("config/*").test("config/a/b.php")).toBe(false);
        expect(globToRegExp("**/*.php").test("app/Models/Card.php")).toBe(true);
        expect(globToRegExp("**/*.php").test("Card.php")).toBe(true);
        expect(globToRegExp(".env*").test(".env.testing")).toBe(true);
    });
    it("finds protected files", () => {
        expect(protectedFilesTouched(["app/Models/Card.php", "composer.lock", "database/migrations/x.php"], config.projects[0]!.protectedPaths)).toEqual(["composer.lock", "database/migrations/x.php"]);
    });
});

describe("markers", () => {
    it("round-trip", () => {
        const m: Marker = { kind: "fix", sha: "deadbeef", round: 2 };
        expect(parseMarker(markerComment(m, "body"))).toEqual(m);
        expect(parseMarker("just a human comment")).toBeUndefined();
    });
});

describe("agent reports", () => {
    it("reads the last orchestrator block", () => {
        const text = 'blah\n```orchestrator\n{"status":"done","summary":"one"}\n```\nmore\n```orchestrator\n{"status":"needs_input","summary":"two","question":"q?"}\n```';
        expect(parseBuildReport(text)).toEqual({ status: "needs_input", summary: "two", question: "q?" });
    });
    it("treats a missing build report as done", () => {
        expect(parseBuildReport("I did it").status).toBe("done");
    });
    it("treats a malformed review as needs_input, never approve", () => {
        expect(parseReviewReport("LGTM!").verdict).toBe("needs_input");
    });
    it("ignores minor-only findings", () => {
        const r = parseReviewReport('```orchestrator\n{"verdict":"changes","summary":"s","findings":[{"severity":"minor","issue":"rename x"}]}\n```');
        expect(blockingFindings(r, ["blocker", "major"])).toHaveLength(0);
    });
});

describe("PR state machine", () => {
    it("waits while you're deciding", () => expect(decidePrAction(snap({ ticketState: "Needs input" })).do).toBe("wait"));
    it("waits for CI", () => expect(decidePrAction(snap({ ci: "pending" })).do).toBe("wait"));
    it("fixes red CI", () => expect(decidePrAction(snap({ ci: "failure" }))).toEqual({ do: "fix", reason: "ci" }));
    it("reviews a green, unreviewed head", () => expect(decidePrAction(snap()).do).toBe("review"));
    it("re-reviews after a new push", () => expect(decidePrAction(snap({ markers: [{ kind: "review", sha: "old", verdict: "approve" }] })).do).toBe("review"));
    it("fixes review findings", () => expect(decidePrAction(snap({ markers: [{ kind: "review", sha: "abc", verdict: "changes" }] }))).toEqual({ do: "fix", reason: "review" }));
    it("merges green + approved", () => expect(decidePrAction(snap({ markers: [approved] })).do).toBe("merge"));
    it("never merges on red CI even if approved", () => expect(decidePrAction(snap({ ci: "failure", markers: [approved] })).do).not.toBe("merge"));
    it("holds protected changes", () => expect(decidePrAction(snap({ markers: [approved], protectedTouched: ["composer.lock"] })).do).toBe("hold"));
    it("holds only once per head", () => expect(decidePrAction(snap({ markers: [approved, { kind: "hold", sha: "abc" }], holdLabel: true })).do).toBe("wait"));
    it("fixes conflicts first", () => expect(decidePrAction(snap({ mergeable: false, markers: [approved] }))).toEqual({ do: "fix", reason: "conflict" }));
    it("escalates at the round limit", () => {
        const fixes: Marker[] = [1, 2, 3].map((round) => ({ kind: "fix", sha: `s${round}`, round }));
        expect(decidePrAction(snap({ ci: "failure", markers: fixes })).do).toBe("escalate");
    });
    it("escalates reviewer questions", () => expect(decidePrAction(snap({ markers: [{ kind: "review", sha: "abc", verdict: "needs_input" }] })).do).toBe("escalate"));
    it("resumes after you move it back, then re-reviews with fresh rounds", () => {
        const fixes: Marker[] = [1, 2, 3].map((round) => ({ kind: "fix", sha: "abc", round }));
        const escalated: Marker[] = [...fixes, { kind: "review", sha: "abc", verdict: "changes" }, { kind: "escalate", sha: "abc" }];
        expect(decidePrAction(snap({ markers: escalated })).do).toBe("resume");
        expect(decidePrAction(snap({ markers: [...escalated, { kind: "resume", sha: "abc" }] })).do).toBe("review");
    });
});
