import { afterEach, describe, expect, it } from "vitest";
import { bridgePtyEvent } from "../PtyEventsBridge.js";
import { events } from "../../events.js";
import { HANDBACK_MESSAGE_MAX_CHARS } from "../../../../shared/types/handback.js";

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

  it("keeps a host throwaway run's agent observations off the bus (#14445)", () => {
    const heard: unknown[] = [];
    events.on("agent:state-changed", (payload) => heard.push(payload));
    events.on("agent:detected", (payload) => heard.push(payload));
    events.on("agent:spawned", (payload) => heard.push(payload));

    const throwaway = "daintree-throwaway-1";
    expect(
      bridgePtyEvent({
        type: "agent-state",
        id: throwaway,
        agentId: "claude",
        state: "waiting",
        previousState: "working",
        timestamp: 1,
        trigger: "activity",
        confidence: 1,
      } as never)
    ).toBe(true);
    expect(
      bridgePtyEvent({
        type: "agent-detected",
        terminalId: throwaway,
        agentType: "claude",
        timestamp: 1,
      } as never)
    ).toBe(true);
    expect(
      bridgePtyEvent({
        type: "agent-spawned",
        payload: { agentId: "claude", terminalId: throwaway, type: "claude", timestamp: 1 },
      } as never)
    ).toBe(true);
    expect(heard).toEqual([]);

    bridgePtyEvent({
      type: "agent-detected",
      terminalId: "term-1",
      agentType: "claude",
      timestamp: 1,
    } as never);
    expect(heard).toHaveLength(1);
  });

  it("forwards a rate-limit observation (#12797)", () => {
    const payloads: unknown[] = [];
    events.on("agent:rate-limit-observed", (payload) => payloads.push(payload));

    const handled = bridgePtyEvent({
      type: "agent-rate-limit-observed",
      terminalId: "term-1",
      observedAt: 1_000,
      timestamp: 1_000,
    });

    expect(handled).toBe(true);
    expect(payloads).toEqual([{ terminalId: "term-1", observedAt: 1_000, timestamp: 1_000 }]);
  });

  it("forwards a fallback offer from the host, and drops one with an unknown reason (#14370)", () => {
    const payloads: unknown[] = [];
    events.on("agent:fallback-triggered", (payload) => payloads.push(payload));
    const base = {
      terminalId: "term-1",
      agentId: "claude",
      fromPresetId: "work",
      originalPresetId: "home",
      timestamp: 1_000,
    };

    expect(
      bridgePtyEvent({
        type: "agent-fallback-triggered",
        payload: { ...base, reason: "rate-limit" },
      })
    ).toBe(true);
    bridgePtyEvent({
      type: "agent-fallback-triggered",
      payload: { ...base, reason: "auth", exitCode: 1 },
    });
    bridgePtyEvent({
      type: "agent-fallback-triggered",
      payload: { ...base, reason: "user-error" as never, exitCode: 1 },
    });
    bridgePtyEvent({
      type: "agent-fallback-triggered",
      payload: { ...base, reason: "auth", timestamp: Number.NaN },
    });
    bridgePtyEvent({ type: "agent-fallback-triggered", payload: null as never });

    expect(payloads).toEqual([
      { ...base, reason: "rate-limit" },
      { ...base, reason: "auth", exitCode: 1 },
    ]);
  });

  it("forwards a handback with its code, and drops a code of the wrong shape", () => {
    const codes: Array<string | undefined> = [];
    events.on("agent:handback-observed", (payload) => codes.push(payload.code));
    const handback = { message: "done", observedAt: 1_000, truncated: false };

    for (const code of ["k7f3qa", "../etc", undefined]) {
      bridgePtyEvent({
        type: "agent-handback-observed",
        terminalId: "term-1",
        handback,
        ...(code !== undefined ? { code } : {}),
        timestamp: 1_000,
      });
    }

    expect(codes).toEqual(["k7f3qa", undefined, undefined]);
  });

  it("forwards the pane's last transition with a handback, and drops one that is not a time (#15726)", () => {
    const seen: Array<number | undefined> = [];
    events.on("agent:handback-observed", (payload) => seen.push(payload.lastStateChange));
    const handback = { message: "done", observedAt: 1_000, truncated: false };

    for (const lastStateChange of [
      900,
      0,
      1_792_317_600_123,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "900",
      undefined,
    ]) {
      bridgePtyEvent({
        type: "agent-handback-observed",
        terminalId: "term-1",
        handback,
        ...(lastStateChange !== undefined ? { lastStateChange: lastStateChange as number } : {}),
        timestamp: 1_000,
      });
    }

    expect(seen).toEqual([900, 0, 1_792_317_600_123, undefined, undefined, undefined, undefined]);
  });

  it("forwards a scheduled run's report, and drops one that crossed malformed (#15982)", () => {
    const seen: unknown[] = [];
    events.on("agent:run-handback-observed", (payload) => seen.push(payload));
    const report = {
      type: "agent-run-handback-observed" as const,
      terminalId: "term-1",
      spawnedAt: 900,
      code: "k7f3qa",
      report: "needs-you" as const,
      message: "the migration needs a decision",
      truncated: false,
      observedAt: 1_000,
      timestamp: 1_000,
    };

    bridgePtyEvent(report);
    bridgePtyEvent({ ...report, message: null, report: "done" });
    for (const malformed of [
      { code: "../etc" },
      { report: "finished" },
      { spawnedAt: Number.NaN },
      { message: "x".repeat(HANDBACK_MESSAGE_MAX_CHARS + 1) },
      { message: 42 },
      { truncated: "no" },
      { observedAt: Number.POSITIVE_INFINITY },
    ]) {
      bridgePtyEvent({ ...report, ...malformed } as unknown as typeof report);
    }

    const { type: _type, ...forwarded } = report;
    expect(seen).toEqual([forwarded, { ...forwarded, message: null, report: "done" }]);
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

  it("forwards the settle's handback onto the main bus, and only on that settle (#12488)", () => {
    const payloads: Array<Record<string, unknown>> = [];
    events.on("agent:state-changed", (payload) => {
      payloads.push(payload as unknown as Record<string, unknown>);
    });
    const lastHandback = {
      message: "fixed the flaky test",
      observedAt: 1_700_000_000_000,
      submissionToken: "tok-1",
      truncated: false,
    };

    bridgePtyEvent({
      type: "agent-state",
      id: "term-settled",
      agentId: "claude",
      state: "waiting",
      previousState: "working",
      timestamp: Date.now(),
      trigger: "activity",
      confidence: 1.0,
      lastHandback,
    });
    bridgePtyEvent({
      type: "agent-state",
      id: "term-settled",
      agentId: "claude",
      state: "working",
      previousState: "waiting",
      timestamp: Date.now(),
      trigger: "activity",
      confidence: 1.0,
    });

    expect(payloads[0]?.lastHandback).toEqual(lastHandback);
    expect(payloads[1]).not.toHaveProperty("lastHandback");
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
    const payloads: Array<{
      sessionId: string;
      worktreeId: string | null;
      terminalId: string;
      launchGeneration: number | null | undefined;
      boundary: string;
    }> = [];
    events.on("agent-session:captured", (payload) => {
      payloads.push({
        sessionId: payload.record.sessionId,
        worktreeId: payload.record.worktreeId,
        terminalId: payload.terminalId,
        launchGeneration: payload.launchGeneration,
        boundary: payload.boundary,
      });
    });

    const handled = bridgePtyEvent({
      type: "agent-session-captured",
      terminalId: "term-9",
      launchGeneration: 3,
      boundary: "exit",
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
    expect(payloads).toEqual([
      {
        sessionId: "sess-1",
        worktreeId: null,
        terminalId: "term-9",
        launchGeneration: 3,
        // Provenance must survive the hop: only an exit may touch the saved pane.
        boundary: "exit",
      },
    ]);
  });

  it("forwards the trash letting a terminal go, with which trash it was", () => {
    const heard: Array<{ id: string; expiresAt: number }> = [];
    events.on("terminal:trash-cleared", (payload) => heard.push(payload));
    const handled = bridgePtyEvent({
      type: "terminal-trash-cleared",
      id: "term-3",
      expiresAt: 1_800_000_020_000,
    });
    expect(handled).toBe(true);
    expect(heard).toEqual([{ id: "term-3", expiresAt: 1_800_000_020_000 }]);
  });

  it("returns false for unhandled event types", () => {
    const handled = bridgePtyEvent({ type: "unknown-event" } as never);
    expect(handled).toBe(false);
  });
});
