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

  it("returns false for unhandled event types", () => {
    const handled = bridgePtyEvent({ type: "unknown-event" } as never);
    expect(handled).toBe(false);
  });
});
