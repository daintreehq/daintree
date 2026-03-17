import { afterEach, describe, expect, it } from "vitest";
import { AgentStateService } from "../AgentStateService.js";
import { events } from "../../events.js";
import type { TerminalInfo } from "../types.js";

function createTerminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "term-1",
    cwd: "/repo",
    shell: "/bin/zsh",
    spawnedAt: Date.now(),
    analysisEnabled: false,
    lastInputTime: 0,
    lastOutputTime: 0,
    lastCheckTime: 0,
    restartCount: 0,
    agentId: "claude",
    agentState: "idle",
    ptyProcess: {} as never,
    inputWriteQueue: [],
    inputWriteTimeout: null,
    outputBuffer: "",
    semanticBuffer: [],
    ...overrides,
  } as TerminalInfo;
}

describe("AgentStateService", () => {
  afterEach(() => {
    events.removeAllListeners();
  });

  it("clamps confidence into valid schema range before emitting state-changed", () => {
    const service = new AgentStateService();
    const terminal = createTerminal();
    const stateChanges: Array<{ confidence: number }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ confidence: payload.confidence });
    });

    const changed = service.transitionState(
      terminal,
      { type: "busy" },
      "heuristic",
      2.5,
      terminal.spawnedAt
    );

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("working");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.confidence).toBe(1);
  });

  it("rejects stale transitions with mismatched spawnedAt token", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ spawnedAt: 1000 });
    const stateChanges: unknown[] = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push(payload);
    });

    const changed = service.transitionState(terminal, { type: "busy" }, "output", 1.0, 999);

    expect(changed).toBe(false);
    expect(stateChanges).toHaveLength(0);
    expect(terminal.agentState).toBe("idle");
  });

  it("recovers from failed to working on user input and clears error", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "auth failure" });
    const stateChanges: Array<{ state: string; previousState: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ state: payload.state, previousState: payload.previousState });
    });

    const changed = service.updateAgentState(terminal, { type: "input" });

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("working");
    expect(terminal.error).toBeUndefined();
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.previousState).toBe("failed");
    expect(stateChanges[0]?.state).toBe("working");
  });

  it("does not recover from failed on heuristic busy event", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "network timeout" });

    const changed = service.updateAgentState(terminal, { type: "busy" });

    expect(changed).toBe(false);
    expect(terminal.agentState).toBe("failed");
    expect(terminal.error).toBe("network timeout");
  });

  it("does not recover from failed on prompt or completion events", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "api error" });

    expect(service.updateAgentState(terminal, { type: "prompt" })).toBe(false);
    expect(terminal.agentState).toBe("failed");

    expect(service.updateAgentState(terminal, { type: "completion" })).toBe(false);
    expect(terminal.agentState).toBe("failed");
  });

  it("updates error message on failed → failed without emitting state-changed", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "old error" });
    const stateChanges: unknown[] = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push(payload);
    });

    const changed = service.updateAgentState(terminal, { type: "error", error: "new error" });

    expect(changed).toBe(false);
    expect(terminal.agentState).toBe("failed");
    expect(terminal.error).toBe("new error");
    expect(stateChanges).toHaveLength(0);
  });

  it("handleActivityState with trigger input recovers from failed with input trigger", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "some error" });
    const stateChanges: Array<{ trigger: string; state: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ trigger: payload.trigger, state: payload.state });
    });

    service.handleActivityState(terminal, "busy", { trigger: "input" });

    expect(terminal.agentState).toBe("working");
    expect(terminal.error).toBeUndefined();
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.trigger).toBe("input");
    expect(stateChanges[0]?.state).toBe("working");
  });

  it("handleActivityState with trigger output does not recover from failed", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "some error" });

    service.handleActivityState(terminal, "busy", { trigger: "output" });

    expect(terminal.agentState).toBe("failed");
    expect(terminal.error).toBe("some error");
  });

  it("emits completed event with non-negative duration", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ spawnedAt: Date.now() + 10_000, agentState: "working" });
    const completedPayloads: Array<{ duration: number; exitCode: number }> = [];

    events.on("agent:completed", (payload) => {
      completedPayloads.push({ duration: payload.duration, exitCode: payload.exitCode });
    });

    service.emitAgentCompleted(terminal, 0);

    expect(completedPayloads).toHaveLength(1);
    expect(completedPayloads[0]?.duration).toBe(0);
    expect(completedPayloads[0]?.exitCode).toBe(0);
  });
});
