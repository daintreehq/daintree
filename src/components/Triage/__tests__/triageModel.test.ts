import { describe, expect, it } from "vitest";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { TriageCard } from "@shared/types/ipc/triage";
import { buildPilotGroups, type PilotRowContext } from "@/components/Pilot/pilotRows";
import { buildTriageSections, observedKind } from "../triageModel";

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

function sections(runs: FleetRunRow[], cards: TriageCard[] = []) {
  return buildTriageSections(buildPilotGroups(runs, ctx), new Map(cards.map((c) => [c.runId, c])));
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

describe("buildTriageSections", () => {
  it("leads with blocking runs, worst kind first, then the longest-waiting", () => {
    const result = sections([
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
    expect(result.map((s) => s.id)).toEqual(["needs-you", "working", "quiet"]);
    expect(result[0]!.items.map((i) => i.runId)).toEqual([
      "approval-old",
      "approval-new",
      "finished",
    ]);
    expect(result[1]!.items.map((i) => i.runId)).toEqual(["working"]);
    expect(result[2]!.items.map((i) => i.runId)).toEqual(["idle"]);
  });

  it("files a run by the classifier's reading once it has one", () => {
    const result = sections(
      [run("a", { agentState: "working", since: NOW - 5_000 })],
      [card("a", { category: "approval", observedAt: NOW })]
    );
    expect(result[0]!.id).toBe("needs-you");
    expect(result[0]!.items[0]!.kind).toBe("approval");
  });

  it("drops a card read before the run's latest state change when the kinds disagree", () => {
    const result = sections(
      [run("a", { agentState: "working", since: NOW })],
      [card("a", { category: "approval", observedAt: NOW - 60_000 })]
    );
    const item = result[0]!.items[0]!;
    expect(item.kind).toBe("working");
    expect(item.card).toBeNull();
    expect(item.pending).toBe(true);
  });

  it("keeps an older card's words while it still agrees with the observed state", () => {
    const result = sections(
      [run("a", { agentState: "working", since: NOW })],
      [card("a", { category: "working", observedAt: NOW - 60_000, activity: "Update(src/app.ts)" })]
    );
    expect(result[0]!.items[0]!.card?.activity).toBe("Update(src/app.ts)");
  });

  it("never carries an older card's prompt into a newer approval", () => {
    const result = sections(
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
    const item = result[0]!.items[0]!;
    expect(item.card?.headline).toBe("Run the tests?");
    expect(item.card?.question).toBeNull();
    expect(item.card?.options).toEqual([]);
    expect(item.pending).toBe(true);
  });

  it("marks a run pending while its describer pass is in flight", () => {
    const result = sections(
      [run("a", { agentState: "waiting", waitingReason: "question" })],
      [card("a", { category: "question", describing: true, stage: "classified" })]
    );
    expect(result[0]!.items[0]!.pending).toBe(true);
  });

  it("drops a card read from an earlier incarnation of the terminal", () => {
    const result = sections(
      [run("a", { agentState: "waiting", waitingReason: "approval", spawnedAt: NOW })],
      [card("a", { category: "approval", spawnedAt: NOW - 3_600_000, options: ["Yes"] })]
    );
    expect(result[0]!.items[0]!.card).toBeNull();
  });

  it("marks a card stale once the run's state moved after it was read", () => {
    const result = sections(
      [run("a", { agentState: "waiting", waitingReason: "question", since: NOW })],
      [card("a", { category: "question", observedAt: NOW - 60_000, question: "Keep it?" })]
    );
    expect(result[0]!.items[0]!.stale).toBe(true);
  });
});
