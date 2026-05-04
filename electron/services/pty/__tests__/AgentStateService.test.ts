import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    launchAgentId: "claude",
    agentState: "idle",
    ptyProcess: {} as never,
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
        launchAgentId: undefined,
        detectedAgentId: "claude",
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
        launchAgentId: undefined,
        detectedAgentId: "gemini",
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

    // #6650 — Identity-less terminals (no detectedAgentId, no launchAgentId)
    // must still flow through the state machine so the renderer can show an
    // active-state indicator during the boot/identity-commit window.
    it("emits state-changed for identity-less terminal with agentId undefined (#6650)", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        launchAgentId: undefined,
        detectedAgentId: undefined,
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
      expect(stateChanges[0]?.state).toBe("working");
      expect(stateChanges[0]?.agentId).toBeUndefined();
    });

    it("handleActivityState emits state-changed for identity-less terminal (#6650)", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        launchAgentId: undefined,
        detectedAgentId: undefined,
        agentState: "idle",
      });
      const stateChanges: Array<{ state: string; agentId?: string; trigger: string }> = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push({
          state: payload.state,
          agentId: payload.agentId,
          trigger: payload.trigger,
        });
      });

      service.handleActivityState(terminal, "busy", { trigger: "output" });

      expect(terminal.agentState).toBe("working");
      expect(stateChanges).toHaveLength(1);
      expect(stateChanges[0]?.state).toBe("working");
      expect(stateChanges[0]?.agentId).toBeUndefined();
      expect(stateChanges[0]?.trigger).toBe("output");
    });

    it("emitTerminalActivity produces agent-style headline for detectedAgentType-only terminal", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        launchAgentId: undefined,
        detectedAgentId: "claude",
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
        launchAgentId: undefined,
        detectedAgentId: "claude",
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

  // #6665 — A high-confidence transition should not be flipped by a
  // lower-confidence opposite-direction trigger arriving inside a short
  // hysteresis window. Lifecycle events and same- or higher-confidence
  // signals always pass through.
  describe("hysteresis (#6665)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-04T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("suppresses low-confidence timeout that would flip working back to waiting within window", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });
      const stateChanges: Array<{ state: string; trigger: string }> = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push({ state: payload.state, trigger: payload.trigger });
      });

      // High-confidence input transitions idle → working
      service.updateAgentState(terminal, { type: "input" });
      expect(terminal.agentState).toBe("working");
      expect(stateChanges).toHaveLength(1);

      // 100ms later, watchdog timeout fires → would normally flip working → waiting
      vi.setSystemTime(Date.now() + 100);
      const changed = service.handleActivityState(terminal, "idle", { trigger: "timeout" });

      expect(terminal.agentState).toBe("working");
      expect(stateChanges).toHaveLength(1);
      expect(changed).toBeUndefined();
    });

    it("suppresses heuristic prompt that would flip working back to waiting within window", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });
      const stateChanges: Array<{ state: string }> = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push({ state: payload.state });
      });

      // High-confidence busy heuristic (0.9) transitions idle → working and locks
      service.transitionState(terminal, { type: "busy" }, "heuristic", 0.9, terminal.spawnedAt);
      expect(terminal.agentState).toBe("working");

      // 200ms later, prompt heuristic at 0.75 → suppressed
      vi.setSystemTime(Date.now() + 200);
      const changed = service.transitionState(
        terminal,
        { type: "prompt" },
        "heuristic",
        0.75,
        terminal.spawnedAt
      );

      expect(changed).toBe(false);
      expect(terminal.agentState).toBe("working");
      expect(stateChanges).toHaveLength(1);
    });

    it("allows the transition once the hysteresis window has expired", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });

      service.updateAgentState(terminal, { type: "input" });
      expect(terminal.agentState).toBe("working");

      // 501ms later — past the 500ms window
      vi.setSystemTime(Date.now() + 501);
      const changed = service.handleActivityState(terminal, "idle", { trigger: "timeout" });

      expect(changed).toBeUndefined();
      expect(terminal.agentState).toBe("waiting");
    });

    it("high-confidence opposite event passes through within the window", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });

      service.updateAgentState(terminal, { type: "input" });
      expect(terminal.agentState).toBe("working");

      // Within the window, an explicit high-confidence prompt (1.0) wins
      vi.setSystemTime(Date.now() + 100);
      const changed = service.transitionState(
        terminal,
        { type: "prompt" },
        "activity",
        1.0,
        terminal.spawnedAt
      );

      expect(changed).toBe(true);
      expect(terminal.agentState).toBe("waiting");
    });

    it("lifecycle exit event is never suppressed by the hysteresis window", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });

      service.updateAgentState(terminal, { type: "input" });
      expect(terminal.agentState).toBe("working");

      vi.setSystemTime(Date.now() + 100);
      const changed = service.updateAgentState(terminal, { type: "exit", code: 0 });

      expect(changed).toBe(true);
      expect(terminal.agentState).toBe("exited");
    });

    it("same-direction confirmations do not extend the original window", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });

      // First high-confidence input at t=0 sets the lock to t=500
      service.updateAgentState(terminal, { type: "input" });
      const lockAfterFirst = terminal.hysteresisLockedUntil;
      expect(lockAfterFirst).toBeDefined();

      // A same-state input at t=200 produces no state change (working → working)
      // and therefore must NOT shift the lock — hysteresis is anchored to actual
      // direction-changing high-confidence transitions, not no-ops.
      vi.setSystemTime(Date.now() + 200);
      service.updateAgentState(terminal, { type: "input" });
      expect(terminal.hysteresisLockedUntil).toBe(lockAfterFirst);
    });

    it("a fresh terminal (new session) starts with no hysteresis lock", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });

      // A low-confidence transition on a brand-new terminal must not be
      // affected by any prior session's lock — TerminalInfo is per-session.
      const changed = service.handleActivityState(terminal, "busy", {
        trigger: "pattern",
        patternConfidence: 0.7,
      });

      expect(changed).toBeUndefined();
      expect(terminal.agentState).toBe("working");
      expect(terminal.hysteresisLockedUntil).toBeUndefined();
    });

    it("respawn (passive→passive) does not lock out a subsequent low-confidence active transition", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "exited" });

      // Lifecycle respawn at confidence 1.0 — passive→passive (exited→idle).
      // Per design, this must NOT arm the hysteresis lock; otherwise a fresh
      // agent session detected within 500ms would have its first low-confidence
      // busy/start signal silently suppressed.
      service.updateAgentState(terminal, { type: "respawn" });
      expect(terminal.agentState).toBe("idle");
      expect(terminal.hysteresisLockedUntil).toBeUndefined();

      vi.setSystemTime(Date.now() + 100);
      const changed = service.handleActivityState(terminal, "busy", {
        trigger: "pattern",
        patternConfidence: 0.7,
      });

      expect(changed).toBeUndefined();
      expect(terminal.agentState).toBe("working");
    });

    it("passive→passive high-confidence transition does not arm the lock", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "completed" });

      // completed→waiting at confidence 1.0 (both PASSIVE) must not lock —
      // the window protects active/passive boundary settling, not within-group
      // movement through the FSM.
      service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0);
      expect(terminal.agentState).toBe("waiting");
      expect(terminal.hysteresisLockedUntil).toBeUndefined();
    });

    it("suppression leaves all terminal state and emitted events untouched", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });
      const stateChanges: unknown[] = [];
      const activityEvents: unknown[] = [];

      service.updateAgentState(terminal, { type: "input" });
      const lockSnapshot = terminal.hysteresisLockedUntil;
      const lastChangeSnapshot = terminal.lastStateChange;
      const stateSnapshot = terminal.agentState;
      const waitingReasonSnapshot = terminal.waitingReason;

      // Subscribe AFTER the priming transition to isolate the suppressed case.
      events.on("agent:state-changed", (payload) => stateChanges.push(payload));
      events.on("terminal:activity", (payload) => activityEvents.push(payload));

      vi.setSystemTime(Date.now() + 100);
      const changed = service.handleActivityState(terminal, "idle", { trigger: "timeout" });

      expect(changed).toBeUndefined();
      expect(terminal.agentState).toBe(stateSnapshot);
      expect(terminal.lastStateChange).toBe(lastChangeSnapshot);
      expect(terminal.waitingReason).toBe(waitingReasonSnapshot);
      expect(terminal.hysteresisLockedUntil).toBe(lockSnapshot);
      expect(stateChanges).toHaveLength(0);
      expect(activityEvents).toHaveLength(0);
    });

    it("guard boundary: suppression at 499ms, pass-through at 500ms", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });

      service.updateAgentState(terminal, { type: "input" });
      const lockedUntil = terminal.hysteresisLockedUntil;
      expect(lockedUntil).toBeDefined();

      // Strictly inside the window — `now < lockedUntil` is true.
      vi.setSystemTime((lockedUntil ?? 0) - 1);
      let changed = service.handleActivityState(terminal, "idle", { trigger: "timeout" });
      expect(changed).toBeUndefined();
      expect(terminal.agentState).toBe("working");

      // At the boundary — `now < lockedUntil` is false, transition allowed.
      vi.setSystemTime(lockedUntil ?? 0);
      changed = service.handleActivityState(terminal, "idle", { trigger: "timeout" });
      expect(changed).toBeUndefined();
      expect(terminal.agentState).toBe("waiting");
    });

    it("threshold boundary: confidence 0.85 passes guard and arms lock; 0.849 is suppressed", () => {
      // 0.85 sets the lock — armed transition through a passive→active boundary.
      const a = new AgentStateService();
      const t1 = createTerminal({ agentState: "idle" });
      a.transitionState(t1, { type: "busy" }, "ai-classification", 0.85, t1.spawnedAt);
      expect(t1.agentState).toBe("working");
      expect(t1.hysteresisLockedUntil).toBeDefined();

      // 0.849 is below threshold — passes ONLY when no lock is active. Use a
      // fresh terminal so the guard does not fire on the first transition;
      // then verify a second 0.849 cross-direction event would be suppressed
      // by the lock that 0.85 just armed on the first terminal.
      const t2 = createTerminal({ agentState: "idle" });
      const changedFresh = a.transitionState(
        t2,
        { type: "busy" },
        "heuristic",
        0.849,
        t2.spawnedAt
      );
      expect(changedFresh).toBe(true);
      expect(t2.agentState).toBe("working");
      expect(t2.hysteresisLockedUntil).toBeUndefined();

      // Within the lock armed by t1's 0.85 transition, an opposite-direction
      // 0.849 event MUST be suppressed.
      vi.setSystemTime(Date.now() + 100);
      const changedSuppressed = a.transitionState(
        t1,
        { type: "prompt" },
        "heuristic",
        0.849,
        t1.spawnedAt
      );
      expect(changedSuppressed).toBe(false);
      expect(t1.agentState).toBe("working");
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

  // #5803: Runtime-detected agents have no launch-time agentId; lifecycle
  // events must still fire using detectedAgentType as the live identity.
  describe("lifecycle events use live identity (#5803)", () => {
    it("emitAgentCompleted uses detectedAgentType when agentId is absent", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        launchAgentId: undefined,
        detectedAgentId: "claude",
        agentState: "working",
      });
      const payloads: Array<{ agentId: string }> = [];

      events.on("agent:completed", (payload) => {
        payloads.push({ agentId: payload.agentId });
      });

      service.emitAgentCompleted(terminal, 0);

      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.agentId).toBe("claude");
    });

    it("emitAgentKilled uses detectedAgentType when agentId is absent", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        launchAgentId: undefined,
        detectedAgentId: "gemini",
        agentState: "working",
      });
      const payloads: Array<{ agentId: string; reason?: string }> = [];

      events.on("agent:killed", (payload) => {
        payloads.push({ agentId: payload.agentId, reason: payload.reason });
      });

      service.emitAgentKilled(terminal, "manual");

      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.agentId).toBe("gemini");
      expect(payloads[0]?.reason).toBe("manual");
    });

    it("emitAgentCompleted uses detectedAgentId when both launchAgentId and detectedAgentId are set (live identity wins)", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        launchAgentId: "claude",
        detectedAgentId: "gemini",
        agentState: "working",
      });
      const payloads: Array<{ agentId: string }> = [];

      events.on("agent:completed", (payload) => {
        payloads.push({ agentId: payload.agentId });
      });

      service.emitAgentCompleted(terminal, 0);

      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.agentId).toBe("gemini");
    });

    it("emitAgentCompleted is a no-op when both agentId and detectedAgentType are absent", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        launchAgentId: undefined,
        detectedAgentId: undefined,
        agentState: "idle",
      });
      const payloads: unknown[] = [];

      events.on("agent:completed", (payload) => {
        payloads.push(payload);
      });

      service.emitAgentCompleted(terminal, 0);

      expect(payloads).toHaveLength(0);
    });

    it("emitAgentKilled is a no-op when both agentId and detectedAgentType are absent", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        launchAgentId: undefined,
        detectedAgentId: undefined,
        agentState: "idle",
      });
      const payloads: unknown[] = [];

      events.on("agent:killed", (payload) => {
        payloads.push(payload);
      });

      service.emitAgentKilled(terminal, "manual");

      expect(payloads).toHaveLength(0);
    });
  });
});
