import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const busListeners = vi.hoisted(() => new Set<(payload: unknown) => void>());
vi.mock("../../services/events.js", () => ({
  events: {
    on: (_event: string, handler: (payload: unknown) => void) => {
      busListeners.add(handler);
      return () => busListeners.delete(handler);
    },
  },
}));
vi.mock("../../utils/webContentsLifecycle.js", () => ({ unfreezeWebContents: vi.fn() }));

import { initAgentStateCache } from "../ProjectViewAgentStateCache.js";

type Info = { id: string; projectId?: string; agentState?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeFixture() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const fullReplies: Array<ReturnType<typeof deferred<Info[]>>> = [];
  const singleReplies = new Map<string, ReturnType<typeof deferred<Info | null>>>();
  const ptyClient = {
    getAllTerminalsAsync: vi.fn(() => {
      const d = deferred<Info[]>();
      fullReplies.push(d);
      return d.promise;
    }),
    getTerminalAsync: vi.fn((id: string) => {
      const d = deferred<Info | null>();
      singleReplies.set(id, d);
      return d.promise;
    }),
    getTerminalProjectId: vi.fn((_id: string): string | null => null),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
    }),
    off: vi.fn(),
  };
  const host = {
    disposed: false,
    agentCacheCleanup: [] as Array<() => void>,
    projectByTerminal: new Map<string, string>(),
    agentStateByTerminal: new Map<string, string>(),
    efficiencyFreezeEnabled: false,
    activeProjectId: null,
    views: new Map(),
    unfreezeActiveAgentViews: vi.fn(),
  };
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.(...args);
  const stateChanged = (terminalId: string, state: string) => {
    for (const handler of busListeners) handler({ terminalId, state });
  };
  return { ptyClient, host, fullReplies, singleReplies, emit, stateChanged };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function seeded(initial: Info[] = []) {
  const f = makeFixture();
  const ready = initAgentStateCache(f.host as never, f.ptyClient as never);
  f.fullReplies[0].resolve(initial);
  await ready;
  f.ptyClient.getAllTerminalsAsync.mockClear();
  f.host.unfreezeActiveAgentViews.mockClear();
  return f;
}

describe("ProjectViewAgentStateCache", () => {
  beforeEach(() => {
    busListeners.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps a successfully spawned terminal with one lookup instead of a full reseed", async () => {
    const f = await seeded([{ id: "t0", projectId: "p0", agentState: "idle" }]);
    f.ptyClient.getTerminalProjectId.mockReturnValue("p1");

    f.emit("spawn-result", "t1", { success: true, id: "t1" });
    expect(f.host.projectByTerminal.get("t1")).toBe("p1");

    f.singleReplies.get("t1")!.resolve({ id: "t1", projectId: "p1", agentState: "working" });
    await flush();

    expect(f.ptyClient.getAllTerminalsAsync).not.toHaveBeenCalled();
    expect(f.ptyClient.getTerminalAsync).toHaveBeenCalledTimes(1);
    expect(f.host.agentStateByTerminal.get("t1")).toBe("working");
    expect(f.host.projectByTerminal.get("t0")).toBe("p0");
    expect(f.host.unfreezeActiveAgentViews).toHaveBeenCalledTimes(1);
  });

  it("falls back to a full reseed for a failed spawn-result", async () => {
    const f = await seeded([{ id: "t0", projectId: "p0", agentState: "working" }]);

    f.emit("spawn-result", "t1", { success: false, id: "t1" });
    f.fullReplies[1].resolve([]);
    await flush();

    expect(f.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(f.host.projectByTerminal.size).toBe(0);
    expect(f.host.agentStateByTerminal.size).toBe(0);
  });

  it("coalesces reseeds requested while one is in flight into a single rerun", async () => {
    const f = await seeded();

    f.emit("host-crash");
    f.emit("host-crash");
    f.emit("host-crash");
    expect(f.ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);

    f.fullReplies[1].resolve([{ id: "old", projectId: "p0", agentState: "idle" }]);
    await flush();
    expect(f.ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(2);

    f.fullReplies[2].resolve([{ id: "new", projectId: "p0", agentState: "working" }]);
    await flush();
    expect(f.ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(2);
    expect([...f.host.projectByTerminal.keys()]).toEqual(["new"]);
    expect(f.host.agentStateByTerminal.get("new")).toBe("working");
  });

  it("keeps a terminal spawned while a full reseed is in flight", async () => {
    const f = await seeded();
    f.emit("host-crash");

    f.ptyClient.getTerminalProjectId.mockReturnValue("p1");
    f.emit("spawn-result", "t1", { success: true, id: "t1" });
    f.singleReplies.get("t1")!.resolve({ id: "t1", projectId: "p1", agentState: "working" });
    await flush();

    // The snapshot left the host before t1 existed.
    f.fullReplies[1].resolve([]);
    await flush();

    expect(f.host.projectByTerminal.get("t1")).toBe("p1");
    expect(f.host.agentStateByTerminal.get("t1")).toBe("working");
  });

  it("does not let an older snapshot resurrect a terminal that exited meanwhile", async () => {
    const f = await seeded([{ id: "t1", projectId: "p1", agentState: "working" }]);
    f.emit("host-crash");

    f.emit("exit", "t1", 0);
    f.fullReplies[1].resolve([{ id: "t1", projectId: "p1", agentState: "working" }]);
    await flush();

    expect(f.host.projectByTerminal.has("t1")).toBe(false);
    expect(f.host.agentStateByTerminal.has("t1")).toBe(false);
  });

  it("does not let an older snapshot overwrite a newer agent state event", async () => {
    const f = await seeded([{ id: "t1", projectId: "p1", agentState: "idle" }]);
    f.emit("host-crash");

    f.stateChanged("t1", "working");
    f.fullReplies[1].resolve([{ id: "t1", projectId: "p1", agentState: "idle" }]);
    await flush();

    expect(f.host.projectByTerminal.get("t1")).toBe("p1");
    expect(f.host.agentStateByTerminal.get("t1")).toBe("working");
  });

  it("does not let a spawn lookup overwrite a newer agent state event", async () => {
    const f = await seeded();
    f.emit("spawn-result", "t1", { success: true, id: "t1" });

    f.stateChanged("t1", "waiting");
    f.singleReplies.get("t1")!.resolve({ id: "t1", projectId: "p1", agentState: "idle" });
    await flush();

    expect(f.host.projectByTerminal.get("t1")).toBe("p1");
    expect(f.host.agentStateByTerminal.get("t1")).toBe("waiting");
  });

  it("drops a spawn lookup reply for a terminal that exited meanwhile", async () => {
    const f = await seeded();
    f.emit("spawn-result", "t1", { success: true, id: "t1" });

    f.emit("exit", "t1", 0);
    f.singleReplies.get("t1")!.resolve({ id: "t1", projectId: "p1", agentState: "working" });
    await flush();

    expect(f.host.projectByTerminal.has("t1")).toBe(false);
    expect(f.host.agentStateByTerminal.has("t1")).toBe(false);
  });

  it("still applies snapshot values for terminals untouched during the reseed", async () => {
    const f = await seeded([{ id: "stale", projectId: "p0", agentState: "working" }]);
    f.emit("host-crash");

    f.stateChanged("other", "working");
    f.fullReplies[1].resolve([{ id: "t2", projectId: "p2", agentState: "idle" }]);
    await flush();

    expect(f.host.projectByTerminal.has("stale")).toBe(false);
    expect(f.host.agentStateByTerminal.has("stale")).toBe(false);
    expect(f.host.projectByTerminal.get("t2")).toBe("p2");
    expect(f.host.agentStateByTerminal.get("t2")).toBe("idle");
    expect(f.host.agentStateByTerminal.get("other")).toBe("working");
  });

  it("reconciles with one full list once a burst of spawn-results settles", async () => {
    const f = await seeded([{ id: "dead", projectId: "p0", agentState: "working" }]);
    for (const id of ["t1", "t2", "t3"]) {
      f.emit("spawn-result", id, { success: true, id });
      f.singleReplies.get(id)!.resolve({ id, projectId: "p1", agentState: "idle" });
      await flush();
      vi.advanceTimersByTime(100);
    }
    expect(f.ptyClient.getAllTerminalsAsync).not.toHaveBeenCalled();
    // A missed exit: "dead" is still cached until the reconcile lands.
    expect(f.host.projectByTerminal.has("dead")).toBe(true);

    vi.advanceTimersByTime(250);
    expect(f.ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
    f.fullReplies[1].resolve(
      ["t1", "t2", "t3"].map((id) => ({ id, projectId: "p1", agentState: "idle" }))
    );
    await flush();

    expect(f.host.projectByTerminal.has("dead")).toBe(false);
    expect(f.host.agentStateByTerminal.has("dead")).toBe(false);
    expect([...f.host.projectByTerminal.keys()].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("caps the reconcile delay under a steady stream of spawn-results", async () => {
    const f = await seeded();
    for (let i = 0; i < 12; i++) {
      f.emit("spawn-result", `t${i}`, { success: true, id: `t${i}` });
      vi.advanceTimersByTime(100);
    }
    expect(f.ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
  });

  it("repairs a successor dropped by its predecessor's late exit", async () => {
    const f = await seeded();
    f.ptyClient.getTerminalProjectId.mockReturnValue("p1");
    f.emit("spawn-result", "t1", { success: true, id: "t1" });
    // The killed predecessor's exit arrives after the successor spawned.
    f.emit("exit", "t1", 0);
    f.singleReplies.get("t1")!.resolve({ id: "t1", projectId: "p1", agentState: "working" });
    await flush();
    expect(f.host.projectByTerminal.has("t1")).toBe(false);

    vi.advanceTimersByTime(250);
    f.fullReplies[1].resolve([{ id: "t1", projectId: "p1", agentState: "working" }]);
    await flush();

    expect(f.host.projectByTerminal.get("t1")).toBe("p1");
    expect(f.host.agentStateByTerminal.get("t1")).toBe("working");
  });

  it("drops a cached agent state the spawn lookup reports as absent", async () => {
    const f = await seeded([{ id: "t1", projectId: "p1", agentState: "working" }]);
    f.emit("spawn-result", "t1", { success: true, id: "t1" });
    f.singleReplies.get("t1")!.resolve({ id: "t1", projectId: "p1" });
    await flush();

    expect(f.host.projectByTerminal.get("t1")).toBe("p1");
    expect(f.host.agentStateByTerminal.has("t1")).toBe(false);
  });

  it("still wakes views when the spawn lookup comes back empty", async () => {
    const f = await seeded();
    f.stateChanged("t1", "working");
    f.ptyClient.getTerminalProjectId.mockReturnValue("p1");
    f.emit("spawn-result", "t1", { success: true, id: "t1" });
    f.singleReplies.get("t1")!.resolve(null);
    await flush();

    expect(f.host.projectByTerminal.get("t1")).toBe("p1");
    expect(f.host.unfreezeActiveAgentViews).toHaveBeenCalledTimes(1);
  });

  it("still wakes views when the spawn lookup rejects", async () => {
    const f = await seeded();
    f.ptyClient.getTerminalProjectId.mockReturnValue("p1");
    f.ptyClient.getTerminalAsync.mockRejectedValueOnce(new Error("shard gone"));
    f.emit("spawn-result", "t1", { success: true, id: "t1" });
    await flush();

    expect(f.host.projectByTerminal.get("t1")).toBe("p1");
    expect(f.host.unfreezeActiveAgentViews).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing project lookup", async () => {
    const f = await seeded();
    f.ptyClient.getTerminalProjectId.mockImplementation(() => {
      throw new Error("boom");
    });
    f.emit("spawn-result", "t1", { success: true, id: "t1" });
    f.singleReplies.get("t1")!.resolve({ id: "t1", projectId: "p1", agentState: "idle" });
    await flush();

    expect(f.host.projectByTerminal.get("t1")).toBe("p1");
  });

  it("ignores replies that land after the wiring is torn down", async () => {
    const f = await seeded();
    f.emit("spawn-result", "t1", { success: true, id: "t1" });
    f.emit("host-crash");
    for (const cleanup of f.host.agentCacheCleanup) cleanup();

    f.singleReplies.get("t1")!.resolve({ id: "t1", projectId: "p1", agentState: "working" });
    f.fullReplies[1].resolve([{ id: "t2", projectId: "p2", agentState: "working" }]);
    await flush();
    vi.advanceTimersByTime(1_000);

    expect(f.host.projectByTerminal.size).toBe(0);
    expect(f.host.agentStateByTerminal.size).toBe(0);
    expect(f.host.unfreezeActiveAgentViews).not.toHaveBeenCalled();
    expect(f.ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
  });
});
