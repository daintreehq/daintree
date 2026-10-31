// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const flushPanelPersistenceMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/slices", () => ({
  flushPanelPersistence: flushPanelPersistenceMock,
}));

const flushDraftsMock = vi.hoisted(() => vi.fn());
const draftsIdleMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const stopLiveSyncMock = vi.hoisted(() => vi.fn());
const startLiveSyncMock = vi.hoisted(() => vi.fn(() => stopLiveSyncMock));
vi.mock("@/store/persistence/draftInputPersistence", () => ({
  draftInputPersistence: {
    flushAll: flushDraftsMock,
    whenIdle: draftsIdleMock,
    startLiveSync: startLiveSyncMock,
  },
}));

vi.mock("@/store/resourceMonitoringStore", () => ({
  useResourceMonitoringStore: {
    getState: () => ({ enabled: false, updateMetrics: vi.fn() }),
  },
}));

const { setupResourceListeners } = await import("../resource");
const { __resetProjectViewCacheStateForTests } = await import("@/lib/viewCacheState");

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

describe("setupResourceListeners — persistence flush on hide (#9914)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { window: Window }).window.electron = {
      terminal: {
        onResourceMetrics: vi.fn(() => () => {}),
      },
    } as unknown as Window["electron"];
  });

  afterEach(() => {
    setHidden(false);
  });

  it("flushes panel and draft persistence when the document becomes hidden", () => {
    const d = setupResourceListeners();

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushPanelPersistenceMock).toHaveBeenCalledTimes(1);
    expect(flushDraftsMock).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("does not flush while the document is still visible", () => {
    const d = setupResourceListeners();

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushPanelPersistenceMock).not.toHaveBeenCalled();
    expect(flushDraftsMock).not.toHaveBeenCalled();
    d.dispose();
  });

  it("removes the listener on dispose — no flush after teardown", () => {
    const d = setupResourceListeners();
    d.dispose();

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushPanelPersistenceMock).not.toHaveBeenCalled();
    expect(flushDraftsMock).not.toHaveBeenCalled();
  });

  it("flushes both immediately when the document is already hidden at registration", () => {
    setHidden(true);
    const d = setupResourceListeners();

    expect(flushPanelPersistenceMock).toHaveBeenCalledTimes(1);
    expect(flushDraftsMock).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("does not register a beforeunload handler (the unreliable signal it replaced)", () => {
    const windowSpy = vi.spyOn(window, "addEventListener");
    const documentSpy = vi.spyOn(document, "addEventListener");
    const d = setupResourceListeners();

    expect(windowSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
    expect(documentSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
    d.dispose();
    windowSpy.mockRestore();
    documentSpy.mockRestore();
  });

  it("keeps drafts syncing live while the listeners are up (#13283)", () => {
    const d = setupResourceListeners();
    expect(startLiveSyncMock).toHaveBeenCalledTimes(1);
    expect(stopLiveSyncMock).not.toHaveBeenCalled();
    d.dispose();
    expect(stopLiveSyncMock).toHaveBeenCalledTimes(1);
  });
});

// Mirrors preload: `isViewCached` is the latch, and main's cached edge runs
// every registered flusher and settles once they all have.
function installViewLifecycle(latchedCached = false) {
  const flushers = new Set<() => unknown>();
  let latched = latchedCached;
  (globalThis as unknown as { window: Window }).window.electron = {
    terminal: { onResourceMetrics: vi.fn(() => () => {}) },
    app: {
      isViewCached: () => latched,
      onViewCached: () => () => {},
      onViewCachedFlush: (cb: () => unknown) => {
        const flush = () => cb();
        flushers.add(flush);
        return () => flushers.delete(flush);
      },
      onViewWarmActivated: () => () => {},
      onViewRevealed: () => () => {},
    },
  } as unknown as Window["electron"];
  return {
    cache: () => {
      latched = true;
      return Promise.allSettled(Array.from(flushers, (flush) => flush()));
    },
    flusherCount: () => flushers.size,
  };
}

// A cached view never gets `visibilitychange`: it keeps reporting "visible",
// so main's cached edge is the only cue a project switch gives (#15651).
describe("setupResourceListeners — persistence flush when the view is cached (#15651)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetProjectViewCacheStateForTests();
    setHidden(false);
  });

  afterEach(() => {
    setHidden(false);
    __resetProjectViewCacheStateForTests();
  });

  it("flushes panel and draft persistence on the cached edge, with the document still visible", async () => {
    const view = installViewLifecycle();
    const d = setupResourceListeners();
    expect(flushPanelPersistenceMock).not.toHaveBeenCalled();

    await view.cache();

    expect(document.hidden).toBe(false);
    expect(flushPanelPersistenceMock).toHaveBeenCalledTimes(1);
    expect(flushDraftsMock).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("holds main's cached edge until both the layout and draft writes settle", async () => {
    const view = installViewLifecycle();
    let releasePanels!: () => void;
    let releaseDrafts!: () => void;
    flushPanelPersistenceMock.mockReturnValueOnce(
      new Promise<void>((resolve) => (releasePanels = resolve))
    );
    draftsIdleMock.mockReturnValueOnce(new Promise<void>((resolve) => (releaseDrafts = resolve)));
    const d = setupResourceListeners();

    let released = false;
    void view.cache().then(() => (released = true));
    releasePanels();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);

    releaseDrafts();
    await vi.waitFor(() => expect(released).toBe(true));
    // The drafts were queued before their writes were awaited.
    expect(flushDraftsMock.mock.invocationCallOrder[0]).toBeLessThan(
      draftsIdleMock.mock.invocationCallOrder[0]!
    );
    d.dispose();
  });

  it("flushes both immediately when the view is already cached at registration", () => {
    installViewLifecycle(true);
    const d = setupResourceListeners();

    expect(flushPanelPersistenceMock).toHaveBeenCalledTimes(1);
    expect(flushDraftsMock).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("unregisters the cached-edge flusher on dispose", async () => {
    const view = installViewLifecycle();
    const d = setupResourceListeners();
    expect(view.flusherCount()).toBe(1);
    d.dispose();

    expect(view.flusherCount()).toBe(0);
    await view.cache();
    expect(flushPanelPersistenceMock).not.toHaveBeenCalled();
    expect(flushDraftsMock).not.toHaveBeenCalled();
  });
});
