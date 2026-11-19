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
import type { RemoteViewEndpoint } from "../RemoteViewEndpoint.js";
import type {
  EndpointOpenedListener,
  EndpointSessionHandle,
  TransportChangeListener,
} from "../SessionHost.js";

const MINUTE = 60_000;

/** The parts of a SessionHost the idle clock reads, with a Shell's moves on it. */
function fakeSessionHost(servesViews = false) {
  const opened = new Set<EndpointOpenedListener>();
  const transport = new Set<TransportChangeListener>();
  return {
    servesViews,
    onEndpointOpened(listener: EndpointOpenedListener) {
      opened.add(listener);
      return () => opened.delete(listener);
    },
    onTransportChange(listener: TransportChangeListener) {
      transport.add(listener);
      return () => transport.delete(listener);
    },
    /** A Shell opens a view here. */
    openView() {
      for (const listener of [...opened]) {
        listener({} as RemoteViewEndpoint, {} as EndpointSessionHandle);
      }
    },
    /** A link carrying a view drops, or resumes. */
    transport(attached: boolean) {
      for (const listener of [...transport]) listener(["remote:s1:view-1"], attached);
    },
    get listeners() {
      return opened.size + transport.size;
    },
  };
}

const idle = () => getRemoteService("hostIdle")!.observation();

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
    const dispose = installHostIdle(fakeSessionHost());
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
    const dispose = installHostIdle(fakeSessionHost());
    await vi.advanceTimersByTimeAsync(0);

    const observed = getRemoteService("hostIdle")?.observation();
    expect(observed).toMatchObject({ busy: false, idleAfterMinutes: 45 });
    expect(observed!.idleEndsAt! - observed!.lastWorkAt).toBe(45 * 60_000);
    dispose();
  });

  it("holds the clock while a Shell's window is open here, or the terminals can't all be read", async () => {
    const sessionHost = fakeSessionHost(true);
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
    const dispose = installHostIdle(fakeSessionHost());
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
    const dispose = installHostIdle(fakeSessionHost());
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

  it("restarts the idle time for a window opened and closed between two checks (#17920)", async () => {
    const sessionHost = fakeSessionHost();
    const dispose = installHostIdle(sessionHost);
    await vi.advanceTimersByTimeAsync(0);
    const endsAt = idle().idleEndsAt!;
    const idleTime = idle().idleAfterMinutes * MINUTE;

    // Ten seconds before the idle time ends, five after the last check.
    await vi.advanceTimersByTimeAsync(idleTime - 10_000);
    sessionHost.servesViews = true;
    sessionHost.openView();
    sessionHost.servesViews = false;
    expect(idle().busy).toBe(true);

    // The check that ends the old idle time can't see the window, but it was
    // counted: the first check to find none starts a full idle time again.
    await vi.advanceTimersByTimeAsync(endsAt - Date.now());
    const restarted = { busy: false, lastWorkAt: endsAt, idleEndsAt: endsAt + idleTime };
    expect(idle()).toMatchObject(restarted);
    // And so is the last look before a stop.
    await getRemoteService("hostIdle")!.checkFresh();
    expect(idle()).toMatchObject(restarted);
    dispose();
  });

  it("restarts the idle time for a link that resumed with views and dropped between two checks (#17920)", async () => {
    const sessionHost = fakeSessionHost();
    const dispose = installHostIdle(sessionHost);
    await vi.advanceTimersByTimeAsync(0);
    const endsAt = idle().idleEndsAt!;
    const idleTime = idle().idleAfterMinutes * MINUTE;

    await vi.advanceTimersByTimeAsync(idleTime - 10_000);
    sessionHost.servesViews = true;
    sessionHost.transport(true);
    sessionHost.servesViews = false;
    sessionHost.transport(false);
    expect(idle().busy).toBe(true);

    await vi.advanceTimersByTimeAsync(endsAt - Date.now());
    const restarted = { busy: false, lastWorkAt: endsAt, idleEndsAt: endsAt + idleTime };
    expect(idle()).toMatchObject(restarted);
    await getRemoteService("hostIdle")!.checkFresh();
    expect(idle()).toMatchObject(restarted);
    dispose();
  });

  it("leaves the idle time running when a link only drops (#17920)", async () => {
    // A link with no view raises nothing at all (SessionHost.test.ts); one
    // that drops takes its views away, which is no new work.
    const sessionHost = fakeSessionHost();
    const dispose = installHostIdle(sessionHost);
    await vi.advanceTimersByTimeAsync(0);
    const endsAt = idle().idleEndsAt!;

    await vi.advanceTimersByTimeAsync(idle().idleAfterMinutes * MINUTE - 10_000);
    sessionHost.transport(false);
    expect(idle()).toMatchObject({ busy: false, idleEndsAt: endsAt });

    await vi.advanceTimersByTimeAsync(endsAt - Date.now());
    await getRemoteService("hostIdle")!.checkFresh();
    expect(idle()).toMatchObject({ busy: false, idleEndsAt: endsAt });
    dispose();
  });

  describe("a claim on the ended idle time (#17922)", () => {
    const claim = async () => {
      const tracker = getRemoteService("hostIdle")!;
      return tracker.tryClaim(await tracker.checkFresh(), Symbol("shell-link"));
    };

    it.each([
      [
        "working agent",
        {
          terminals: [{ id: "t1", detectedAgentId: "claude", agentState: "working" }],
          degraded: false,
        },
      ],
      [
        "agent whose state can't be read",
        {
          terminals: [{ id: "t1", detectedAgentId: "claude", agentState: "thinking" }],
          degraded: false,
        },
      ],
      ["degraded read", { terminals: [], degraded: true }],
    ])(
      "is refused for a %s the PTY host reports, whatever the shared snapshot says",
      async (_name, live) => {
        const dispose = installHostIdle(fakeSessionHost());
        await vi.advanceTimersByTimeAsync(31 * MINUTE);
        expect(idle().busy).toBe(false);
        terminals.live = live;
        expect(await claim()).toBe(false);
        expect(idle().busy).toBe(true);
        dispose();
      }
    );

    it("is ended by work a check finds, so the next idle time can be claimed", async () => {
      const dispose = installHostIdle(fakeSessionHost());
      await vi.advanceTimersByTimeAsync(31 * MINUTE);
      expect(await claim()).toBe(true);
      terminals.snapshot = { terminals: [], degraded: true };
      await vi.advanceTimersByTimeAsync(15_000);
      expect(idle().busy).toBe(true);
      terminals.snapshot = { terminals: [], degraded: false };
      await vi.advanceTimersByTimeAsync(31 * MINUTE);
      expect(await claim()).toBe(true);
      dispose();
    });

    it("is spent across a link only dropping, and restarted by a view opening", async () => {
      const sessionHost = fakeSessionHost();
      const dispose = installHostIdle(sessionHost);
      await vi.advanceTimersByTimeAsync(31 * MINUTE);
      expect(await claim()).toBe(true);
      sessionHost.transport(false);
      await vi.advanceTimersByTimeAsync(31 * MINUTE);
      expect(await claim()).toBe(false);

      sessionHost.servesViews = true;
      sessionHost.openView();
      sessionHost.servesViews = false;
      await vi.advanceTimersByTimeAsync(31 * MINUTE);
      expect(await claim()).toBe(true);
      dispose();
    });
  });

  it("stops, unsubscribes and unregisters when disposed", async () => {
    const sessionHost = fakeSessionHost();
    const dispose = installHostIdle(sessionHost);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionHost.listeners).toBe(2);
    dispose();

    expect(getRemoteService("hostIdle")).toBeUndefined();
    expect(bus.listeners.get("agent:state-changed")?.size ?? 0).toBe(0);
    expect(sessionHost.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
