import { describe, expect, it, vi, beforeEach } from "vitest";

const availabilityMock = vi.hoisted(() => ({
  isHelpTerminal: vi.fn<(id: string) => boolean>(() => false),
}));

vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => availabilityMock,
}));

import { computeProjectAgentCounts, type CountableTerminal } from "../projectAgentCounts.js";

const agent = (over: Partial<CountableTerminal> = {}): CountableTerminal => ({
  id: "t1",
  projectId: "p1",
  kind: "terminal",
  launchAgentId: "claude",
  ...over,
});

beforeEach(() => {
  availabilityMock.isHelpTerminal.mockReset();
  availabilityMock.isHelpTerminal.mockReturnValue(false);
});

describe("computeProjectAgentCounts", () => {
  it("counts waiting and working agents per project", () => {
    const counts = computeProjectAgentCounts(
      ["p1", "p2"],
      [
        agent({ id: "a", agentState: "waiting" }),
        agent({ id: "b", agentState: "working" }),
        agent({ id: "c", projectId: "p2", agentState: "working" }),
      ]
    );

    expect(counts.get("p1")).toMatchObject({ waiting: 1, active: 1 });
    expect(counts.get("p2")).toMatchObject({ waiting: 0, active: 1 });
  });

  it("treats an error wait as a subset of waiting, never an addition", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "waiting", waitingReason: "error" }),
        agent({ id: "b", agentState: "waiting", waitingReason: "prompt" }),
      ]
    );

    const p1 = counts.get("p1")!;
    expect(p1.waiting).toBe(2);
    expect(p1.blocked).toBe(1);
    expect(p1.blocked).toBeLessThanOrEqual(p1.waiting);
  });

  it("takes the earliest wait as the age, ignoring non-waiting agents", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "waiting", lastStateChange: 900 }),
        agent({ id: "b", agentState: "waiting", lastStateChange: 400 }),
        agent({ id: "c", agentState: "working", lastStateChange: 10 }),
      ]
    );

    expect(counts.get("p1")!.oldestWaitingSince).toBe(400);
  });

  it("leaves the age absent when no wait recorded a transition", () => {
    const counts = computeProjectAgentCounts(["p1"], [agent({ agentState: "waiting" })]);

    // Absent rather than 0 — a wait with no known start must not read as epoch.
    expect(counts.get("p1")!.oldestWaitingSince).toBeNull();
  });

  it("keeps the assistant terminal out of agent counts and tallies it separately", () => {
    availabilityMock.isHelpTerminal.mockImplementation((id) => id === "help");

    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "help", agentState: "waiting" }), agent({ id: "real", agentState: "working" })]
    );

    const p1 = counts.get("p1")!;
    // #10989: the assistant is tooling-internal — it must never surface as an
    // agent, and callers subtract `helpTerminals` from the host's raw count.
    expect(p1.waiting).toBe(0);
    expect(p1.active).toBe(1);
    expect(p1.helpTerminals).toBe(1);
  });

  it("excludes trashed, dev-preview, PTY-less, and non-agent terminals", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "working", isTrashed: true }),
        agent({ id: "b", agentState: "working", kind: "dev-preview" }),
        agent({ id: "c", agentState: "working", hasPty: false }),
        agent({ id: "d", agentState: "working", launchAgentId: undefined }),
        agent({ id: "e", agentState: "working" }),
      ]
    );

    expect(counts.get("p1")!.active).toBe(1);
  });

  it("prefers runtime identity over launch intent for a demoted agent", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        // Launched as an agent but detection has since committed otherwise.
        agent({ id: "a", agentState: "working", everDetectedAgent: true }),
        agent({ id: "b", agentState: "working", detectedAgentId: "claude" }),
      ]
    );

    expect(counts.get("p1")!.active).toBe(1);
  });

  it("ignores terminals belonging to projects that were not asked about", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ projectId: "other", agentState: "working" })]
    );

    expect(counts.get("p1")!.active).toBe(0);
    expect(counts.has("other")).toBe(false);
  });
});
