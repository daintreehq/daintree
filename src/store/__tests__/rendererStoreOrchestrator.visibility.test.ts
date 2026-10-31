// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Replace the MRU debounce with a stub whose `flush`/`cancel` are spies, so the
// "flush on hide" wiring (#9914) can be asserted directly without depending on
// the 150ms timer or the focus-subscription chain.
const flushSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const cancelSpy = vi.hoisted(() => vi.fn());
vi.mock("@/utils/debounce", () => ({
  debounce: () => {
    const fn = vi.fn() as unknown as {
      (...args: unknown[]): void;
      flush: typeof flushSpy;
      cancel: typeof cancelSpy;
    };
    fn.flush = flushSpy;
    fn.cancel = cancelSpy;
    return fn;
  },
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    onBroadcastResult: vi.fn().mockReturnValue(() => {}),
    setFocusedTerminal: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({ agents: {} }),
    set: vi.fn(),
    reset: vi.fn(),
    stampVersion: vi.fn(),
  },
  cliAvailabilityClient: { refresh: vi.fn() },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    setInputLocked: vi.fn(),
    wake: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

// A controllable stand-in for main's view-lifecycle signals: a cached view
// keeps reporting `document.visibilityState === "visible"`, so this is the
// only way the orchestrator can learn nobody is looking.
type LifecyclePhase = "cached" | "active" | "revealed";
const viewCache = vi.hoisted(() => ({
  cached: false,
  listeners: new Set<(phase: "cached" | "active" | "revealed") => void>(),
  flushers: new Set<() => unknown>(),
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => viewCache.cached,
  subscribeProjectViewLifecycle: (listener: (phase: LifecyclePhase) => void) => {
    viewCache.listeners.add(listener);
    return () => viewCache.listeners.delete(listener);
  },
  subscribeProjectViewCachedFlush: (flush: () => unknown) => {
    viewCache.flushers.add(flush);
    return () => viewCache.flushers.delete(flush);
  },
  __resetProjectViewCacheStateForTests: vi.fn(),
}));
function emitPhase(phase: LifecyclePhase): void {
  for (const listener of Array.from(viewCache.listeners)) listener(phase);
}
// Mirrors preload on main's cached edge: run every flusher and hand back what
// main waits on before it may freeze or evict the view.
function cacheView(): unknown[] {
  viewCache.cached = true;
  return Array.from(viewCache.flushers, (flush) => flush());
}

const { initStoreOrchestrator, destroyStoreOrchestrator } =
  await import("../rendererStoreOrchestrator");
const { usePanelStore } = await import("../panelStore");
const { useWorktreeSelectionStore } = await import("../worktreeStore");

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

describe("rendererStoreOrchestrator — focus-follow release while hidden (#12370)", () => {
  const panel = (id: string, worktreeId: string) => ({
    id,
    title: id,
    kind: "terminal" as const,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid" as const,
    worktreeId,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    destroyStoreOrchestrator();
    initStoreOrchestrator();
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", restoreWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: { "term-1": panel("term-1", "wt-1"), "term-2": panel("term-2", "wt-2") },
      panelIds: ["term-1", "term-2"],
      focusedId: "term-1",
    });
    // Nine alternating flips: eight revisits, the ninth trips with wt-1
    // active and focus parked on term-2.
    for (let i = 0; i < 9; i++) {
      usePanelStore.setState({ focusedId: i % 2 === 0 ? "term-2" : "term-1" });
    }
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });

  afterEach(() => {
    destroyStoreOrchestrator();
    vi.useRealTimers();
    setHidden(false);
    viewCache.cached = false;
    viewCache.listeners.clear();
    viewCache.flushers.clear();
  });

  it("holds the release while the view is cached and runs it on reveal", () => {
    viewCache.cached = true;
    vi.advanceTimersByTime(2_001);
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");

    viewCache.cached = false;
    emitPhase("revealed");

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-2");
  });

  it("re-arms on warm activation, so a switch rollback that never reveals still releases", () => {
    viewCache.cached = true;
    vi.advanceTimersByTime(2_001);
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");

    viewCache.cached = false;
    emitPhase("active");
    // Not run on the signal itself — the view may still sit behind the
    // anti-flash bridge — but on a fresh timer that re-checks.
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
    vi.advanceTimersByTime(1);

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-2");
  });

  it("holds the release while the document is hidden and runs it once shown again", () => {
    setHidden(true);
    vi.advanceTimersByTime(2_001);
    // Switching a workspace nobody can see would re-run the terminal policy
    // and push a set-active for nothing.
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-2");
  });

  it("forgets a pending release on destroy", () => {
    setHidden(true);
    vi.advanceTimersByTime(2_001);
    destroyStoreOrchestrator();

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
  });
});

describe("rendererStoreOrchestrator — MRU flush on hide (#9914)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    destroyStoreOrchestrator();
    initStoreOrchestrator();
  });

  afterEach(() => {
    destroyStoreOrchestrator();
    setHidden(false);
    viewCache.cached = false;
    viewCache.listeners.clear();
    viewCache.flushers.clear();
  });

  it("flushes the MRU debounce when the document becomes hidden", () => {
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it("does not flush while the document is still visible", () => {
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushSpy).not.toHaveBeenCalled();
  });

  it("removes the visibilitychange listener on destroy — no flush after teardown", () => {
    destroyStoreOrchestrator();

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushSpy).not.toHaveBeenCalled();
  });

  it("flushes immediately when the document is already hidden at init", () => {
    // beforeEach init'd while visible; re-init with the document already hidden.
    destroyStoreOrchestrator();
    setHidden(true);
    initStoreOrchestrator();

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  // A cached view never gets `visibilitychange`: it keeps reporting "visible",
  // so main's cached edge is the only cue a project switch gives (#15651).
  it("flushes the MRU debounce when main caches the view, with the document still visible", async () => {
    setHidden(false);
    let settle!: () => void;
    flushSpy.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)));

    const [held] = cacheView();

    expect(document.hidden).toBe(false);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    // Main keeps the view unfrozen and resident until the persist settles.
    let released = false;
    void (held as Promise<unknown>).then(() => (released = true));
    await Promise.resolve();
    expect(released).toBe(false);
    settle();
    await vi.waitFor(() => expect(released).toBe(true));
  });

  it("flushes immediately when the view is already cached at init", () => {
    destroyStoreOrchestrator();
    setHidden(false);
    viewCache.cached = true;
    initStoreOrchestrator();

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it("stops flushing on the cached edge after destroy", () => {
    destroyStoreOrchestrator();

    cacheView();

    expect(viewCache.flushers.size).toBe(0);
    expect(flushSpy).not.toHaveBeenCalled();
  });
});
