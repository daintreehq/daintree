import { describe, expect, it, vi, beforeEach } from "vitest";

const availabilityMock = vi.hoisted(() => ({
  isHelpTerminal: vi.fn<(id: string) => boolean>(() => false),
}));

vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => availabilityMock,
}));

import {
  classifyRun,
  computeProjectAgentCounts,
  type CountableTerminal,
} from "../projectAgentCounts.js";

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

describe("classifyRun", () => {
  const isHelp = (id: string) => id === "help";

  it("admits a live agent terminal", () => {
    expect(classifyRun(agent({ detectedAgentId: "claude" }), isHelp)).toBeNull();
  });

  it("checks trashed before help, so a trashed assistant is never tallied", () => {
    // Guard ORDER is the contract: if help were checked first, a trashed
    // assistant PTY would be netted out of a process count it no longer
    // contributes to, under-reporting every project it lives in.
    expect(classifyRun(agent({ id: "help", isTrashed: true }), isHelp)).toBe("trashed");
  });

  it("reports a live assistant as help so callers can net it back out", () => {
    expect(classifyRun(agent({ id: "help" }), isHelp)).toBe("help");
  });

  it("reports help before the no-pty and non-agent guards", () => {
    // A dead or unidentified assistant must still classify as help rather than
    // falling through — the tally decision belongs to the caller, not here.
    expect(classifyRun(agent({ id: "help", hasPty: false }), isHelp)).toBe("help");
    expect(
      classifyRun(
        agent({ id: "help", launchAgentId: undefined, detectedAgentId: undefined }),
        isHelp
      )
    ).toBe("help");
  });

  it("excludes dev previews, dead PTYs and plain shells with distinct reasons", () => {
    expect(classifyRun(agent({ kind: "dev-preview" }), isHelp)).toBe("dev-preview");
    expect(classifyRun(agent({ hasPty: false }), isHelp)).toBe("no-pty");
    expect(
      classifyRun(agent({ launchAgentId: undefined, detectedAgentId: undefined }), isHelp)
    ).toBe("not-an-agent");
  });

  it("keeps a boot-window launch intent but drops a demoted ex-agent", () => {
    expect(classifyRun(agent({ launchAgentId: "codex" }), isHelp)).toBeNull();
    expect(classifyRun(agent({ launchAgentId: "codex", everDetectedAgent: true }), isHelp)).toBe(
      "not-an-agent"
    );
  });
});

describe("computeProjectAgentCounts", () => {
  it("never tallies a trashed or dead assistant into helpTerminals", () => {
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id.startsWith("help"));
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "help-live" }),
        agent({ id: "help-trashed", isTrashed: true }),
        agent({ id: "help-dead", hasPty: false }),
      ]
    );

    expect(counts.get("p1")!.helpTerminals).toBe(1);
  });

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

  it("tallies completed agents with oldest/latest completion timestamps", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "completed", lastStateChange: 500 }),
        agent({ id: "b", agentState: "completed", lastStateChange: 900 }),
        agent({ id: "c", agentState: "working", lastStateChange: 950 }),
      ]
    );

    const p1 = counts.get("p1")!;
    expect(p1.completed).toBe(2);
    expect(p1.unacknowledgedCompleted).toBe(2);
    expect(p1.oldestUnacknowledgedCompletionAt).toBe(500);
    expect(p1.latestUnacknowledgedCompletionAt).toBe(900);
    expect(p1.latestCompletionAt).toBe(900);
  });

  it("splits completions across the acknowledgement watermark", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "completed", lastStateChange: 500 }),
        agent({ id: "b", agentState: "completed", lastStateChange: 900 }),
      ],
      new Map([["p1", 600]])
    );

    const p1 = counts.get("p1")!;
    expect(p1.completed).toBe(2);
    // Only the completion after the watermark is unacknowledged.
    expect(p1.unacknowledgedCompleted).toBe(1);
    expect(p1.oldestUnacknowledgedCompletionAt).toBe(900);
    expect(p1.latestUnacknowledgedCompletionAt).toBe(900);
    // The all-completions timestamp keeps the acknowledged one.
    expect(p1.latestCompletionAt).toBe(900);
  });

  it("a watermark at the exact completion time acknowledges it (seen-up-to is inclusive)", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "a", agentState: "completed", lastStateChange: 900 })],
      new Map([["p1", 900]])
    );

    const p1 = counts.get("p1")!;
    expect(p1.unacknowledgedCompleted).toBe(0);
    expect(p1.oldestUnacknowledgedCompletionAt).toBeNull();
  });

  it("never expires an unacknowledged completion by age", () => {
    // A completion from arbitrarily long ago stays unacknowledged until the
    // watermark passes it — elapsed time is not an acknowledgement.
    const ancient = 1; // epoch + 1ms
    const counts = computeProjectAgentCounts(
      ["p1"],
      [agent({ id: "a", agentState: "completed", lastStateChange: ancient })],
      new Map()
    );

    expect(counts.get("p1")!.unacknowledgedCompleted).toBe(1);
    expect(counts.get("p1")!.oldestUnacknowledgedCompletionAt).toBe(ancient);
  });

  it("counts a completion with no transition timestamp as completed but not unacknowledged", () => {
    const counts = computeProjectAgentCounts(["p1"], [agent({ id: "a", agentState: "completed" })]);

    const p1 = counts.get("p1")!;
    // Without a timestamp it can never clear a watermark, so surfacing it as
    // unacknowledged would create a permanent attention row.
    expect(p1.completed).toBe(1);
    expect(p1.unacknowledgedCompleted).toBe(0);
    expect(p1.latestCompletionAt).toBeNull();
  });

  it("records the latest working transition for Running-band ordering", () => {
    const counts = computeProjectAgentCounts(
      ["p1"],
      [
        agent({ id: "a", agentState: "working", lastStateChange: 100 }),
        agent({ id: "b", agentState: "working", lastStateChange: 700 }),
        agent({ id: "c", agentState: "waiting", lastStateChange: 999 }),
      ]
    );

    expect(counts.get("p1")!.latestWorkingSince).toBe(700);
  });
});
