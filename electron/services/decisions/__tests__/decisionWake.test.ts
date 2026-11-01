import { describe, expect, it, vi } from "vitest";
import type { TerminalTarget } from "@daintreehq/decisions-client";
import type { NotifyTerminalInfo } from "../../mcp-server/terminalNotify.js";
import {
  createDecisionWake,
  identityMismatch,
  type DecisionIdentitySources,
} from "../decisionWake.js";

const TARGET: TerminalTarget = {
  hostId: "host-own-01",
  paneId: "pane-1",
  terminalGeneration: 7,
  ownershipPrincipal: "principal-1",
  agentIncarnation: "0",
  agentSessionId: "session-1",
  worktreeId: "wt-1",
};

function sources(overrides: Partial<{ hostId: string | null; principal: string | null }> = {}) {
  const state = {
    hostId: "host-own-01" as string | null,
    principal: "principal-1" as string | null,
    liveGeneration: 7 as number | null,
    displaced: new Set<number>(),
    /** Generations the lifecycle ledger no longer counts live, whatever `getLiveGeneration` says. */
    notLive: new Set<number>(),
    client: true,
    ...overrides,
  };
  const value: DecisionIdentitySources = {
    hostId: () => state.hostId,
    principalFor: (paneId) => (paneId === TARGET.paneId ? state.principal : null),
    getPtyClient: () =>
      state.client
        ? {
            getLiveGeneration: () => state.liveGeneration,
            isLiveGeneration: (_id, generation) =>
              !state.notLive.has(generation) &&
              (generation === state.liveGeneration || state.displaced.has(generation)),
          }
        : null,
  };
  return { state, value };
}

/** The pane as the delivery attempt reads it: the asking run, settled at its prompt. */
function record(overrides: Partial<NotifyTerminalInfo> = {}): NotifyTerminalInfo {
  return {
    projectId: "project-1",
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: Date.now() - 60_000,
    detectedAgentId: "claude",
    hasPty: true,
    launchGeneration: 7,
    agentIncarnation: 0,
    agentSessionId: "session-1",
    worktreeId: "wt-1",
    ...overrides,
  };
}

describe("identityMismatch", () => {
  it("passes only the exact run that asked", () => {
    const { value } = sources();
    expect(identityMismatch(value, TARGET)).toBeNull();
    expect(identityMismatch(value, TARGET, record())).toBeNull();
  });

  it.each([
    ["an unset own host id", { hostId: null }, undefined, "host-offline"],
    ["another host's pane", { hostId: "host-other-02" }, undefined, "host-offline"],
    ["a new ownership principal", { principal: "principal-2" }, undefined, "relaunched"],
    ["no bearer at all", { principal: null }, undefined, "relaunched"],
    ["a new agent incarnation", {}, { agentIncarnation: 1 }, "relaunched"],
    ["an unobserved incarnation", {}, { agentIncarnation: undefined }, "relaunched"],
    ["another launch generation on the record", {}, { launchGeneration: 8 }, "generation-mismatch"],
    ["another agent session", {}, { agentSessionId: "session-2" }, "session-mismatch"],
    ["a session that is no longer known", {}, { agentSessionId: undefined }, "session-mismatch"],
    ["another worktree", {}, { worktreeId: "wt-2" }, "gone"],
    ["an exited terminal", {}, { isExited: true }, "gone"],
    ["a trashed pane", {}, { isTrashed: true }, "gone"],
  ] as const)("reports %s", (_label, source, info, expected) => {
    const { value } = sources(source);
    expect(identityMismatch(value, TARGET, info === undefined ? undefined : record(info))).toBe(
      expected
    );
  });

  it("calls a relaunch a relaunch, though it changed the generation too", () => {
    const { state, value } = sources({ principal: "principal-2" });
    state.liveGeneration = 8;
    expect(identityMismatch(value, TARGET, record({ launchGeneration: 8 }))).toBe("relaunched");
  });

  it("refuses the reported generation once the ledger stops counting it live", () => {
    const { state, value } = sources();
    state.notLive.add(7);
    expect(identityMismatch(value, TARGET)).toBe("generation-mismatch");
  });

  it("refuses a generation that is not the live one, displaced spawns included", () => {
    const { state, value } = sources();
    state.liveGeneration = 8;
    state.displaced.add(7);
    expect(identityMismatch(value, TARGET)).toBe("generation-mismatch");
    state.liveGeneration = null;
    expect(identityMismatch(value, TARGET)).toBe("generation-mismatch");
  });

  it("calls a pane with no pty client to ask unreadable", () => {
    const { state, value } = sources();
    state.client = false;
    expect(identityMismatch(value, TARGET)).toBe("unreadable");
  });
});

describe("createDecisionWake", () => {
  const section = { id: "dec-abc", text: "Daintree Decisions: …" };

  it("is a decision wake whose recheck follows the run and the exact prompt gate", () => {
    const { state, value } = sources();
    const report = vi.fn();
    const wake = createDecisionWake(value, TARGET, section, report);

    expect(wake).toMatchObject({
      id: "dec-abc",
      kind: "decision",
      decision: { text: section.text },
    });
    expect(wake.beforeType()).toBe(true);
    expect(wake.recheck()).toEqual({ kind: "ready" });
    expect(wake.recheck(record())).toEqual({ kind: "ready" });

    state.principal = "principal-2";
    expect(wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
    state.principal = "principal-1";
    expect(wake.recheck(record({ agentSessionId: "session-2" }))).toEqual({
      kind: "unavailable",
      reason: "session-mismatch",
    });
    state.client = false;
    expect(wake.recheck()).toEqual({ kind: "held", reason: "unreadable" });
    expect(report).not.toHaveBeenCalled();
  });

  it.each([
    // Claude queues mid-turn input; an answer still waits for its prompt.
    ["busy", { agentState: "working" }, "working"],
    ["at an approval", { waitingReason: "approval" }, "approval"],
    ["at a question", { waitingReason: "question" }, "question"],
    ["typed into since it settled", { lastTypedInputAt: Date.now() }, "typing"],
  ] as const)("holds while the pane is %s", (_label, patch, reason) => {
    const wake = createDecisionWake(sources().value, TARGET, section, vi.fn());
    expect(wake.recheck(record(patch))).toEqual({ kind: "held", reason });
  });
});
