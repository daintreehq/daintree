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
  } as unknown as HostContext["ptyManager"];

  return {
    analysisWorkerPool: null,
    ptyManager,
    processTreeCache: {} as HostContext["processTreeCache"],
    terminalResourceMonitor: {} as HostContext["terminalResourceMonitor"],
    backpressureManager: {} as HostContext["backpressureManager"],
    ipcQueueManager: {} as HostContext["ipcQueueManager"],
    resourceGovernor: {} as HostContext["resourceGovernor"],
    packetFramer: {} as HostContext["packetFramer"],
    pauseCoordinators: new Map(),
    rendererConnections: new Map(),
    windowProjectMap: new Map(),
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
    getPausedDurationsSnapshot: vi.fn(() => []),
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

    const projectEnv = { MY_API_KEY: "x", NODE_ENV: "production" };
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
