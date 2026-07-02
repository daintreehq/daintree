import { afterEach, describe, expect, it } from "vitest";
import { bridgePtyEvent } from "../PtyEventsBridge.js";
import { events } from "../../events.js";

describe("bridgePtyEvent", () => {
  afterEach(() => {
    events.removeAllListeners();
  });

  it("normalizes agent-state trigger and confidence before emitting", () => {
    const payloads: Array<{ trigger: string; confidence: number }> = [];
    events.on("agent:state-changed", (payload) => {
      payloads.push({ trigger: payload.trigger, confidence: payload.confidence });
    });

    const handled = bridgePtyEvent({
      type: "agent-state",
      id: "term-1",
      agentId: "claude",
      state: "working",
      previousState: "idle",
      timestamp: Date.now(),
      trigger: "invalid-trigger",
      confidence: 4.5,
      worktreeId: "wt-1",
    } as never);

    expect(handled).toBe(true);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      trigger: "activity",
      confidence: 1,
    });
  });

  it("forwards waitingReason from agent-state events", () => {
    const payloads: Array<{ waitingReason?: string }> = [];
    events.on("agent:state-changed", (payload) => {
      payloads.push({ waitingReason: payload.waitingReason });
    });

    bridgePtyEvent({
      type: "agent-state",
      id: "term-1",
      agentId: "claude",
      state: "waiting",
      previousState: "working",
      timestamp: Date.now(),
      trigger: "activity",
      confidence: 1.0,
      cwd: "/repo/wt-1",
      waitingReason: "prompt",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.waitingReason).toBe("prompt");
  });

  it("forwards exitCode and exitSignal across the pty-host wire (#10638)", () => {
    const payloads: Array<{ exitCode?: number | null; exitSignal?: number }> = [];
    events.on("agent:state-changed", (payload) => {
      payloads.push({ exitCode: payload.exitCode, exitSignal: payload.exitSignal });
    });

    bridgePtyEvent({
      type: "agent-state",
      id: "term-exit",
      agentId: "claude",
      state: "exited",
      previousState: "working",
      timestamp: Date.now(),
      trigger: "exit",
      confidence: 1.0,
      exitCode: 137,
      exitSignal: 9,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.exitCode).toBe(137);
    expect(payloads[0]?.exitSignal).toBe(9);
  });

  it("forwards a null exitCode (signal kill) across the wire without dropping it (#10638)", () => {
    const payloads: Array<{ exitCode?: number | null }> = [];
    events.on("agent:state-changed", (payload) => {
      payloads.push({ exitCode: payload.exitCode });
    });

    bridgePtyEvent({
      type: "agent-state",
      id: "term-null",
      agentId: "claude",
      state: "exited",
      previousState: "working",
      timestamp: Date.now(),
      trigger: "exit",
      confidence: 1.0,
      exitCode: null,
      exitSignal: 15,
    });

    expect(payloads).toHaveLength(1);
    // null is a meaningful value (signal kill, no numeric code) — it must
    // survive the wire, not be coerced away by a truthiness check.
    expect(payloads[0]?.exitCode).toBeNull();
  });

  it("omits exit metadata for non-exit transitions (#10638)", () => {
    const payloads: Array<Record<string, unknown>> = [];
    events.on("agent:state-changed", (payload) => {
      payloads.push(payload as unknown as Record<string, unknown>);
    });

    bridgePtyEvent({
      type: "agent-state",
      id: "term-working",
      agentId: "claude",
      state: "working",
      previousState: "idle",
      timestamp: Date.now(),
      trigger: "output",
      confidence: 1.0,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("exitCode");
    expect(payloads[0]).not.toHaveProperty("exitSignal");
  });

  it("routes terminal-status events to bus and callback", () => {
    const terminalStatusPayloads: Array<{ id: string; status: string }> = [];
    events.on("terminal:status", (payload) => {
      terminalStatusPayloads.push({ id: payload.id, status: payload.status });
    });

    const callbackPayloads: Array<{ id: string; status: string }> = [];
    const handled = bridgePtyEvent(
      {
        type: "terminal-status",
        id: "term-2",
        status: "paused",
        timestamp: Date.now(),
      } as never,
      {
        onTerminalStatus: (payload) => {
          callbackPayloads.push({ id: payload.id, status: payload.status });
        },
      }
    );

    expect(handled).toBe(true);
    expect(terminalStatusPayloads).toEqual([{ id: "term-2", status: "paused" }]);
    expect(callbackPayloads).toEqual([{ id: "term-2", status: "paused" }]);
  });

  it("forwards droppedBytes on data-loss terminal-status events", () => {
    const callbackPayloads: Array<{ id: string; status: string; droppedBytes?: number }> = [];
    const busPayloads: Array<{ id: string; status: string; droppedBytes?: number }> = [];
    events.on("terminal:status", (payload) => {
      busPayloads.push({
        id: payload.id,
        status: payload.status,
        droppedBytes: (payload as { droppedBytes?: number }).droppedBytes,
      });
    });

    const handled = bridgePtyEvent(
      {
        type: "terminal-status",
        id: "term-3",
        status: "data-loss",
        droppedBytes: 1024,
        timestamp: Date.now(),
      } as never,
      {
        onTerminalStatus: (payload) => {
          callbackPayloads.push({
            id: payload.id,
            status: payload.status,
            droppedBytes: (payload as { droppedBytes?: number }).droppedBytes,
          });
        },
      }
    );

    expect(handled).toBe(true);
    expect(busPayloads).toEqual([{ id: "term-3", status: "data-loss", droppedBytes: 1024 }]);
    expect(callbackPayloads).toEqual([{ id: "term-3", status: "data-loss", droppedBytes: 1024 }]);
  });

  it("re-emits a pty-host captured session onto the main bus for persistence", () => {
    const payloads: Array<{ sessionId: string; worktreeId: string | null }> = [];
    events.on("agent-session:captured", (payload) => {
      payloads.push({
        sessionId: payload.record.sessionId,
        worktreeId: payload.record.worktreeId,
      });
    });

    const handled = bridgePtyEvent({
      type: "agent-session-captured",
      record: {
        sessionId: "sess-1",
        agentId: "claude",
        worktreeId: null,
        title: null,
        projectId: "proj-1",
        cwd: "/repo/wt-a",
      },
    });

    expect(handled).toBe(true);
    expect(payloads).toEqual([{ sessionId: "sess-1", worktreeId: null }]);
  });

  it("returns false for unhandled event types", () => {
    const handled = bridgePtyEvent({ type: "unknown-event" } as never);
    expect(handled).toBe(false);
  });
});
