import { describe, it, expect, vi } from "vitest";
import { createConnectionHandlers } from "../connection.js";
import { SharedRingBuffer } from "../../../../shared/utils/SharedRingBuffer.js";
import { computePoolEnvHash } from "../../../services/pty/ptyPoolEnvHash.js";
import type { HostContext } from "../types.js";

function makeCtx(stateRef: {
  visualBuffers: SharedRingBuffer[];
  visualSignalView: Int32Array | null;
  analysisBuffer: SharedRingBuffer | null;
}): HostContext {
  const ptyManager = {
    setSabMode: vi.fn(),
    isSabMode: vi.fn(() => true),
    resize: vi.fn(),
    write: vi.fn(),
    mayDriveFrom: vi.fn(() => true),
    setDriveLeases: vi.fn(),
  } as unknown as HostContext["ptyManager"];

  return {
    analysisWorkerPool: null,
    ptyManager,
    pluginPtyManager: {} as HostContext["pluginPtyManager"],
    processTreeCache: {} as HostContext["processTreeCache"],
    terminalResourceMonitor: {} as HostContext["terminalResourceMonitor"],
    backpressureManager: {} as HostContext["backpressureManager"],
    ipcQueueManager: {} as HostContext["ipcQueueManager"],
    resourceGovernor: {} as HostContext["resourceGovernor"],
    packetFramer: {} as HostContext["packetFramer"],
    pauseCoordinators: new Map(),
    rendererConnections: new Map(),
    windowProjectMap: new Map(),
    fallbackEligibleProjects: new Set(),
    windowFocusedTerminalMap: new Map(),
    ipcDataMirrorTerminals: new Set(),
    // Mirror the production wiring: getter/setter pairs read & write the
    // outer module-level state. Handlers must see the *current* value, not
    // a snapshot taken at factory construction time.
    get visualBuffers() {
      return stateRef.visualBuffers;
    },
    set visualBuffers(value: SharedRingBuffer[]) {
      stateRef.visualBuffers = value;
    },
    get visualSignalView() {
      return stateRef.visualSignalView;
    },
    set visualSignalView(value: Int32Array | null) {
      stateRef.visualSignalView = value;
    },
    get analysisBuffer() {
      return stateRef.analysisBuffer;
    },
    set analysisBuffer(value: SharedRingBuffer | null) {
      stateRef.analysisBuffer = value;
    },
    ptyPool: null,
    initialPoolWarmDeferred: false,
    sendEvent: vi.fn(),
    getPauseCoordinator: vi.fn(),
    getOrCreatePauseCoordinator: vi.fn(),
    disconnectWindow: vi.fn(),
    recomputeActivityTiers: vi.fn(),
    tryReplayAndResume: vi.fn(),
    resumePausedTerminal: vi.fn(),
    createPortQueueManager: vi.fn(),
    createTerminalWorkerPortQueueManager: vi.fn(),
    terminalWorkerConnections: new Map(),
    disconnectTerminalWorkerPort: vi.fn(),
    getPausedDurationsSnapshot: vi.fn(() => []),
    getDropTallySnapshot: vi.fn(() => []),
  };
}

describe("init-buffers handler", () => {
  it("populates visualBuffers, visualSignalView, and analysisBuffer via the ctx setters", () => {
    // The whole reason HostContext uses getter/setter pairs is that
    // init-buffers swaps in fresh SharedRingBuffer instances after factory
    // construction. If the handler captured a local snapshot of
    // `ctx.visualBuffers` it would silently keep using the empty array.
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);

    const visualBuffer = SharedRingBuffer.create(4096);
    const analysisBuffer = SharedRingBuffer.create(4096);
    const signalBuffer = new SharedArrayBuffer(4);

    handlers["init-buffers"]({
      visualBuffers: [visualBuffer],
      visualSignalBuffer: signalBuffer,
      analysisBuffer,
    });

    expect(stateRef.visualBuffers).toHaveLength(1);
    expect(stateRef.visualBuffers[0]).toBeInstanceOf(SharedRingBuffer);
    expect(stateRef.visualSignalView).toBeInstanceOf(Int32Array);
    expect(stateRef.analysisBuffer).toBeInstanceOf(SharedRingBuffer);
    expect(ctx.ptyManager.setSabMode).toHaveBeenCalledWith(true);
  });

  it("does not enable SAB mode if visualBuffers is missing or invalid", () => {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    handlers["init-buffers"]({
      visualBuffers: undefined,
      visualSignalBuffer: undefined,
      analysisBuffer: undefined,
    });

    expect(ctx.ptyManager.setSabMode).not.toHaveBeenCalled();
    expect(stateRef.visualBuffers).toHaveLength(0);
    expect(stateRef.visualSignalView).toBeNull();
    expect(stateRef.analysisBuffer).toBeNull();
  });

  it("project handler updates the window→project map and recomputes activity tiers", () => {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);

    handlers["set-active-project"]({ windowId: 1, projectId: "proj-a" });

    expect(ctx.windowProjectMap.get(1)).toBe("proj-a");
    expect(ctx.recomputeActivityTiers).toHaveBeenCalledTimes(1);
    expect(ctx.recomputeActivityTiers).toHaveBeenCalledWith("proj-a");
  });

  it("set-fallback-eligible-projects replaces the set rather than merging (#12557)", () => {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);

    handlers["set-fallback-eligible-projects"]({ projectIds: ["proj-a", "proj-b"] });
    expect([...ctx.fallbackEligibleProjects]).toEqual(["proj-a", "proj-b"]);

    // Main recomputes the whole set from its registry, so this is a replace:
    // merging would keep the IPC fallback open for proj-b forever.
    handlers["set-fallback-eligible-projects"]({ projectIds: ["proj-c"] });
    expect([...ctx.fallbackEligibleProjects]).toEqual(["proj-c"]);

    // An empty list is a legitimate "nothing is eligible any more".
    handlers["set-fallback-eligible-projects"]({ projectIds: [] });
    expect([...ctx.fallbackEligibleProjects]).toEqual([]);
  });

  it("set-fallback-eligible-projects rejects a malformed list outright (#12557)", () => {
    // Filtering junk out of a partly-valid list would silently narrow the set
    // and starve whatever it dropped. Reject the payload and keep the last
    // known-good one instead.
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);
    handlers["set-fallback-eligible-projects"]({ projectIds: ["proj-a", "proj-b"] });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handlers["set-fallback-eligible-projects"]({ projectIds: ["proj-a", "", 7, null] });
    warn.mockRestore();

    expect([...ctx.fallbackEligibleProjects]).toEqual(["proj-a", "proj-b"]);
  });

  it("set-fallback-eligible-projects leaves the set alone when projectIds is not an array (#12557)", () => {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);
    ctx.fallbackEligibleProjects.add("proj-a");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handlers["set-fallback-eligible-projects"]({});
    warn.mockRestore();

    expect([...ctx.fallbackEligibleProjects]).toEqual(["proj-a"]);
  });

  it("project-switch handler updates the window→project map and recomputes activity tiers scoped to the new project (#10857)", () => {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    const handlers = createConnectionHandlers(ctx);

    handlers["project-switch"]({ windowId: 1, projectId: "proj-b" });

    expect(ctx.windowProjectMap.get(1)).toBe("proj-b");
    expect(ctx.recomputeActivityTiers).toHaveBeenCalledTimes(1);
    expect(ctx.recomputeActivityTiers).toHaveBeenCalledWith("proj-b");
  });
});

describe("set-active-project pool warming (#9774)", () => {
  interface FakePool {
    drainAndRefill: ReturnType<typeof vi.fn>;
    warmForKey: ReturnType<typeof vi.fn>;
    getMaxEntries: () => number;
    getMaxPoolSize: () => number;
  }

  function makePoolCtx(pool: FakePool) {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    ctx.ptyPool = pool as unknown as HostContext["ptyPool"];
    return ctx;
  }

  function makeFakePool(
    overrides: Partial<FakePool> = {},
    drainResult: Promise<void> = Promise.resolve()
  ): FakePool {
    return {
      drainAndRefill: vi.fn(() => drainResult),
      warmForKey: vi.fn(),
      getMaxEntries: () => 8,
      getMaxPoolSize: () => 2,
      ...overrides,
    };
  }

  it("warms each restored panel cwd with the env-empty hash after drain resolves", async () => {
    const pool = makeFakePool();
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/repo/wt-a", "/repo/wt-b"],
    });

    expect(pool.drainAndRefill).toHaveBeenCalledWith("/repo");
    // Warms fire only after the drain promise resolves.
    await Promise.resolve();
    await Promise.resolve();

    expect(pool.warmForKey).toHaveBeenCalledTimes(2);
    expect(pool.warmForKey.mock.calls[0]?.[0]).toBe("/repo/wt-a");
    expect(pool.warmForKey.mock.calls[1]?.[0]).toBe("/repo/wt-b");
    // Each warm uses the env-empty hash (3rd arg) matching plain-shell acquires.
    for (const call of pool.warmForKey.mock.calls) {
      expect(call[1]).toBeUndefined();
      expect(typeof call[2]).toBe("string");
      expect(call[2]).toBe(pool.warmForKey.mock.calls[0]?.[2]);
    }
  });

  it("does not warm panel cwds before the root drain resolves", async () => {
    let resolveDrain!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const pool = makeFakePool({}, deferred);
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/repo/wt-a"],
    });

    // Drain is in flight — no warms yet.
    await Promise.resolve();
    expect(pool.warmForKey).not.toHaveBeenCalled();

    resolveDrain();
    await deferred;
    await Promise.resolve();
    expect(pool.warmForKey).toHaveBeenCalledTimes(1);
  });

  it("caps warmed panel cwds so high-priority entries aren't evicted (#9774)", async () => {
    // maxEntries=8, poolSize=2 → root takes 2, leaving room for 3 panel keys.
    const pool = makeFakePool();
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/wt/a", "/wt/b", "/wt/c", "/wt/d", "/wt/e"],
    });

    await Promise.resolve();
    await Promise.resolve();

    // Only the first 3 (highest priority) cwds are warmed; lower-priority
    // ones are dropped rather than evicting the earlier warms.
    expect(pool.warmForKey).toHaveBeenCalledTimes(3);
    expect(pool.warmForKey.mock.calls.map((c) => c[0])).toEqual(["/wt/a", "/wt/b", "/wt/c"]);
  });

  it("skips warming when no pool is present (e.g. Windows)", () => {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    // ctx.ptyPool stays null (default) — mirrors the Windows pool-disabled path.
    const handlers = createConnectionHandlers(ctx);

    expect(() =>
      handlers["set-active-project"]({
        windowId: 1,
        projectId: "proj-a",
        projectPath: "/repo",
        panelCwds: ["/repo/wt-a"],
      })
    ).not.toThrow();
    expect(ctx.windowProjectMap.get(1)).toBe("proj-a");
  });
});

describe("deferred boot pool warm (#10393)", () => {
  interface FakePool {
    drainAndRefill: ReturnType<typeof vi.fn>;
    warmPool: ReturnType<typeof vi.fn>;
    warmForKey: ReturnType<typeof vi.fn>;
    getMaxEntries: () => number;
    getMaxPoolSize: () => number;
  }

  function makeDeferredCtx(deferred: boolean) {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const pool: FakePool = {
      drainAndRefill: vi.fn(() => Promise.resolve()),
      warmPool: vi.fn(() => Promise.resolve()),
      warmForKey: vi.fn(),
      getMaxEntries: () => 8,
      getMaxPoolSize: () => 2,
    };
    const ctx = makeCtx(stateRef);
    ctx.ptyPool = pool as unknown as HostContext["ptyPool"];
    ctx.initialPoolWarmDeferred = deferred;
    return { ctx, pool };
  }

  it("runs the fallback warm when the restore fell through (no projectPath)", () => {
    const { ctx, pool } = makeDeferredCtx(true);
    const handlers = createConnectionHandlers(ctx);

    handlers["set-active-project"]({ windowId: 1, projectId: null });

    expect(pool.warmPool).toHaveBeenCalledTimes(1);
    expect(pool.drainAndRefill).not.toHaveBeenCalled();
    expect(ctx.initialPoolWarmDeferred).toBe(false);
  });

  it("does not fallback-warm when the boot warm was not deferred", () => {
    const { ctx, pool } = makeDeferredCtx(false);
    const handlers = createConnectionHandlers(ctx);

    handlers["set-active-project"]({ windowId: 1, projectId: null });

    expect(pool.warmPool).not.toHaveBeenCalled();
  });

  it("consumes the deferral via the project drain when a projectPath arrives", () => {
    const { ctx, pool } = makeDeferredCtx(true);
    const handlers = createConnectionHandlers(ctx);

    handlers["set-active-project"]({ windowId: 1, projectId: "proj-a", projectPath: "/repo" });

    expect(pool.drainAndRefill).toHaveBeenCalledWith("/repo");
    expect(pool.warmPool).not.toHaveBeenCalled();
    expect(ctx.initialPoolWarmDeferred).toBe(false);
  });

  it("consumes the deferral on project-switch", () => {
    const { ctx, pool } = makeDeferredCtx(true);
    const handlers = createConnectionHandlers(ctx);

    handlers["project-switch"]({ windowId: 1, projectId: "proj-a", projectPath: "/repo" });

    expect(pool.drainAndRefill).toHaveBeenCalledWith("/repo");
    expect(ctx.initialPoolWarmDeferred).toBe(false);
  });

  it("fallback-warms on a project-switch with no recorded path (restart replay)", () => {
    const { ctx, pool } = makeDeferredCtx(true);
    const handlers = createConnectionHandlers(ctx);

    handlers["project-switch"]({ windowId: 1, projectId: "proj-a" });

    expect(pool.warmPool).toHaveBeenCalledTimes(1);
    expect(pool.drainAndRefill).not.toHaveBeenCalled();
    expect(ctx.initialPoolWarmDeferred).toBe(false);
  });
});

describe("set-active-project non-empty envHash warming (#9810)", () => {
  interface FakePool {
    drainAndRefill: ReturnType<typeof vi.fn>;
    warmForKey: ReturnType<typeof vi.fn>;
    getMaxEntries: () => number;
    getMaxPoolSize: () => number;
  }

  function makePoolCtx(pool: FakePool) {
    const stateRef = {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
    const ctx = makeCtx(stateRef);
    ctx.ptyPool = pool as unknown as HostContext["ptyPool"];
    return ctx;
  }

  function makeFakePool(
    overrides: Partial<FakePool> = {},
    drainResult: Promise<void> = Promise.resolve()
  ): FakePool {
    return {
      drainAndRefill: vi.fn(() => drainResult),
      warmForKey: vi.fn(),
      getMaxEntries: () => 8,
      getMaxPoolSize: () => 2,
      ...overrides,
    };
  }

  it("warms each restored panel cwd with the project env hash when projectEnv is non-empty", async () => {
    const pool = makeFakePool();
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    const projectEnv = { APP_MODE: "x", NODE_ENV: "production" };
    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/repo/wt-a", "/repo/wt-b"],
      projectEnv,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(pool.warmForKey).toHaveBeenCalledTimes(2);
    // The non-empty env is passed as callerEnv so the warmed slot can serve
    // acquires that carry the same merged env.
    expect(pool.warmForKey.mock.calls[0]?.[0]).toBe("/repo/wt-a");
    expect(pool.warmForKey.mock.calls[0]?.[1]).toEqual(projectEnv);
    expect(pool.warmForKey.mock.calls[1]?.[0]).toBe("/repo/wt-b");
    expect(pool.warmForKey.mock.calls[1]?.[1]).toEqual(projectEnv);
    // Both warms use the SAME envHash — it was computed once from projectEnv
    // and is reused for every panel cwd (one envHash, many cwds).
    const envHashA = pool.warmForKey.mock.calls[0]?.[2];
    const envHashB = pool.warmForKey.mock.calls[1]?.[2];
    expect(typeof envHashA).toBe("string");
    expect(envHashA).not.toBe("env-empty");
    expect(envHashA).toBe(envHashB);
    // Lock down the hash VALUE: the warm must produce the exact same hash
    // `acquireByKey` will look up at spawn time, so any drift in
    // `computePoolEnvHash` (forgetting `filterSensitiveOnly`, shadowing the
    // import, etc.) is caught here.
    expect(envHashA).toBe(computePoolEnvHash(projectEnv));
  });

  it("warms no panel cwds when projectEnv carries a secret-named variable", async () => {
    const pool = makeFakePool();
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    // Launches carrying this env bypass the pool (the pool would strip the
    // secret), so a shell warmed for its key could never be taken.
    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/repo/wt-a"],
      projectEnv: { MY_API_KEY: "x", NODE_ENV: "production" },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(pool.drainAndRefill).toHaveBeenCalledWith("/repo");
    expect(pool.warmForKey).not.toHaveBeenCalled();
  });

  it("falls back to env-empty warm (callerEnv undefined) when projectEnv is null", async () => {
    const pool = makeFakePool();
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/repo/wt-a"],
      projectEnv: null,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(pool.warmForKey).toHaveBeenCalledTimes(1);
    expect(pool.warmForKey.mock.calls[0]?.[1]).toBeUndefined();
    expect(pool.warmForKey.mock.calls[0]?.[2]).toBe("env-empty");
  });

  it("falls back to env-empty warm when projectEnv is undefined (back-compat with #9774 callers)", async () => {
    const pool = makeFakePool();
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/repo/wt-a"],
      // projectEnv omitted — must match pre-#9810 behaviour
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(pool.warmForKey).toHaveBeenCalledTimes(1);
    expect(pool.warmForKey.mock.calls[0]?.[1]).toBeUndefined();
    expect(pool.warmForKey.mock.calls[0]?.[2]).toBe("env-empty");
  });

  it("falls back to env-empty warm when projectEnv is an empty object (matches acquirePtyProcess contract)", async () => {
    const pool = makeFakePool();
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/repo/wt-a"],
      projectEnv: {},
    });

    await Promise.resolve();
    await Promise.resolve();

    // `{}` is filtered to nothing by computePoolEnvHash, so the warm collapses
    // to the env-empty path — no point burning a slot on a hash that
    // `acquireByKey` would also produce for the no-caller-env case.
    expect(pool.warmForKey).toHaveBeenCalledTimes(1);
    expect(pool.warmForKey.mock.calls[0]?.[1]).toBeUndefined();
    expect(pool.warmForKey.mock.calls[0]?.[2]).toBe("env-empty");
  });

  it("collapses to env-empty warm when every projectEnv key is filtered by computePoolEnvHash (#9810)", async () => {
    const pool = makeFakePool();
    const handlers = createConnectionHandlers(makePoolCtx(pool));

    // SHLVL, PWD, OLDPWD, _ are VOLATILE_ENV_KEYS — excluded from the hash.
    // DAINTREE_PANE_ID/CWD/PROJECT_ID/WORKTREE_ID are auto-injected — also
    // excluded. So a payload consisting only of those keys hashes to
    // env-empty, and the warm must collapse to the env-empty path (callerEnv
    // undefined) so the slot the next acquire looks up is the right one.
    const allFilteredEnv = {
      SHLVL: "1",
      PWD: "/foo",
      OLDPWD: "/bar",
      _: "/usr/bin/env",
      DAINTREE_PANE_ID: "p-1",
      DAINTREE_CWD: "/repo",
      DAINTREE_PROJECT_ID: "proj-a",
      DAINTREE_WORKTREE_ID: "wt-1",
    };
    handlers["set-active-project"]({
      windowId: 1,
      projectId: "proj-a",
      projectPath: "/repo",
      panelCwds: ["/repo/wt-a"],
      projectEnv: allFilteredEnv,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(pool.warmForKey).toHaveBeenCalledTimes(1);
    expect(pool.warmForKey.mock.calls[0]?.[1]).toBeUndefined();
    expect(pool.warmForKey.mock.calls[0]?.[2]).toBe("env-empty");
  });
});

describe("worker-ingest dedicated ports (#10960)", () => {
  function makeStateRef() {
    return {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
  }

  function makeQueueManagerMock() {
    return {
      removeBytes: vi.fn(),
      tryResume: vi.fn(),
      isAtCapacity: vi.fn(() => false),
      addBytes: vi.fn(),
      applyBackpressure: vi.fn(),
      getUtilization: vi.fn(() => 0),
      getPausedTerminalIds: vi.fn(() => []),
      resumeAll: vi.fn(),
      dispose: vi.fn(),
    };
  }

  function makeNodePort() {
    const listeners = new Map<string, Set<(arg?: unknown) => void>>();
    return {
      started: false,
      closed: false,
      posted: [] as Array<Record<string, unknown>>,
      start() {
        this.started = true;
      },
      close() {
        this.closed = true;
      },
      postMessage(msg: Record<string, unknown>) {
        this.posted.push(msg);
      },
      on(event: string, handler: (arg?: unknown) => void) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(handler);
      },
      removeListener(event: string, handler: (arg?: unknown) => void) {
        listeners.get(event)?.delete(handler);
      },
      emit(event: string, arg?: unknown) {
        listeners.get(event)?.forEach((handler) => handler(arg));
      },
    };
  }

  function makeWorkerIngestHarness() {
    const ctx = makeCtx(makeStateRef());
    const workerQm = makeQueueManagerMock();
    const windowQm = makeQueueManagerMock();
    vi.mocked(ctx.createTerminalWorkerPortQueueManager).mockReturnValue(
      workerQm as unknown as ReturnType<HostContext["createTerminalWorkerPortQueueManager"]>
    );
    vi.mocked(ctx.createPortQueueManager).mockReturnValue(
      windowQm as unknown as ReturnType<HostContext["createPortQueueManager"]>
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const handlers = createConnectionHandlers(ctx);
    const dedicatedPort = makeNodePort();
    const windowPort = makeNodePort();
    return { ctx, handlers, dedicatedPort, windowPort, workerQm, windowQm };
  }

  it("connect-terminal-port stores a disengaged per-terminal connection and starts the port", () => {
    const h = makeWorkerIngestHarness();
    h.handlers["connect-terminal-port"]({ windowId: 1, id: "term-1" }, [h.dedicatedPort] as never);

    const conn = h.ctx.terminalWorkerConnections.get(1)?.get("term-1");
    expect(conn).toBeDefined();
    expect(conn!.engaged).toBe(false);
    expect(h.dedicatedPort.started).toBe(true);
  });

  it("acks arriving on the dedicated port debit the per-terminal queue ledger", () => {
    const h = makeWorkerIngestHarness();
    h.handlers["connect-terminal-port"]({ windowId: 1, id: "term-1" }, [h.dedicatedPort] as never);

    h.dedicatedPort.emit("message", { data: { type: "ack", id: "term-1", bytes: 64 } });

    expect(h.workerQm.removeBytes).toHaveBeenCalledWith("term-1", 64);
    expect(h.workerQm.tryResume).toHaveBeenCalledWith("term-1");
  });

  it("engage flips routing and answers with the marker on the WINDOW port; release posts the sentinel on the dedicated port", () => {
    const h = makeWorkerIngestHarness();
    h.handlers["connect-terminal-port"]({ windowId: 1, id: "term-1" }, [h.dedicatedPort] as never);
    h.handlers["connect-port"]({ windowId: 1 }, [h.windowPort] as never);

    h.windowPort.emit("message", { data: { type: "worker-ingest-engage", id: "term-1" } });

    const conn = h.ctx.terminalWorkerConnections.get(1)!.get("term-1")!;
    expect(conn.engaged).toBe(true);
    expect(h.windowPort.posted).toContainEqual({ type: "worker-ingest-engaged", id: "term-1" });

    h.windowPort.emit("message", {
      data: { type: "worker-ingest-release", id: "term-1", drainId: 3 },
    });
    expect(conn.engaged).toBe(false);
    expect(h.dedicatedPort.posted).toContainEqual({ type: "ingest-detached", drainId: 3 });
  });

  it("a serialize fence flushes held output ahead of the marker, then answers with the snapshot", async () => {
    const h = makeWorkerIngestHarness();
    const snapshot = { data: "SNAP", cols: 90, rows: 30 };
    let serializedAfter: number | null = null;
    (h.ctx.ptyManager as unknown as { getSerializedStateAsync: unknown }).getSerializedStateAsync =
      vi.fn(async () => {
        serializedAfter = h.windowPort.posted.length;
        return snapshot;
      });
    (h.ctx.ptyManager as unknown as { getTerminal: unknown }).getTerminal = vi.fn(() => ({
      projectId: "proj-a",
    }));
    h.ctx.windowProjectMap.set(-7, "proj-a");
    h.handlers["connect-port"]({ windowId: -7 }, [h.windowPort] as never);
    const bytes = new TextEncoder().encode("held");
    h.ctx.rendererConnections.get(-7)!.batcher.write("term-1", bytes, bytes.byteLength);
    expect(h.windowPort.posted).toEqual([]);

    h.windowPort.emit("message", {
      data: { type: "serialize-fence", id: "term-1", requestId: 5 },
    });

    expect(h.windowPort.posted.map((m) => m.type)).toEqual(["data", "serialize-fence"]);
    // Serialized in the same turn as the fence, before anything else could be posted.
    expect(serializedAfter).toBe(2);
    await vi.waitFor(() => expect(h.windowPort.posted).toHaveLength(3));
    expect(h.windowPort.posted[2]).toEqual({
      type: "serialized-state",
      id: "term-1",
      requestId: 5,
      state: snapshot,
    });
  });

  it.each([
    { label: "an ordinary local renderer port", windowId: 1, project: "proj-a" },
    { label: "a remote connection scoped to another project", windowId: -7, project: "proj-b" },
    { label: "a remote connection with no project", windowId: -7, project: null },
  ])("ignores a serialize fence from $label", async ({ windowId, project }) => {
    const h = makeWorkerIngestHarness();
    const serialize = vi.fn(async () => ({ data: "SECRET", cols: 80, rows: 24 }));
    const flushTerminal = vi.fn();
    Object.assign(h.ctx.ptyManager, {
      getSerializedStateAsync: serialize,
      getTerminal: vi.fn(() => ({ projectId: "proj-a" })),
    });
    h.ctx.windowProjectMap.set(windowId, project);
    h.handlers["connect-port"]({ windowId }, [h.windowPort] as never);
    const batcher = h.ctx.rendererConnections.get(windowId)!.batcher;
    vi.spyOn(batcher, "flushTerminal").mockImplementation(flushTerminal);

    h.windowPort.emit("message", {
      data: { type: "serialize-fence", id: "term-1", requestId: 5 },
    });
    await Promise.resolve();

    expect(serialize).not.toHaveBeenCalled();
    expect(flushTerminal).not.toHaveBeenCalled();
    expect(h.windowPort.posted).toEqual([]);
  });

  it("engage without a dedicated connection never posts the marker", () => {
    const h = makeWorkerIngestHarness();
    h.handlers["connect-port"]({ windowId: 1 }, [h.windowPort] as never);

    h.windowPort.emit("message", { data: { type: "worker-ingest-engage", id: "ghost" } });

    expect(h.windowPort.posted.some((msg) => msg.type === "worker-ingest-engaged")).toBe(false);
  });

  it("the dedicated port's close event tears down only that (window, terminal) pair", () => {
    const h = makeWorkerIngestHarness();
    h.handlers["connect-terminal-port"]({ windowId: 1, id: "term-1" }, [h.dedicatedPort] as never);

    h.dedicatedPort.emit("close");

    expect(h.ctx.disconnectTerminalWorkerPort).toHaveBeenCalledWith(1, "term-1", "port-close");
  });

  it("a replacement port for the same terminal disconnects the previous one first", () => {
    const h = makeWorkerIngestHarness();
    h.handlers["connect-terminal-port"]({ windowId: 1, id: "term-1" }, [h.dedicatedPort] as never);
    const replacement = makeNodePort();
    h.handlers["connect-terminal-port"]({ windowId: 1, id: "term-1" }, [replacement] as never);

    expect(h.ctx.disconnectTerminalWorkerPort).toHaveBeenCalledWith(1, "term-1", "port-replace");
    expect(h.ctx.terminalWorkerConnections.get(1)!.get("term-1")!.port).toBe(replacement);
  });

  it("disconnect-terminal-port routes to the ctx teardown with explicit-disconnect", () => {
    const h = makeWorkerIngestHarness();
    h.handlers["disconnect-terminal-port"]({ windowId: 2, id: "term-9" });
    expect(h.ctx.disconnectTerminalWorkerPort).toHaveBeenCalledWith(
      2,
      "term-9",
      "explicit-disconnect"
    );
  });
});

describe("resize transport attribution (#12442)", () => {
  function makeStateRef() {
    return {
      visualBuffers: [] as SharedRingBuffer[],
      visualSignalView: null as Int32Array | null,
      analysisBuffer: null as SharedRingBuffer | null,
    };
  }

  function makeNodePort() {
    const listeners = new Map<string, Set<(arg?: unknown) => void>>();
    return {
      start() {},
      close() {},
      postMessage() {},
      on(event: string, handler: (arg?: unknown) => void) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(handler);
      },
      removeListener(event: string, handler: (arg?: unknown) => void) {
        listeners.get(event)?.delete(handler);
      },
      emit(event: string, arg?: unknown) {
        listeners.get(event)?.forEach((handler) => handler(arg));
      },
    };
  }

  it("names the MessagePort as the transport for a resize it delivers", () => {
    // The renderer's MessagePort reaches this process without passing through
    // Main, so when a collapsed grid is refused at the boundary the log has to
    // say which of the two doors it arrived through — the issue asks for the
    // caller to be named, and this is the half the host owns.
    const ctx = makeCtx(makeStateRef());
    vi.mocked(ctx.createPortQueueManager).mockReturnValue({
      removeBytes: vi.fn(),
      tryResume: vi.fn(),
      isAtCapacity: vi.fn(() => false),
      addBytes: vi.fn(),
      applyBackpressure: vi.fn(),
      getUtilization: vi.fn(() => 0),
      getPausedTerminalIds: vi.fn(() => []),
      resumeAll: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ReturnType<HostContext["createPortQueueManager"]>);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const handlers = createConnectionHandlers(ctx);
    const port = makeNodePort();

    handlers["connect-port"]({ windowId: 1 }, [port] as never);
    port.emit("message", { data: { type: "resize", id: "term-1", cols: 100, rows: 30 } });

    expect(ctx.ptyManager.resize).toHaveBeenCalledWith("term-1", 100, 30, "renderer-message-port");
  });

  function makeResizeCtx() {
    const ctx = makeCtx(makeStateRef());
    vi.mocked(ctx.createPortQueueManager).mockReturnValue({
      removeBytes: vi.fn(),
      tryResume: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ReturnType<HostContext["createPortQueueManager"]>);
    vi.spyOn(console, "log").mockImplementation(() => {});
    return ctx;
  }

  it("asks the drive lease about every port's input and resize, with the bridge's stamp", () => {
    const ctx = makeResizeCtx();
    // Only the remote holder's connection drives.
    vi.mocked(ctx.ptyManager.mayDriveFrom).mockImplementation(
      (_id, connectionId) => connectionId === -3
    );
    const handlers = createConnectionHandlers(ctx);
    const local = makeNodePort();
    const remote = makeNodePort();

    handlers["connect-port"]({ windowId: 1 }, [local] as never);
    handlers["connect-port"]({ windowId: -3 }, [remote] as never);
    local.emit("message", { data: { type: "resize", id: "term-1", cols: 100, rows: 30 } });
    local.emit("message", { data: { type: "write", id: "term-1", data: "ls\r" } });
    expect(ctx.ptyManager.resize).not.toHaveBeenCalled();
    expect(ctx.ptyManager.write).not.toHaveBeenCalled();
    expect(ctx.ptyManager.mayDriveFrom).toHaveBeenCalledWith("term-1", 1, undefined);

    remote.emit("message", {
      data: { type: "resize", id: "term-1", cols: 90, rows: 20, leaseId: 4 },
    });
    remote.emit("message", { data: { type: "write", id: "term-1", data: "x", leaseId: 4 } });
    expect(ctx.ptyManager.mayDriveFrom).toHaveBeenCalledWith("term-1", -3, 4);
    expect(ctx.ptyManager.resize).toHaveBeenCalledWith("term-1", 90, 20, "renderer-message-port");
    expect(ctx.ptyManager.write).toHaveBeenCalledWith("term-1", "x", undefined);

    // A stamp that is not a lease id is no stamp at all.
    remote.emit("message", { data: { type: "write", id: "term-1", data: "y", leaseId: "4" } });
    expect(ctx.ptyManager.mayDriveFrom).toHaveBeenLastCalledWith("term-1", -3, undefined);
  });

  it("applies the lease table from Main and refuses a malformed one", () => {
    const ctx = makeResizeCtx();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const handlers = createConnectionHandlers(ctx);
    const leases = [
      { projectId: "p1", leaseId: 3, holderConnection: -4 },
      { projectId: "p2", leaseId: 5, holderConnection: null },
    ];

    handlers["set-drive-leases"]({ leases }, undefined as never);
    expect(ctx.ptyManager.setDriveLeases).toHaveBeenCalledWith(leases);

    handlers["set-drive-leases"](
      { leases: [{ projectId: "p1", leaseId: "3", holderConnection: -4 }] },
      undefined as never
    );
    handlers["set-drive-leases"](
      { leases: [{ projectId: "", leaseId: 3, holderConnection: null }] },
      undefined as never
    );
    handlers["set-drive-leases"]({ leases: "p1" }, undefined as never);
    expect(ctx.ptyManager.setDriveLeases).toHaveBeenCalledTimes(1);
  });
});
