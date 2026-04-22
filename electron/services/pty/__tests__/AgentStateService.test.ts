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

  it("transitions working → exited on crash-signal exit (no failed state)", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });

    // SIGSEGV: exit code 139 = 128 + 11
    const changed = service.updateAgentState(terminal, { type: "exit", code: 139 });

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("exited");
  });

  it("transitions working → exited on routine exit", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });

    const changed = service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("exited");
  });

  it("transitions idle → exited on graceful agent exit detected from idle (Issue #5767)", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "idle" });
    const stateChanges: Array<{ state: string; previousState: string; trigger: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({
        state: payload.state,
        previousState: payload.previousState,
        trigger: payload.trigger,
      });
    });

    const changed = service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("exited");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.state).toBe("exited");
    expect(stateChanges[0]?.previousState).toBe("idle");
    expect(stateChanges[0]?.trigger).toBe("exit");
  });

  it("is idempotent when exit event fires on an already-exited terminal", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "exited" });
    const stateChanges: unknown[] = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push(payload);
    });

    const changed = service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(changed).toBe(false);
    expect(terminal.agentState).toBe("exited");
    expect(stateChanges).toHaveLength(0);
  });

  it("transitions exited → idle on respawn (Issue #5767 — agent re-detected in same PTY)", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "exited" });
    const stateChanges: Array<{ state: string; previousState: string; trigger: string }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({
        state: payload.state,
        previousState: payload.previousState,
        trigger: payload.trigger,
      });
    });

    const changed = service.updateAgentState(terminal, { type: "respawn" });

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("idle");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.state).toBe("idle");
    expect(stateChanges[0]?.previousState).toBe("exited");
    expect(stateChanges[0]?.trigger).toBe("activity");
  });

  it("error event is a no-op and does not change state", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });

    const changed = service.updateAgentState(terminal, { type: "error", error: "transient error" });

    expect(changed).toBe(false);
    expect(terminal.agentState).toBe("working");
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

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.agentState).toBe("waiting");
    expect(terminal.waitingReason).toBe("prompt");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.waitingReason).toBe("prompt");
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

  // #5773 — Runtime-detected agents (plain terminals where a CLI was detected
  // via ProcessDetector) have no persisted launch-time agentId but should still
  // flow through the state machine and emit agent events, keyed by their
  // detectedAgentType.
  describe("runtime-detected agent identity (#5773)", () => {
    it("updateAgentState emits agent:state-changed using detectedAgentType when agentId is absent", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentId: undefined,
        detectedAgentType: "claude",
        agentState: "idle",
      });
      const stateChanges: Array<{ state: string; agentId?: string }> = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push({ state: payload.state, agentId: payload.agentId });
      });

      const changed = service.updateAgentState(terminal, { type: "busy" });

      expect(changed).toBe(true);
      expect(terminal.agentState).toBe("working");
      expect(stateChanges).toHaveLength(1);
      expect(stateChanges[0]?.agentId).toBe("claude");
    });

    it("handleActivityState transitions state for runtime-detected agents", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentId: undefined,
        detectedAgentType: "gemini",
        agentState: "working",
      });
      const stateChanges: Array<{ state: string; agentId?: string }> = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push({ state: payload.state, agentId: payload.agentId });
      });

      service.handleActivityState(terminal, "idle", { trigger: "timeout" });

      expect(terminal.agentState).toBe("waiting");
      expect(stateChanges).toHaveLength(1);
      expect(stateChanges[0]?.agentId).toBe("gemini");
    });

    it("does nothing when both agentId and detectedAgentType are absent", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentId: undefined,
        detectedAgentType: undefined,
        agentState: "idle",
      });
      const stateChanges: unknown[] = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push(payload);
      });

      const changed = service.updateAgentState(terminal, { type: "busy" });

      expect(changed).toBe(false);
      expect(terminal.agentState).toBe("idle");
      expect(stateChanges).toHaveLength(0);
    });

    it("emitTerminalActivity produces agent-style headline for detectedAgentType-only terminal", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentId: undefined,
        detectedAgentType: "claude",
        agentState: "working",
      });
      const activityEvents: Array<{ headline: string; status: string }> = [];

      events.on("terminal:activity", (payload) => {
        activityEvents.push({ headline: payload.headline, status: payload.status });
      });

      service.emitTerminalActivity(terminal);

      expect(activityEvents).toHaveLength(1);
      expect(activityEvents[0]?.headline).toBe("Agent working");
      expect(activityEvents[0]?.status).toBe("working");
    });

    it("emits 'exited' completion cue when runtime-detected agent exits", () => {
      const service = new AgentStateService();
      // Simulate the state of the terminal at the moment the exit transition
      // is observed — detectedAgentType is still set (TerminalProcess clears
      // it AFTER calling updateAgentState).
      const terminal = createTerminal({
        agentId: undefined,
        detectedAgentType: "claude",
        agentState: "working",
      });
      const stateChanges: Array<{ state: string; agentId?: string }> = [];
      const activityEvents: Array<{ headline: string }> = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push({ state: payload.state, agentId: payload.agentId });
      });
      events.on("terminal:activity", (payload) => {
        activityEvents.push({ headline: payload.headline });
      });

      const changed = service.updateAgentState(terminal, { type: "exit", code: 0 });

      expect(changed).toBe(true);
      expect(terminal.agentState).toBe("exited");
      expect(stateChanges).toHaveLength(1);
      expect(stateChanges[0]?.state).toBe("exited");
      expect(stateChanges[0]?.agentId).toBe("claude");
      // The completion cue produces the "Exited" headline before the caller
      // clears detectedAgentType and reverts to shell mode.
      expect(activityEvents).toHaveLength(1);
      expect(activityEvents[0]?.headline).toBe("Exited");
    });
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
