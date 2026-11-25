import { describe, expect, it } from "vitest";
import type { DaintreeEventMap } from "../../../services/events.js";
import { agentWaitingOf, type WaitingTerminalFacts } from "../agentWaiting.js";
import { AgentWaitingPayloadSchema } from "../linkMethods.js";

type StateChange = DaintreeEventMap["agent:state-changed"];

const change = (overrides: Partial<StateChange> = {}): StateChange => ({
  terminalId: "t1",
  state: "waiting",
  previousState: "working",
  trigger: "heuristic",
  confidence: 0.9,
  timestamp: 1_000,
  ...overrides,
});

const facts: WaitingTerminalFacts = {
  getTerminalProjectId: (id) => (id === "t1" ? "p1" : null),
  getTerminalLaunchAttribution: (id) => (id === "t1" ? { worktreeId: "/work/launched" } : null),
  getLiveGeneration: (id) => (id === "t1" ? 4 : null),
};

describe("agentWaitingOf (#16188)", () => {
  it("reads an agent starting to wait as observations, with both run generations", () => {
    expect(
      agentWaitingOf(change({ waitingReason: "approval", agentIncarnation: 2 }), facts)
    ).toEqual({
      terminalId: "t1",
      projectId: "p1",
      worktreeId: "/work/launched",
      incarnation: 4,
      agentIncarnation: 2,
      waitingReason: "approval",
      refined: false,
      seenAt: 1_000,
    });
  });

  it("marks a reason changed while it already waited, and prefers the event's own worktree", () => {
    expect(
      agentWaitingOf(
        change({ previousState: "waiting", waitingReason: "question", worktreeId: "/work/event" }),
        facts
      )
    ).toMatchObject({ refined: true, waitingReason: "question", worktreeId: "/work/event" });
  });

  it("carries an approval wait's kind, and a kind dropped while it waited (#18170)", () => {
    expect(
      agentWaitingOf(change({ waitingReason: "approval", approvalKind: "trust" }), facts)
    ).toMatchObject({ waitingReason: "approval", approvalKind: "trust", refined: false });
    const dropped = agentWaitingOf(
      change({ previousState: "waiting", waitingReason: "approval" }),
      facts
    );
    expect(dropped).toMatchObject({ refined: true, waitingReason: "approval" });
    expect(dropped).not.toHaveProperty("approvalKind");
    expect(
      agentWaitingOf(change({ waitingReason: "prompt", approvalKind: "trust" }), facts)
    ).not.toHaveProperty("approvalKind");
  });

  it("says nothing of other transitions, and keeps what it can't read unknown", () => {
    expect(
      agentWaitingOf(change({ state: "working", previousState: "waiting" }), facts)
    ).toBeNull();
    expect(agentWaitingOf(change({ terminalId: undefined }), facts)).toBeNull();
    expect(agentWaitingOf(change({ terminalId: "gone" }), null)).toEqual({
      terminalId: "gone",
      projectId: null,
      worktreeId: null,
      incarnation: null,
      agentIncarnation: null,
      waitingReason: null,
      refined: false,
      seenAt: 1_000,
    });
  });
});

describe("an agent's wait on the wire (#18170)", () => {
  const payload = (extra: Record<string, unknown>) => ({
    terminalId: "t1",
    projectId: "p1",
    worktreeId: null,
    incarnation: 4,
    agentIncarnation: 2,
    waitingReason: "approval",
    refined: false,
    seenAt: 1_000,
    ...extra,
  });

  it("carries a trust prompt, and reads a kind a later host adds as absent", () => {
    expect(AgentWaitingPayloadSchema.parse(payload({ approvalKind: "trust" }))).toMatchObject({
      approvalKind: "trust",
    });
    expect(
      AgentWaitingPayloadSchema.parse(payload({ approvalKind: "tool" })).approvalKind
    ).toBeUndefined();
    expect(AgentWaitingPayloadSchema.parse(payload({}))).not.toHaveProperty("approvalKind");
  });
});
