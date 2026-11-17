// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return () => listeners.get(event)!.delete(listener);
    }),
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
});
const terminals = vi.hoisted(() => ({
  snapshot: { terminals: [] as unknown[], degraded: false },
  /** What a direct read of the PTY host answers, past the shared cache. */
  live: { terminals: [] as unknown[], degraded: false },
}));
const stored = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock("../../../services/events.js", () => ({ events: { on: bus.on } }));
vi.mock("../../../services/sharedTerminalSnapshot.js", () => ({
  getSharedTerminalSnapshot: async () => terminals.snapshot,
}));
vi.mock("../../../store.js", () => ({ store: { get: (key: string) => stored.values[key] } }));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({ getAllTerminalsWithCompletenessAsync: async () => terminals.live }),
}));

import { _resetRemoteServicesForTest, getRemoteService } from "../../runtime.js";
import { installHostIdle } from "../hostIdle.js";

beforeEach(() => {
  vi.useFakeTimers();
  bus.listeners.clear();
  terminals.snapshot = { terminals: [], degraded: false };
  terminals.live = { terminals: [], degraded: false };
  stored.values = {};
  _resetRemoteServicesForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("installHostIdle (#17357)", () => {
  it("reads the PTY host itself, past the shared snapshot, for a check before acting (#17361)", async () => {
    const dispose = installHostIdle({ servesViews: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(false);
    // The shared snapshot is from before an agent started; the PTY host knows it now.
    terminals.live = {
      terminals: [{ id: "t1", detectedAgentId: "claude", agentState: "working" }],
      degraded: false,
    };
    await getRemoteService("hostIdle")?.checkFresh();
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(true);
    dispose();
  });

  it("runs the idle clock with no Shell attached, at the host's stored idle time", async () => {
    stored.values.hostIdle = { idleAfterMinutes: 45 };
    const dispose = installHostIdle({ servesViews: false });
    await vi.advanceTimersByTimeAsync(0);

    const observed = getRemoteService("hostIdle")?.observation();
    expect(observed).toMatchObject({ busy: false, idleAfterMinutes: 45 });
    expect(observed!.idleEndsAt! - observed!.lastWorkAt).toBe(45 * 60_000);
    dispose();
  });

  it("holds the clock while a Shell's window is open here, or the terminals can't all be read", async () => {
    const sessionHost = { servesViews: true };
    const dispose = installHostIdle(sessionHost);
    await vi.advanceTimersByTimeAsync(0);
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(true);

    sessionHost.servesViews = false;
    terminals.snapshot = { terminals: [], degraded: true };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(true);

    terminals.snapshot = { terminals: [], degraded: false };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(false);
    dispose();
  });

  it("reads the host's own agents: one waiting holds the clock, one that finished doesn't", async () => {
    terminals.snapshot = {
      terminals: [
        { id: "a", detectedAgentId: "claude", agentState: "completed" },
        { id: "b", detectedAgentId: "codex", agentState: "waiting" },
      ],
      degraded: false,
    };
    const dispose = installHostIdle({ servesViews: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(true);

    terminals.snapshot = {
      terminals: [
        { id: "a", detectedAgentId: "claude", agentState: "completed" },
        { id: "b", detectedAgentId: "codex", agentState: "idle" },
      ],
      degraded: false,
    };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(false);
    dispose();
  });

  it("takes an agent starting to work from its event, before the next check", async () => {
    const dispose = installHostIdle({ servesViews: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(false);

    bus.emit("agent:state-changed", { state: "idle", previousState: "completed" });
    expect(getRemoteService("hostIdle")?.observation().busy).toBe(false);
    for (const state of ["working", "waiting", "directing"]) {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(getRemoteService("hostIdle")?.observation().busy).toBe(false);
      bus.emit("agent:state-changed", { state, previousState: "idle" });
      expect(getRemoteService("hostIdle")?.observation().busy).toBe(true);
    }
    dispose();
  });

  it("stops, unsubscribes and unregisters when disposed", async () => {
    const dispose = installHostIdle({ servesViews: false });
    await vi.advanceTimersByTimeAsync(0);
    dispose();

    expect(getRemoteService("hostIdle")).toBeUndefined();
    expect(bus.listeners.get("agent:state-changed")?.size ?? 0).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
