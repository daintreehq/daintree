// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";

// The service is re-imported under vi.resetModules() in beforeEach, so the
// cache signal has to be a module mock rather than the preload-bridge stub the
// controller suites use — a statically imported reset helper would operate on a
// different module instance than the one the service under test binds to.
// `viewCacheState.test.ts` owns the bridge-latch behaviour itself.
const viewCacheState = vi.hoisted(() => ({
  isProjectViewCached: vi.fn(() => false),
  subscribeProjectViewLifecycle: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/viewCacheState", () => viewCacheState);

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({
      visualBuffers: [],
      signalBuffer: null,
    })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

type BackgroundResizeTestService = {
  instances: Map<string, ManagedTerminal>;
  applyBackgroundWindowResize: (width: number, height: number) => void;
  resetBackgroundResizeBasis: () => void;
  resizeController: {
    applyBackgroundResize: (
      id: string,
      width: number,
      height: number
    ) => { cols: number; rows: number } | null;
  };
};

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    isOpened: true,
    lastWidth: 800,
    lastHeight: 600,
    ...overrides,
  } as ManagedTerminal;
}

function setViewport(width: number, height: number, visibility: "visible" | "hidden") {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  Object.defineProperty(document, "visibilityState", { value: visibility, configurable: true });
}

function setCached(cached: boolean) {
  viewCacheState.isProjectViewCached.mockReturnValue(cached);
}

describe("TerminalInstanceService applyBackgroundWindowResize", () => {
  let service: BackgroundResizeTestService;
  let applyBackgroundResizeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: BackgroundResizeTestService;
      });
    service.instances.clear();
    service.resetBackgroundResizeBasis();
    applyBackgroundResizeSpy = vi
      .spyOn(service.resizeController, "applyBackgroundResize")
      .mockReturnValue(null) as ReturnType<typeof vi.spyOn>;
    // The production state this method exists to serve: main has detached and
    // hidden the view, but a child WebContentsView keeps reporting "visible"
    // (#11443). Cases that assert a resize is applied therefore only pass
    // because the guard consults the cache signal — under the old
    // visibility-only guard they would all no-op.
    setViewport(1000, 700, "visible");
    setCached(true);
  });

  afterEach(() => {
    service.instances.clear();
    vi.restoreAllMocks();
  });

  it("scales each terminal's last measured size by the window-bounds ratio", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));
    service.instances.set("b", makeManaged({ lastWidth: 400, lastHeight: 300 }));

    service.applyBackgroundWindowResize(1200, 840);

    expect(applyBackgroundResizeSpy).toHaveBeenCalledTimes(2);
    expect(applyBackgroundResizeSpy).toHaveBeenCalledWith("a", 800 * 1.2, 600 * 1.2);
    expect(applyBackgroundResizeSpy).toHaveBeenCalledWith("b", 400 * 1.2, 300 * 1.2);
  });

  it("no-ops only once the view is neither cached nor page-hidden", () => {
    service.instances.set("a", makeManaged());

    setCached(false);
    setViewport(1000, 700, "visible");
    service.applyBackgroundWindowResize(1200, 840);
    expect(applyBackgroundResizeSpy).not.toHaveBeenCalled();

    // Either signal alone is enough to keep scaling: a minimized window that
    // was never cached, and a cached view that still reports "visible".
    setViewport(1000, 700, "hidden");
    service.applyBackgroundWindowResize(1200, 840);
    expect(applyBackgroundResizeSpy).toHaveBeenCalledTimes(1);

    setCached(true);
    setViewport(1000, 700, "visible");
    service.applyBackgroundWindowResize(1200, 840);
    expect(applyBackgroundResizeSpy).toHaveBeenCalledTimes(2);
  });

  it("skips alt-buffer panes so xterm and the PTY never split while backgrounded", () => {
    // A PTY-only resize would leave a live TUI painting a wider frame into a
    // narrower alt grid, which never reflows — and the reattach resize dedupes
    // to no SIGWINCH, so the app never redraws to correct it.
    service.instances.set("main", makeManaged({ lastWidth: 800, lastHeight: 600 }));
    service.instances.set(
      "alt",
      makeManaged({ lastWidth: 800, lastHeight: 600, isAltBuffer: true })
    );

    service.applyBackgroundWindowResize(1200, 840);

    expect(applyBackgroundResizeSpy.mock.calls.map((call) => call[0])).toEqual(["main"]);
  });

  it("scales a pane that leaves the alternate screen mid-session from its pre-background size", () => {
    // The origin is captured on first eligibility, not on session start, so a
    // pane skipped while alt-screen still lands on an absolute target anchored
    // to the same basis rather than compounding off a partial resize.
    const managed = makeManaged({ lastWidth: 800, lastHeight: 600, isAltBuffer: true });
    service.instances.set("a", managed);

    service.applyBackgroundWindowResize(1200, 840);
    expect(applyBackgroundResizeSpy).not.toHaveBeenCalled();

    managed.isAltBuffer = false;
    service.applyBackgroundWindowResize(1500, 700);

    expect(applyBackgroundResizeSpy).toHaveBeenCalledWith("a", 800 * 1.5, 600 * 1.0);
  });

  it("anchors repeated resizes to the session origin — targets are absolute, never compounded", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(1200, 840);
    service.applyBackgroundWindowResize(1500, 700);

    // Both events scale the captured 800x600 origin against the 1000x700
    // viewport snapshot, regardless of what earlier events applied.
    expect(applyBackgroundResizeSpy).toHaveBeenNthCalledWith(1, "a", 800 * 1.2, 600 * 1.2);
    expect(applyBackgroundResizeSpy).toHaveBeenNthCalledWith(2, "a", 800 * 1.5, 600 * 1.0);
  });

  it("a terminal skipped in one pass still lands on the correct absolute size in the next", () => {
    const managed = makeManaged({ lastWidth: 800, lastHeight: 600 });
    service.instances.set("a", managed);

    // First pass skipped (e.g. resize-locked) — applyBackgroundResize returns null
    // and lastWidth is untouched. The origin snapshot must keep the second
    // pass anchored to the original viewport, not an advanced basis.
    service.applyBackgroundWindowResize(1200, 840);
    service.applyBackgroundWindowResize(1500, 1400);

    expect(applyBackgroundResizeSpy).toHaveBeenLastCalledWith("a", 800 * 1.5, 600 * 2.0);
  });

  it("resetBackgroundResizeBasis restores the live viewport as the basis", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(1200, 840);
    service.resetBackgroundResizeBasis();
    service.applyBackgroundWindowResize(1300, 770);

    expect(applyBackgroundResizeSpy).toHaveBeenLastCalledWith("a", 800 * 1.3, 600 * 1.1);
  });

  it("an uncached, visible delivery resets the basis for the next background session", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(1200, 840);

    // Reactivated: the delivery is dropped AND the anchor released. Real layout
    // then re-measures the pane against a viewport the old basis knows nothing
    // about — a stale basis would scale 1560/1000 instead of 1560/1300.
    setCached(false);
    setViewport(1300, 770, "visible");
    service.applyBackgroundWindowResize(1200, 840);
    const callsBeforeNextSession = applyBackgroundResizeSpy.mock.calls.length;

    setCached(true);
    service.applyBackgroundWindowResize(1560, 385);

    expect(applyBackgroundResizeSpy).toHaveBeenLastCalledWith("a", 800 * 1.2, 600 * 0.5);
    expect(applyBackgroundResizeSpy.mock.calls.length).toBe(callsBeforeNextSession + 1);
  });

  it("keeps the anchor across a cached delivery that still reports visible", () => {
    // The reset must key off "not cached AND visible", not visibility alone —
    // re-snapshotting mid-background would rebase every later event onto an
    // already-scaled viewport and compound the targets.
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(1200, 840);
    setViewport(1200, 840, "visible");
    service.applyBackgroundWindowResize(1500, 700);

    expect(applyBackgroundResizeSpy).toHaveBeenLastCalledWith("a", 800 * 1.5, 600 * 1.0);
  });

  it("skips unopened and never-measured terminals", () => {
    service.instances.set("unopened", makeManaged({ isOpened: false }));
    service.instances.set("unmeasured", makeManaged({ lastWidth: 0, lastHeight: 0 }));
    service.instances.set("eligible", makeManaged());

    service.applyBackgroundWindowResize(1200, 840);

    expect(applyBackgroundResizeSpy).toHaveBeenCalledTimes(1);
    expect(applyBackgroundResizeSpy).toHaveBeenCalledWith(
      "eligible",
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("ignores non-finite and non-positive bounds", () => {
    service.instances.set("a", makeManaged());

    service.applyBackgroundWindowResize(Number.NaN, 840);
    service.applyBackgroundWindowResize(1200, Number.POSITIVE_INFINITY);
    service.applyBackgroundWindowResize(0, 840);
    service.applyBackgroundWindowResize(-100, 840);

    expect(applyBackgroundResizeSpy).not.toHaveBeenCalled();
  });

  it("invalid bounds do not corrupt the session for a following valid event", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(0, 0);
    service.applyBackgroundWindowResize(1200, 840);

    expect(applyBackgroundResizeSpy).toHaveBeenCalledWith("a", 800 * 1.2, 600 * 1.2);
  });

  it("captures the origin for a terminal measured only after the session started", () => {
    const managed = makeManaged({ lastWidth: 0, lastHeight: 0 });
    service.instances.set("late", managed);

    service.applyBackgroundWindowResize(1200, 840);
    expect(applyBackgroundResizeSpy).not.toHaveBeenCalled();

    managed.lastWidth = 500;
    managed.lastHeight = 400;
    service.applyBackgroundWindowResize(1500, 700);

    expect(applyBackgroundResizeSpy).toHaveBeenCalledWith("late", 500 * 1.5, 400 * 1.0);
  });

  it("no-ops when the stale viewport reports zero dimensions", () => {
    setViewport(0, 0, "hidden");
    service.instances.set("a", makeManaged());

    service.applyBackgroundWindowResize(1200, 840);

    expect(applyBackgroundResizeSpy).not.toHaveBeenCalled();
  });
});
