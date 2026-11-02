import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStateService } from "../AgentStateService.js";
import { events } from "../../events.js";
import { HandbackTracker } from "../HandbackTracker.js";
import type { TerminalInfo } from "../types.js";
import { buildHandbackInstruction } from "../../../../shared/utils/handback.js";
import * as detector from "../HandbackDetector.js";
import {
  ASSISTANT_SEND_GATE,
  evaluateWakeGate,
} from "../../../../shared/utils/terminalWakeGate.js";

vi.mock("../HandbackDetector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../HandbackDetector.js")>();
  return { ...actual, findHandback: vi.fn(actual.findHandback) };
});

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
    agentIncarnation: 0,
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

  it("threads exitCode and exitSignal onto the exited state-changed payload (#10638)", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });
    const stateChanges: Array<{ state: string; exitCode?: number | null; exitSignal?: number }> =
      [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({
        state: payload.state,
        exitCode: payload.exitCode,
        exitSignal: payload.exitSignal,
      });
    });

    service.updateAgentState(terminal, { type: "exit", code: 137, signal: 9 });

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.state).toBe("exited");
    expect(stateChanges[0]?.exitCode).toBe(137);
    expect(stateChanges[0]?.exitSignal).toBe(9);
  });

  it("carries exitCode 0 without an exitSignal on a clean exit (#10638)", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });
    const stateChanges: Array<{ exitCode?: number | null; exitSignal?: number }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ exitCode: payload.exitCode, exitSignal: payload.exitSignal });
    });

    service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.exitCode).toBe(0);
    expect(stateChanges[0]?.exitSignal).toBeUndefined();
  });

  it("does not attach exit metadata to non-exit completion transitions (#10638)", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working" });
    const stateChanges: Array<{ state: string; exitCode?: number | null }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ state: payload.state, exitCode: payload.exitCode });
    });

    // A pattern-driven completion (not a PTY exit) has no exit code to report.
    service.updateAgentState(terminal, { type: "completion" }, "activity", 1.0);

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.state).toBe("completed");
    expect(stateChanges[0]?.exitCode).toBeUndefined();
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
    const dropped: unknown[] = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push(payload);
    });
    events.on("agent:state-transition-dropped", (payload) => {
      dropped.push(payload);
    });

    const changed = service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(changed).toBe(false);
    expect(terminal.agentState).toBe("exited");
    expect(stateChanges).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect((dropped[0] as { outcome: string }).outcome).toBe("no-op");
  });

  it("counts a respawn as a new session and carries the count on the event", () => {
    // #12535: the only observable that moves when an agent is relaunched inside
    // a pty that never restarted. Carried on the transition itself so a
    // subscriber applies the session and the state it belongs to together.
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "exited", agentIncarnation: 0 });
    const counts: Array<number | undefined> = [];
    events.on("agent:state-changed", (payload) => counts.push(payload.agentIncarnation));

    expect(service.updateAgentState(terminal, { type: "respawn" })).toBe(true);

    expect(terminal.agentIncarnation).toBe(1);
    expect(counts).toEqual([1]);
  });

  it("leaves the session count alone on ordinary transitions", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "idle", agentIncarnation: 2 });
    const counts: Array<number | undefined> = [];
    events.on("agent:state-changed", (payload) => counts.push(payload.agentIncarnation));

    service.updateAgentState(terminal, { type: "busy" });
    service.updateAgentState(terminal, { type: "prompt" });

    expect(terminal.agentIncarnation).toBe(2);
    expect(counts).toEqual([2, 2]);
  });

  it("does not advance the session count on a dropped respawn", () => {
    // A respawn from a state the machine will not leave is a no-op, and a count
    // that moved for a transition nobody published would name a session that
    // never started.
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "working", agentIncarnation: 1 });

    expect(service.updateAgentState(terminal, { type: "respawn" })).toBe(false);

    expect(terminal.agentIncarnation).toBe(1);
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

  it("does not emit state changes for waitingReason-only updates", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ agentState: "waiting" });
    terminal.waitingReason = "prompt";
    const stateChanges: Array<{ state: string; waitingReason?: string }> = [];
    const activityEvents: unknown[] = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ state: payload.state, waitingReason: payload.waitingReason });
    });
    events.on("terminal:activity", (payload) => {
      activityEvents.push(payload);
    });

    const changed = service.updateAgentState(
      terminal,
      { type: "prompt" },
      "activity",
      1.0,
      "question"
    );

    expect(changed).toBe(false);
    expect(terminal.agentState).toBe("waiting");
    expect(terminal.waitingReason).toBe("prompt");
    expect(stateChanges).toHaveLength(0);
    expect(activityEvents).toHaveLength(0);
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

  describe("reason-only updates (#16093)", () => {
    function settledOnError() {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentState: "waiting",
        waitingReason: "error",
        lastStateChange: 1_000,
        detectedAgentId: "claude",
        hasPty: true,
      } as Partial<TerminalInfo>);
      const stateChanges: Array<{
        state: string;
        previousState: string;
        waitingReason?: string;
        timestamp: number;
      }> = [];
      const activityEvents: unknown[] = [];
      events.on("agent:state-changed", (payload) => {
        stateChanges.push({
          state: payload.state,
          previousState: payload.previousState,
          waitingReason: payload.waitingReason,
          timestamp: payload.timestamp,
        });
      });
      events.on("terminal:activity", (payload) => activityEvents.push(payload));
      return { service, terminal, stateChanges, activityEvents };
    }

    it("publishes the new reason as a waiting → waiting change", () => {
      const { service, terminal, stateChanges, activityEvents } = settledOnError();

      service.handleActivityState(terminal, "idle", {
        trigger: "pattern",
        waitingReason: "prompt",
        rereadAt: 5_000,
      });

      expect(terminal.agentState).toBe("waiting");
      expect(terminal.waitingReason).toBe("prompt");
      expect(terminal.lastStateChange).toBe(5_000);
      expect(stateChanges).toEqual([
        { state: "waiting", previousState: "waiting", waitingReason: "prompt", timestamp: 5_000 },
      ]);
      expect(activityEvents).toHaveLength(1);
    });

    it("admits a send typed after the error settle once the prompt is re-read", () => {
      const { service, terminal } = settledOnError();
      // Escape pressed into the limit screen.
      terminal.lastTypedInputAt = 2_000;
      expect(evaluateWakeGate(terminal, ASSISTANT_SEND_GATE)).toEqual({
        kind: "blocked",
        reason: "error",
      });

      service.handleActivityState(terminal, "idle", {
        trigger: "pattern",
        waitingReason: "prompt",
        rereadAt: 3_500,
      });

      expect(evaluateWakeGate(terminal, ASSISTANT_SEND_GATE)).toEqual({ kind: "ready" });
    });

    it("still holds a send for input that landed after the screen was read", () => {
      const { service, terminal } = settledOnError();
      terminal.lastTypedInputAt = 4_000;

      service.updateWaitingReason(terminal, "prompt", 3_500);

      expect(terminal.waitingReason).toBe("prompt");
      expect(evaluateWakeGate(terminal, ASSISTANT_SEND_GATE)).toEqual({
        kind: "hold",
        reason: "typing",
      });
    });

    it.each([
      ["the agent is not waiting", { agentState: "working" as const }, "prompt" as const, 5_000],
      ["the reason is unchanged", {}, "error" as const, 5_000],
      [
        "a later settle already read the screen",
        { lastStateChange: 6_000 },
        "prompt" as const,
        5_000,
      ],
    ])("changes nothing when %s", (_label, overrides, reason, observedAt) => {
      const { service, terminal, stateChanges, activityEvents } = settledOnError();
      Object.assign(terminal, overrides);
      const before = { ...terminal };

      expect(service.updateWaitingReason(terminal, reason, observedAt)).toBe(false);

      expect(terminal.agentState).toBe(before.agentState);
      expect(terminal.waitingReason).toBe(before.waitingReason);
      expect(terminal.lastStateChange).toBe(before.lastStateChange);
      expect(stateChanges).toHaveLength(0);
      expect(activityEvents).toHaveLength(0);
    });

    it("never drives a transition, even for an agent that is not waiting", () => {
      const { service, terminal, stateChanges } = settledOnError();
      terminal.agentState = "working";
      terminal.waitingReason = undefined;

      service.handleActivityState(terminal, "idle", {
        trigger: "pattern",
        waitingReason: "prompt",
        rereadAt: 5_000,
      });

      expect(terminal.agentState).toBe("working");
      expect(terminal.waitingReason).toBeUndefined();
      expect(stateChanges).toHaveLength(0);
    });
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
      vi.advanceTimersByTime(200);
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

    it("high-confidence opposite event passes through within the window", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });

      service.updateAgentState(terminal, { type: "input" });
      expect(terminal.agentState).toBe("working");

      // Within the window, an explicit high-confidence prompt (1.0) wins
      vi.advanceTimersByTime(100);
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

      vi.advanceTimersByTime(100);
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
      vi.advanceTimersByTime(200);
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

      vi.advanceTimersByTime(100);
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

      vi.advanceTimersByTime(100);
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
      vi.advanceTimersByTime((lockedUntil ?? 0) - 1);
      let changed = service.handleActivityState(terminal, "idle", { trigger: "timeout" });
      expect(changed).toBeUndefined();
      expect(terminal.agentState).toBe("working");

      // At the boundary — `now < lockedUntil` is false, transition allowed.
      vi.advanceTimersByTime(1);
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
      vi.advanceTimersByTime(100);
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

  // #9868 — Suppressed and rejected agent state transitions leave no
  // diagnosable evidence. Each drop site (no-op, hysteresis, stale-session,
  // schema-invalid) must emit `agent:state-transition-dropped` with the same
  // context the agent pipeline has at the moment of the drop, so the
  // diagnostics event inspector can answer "why did the agent say `working`
  // when it should have said `waiting`?" without losing the original intent.
  describe("dropped transition diagnostics (#9868)", () => {
    it("emits agent:state-transition-dropped for a no-op transition", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "working" });
      const dropped: Array<Record<string, unknown>> = [];

      events.on("agent:state-transition-dropped", (payload) => {
        dropped.push(payload as unknown as Record<string, unknown>);
      });

      // working + output → working (no-op). `data` is required on the output
      // event shape; the no-op branch doesn't read it, so an empty string is fine.
      const changed = service.updateAgentState(terminal, { type: "output", data: "" });

      expect(changed).toBe(false);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        terminalId: "term-1",
        outcome: "no-op",
        currentState: "working",
        attemptedState: "working",
      });
    });

    it("emits agent:state-transition-dropped for hysteresis suppression", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });
      const dropped: Array<Record<string, unknown>> = [];

      // Arm the hysteresis lock with a high-confidence idle→working transition.
      service.updateAgentState(terminal, { type: "input" });
      expect(terminal.agentState).toBe("working");
      expect(terminal.hysteresisLockedUntil).toBeDefined();

      events.on("agent:state-transition-dropped", (payload) => {
        dropped.push(payload as unknown as Record<string, unknown>);
      });

      // Within the window: low-confidence opposite-direction prompt is dropped.
      const changed = service.transitionState(
        terminal,
        { type: "prompt" },
        "heuristic",
        0.6,
        terminal.spawnedAt
      );

      expect(changed).toBe(false);
      expect(terminal.agentState).toBe("working");
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        terminalId: "term-1",
        outcome: "hysteresis",
        currentState: "working",
        attemptedState: "waiting",
        trigger: "heuristic",
        confidence: 0.6,
      });
      expect(typeof dropped[0]?.reason).toBe("string");
    });

    it("emits agent:state-transition-dropped for a stale-session rejection", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ spawnedAt: 1000, agentState: "idle" });
      const dropped: Array<Record<string, unknown>> = [];

      events.on("agent:state-transition-dropped", (payload) => {
        dropped.push(payload as unknown as Record<string, unknown>);
      });

      const changed = service.transitionState(terminal, { type: "busy" }, "output", 1.0, 999);

      expect(changed).toBe(false);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        terminalId: "term-1",
        outcome: "stale-session",
        currentState: "idle",
        trigger: "output",
        confidence: 1,
        spawnedAt: 999,
        terminalSpawnedAt: 1000,
      });
    });

    it("emits agent:state-transition-dropped with validationErrors for schema-invalid payloads", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "working" });
      const dropped: Array<Record<string, unknown>> = [];
      const stateChanges: unknown[] = [];

      events.on("agent:state-transition-dropped", (payload) => {
        dropped.push(payload as unknown as Record<string, unknown>);
      });
      events.on("agent:state-changed", (payload) => {
        stateChanges.push(payload);
      });

      // Trigger a real Zod validation failure: `sessionCost: -1` fails the
      // `.nonnegative()` schema on the new payload. The state transition
      // itself is valid (working → completed) but the built payload is not,
      // so the build path hits the schema-invalid branch.
      const changed = service.updateAgentState(
        terminal,
        { type: "completion" },
        "activity",
        1.0,
        undefined,
        -1
      );

      expect(changed).toBe(false);
      expect(stateChanges).toHaveLength(0);
      expect(terminal.agentState).toBe("working");
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        terminalId: "term-1",
        outcome: "schema-invalid",
        currentState: "working",
        attemptedState: "completed",
      });
      expect(Array.isArray(dropped[0]?.validationErrors)).toBe(true);
      expect((dropped[0]?.validationErrors as string[]).length).toBeGreaterThan(0);
    });

    it("includes temperature/heatAdded/changedChars on accepted agent:state-changed when observation is provided", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });
      const observations: Array<Record<string, unknown>> = [];

      events.on("agent:state-changed", (payload) => {
        observations.push(payload as unknown as Record<string, unknown>);
      });

      const changed = service.updateAgentState(
        terminal,
        { type: "busy" },
        "output",
        1.0,
        undefined,
        undefined,
        undefined,
        {
          stateHint: "busy",
          changed: true,
          changedChars: 250,
          heatAdded: 12,
          temperature: 73.5,
          suppressed: true, // intentionally present — must NOT leak onto the event
          seeded: false,
        }
      );

      expect(changed).toBe(true);
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        temperature: 73.5,
        heatAdded: 12,
        changedChars: 250,
      });
      expect(observations[0]?.suppressed).toBeUndefined();
    });

    it("omits temperature fields on agent:state-changed when no observation is provided", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });
      const observations: Array<Record<string, unknown>> = [];

      events.on("agent:state-changed", (payload) => {
        observations.push(payload as unknown as Record<string, unknown>);
      });

      // transitionState path — no temperature observation in scope.
      const changed = service.transitionState(
        terminal,
        { type: "busy" },
        "output",
        1.0,
        terminal.spawnedAt
      );

      expect(changed).toBe(true);
      expect(observations).toHaveLength(1);
      expect(observations[0]?.temperature).toBeUndefined();
      expect(observations[0]?.heatAdded).toBeUndefined();
      expect(observations[0]?.changedChars).toBeUndefined();
    });
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

  describe("dispose trigger suppression (#9867)", () => {
    it("does not publish agent:state-changed for a dispose observation from a working terminal", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "working" });
      const stateChanges: unknown[] = [];
      const dropped: Array<{ outcome: string; reason?: string; currentState: string }> = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push(payload);
      });
      events.on("agent:state-transition-dropped", (payload) => {
        dropped.push({
          outcome: payload.outcome,
          reason: payload.reason,
          currentState: payload.currentState,
        });
      });

      service.handleActivityState(terminal, "idle", { trigger: "dispose" });

      expect(terminal.agentState).toBe("working");
      expect(stateChanges).toHaveLength(0);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.outcome).toBe("no-op");
      expect(dropped[0]?.currentState).toBe("working");
      expect(dropped[0]?.reason).toBe("dispose observation suppressed at teardown");
    });

    it("is a no-op for a dispose observation from an idle terminal", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "idle" });
      const stateChanges: unknown[] = [];
      const dropped: unknown[] = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push(payload);
      });
      events.on("agent:state-transition-dropped", (payload) => {
        dropped.push(payload);
      });

      service.handleActivityState(terminal, "idle", { trigger: "dispose" });

      expect(terminal.agentState).toBe("idle");
      expect(stateChanges).toHaveLength(0);
      expect(dropped).toHaveLength(1);
    });

    it("does not race the authoritative exit/kill transition — that path is unaffected", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({ agentState: "working" });
      const stateChanges: Array<{ state: string; previousState: string; trigger: string }> = [];

      events.on("agent:state-changed", (payload) => {
        stateChanges.push({
          state: payload.state,
          previousState: payload.previousState,
          trigger: payload.trigger,
        });
      });

      // First: dispose observation (would have been the false positive).
      service.handleActivityState(terminal, "idle", { trigger: "dispose" });
      // Then: the authoritative exit that follows teardown.
      service.updateAgentState(terminal, { type: "exit", code: 0 });

      expect(terminal.agentState).toBe("exited");
      expect(stateChanges).toHaveLength(1);
      expect(stateChanges[0]?.state).toBe("exited");
      expect(stateChanges[0]?.previousState).toBe("working");
      expect(stateChanges[0]?.trigger).toBe("exit");
    });
  });

  describe("lastCheckResult detection (issue #10682)", () => {
    it("attaches a parsed check result when settling out of working", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentState: "working",
        semanticBuffer: ["> tsc --noEmit", "Found 0 errors."],
      });
      const payloads: Array<{ lastCheckResult?: unknown }> = [];
      events.on("agent:state-changed", (payload) => payloads.push(payload));

      service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

      expect(terminal.agentState).toBe("waiting");
      expect(payloads).toHaveLength(1);
      const result = payloads[0]?.lastCheckResult as
        { passed: boolean; command: string | null } | undefined;
      expect(result?.passed).toBe(true);
      expect(result?.command).toContain("tsc");
      // Stored on the terminal for getPublicState() hydration.
      expect(terminal.lastCheckResult?.passed).toBe(true);
    });

    it("does not attach a result for transitions with no recognized summary", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentState: "working",
        semanticBuffer: ["just some agent narration", "no structured summary here"],
      });
      const payloads: Array<{ lastCheckResult?: unknown }> = [];
      events.on("agent:state-changed", (payload) => payloads.push(payload));

      service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.lastCheckResult).toBeUndefined();
      expect(terminal.lastCheckResult).toBeUndefined();
    });

    it("does not re-attach an identical result on repeat settles", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentState: "working",
        semanticBuffer: ["> eslint .", "✖ 2 problems (2 errors, 0 warnings)"],
      });
      const payloads: Array<{ lastCheckResult?: unknown }> = [];
      events.on("agent:state-changed", (payload) => payloads.push(payload));

      // working → waiting (first detection)
      service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");
      // waiting → working (no detection; not a settle state)
      service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);
      // working → waiting again, same buffer (deduped — no new attach)
      service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

      const withResult = payloads.filter((p) => p.lastCheckResult !== undefined);
      expect(withResult).toHaveLength(1);
      expect((withResult[0]?.lastCheckResult as { passed: boolean } | undefined)?.passed).toBe(
        false
      );
    });

    it("clears the stored result on respawn and does not re-detect the old buffer", () => {
      const service = new AgentStateService();
      const terminal = createTerminal({
        agentState: "exited",
        // Stale summary from the prior session still sitting in the buffer.
        semanticBuffer: ["> tsc --noEmit", "Found 0 errors."],
        lastCheckResult: {
          command: "tsc --noEmit",
          passed: true,
          ranAt: 1,
          failureSummary: null,
          truncated: false,
        },
      });
      const payloads: Array<{ lastCheckResult?: unknown }> = [];
      events.on("agent:state-changed", (payload) => payloads.push(payload));

      // respawn: exited → idle (a settle state) — must NOT resurrect the stale result.
      service.updateAgentState(terminal, { type: "respawn" });

      expect(terminal.agentState).toBe("idle");
      expect(terminal.lastCheckResult).toBeUndefined();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.lastCheckResult).toBeUndefined();
    });
  });
});

describe("AgentStateService handback detection (#12488)", () => {
  const CODE = "k7f3qa";
  const ECHO = `> Fix the flaky test ${buildHandbackInstruction(CODE)}`;
  const MARKER = `DAINTREE-DONE-${CODE}: fixed the race in the retry loop END-${CODE}`;

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
      agentState: "working",
      ptyProcess: {} as never,
      outputBuffer: "",
      semanticBuffer: [],
      ...overrides,
    } as TerminalInfo;
  }

  /** A terminal holding one delivered request, whose screen reads `screen`. */
  function askedTerminal(screen: string[], overrides: Partial<TerminalInfo> = {}) {
    const tracker = new HandbackTracker(() => screen);
    tracker.registerDelivered(CODE);
    return createTerminal({ handbackTracker: tracker, ...overrides });
  }

  function capturePayloads() {
    const payloads: Array<{ lastHandback?: unknown; state: string }> = [];
    events.on("agent:state-changed", (payload) => payloads.push(payload));
    return payloads;
  }

  afterEach(() => {
    events.removeAllListeners();
    vi.mocked(detector.findHandback).mockClear();
  });

  it("publishes a marker seen as the agent settles out of working", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([ECHO, "⏺ Done.", `  ${MARKER}`, "> "]);
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    const expected = {
      message: "fixed the race in the retry loop",
      observedAt: terminal.lastStateChange,
      truncated: false,
    };
    expect(payloads[0]?.lastHandback).toEqual(expected);
    expect(terminal.lastHandback).toEqual(expected);
  });

  it("reports a scheduled run's launch marker to Main with its incarnation (#15982)", () => {
    const service = new AgentStateService();
    const tracker = new HandbackTracker(() => [
      `> Triage ${buildHandbackInstruction(CODE, "run")}`,
      `  DAINTREE-NEEDS-YOU-${CODE}: two labels need a call END-${CODE}`,
    ]);
    tracker.registerDelivered(CODE, "run");
    const terminal = createTerminal({ handbackTracker: tracker, spawnedAt: 4_200 });
    const reports: unknown[] = [];
    events.on("agent:run-handback-observed", (payload) => reports.push(payload));

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(reports).toEqual([
      {
        terminalId: "term-1",
        spawnedAt: 4_200,
        code: CODE,
        report: "needs-you",
        message: "two labels need a call",
        truncated: false,
        observedAt: terminal.lastStateChange,
        timestamp: terminal.lastStateChange,
      },
    ]);
  });

  it("reports no ordinary request's marker as a run's", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([ECHO, `  ${MARKER}`]);
    const reports: unknown[] = [];
    events.on("agent:run-handback-observed", (payload) => reports.push(payload));

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback?.message).toBe("fixed the race in the retry loop");
    expect(reports).toEqual([]);
  });

  it("carries the submission token of the request that asked", () => {
    const service = new AgentStateService();
    const tracker = new HandbackTracker(() => [MARKER]);
    tracker.noteSubmission(CODE, "token-1")?.();
    const terminal = createTerminal({ handbackTracker: tracker });

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback?.submissionToken).toBe("token-1");
  });

  it("fires a code once: a later settle over the same screen publishes nothing", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([MARKER]);
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");
    service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);
    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(payloads.filter((p) => p.lastHandback !== undefined)).toHaveLength(1);
    expect(terminal.handbackTracker?.hasRequests()).toBe(false);
  });

  it("publishes a marker seen early in output on the next settle, once", () => {
    // The output observer retires the code, so the settle detects nothing;
    // the renderer's lastHandback still has to learn of it.
    const service = new AgentStateService();
    const early = { message: "fixed it", observedAt: 1, truncated: false };
    const terminal = createTerminal({ lastHandback: early, lastHandbackUnpublished: true });
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");
    service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);
    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(payloads[0]?.lastHandback).toEqual(early);
    expect(payloads.filter((p) => p.lastHandback !== undefined)).toHaveLength(1);
  });

  it("keeps the first observation of a capture already seen mid-turn (#13128)", () => {
    const service = new AgentStateService();
    const early = { message: "fixed the race in the retry loop", observedAt: 1, truncated: false };
    const terminal = askedTerminal([MARKER], {
      lastHandback: early,
      lastHandbackUnpublished: true,
    });
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback).toBe(early);
    expect(payloads[0]?.lastHandback).toEqual(early);
    expect(terminal.handbackTracker?.hasRequests()).toBe(false);
  });

  it("keeps the first observation when the capture changed since mid-turn", () => {
    const service = new AgentStateService();
    const early = { message: "fixed the race", observedAt: 1, truncated: false };
    const terminal = askedTerminal([MARKER], {
      lastHandback: early,
      lastHandbackUnpublished: true,
    });

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback).toEqual({
      message: "fixed the race in the retry loop",
      observedAt: 1,
      truncated: false,
    });
  });

  it("publishes nothing for the echoed instruction and keeps waiting", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([ECHO, "⏺ Looking into it…"]);
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(payloads[0]?.lastHandback).toBeUndefined();
    expect(terminal.lastHandback).toBeUndefined();
    expect(terminal.handbackTracker?.deliveredRequests()).toHaveLength(1);
  });

  it("publishes nothing for a half-streamed marker", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([ECHO, `⏺ DAINTREE-DONE-${CODE}: fixed the ra`]);

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback).toBeUndefined();
  });

  it("ignores a replayed marker from an earlier turn's code", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([
      "DAINTREE-DONE-oldold: the previous task END-oldold",
      ECHO,
      "⏺ Working on it",
    ]);

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback).toBeUndefined();
  });

  it("never looks while the agent is working", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([MARKER], { agentState: "waiting" });

    // waiting → working: an agent that mentions the marker mid-task is still working.
    service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);

    expect(terminal.agentState).toBe("working");
    expect(terminal.lastHandback).toBeUndefined();
    expect(detector.findHandback).not.toHaveBeenCalled();
  });

  it("only looks at a settle out of working", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([MARKER], { agentState: "waiting" });

    // waiting → idle is a settle state, but not one the agent worked into.
    service.updateAgentState(terminal, { type: "watchdog-timeout" }, "timeout", 0.6);

    expect(terminal.agentState).toBe("idle");
    expect(terminal.lastHandback).toBeUndefined();
    expect(detector.findHandback).not.toHaveBeenCalled();
  });

  it("does not look for a request whose submission has not reached the pty", () => {
    const service = new AgentStateService();
    const tracker = new HandbackTracker(() => [MARKER]);
    tracker.noteSubmission(CODE);
    const terminal = createTerminal({ handbackTracker: tracker });

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback).toBeUndefined();
    expect(detector.findHandback).not.toHaveBeenCalled();
  });

  it("falls back to the raw semantic buffer, keeping cursor-painted gaps as spaces", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([], {
      semanticBuffer: [`\x1b[1m⏺\x1b[0m DAINTREE-DONE-${CODE}:\x1b[1Cfixed\x1b[1Cit END-${CODE}`],
    });

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback?.message).toBe("fixed it");
  });

  it("looks at an exit settle, then drops what is left", () => {
    const service = new AgentStateService();
    const tracker = new HandbackTracker(() => [MARKER]);
    tracker.registerDelivered(CODE);
    tracker.noteSubmission("zzzzzz");
    const terminal = createTerminal({ handbackTracker: tracker });

    service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(terminal.agentState).toBe("exited");
    expect(terminal.lastHandback?.message).toBe("fixed the race in the retry loop");
    expect(tracker.hasRequests()).toBe(false);
  });

  it("clears the handback and outstanding requests on respawn without looking", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([MARKER], {
      agentState: "exited",
      lastHandback: { message: "old", observedAt: 1, truncated: false },
    });
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "respawn" });

    expect(terminal.agentState).toBe("idle");
    expect(terminal.lastHandback).toBeUndefined();
    expect(terminal.handbackTracker?.hasRequests()).toBe(false);
    expect(payloads[0]?.lastHandback).toBeUndefined();
    expect(detector.findHandback).not.toHaveBeenCalled();
  });

  it("never runs the detector for a terminal nobody asked about", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ semanticBuffer: [MARKER] });
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");
    service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);
    service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(detector.findHandback).not.toHaveBeenCalled();
    expect(terminal.lastHandback).toBeUndefined();
    expect(payloads.every((p) => p.lastHandback === undefined)).toBe(true);
  });
});
