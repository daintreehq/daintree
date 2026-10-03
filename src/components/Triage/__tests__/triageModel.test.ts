import { describe, expect, it } from "vitest";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { TriageCard } from "@shared/types/ipc/triage";
import { buildPilotGroups, type PilotRowContext } from "@/components/Pilot/pilotRows";
import {
  buildTriageInbox,
  itemNeedsAttention,
  observedKind,
  type TriageReadState,
} from "../triageModel";

const NOW = 1_700_000_000_000;

function run(runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId,
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/Users/dev/app",
    agentId: "claude",
    ...overrides,
  };
}

const ctx: PilotRowContext = {
  workspaces: new Map([["p1", { kind: "project", name: "app", emoji: "🌳" }]]),
  currentWorkspaceId: null,
  nowMs: NOW,
};

function card(runId: string, overrides: Partial<TriageCard> = {}): TriageCard {
  return {
    runId,
    spawnedAt: NOW - 3_600_000,
    revision: 1,
    category: "working",
    confidence: 0.9,
    attentionProbability: 0.9,
    attentionScore: null,
    priority: 90,
    stage: "described",
    describing: false,
    headline: null,
    summary: null,
    question: null,
    options: [],
    secretPrompt: false,
    activity: null,
    observedAt: NOW,
    ...overrides,
  };
}

function inbox(runs: FleetRunRow[], cards: TriageCard[] = [], read?: TriageReadState) {
  return buildTriageInbox(
    buildPilotGroups(runs, ctx),
    new Map(cards.map((c) => [c.runId, c])),
    read
  );
}

describe("observedKind", () => {
  it("reads Daintree's waiting reason before any screen has been classified", () => {
    expect(observedKind(run("a", { agentState: "waiting", waitingReason: "approval" }))).toBe(
      "approval"
    );
    expect(observedKind(run("a", { agentState: "waiting", waitingReason: "error" }))).toBe("error");
    expect(observedKind(run("a", { agentState: "waiting", waitingReason: "prompt" }))).toBe(
      "question"
    );
    expect(observedKind(run("a", { agentState: "completed" }))).toBe("finished");
    expect(observedKind(run("a", { agentState: "directing" }))).toBe("working");
    expect(observedKind(run("a", { agentState: "exited" }))).toBe("idle");
  });
});

describe("buildTriageInbox", () => {
  it("is one list, most blocked first, then the longest-waiting, before anything is read", () => {
    const result = inbox([
      run("finished", { agentState: "completed", since: NOW - 900_000 }),
      run("approval-new", {
        agentState: "waiting",
        waitingReason: "approval",
        since: NOW - 10_000,
      }),
      run("working", { agentState: "working", since: NOW - 60_000 }),
      run("approval-old", {
        agentState: "waiting",
        waitingReason: "approval",
        since: NOW - 600_000,
      }),
      run("idle", { agentState: "idle" }),
    ]);
    expect(result.map((i) => i.runId)).toEqual([
      "approval-old",
      "approval-new",
      "finished",
      "idle",
      "working",
    ]);
  });

  it("files a run by the classifier's reading once it has one", () => {
    const [item] = inbox(
      [run("a", { agentState: "working", since: NOW - 5_000 })],
      [card("a", { category: "approval", observedAt: NOW })]
    );
    expect(item!.kind).toBe("approval");
    expect(itemNeedsAttention(item!)).toBe(true);
  });

  it("drops a card read before the run's latest state change when the kinds disagree", () => {
    const result = inbox(
      [run("a", { agentState: "working", since: NOW })],
      [card("a", { category: "approval", observedAt: NOW - 60_000 })]
    );
    const item = result[0]!;
    expect(item.kind).toBe("working");
    expect(item.card).toBeNull();
    expect(item.pending).toBe(true);
  });

  it("keeps an older card's words while it still agrees with the observed state", () => {
    const result = inbox(
      [run("a", { agentState: "working", since: NOW })],
      [card("a", { category: "working", observedAt: NOW - 60_000, activity: "Update(src/app.ts)" })]
    );
    expect(result[0]!.card?.activity).toBe("Update(src/app.ts)");
  });

  it("never carries an older card's prompt into a newer approval", () => {
    const result = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval", since: NOW })],
      [
        card("a", {
          category: "approval",
          observedAt: NOW - 60_000,
          headline: "Run the tests?",
          question: "Run npm test?",
          options: ["Yes", "No"],
        }),
      ]
    );
    const item = result[0]!;
    expect(item.card?.headline).toBe("Run the tests?");
    expect(item.card?.question).toBeNull();
    expect(item.card?.options).toEqual([]);
    expect(item.pending).toBe(true);
  });

  it("marks a run pending while its describer pass is in flight", () => {
    const result = inbox(
      [run("a", { agentState: "waiting", waitingReason: "question" })],
      [card("a", { category: "question", describing: true, stage: "classified" })]
    );
    expect(result[0]!.pending).toBe(true);
  });

  it("drops a card read from an earlier incarnation of the terminal", () => {
    const result = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval", spawnedAt: NOW })],
      [card("a", { category: "approval", spawnedAt: NOW - 3_600_000, options: ["Yes"] })]
    );
    expect(result[0]!.card).toBeNull();
  });

  it("marks a card stale once the run's state moved after it was read", () => {
    const result = inbox(
      [run("a", { agentState: "waiting", waitingReason: "question", since: NOW })],
      [card("a", { category: "question", observedAt: NOW - 60_000, question: "Keep it?" })]
    );
    expect(result[0]!.stale).toBe(true);
  });

  it("promises words only while something is on its way to write them", () => {
    const waiting = [run("a", { agentState: "waiting", waitingReason: "question", since: NOW })];
    const staleCard = [card("a", { category: "question", observedAt: NOW - 60_000 })];
    const pending = (cards: TriageCard[], read: TriageReadState) =>
      inbox(waiting, cards, read)[0]!.pending;

    // A first read, or a re-read of a card the run has moved past, is coming.
    expect(pending([], { configured: true, failed: false })).toBe(true);
    expect(pending(staleCard, { configured: true, failed: false })).toBe(true);
    // Without keys nothing reads; after a failed read nothing is reading now.
    for (const cards of [[], staleCard]) {
      expect(pending(cards, { configured: false, failed: false })).toBe(false);
      expect(pending(cards, { configured: true, failed: true })).toBe(false);
    }
  });
});

describe("buildTriageInbox ordering", () => {
  it("orders by the models' combined priority, not by age or state", () => {
    const runs = [
      run("old", { agentState: "waiting", since: NOW - 600_000 }),
      run("urgent", { agentState: "working", since: NOW - 60_000 }),
      run("unread", { agentState: "waiting", waitingReason: "approval", since: NOW - 900_000 }),
    ];
    const result = inbox(runs, [
      card("old", { category: "finished", priority: 30 }),
      // A working agent the readers think is stuck rises above a finished one.
      card("urgent", { category: "working", priority: 85 }),
    ]);
    // Unread runs rank by what Daintree observed: a waiting approval is 70.
    expect(result.map((item) => item.runId)).toEqual(["urgent", "unread", "old"]);
  });

  it("counts a read run as needing someone only past the classifier's threshold", () => {
    const [doubted] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval" })],
      [card("a", { category: "approval", attentionProbability: 0.3 })]
    );
    expect(itemNeedsAttention(doubted!)).toBe(false);
    const [unread] = inbox([run("b", { agentState: "waiting", waitingReason: "approval" })]);
    expect(itemNeedsAttention(unread!)).toBe(true);
  });
});
