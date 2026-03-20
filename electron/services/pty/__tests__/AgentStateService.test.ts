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

  it("recovers from failed to working on busy event and clears error", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "network timeout" });

    const changed = service.updateAgentState(terminal, { type: "busy" });

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("working");
    expect(terminal.error).toBeUndefined();
  });

  it("recovers from failed to waiting on prompt event and clears error", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "api error" });

    const changed = service.updateAgentState(terminal, { type: "prompt" });

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("waiting");
    expect(terminal.error).toBeUndefined();
  });

  it("does not recover from failed on completion event", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "api error" });

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

  it("handleActivityState with trigger output recovers from failed via busy event", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "failed", error: "some error" });

    service.handleActivityState(terminal, "busy", { trigger: "output" });

    expect(terminal.agentState).toBe("working");
    expect(terminal.error).toBeUndefined();
  });

  it("handleActivityState with timeout trigger transitions working to waiting", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });
    const stateChanges: Array<{ trigger: string; confidence: number; state: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({
        trigger: payload.trigger,
        confidence: payload.confidence,
        state: payload.state,
      });
    });

    service.handleActivityState(terminal, "idle", { trigger: "timeout" });

    expect(terminal.agentState).toBe("waiting");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.trigger).toBe("timeout");
    expect(stateChanges[0]?.confidence).toBe(0.6);
    expect(stateChanges[0]?.state).toBe("waiting");
  });

  it("includes waitingReason in state-changed payload when transitioning to waiting", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });
    const stateChanges: Array<{ state: string; waitingReason?: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ state: payload.state, waitingReason: payload.waitingReason });
    });

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "approval");

    expect(terminal.agentState).toBe("waiting");
    expect(terminal.waitingReason).toBe("approval");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.waitingReason).toBe("approval");
  });

  it("clears waitingReason when transitioning away from waiting", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "waiting" });
    terminal.waitingReason = "prompt";
    const stateChanges: Array<{ state: string; waitingReason?: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ state: payload.state, waitingReason: payload.waitingReason });
    });

    service.updateAgentState(terminal, { type: "input" });

    expect(terminal.agentState).toBe("working");
    expect(terminal.waitingReason).toBeUndefined();
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.waitingReason).toBeUndefined();
  });

  it("does not include waitingReason for non-waiting states", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "idle" });
    const stateChanges: Array<{ state: string; waitingReason?: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ state: payload.state, waitingReason: payload.waitingReason });
    });

    service.updateAgentState(terminal, { type: "input" });

    expect(terminal.agentState).toBe("working");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.waitingReason).toBeUndefined();
  });

  it("handleActivityState threads waitingReason for idle transitions", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });
    const stateChanges: Array<{ state: string; waitingReason?: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ state: payload.state, waitingReason: payload.waitingReason });
    });

    service.handleActivityState(terminal, "idle", {
      trigger: "timeout",
      waitingReason: "question",
    });

    expect(terminal.agentState).toBe("waiting");
    expect(terminal.waitingReason).toBe("question");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.waitingReason).toBe("question");
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
