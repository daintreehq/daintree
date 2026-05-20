import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ManagedTerminal } from "../types";

let mockAddonDispose: ReturnType<typeof vi.fn>;
let mockContextLossDispose: ReturnType<typeof vi.fn>;
let mockOnContextLoss: ReturnType<typeof vi.fn>;

function createMockAddon() {
  // Per-instance so a resync test can fire one addon's merge event and assert
  // every co-owning addon's local resize-like reset ran.
  const removeAtlasHandlers = new Set<() => void>();
  const changeAtlasHandlers = new Set<() => void>();
  const clearLocalModel = vi.fn();
  const resizeLocalRenderer = vi.fn();
  return {
    dispose: mockAddonDispose,
    onContextLoss: mockOnContextLoss,
    clearTextureAtlas: vi.fn(),
    _renderer: {
      _clearModel: clearLocalModel,
      handleResize: resizeLocalRenderer,
    },
    onChangeTextureAtlas: vi.fn((handler: () => void) => {
      changeAtlasHandlers.add(handler);
      return {
        dispose: () => {
          changeAtlasHandlers.delete(handler);
        },
      };
    }),
    onRemoveTextureAtlasCanvas: vi.fn((handler: () => void) => {
      removeAtlasHandlers.add(handler);
      return {
        dispose: () => {
          removeAtlasHandlers.delete(handler);
        },
      };
    }),
    // Test helper: simulate a shared-atlas page merge for this addon.
    __fireRemoveTextureAtlasCanvas(): void {
      for (const handler of [...removeAtlasHandlers]) {
        handler();
      }
    },
    __fireChangeTextureAtlas(): void {
      for (const handler of [...changeAtlasHandlers]) {
        handler();
      }
    },
  };
}

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(function () {
    return createMockAddon();
  }),
}));

// Flush microtasks plus a macrotask so the chain
// `import("@xterm/addon-webgl") → .then(flushPendingEnsures)` fully runs.
function flushDynamicImport(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// rAF shim — JSDOM does not implement requestAnimationFrame, and the manager
// drains its ensure queue one entry per frame. Default mode is "sync" so
// existing tests retain their synchronous expectations; rAF-pacing tests flip
// to "queued" and call flushRafFrame() to advance one frame at a time.
type RafMode = "sync" | "queued";
let rafMode: RafMode = "sync";
const rafQueue = new Map<number, FrameRequestCallback>();
let rafIdCounter = 0;

function installRafShim(): void {
  rafMode = "sync";
  rafQueue.clear();
  rafIdCounter = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    if (rafMode === "sync") {
      cb(0);
      return 0;
    }
    rafIdCounter += 1;
    rafQueue.set(rafIdCounter, cb);
    return rafIdCounter;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
    rafQueue.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;
}

function flushRafFrame(): boolean {
  const next = rafQueue.entries().next();
  if (next.done) return false;
  const [id, cb] = next.value;
  rafQueue.delete(id);
  cb(0);
  return true;
}

// Minimal element mock — vitest runs in `node` env without jsdom, so we can't
// use document.createElement. The mock tracks the `capture` flag separately so
// tests can verify the manager registers and removes its listener in the
// capture phase (a regression to a bubble listener would fire after xterm's
// own canvas-target handler — too late to pre-empt the 3s restore timer).
type Listener = (event: Event) => void;
type ListenerOptions = boolean | { capture?: boolean } | undefined;
interface FakeElement {
  addEventListener(type: string, listener: Listener, options?: ListenerOptions): void;
  removeEventListener(type: string, listener: Listener, options?: ListenerOptions): void;
  dispatchEvent(event: Event): boolean;
  // Test helper — only fires bubble-phase listeners; lets a test prove the
  // manager registered in capture phase by showing the listener doesn't run.
  __dispatchBubbleOnly(event: Event): void;
  __listenerCount(type: string): number;
}

function isCapture(options: ListenerOptions): boolean {
  if (typeof options === "boolean") return options;
  return options?.capture === true;
}

function makeFakeElement(): HTMLElement {
  const captureBucket = new Map<string, Set<Listener>>();
  const bubbleBucket = new Map<string, Set<Listener>>();

  const el: FakeElement = {
    addEventListener(type, listener, options) {
      const target = isCapture(options) ? captureBucket : bubbleBucket;
      let set = target.get(type);
      if (!set) {
        set = new Set();
        target.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type, listener, options) {
      const target = isCapture(options) ? captureBucket : bubbleBucket;
      target.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of [...(captureBucket.get(event.type) ?? [])]) {
        listener(event);
      }
      for (const listener of [...(bubbleBucket.get(event.type) ?? [])]) {
        listener(event);
      }
      return true;
    },
    __dispatchBubbleOnly(event) {
      for (const listener of [...(bubbleBucket.get(event.type) ?? [])]) {
        listener(event);
      }
    },
    __listenerCount(type) {
      return (captureBucket.get(type)?.size ?? 0) + (bubbleBucket.get(type)?.size ?? 0);
    },
  };
  return el as unknown as HTMLElement;
}

function makeManagedTerminal(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  const element = makeFakeElement();
  return {
    terminal: {
      loadAddon: vi.fn(),
      element,
      cols: 80,
      rows: 24,
      refresh: vi.fn(),
    },
    isOpened: true,
    lastActiveTime: Date.now(),
    ...overrides,
  } as unknown as ManagedTerminal;
}

describe("TerminalWebGLManager", () => {
  let manager: import("../TerminalWebGLManager").TerminalWebGLManager;
  let WebglAddonMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    installRafShim();

    mockAddonDispose = vi.fn();
    mockContextLossDispose = vi.fn();
    mockOnContextLoss = vi.fn((_handler: () => void) => ({ dispose: mockContextLossDispose }));

    vi.clearAllMocks();

    const webglMod = await import("@xterm/addon-webgl");
    WebglAddonMock = webglMod.WebglAddon as unknown as ReturnType<typeof vi.fn>;
    WebglAddonMock.mockImplementation(function () {
      return createMockAddon();
    });

    const mod = await import("../TerminalWebGLManager");
    // Preload the addon class so ensureContext() executes synchronously in tests.
    // The lazy loader is exercised separately in the "lazy WebglAddon loading" suite.
    mod.__testing.setWebglAddonClass(
      WebglAddonMock as unknown as new () => InstanceType<typeof webglMod.WebglAddon>
    );
    // The passive-mode threshold is module-level state that survives across
    // tests. Reset to the balanced default so order doesn't matter; blocks that
    // need to fill the pool past it (LRU eviction, eviction priority) raise it
    // in their own beforeEach, which runs after this one.
    mod.TerminalWebGLManager.setPassiveThreshold(8);
    manager = new mod.TerminalWebGLManager();
  });

  // vitest types .mock.results[n] as possibly-undefined; the resync tests only
  // ever read back an addon they just constructed via ensureContext().
  function addonAt(index: number): ReturnType<typeof createMockAddon> {
    const result = WebglAddonMock.mock.results[index];
    if (!result) {
      throw new Error(`no mock addon constructed at index ${index}`);
    }
    return result.value;
  }

  it("attaches WebGL addon via ensureContext", () => {
    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);

    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
    expect(managed.terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(manager.isActive("t1")).toBe(true);
  });

  it("is a no-op when terminal is not opened", () => {
    const managed = makeManagedTerminal({ isOpened: false });
    manager.ensureContext("t1", managed);

    expect(WebglAddonMock).not.toHaveBeenCalled();
    expect(manager.isActive("t1")).toBe(false);
  });

  it("is a no-op when already active for the same terminal", () => {
    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.ensureContext("t1", managed);

    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
  });

  it("two terminals can both be active simultaneously", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    expect(WebglAddonMock).toHaveBeenCalledTimes(2);
    expect(manager.isActive("t1")).toBe(true);
    expect(manager.isActive("t2")).toBe(true);
    expect(mockAddonDispose).not.toHaveBeenCalled();
  });

  it("resyncs every co-owner when a shared-atlas merge fires", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();
    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    const addon1 = addonAt(0);
    const addon2 = addonAt(1);

    // A real merge reindexes the shared atlas, and xterm forwards the event to
    // every co-owning renderer. Each renderer must run the same local reset
    // path that makes a user resize heal corruption, without clearing the
    // shared atlas again.
    addon1.__fireRemoveTextureAtlasCanvas();
    addon2.__fireRemoveTextureAtlasCanvas();

    expect(addon1._renderer.handleResize).toHaveBeenCalledWith(80, 24);
    expect(addon2._renderer.handleResize).toHaveBeenCalledWith(80, 24);
    expect(addon1._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon2._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon1.clearTextureAtlas).not.toHaveBeenCalled();
    expect(addon2.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed1.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(managed2.terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("only resyncs the terminals whose merge event fired", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();
    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    const addon1 = addonAt(0);
    const addon2 = addonAt(1);

    // Terminals on a different font/theme config own a different atlas, so a
    // merge there forwards the event only to that atlas's co-owners. t2 never
    // fired, so clearing it would be wasted work on an unaffected renderer.
    addon1.__fireRemoveTextureAtlasCanvas();

    expect(addon1._renderer.handleResize).toHaveBeenCalledWith(80, 24);
    expect(addon1._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon1.clearTextureAtlas).not.toHaveBeenCalled();
    expect(addon2._renderer.handleResize).not.toHaveBeenCalled();
    expect(addon2.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed1.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(managed2.terminal.refresh).not.toHaveBeenCalled();
  });

  it("resyncs and refreshes when the renderer switches atlas objects", () => {
    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    const addon = addonAt(0);

    addon.__fireChangeTextureAtlas();

    expect(addon._renderer.handleResize).toHaveBeenCalledWith(80, 24);
    expect(addon._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed.terminal.refresh).toHaveBeenCalledTimes(1);
    expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("falls back to local model clear when resize-like reset is unavailable", () => {
    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    const addon = addonAt(0);
    delete (addon._renderer as { handleResize?: unknown }).handleResize;

    addon.__fireRemoveTextureAtlasCanvas();

    expect(addon._renderer._clearModel).toHaveBeenCalledWith(true);
    expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("coalesces a burst of merge events into a single resync", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();
    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    const addon1 = addonAt(0);
    const addon2 = addonAt(1);

    // _mergePages fires onRemoveTextureAtlasCanvas once per merged-away page,
    // per co-owner — many events for one merge. Queue the rAF so the burst
    // coalesces into one resync covering every co-owner that fired.
    rafMode = "queued";
    expect(flushRafFrame()).toBe(false); // nothing queued before the burst
    addon1.__fireRemoveTextureAtlasCanvas();
    addon1.__fireRemoveTextureAtlasCanvas();
    addon2.__fireRemoveTextureAtlasCanvas();
    addon1.__fireRemoveTextureAtlasCanvas();

    expect(addon1._renderer.handleResize).not.toHaveBeenCalled();
    expect(flushRafFrame()).toBe(true);

    expect(addon1._renderer.handleResize).toHaveBeenCalledTimes(1);
    expect(addon2._renderer.handleResize).toHaveBeenCalledTimes(1);
    expect(addon1._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon2._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon1.clearTextureAtlas).not.toHaveBeenCalled();
    expect(addon2.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed1.terminal.refresh).toHaveBeenCalledTimes(1);
    expect(managed2.terminal.refresh).toHaveBeenCalledTimes(1);
    // The burst collapsed to one frame — nothing else is queued.
    expect(flushRafFrame()).toBe(false);
  });

  it("falls back to reacquire when local renderer reset throws and continues the fired set", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();
    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    const addon1 = addonAt(0);
    const addon2 = addonAt(1);
    addon1._renderer.handleResize.mockImplementation(() => {
      throw new Error("context lost mid-resync");
    });
    addon1._renderer._clearModel.mockImplementation(() => {
      throw new Error("context lost mid-resync");
    });

    // Both fire into one frame so the throw happens mid-loop — it must not
    // abort the resync for the co-owners after it.
    rafMode = "queued";
    addon1.__fireRemoveTextureAtlasCanvas();
    addon2.__fireRemoveTextureAtlasCanvas();
    flushRafFrame();

    expect(addon1._renderer.handleResize).toHaveBeenCalledTimes(1);
    expect(addon1._renderer._clearModel).toHaveBeenCalledTimes(1);
    expect(addon1.clearTextureAtlas).not.toHaveBeenCalled();
    expect(mockAddonDispose).toHaveBeenCalledTimes(1);
    expect(addon2._renderer.handleResize).toHaveBeenCalledTimes(1);
    expect(addon2._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon2.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed1.terminal.refresh).not.toHaveBeenCalled();
    expect(managed2.terminal.refresh).toHaveBeenCalledTimes(1);

    // The fallback reacquire is paced through the same one-context-per-rAF
    // attach queue as normal WebGL acquisition.
    expect(manager.isActive("t1")).toBe(false);
    expect(flushRafFrame()).toBe(true);
    expect(WebglAddonMock).toHaveBeenCalledTimes(3);
    expect(manager.isActive("t1")).toBe(true);
  });

  it("skips the post-reset refresh when the terminal has no rows", () => {
    const managed = makeManagedTerminal({
      terminal: {
        loadAddon: vi.fn(),
        element: makeFakeElement(),
        cols: 80,
        rows: 0,
        refresh: vi.fn(),
      } as unknown as ManagedTerminal["terminal"],
    });
    manager.ensureContext("t1", managed);
    const addon = addonAt(0);

    addon.__fireRemoveTextureAtlasCanvas();

    expect(addon._renderer.handleResize).not.toHaveBeenCalled();
    expect(addon._renderer._clearModel).toHaveBeenCalledWith(true);
    expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed.terminal.refresh).not.toHaveBeenCalled();
  });

  it("dispose() cancels a pending atlas resync frame", () => {
    const managed1 = makeManagedTerminal();
    manager.ensureContext("t1", managed1);
    const addon1 = addonAt(0);

    rafMode = "queued";
    addon1.__fireRemoveTextureAtlasCanvas();
    manager.dispose();

    // The queued frame was cancelled — flushing finds nothing — and the
    // resync never runs.
    expect(flushRafFrame()).toBe(false);
    expect(addon1._renderer.handleResize).not.toHaveBeenCalled();
    expect(addon1._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon1.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed1.terminal.refresh).not.toHaveBeenCalled();
  });

  it("stops listening for merges after a terminal is released", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();
    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    const addon1 = addonAt(0);
    const addon2 = addonAt(1);

    manager.releaseContext("t1");

    rafMode = "queued";
    addon1.__fireRemoveTextureAtlasCanvas();

    // The released terminal's subscription is disposed: no frame is scheduled
    // and no addon is cleared.
    expect(flushRafFrame()).toBe(false);
    expect(addon1._renderer.handleResize).not.toHaveBeenCalled();
    expect(addon2._renderer.handleResize).not.toHaveBeenCalled();
    expect(addon1._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon2._renderer._clearModel).not.toHaveBeenCalled();
    expect(addon1.clearTextureAtlas).not.toHaveBeenCalled();
    expect(addon2.clearTextureAtlas).not.toHaveBeenCalled();
    expect(managed1.terminal.refresh).not.toHaveBeenCalled();
    expect(managed2.terminal.refresh).not.toHaveBeenCalled();
  });

  it("releaseContext disposes only the targeted entry", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);

    manager.releaseContext("t1");

    expect(manager.isActive("t1")).toBe(false);
    expect(manager.isActive("t2")).toBe(true);
    expect(mockAddonDispose).toHaveBeenCalledTimes(1);
  });

  it("releaseContext is a no-op for unknown id", () => {
    expect(() => manager.releaseContext("unknown")).not.toThrow();
  });

  it("silently falls back when loadAddon throws", () => {
    const managed = makeManagedTerminal();
    (managed.terminal.loadAddon as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("WebGL not supported");
    });

    expect(() => manager.ensureContext("t1", managed)).not.toThrow();
    expect(manager.isActive("t1")).toBe(false);
  });

  it("disposes addon on context loss", () => {
    let contextLossHandler: (() => void) | undefined;
    mockOnContextLoss.mockImplementation((handler: () => void) => {
      contextLossHandler = handler;
      return { dispose: vi.fn() };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);

    expect(contextLossHandler).toBeDefined();
    contextLossHandler!();
    expect(mockAddonDispose).toHaveBeenCalled();
    expect(manager.isActive("t1")).toBe(false);
  });

  it("stale context loss callback is a no-op after release", () => {
    let contextLossHandler: (() => void) | undefined;
    mockOnContextLoss.mockImplementation((handler: () => void) => {
      contextLossHandler = handler;
      return { dispose: vi.fn() };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.releaseContext("t1");

    // Firing stale handler after release should not throw
    expect(() => contextLossHandler!()).not.toThrow();
  });

  it("stale context loss callback does not tear down reacquired addon for same id", () => {
    let firstContextLossHandler: (() => void) | undefined;
    let callCount = 0;
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();

    WebglAddonMock.mockImplementation(function () {
      callCount++;
      const d = callCount === 1 ? firstDispose : secondDispose;
      return {
        dispose: d,
        onContextLoss: vi.fn((handler: () => void) => {
          if (callCount === 1) firstContextLossHandler = handler;
          return { dispose: vi.fn() };
        }),
      };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.releaseContext("t1");

    // Reacquire the same id with a new addon
    manager.ensureContext("t1", managed);
    expect(manager.isActive("t1")).toBe(true);

    // Fire stale context loss from the first addon — must NOT release the new addon
    firstContextLossHandler!();
    expect(manager.isActive("t1")).toBe(true);
    expect(secondDispose).not.toHaveBeenCalled();
  });

  it("onTerminalDestroyed removes state without calling addon.dispose", () => {
    const perAddonDispose = vi.fn();
    WebglAddonMock.mockImplementation(function () {
      return { dispose: perAddonDispose, onContextLoss: mockOnContextLoss };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.onTerminalDestroyed("t1");

    expect(manager.isActive("t1")).toBe(false);
    expect(perAddonDispose).not.toHaveBeenCalled();
    expect(mockContextLossDispose).toHaveBeenCalled();
  });

  it("onTerminalDestroyed is a no-op for non-matching terminal", () => {
    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    manager.onTerminalDestroyed("t2");

    expect(manager.isActive("t1")).toBe(true);
  });

  it("dispose releases all entries", () => {
    const managed1 = makeManagedTerminal();
    const managed2 = makeManagedTerminal();

    manager.ensureContext("t1", managed1);
    manager.ensureContext("t2", managed2);
    manager.dispose();

    expect(manager.isActive("t1")).toBe(false);
    expect(manager.isActive("t2")).toBe(false);
    expect(mockAddonDispose).toHaveBeenCalledTimes(2);
  });

  it("isActive returns false for unknown terminals", () => {
    expect(manager.isActive("unknown")).toBe(false);
  });

  describe("setMaxContexts", () => {
    let originalMax: number;

    beforeEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      originalMax = mod.TerminalWebGLManager.MAX_CONTEXTS;
    });

    afterEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      mod.TerminalWebGLManager.setMaxContexts(originalMax);
    });

    it("clamps zero to 1", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setMaxContexts(0);
      expect(TerminalWebGLManager.MAX_CONTEXTS).toBe(1);
    });

    it("clamps negative values to 1", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setMaxContexts(-5);
      expect(TerminalWebGLManager.MAX_CONTEXTS).toBe(1);
    });

    it("accepts positive values verbatim", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setMaxContexts(8);
      expect(TerminalWebGLManager.MAX_CONTEXTS).toBe(8);
    });
  });

  it("recovers cleanly after failed attach", () => {
    const managed = makeManagedTerminal();
    (managed.terminal.loadAddon as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("WebGL init failed");
    });

    manager.ensureContext("t1", managed);
    expect(manager.isActive("t1")).toBe(false);

    const managed2 = makeManagedTerminal();
    manager.ensureContext("t2", managed2);
    expect(WebglAddonMock).toHaveBeenCalledTimes(2);
    expect(managed2.terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(manager.isActive("t2")).toBe(true);
  });

  describe("GPU hardware availability", () => {
    it("ensureContext is a no-op when hardware is unavailable", () => {
      manager.setHardwareAvailable(false);
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);

      expect(WebglAddonMock).not.toHaveBeenCalled();
      expect(managed.terminal.loadAddon).not.toHaveBeenCalled();
      expect(manager.isActive("t1")).toBe(false);
    });

    it("ensureContext attaches after restoring hardware availability", () => {
      manager.setHardwareAvailable(false);
      manager.setHardwareAvailable(true);
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);

      expect(WebglAddonMock).toHaveBeenCalledTimes(1);
      expect(manager.isActive("t1")).toBe(true);
    });

    it("setting hardware unavailable does not affect already-active contexts", () => {
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      expect(manager.isActive("t1")).toBe(true);

      manager.setHardwareAvailable(false);
      expect(manager.isActive("t1")).toBe(true);
    });

    it("logs a warning only once when skipping due to software GPU", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      manager.setHardwareAvailable(false);

      const managed1 = makeManagedTerminal();
      const managed2 = makeManagedTerminal();
      manager.ensureContext("t1", managed1);
      manager.ensureContext("t2", managed2);

      const softwareWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("software-only GPU")
      );
      expect(softwareWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });

  describe("circuit breaker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      // vi.useFakeTimers() replaces requestAnimationFrame with its own queue.
      // Reinstall our sync shim so ensureContext drains inline as the tests
      // expect — this suite does not exercise rAF pacing.
      installRafShim();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function captureContextLossHandlers(): Array<() => void> {
      const handlers: Array<() => void> = [];
      WebglAddonMock.mockImplementation(function () {
        return {
          dispose: vi.fn(),
          onContextLoss: vi.fn((handler: () => void) => {
            handlers.push(handler);
            return { dispose: vi.fn() };
          }),
        };
      });
      return handlers;
    }

    it("trips after LOSS_THRESHOLD rapid losses and disables WebGL for the session", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      const before = WebglAddonMock.mock.calls.length;
      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);
      expect(WebglAddonMock.mock.calls.length).toBe(before);
      expect(manager.isActive("t4")).toBe(false);
    });

    it("does not trip when losses fall outside the sliding window", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);

      handlers[0]!();
      handlers[1]!();

      vi.setSystemTime(60_000);

      const m3 = makeManagedTerminal();
      manager.ensureContext("t3", m3);
      handlers[2]!();

      const before = WebglAddonMock.mock.calls.length;
      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);
      expect(WebglAddonMock.mock.calls.length).toBe(before + 1);
      expect(manager.isActive("t4")).toBe(true);
    });

    it("does not evict already-active contexts when the breaker trips", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      const m4 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);
      manager.ensureContext("t4", m4);

      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      expect(manager.isActive("t4")).toBe(true);
    });

    it("stale handlers from recycled ids do not contribute to the loss count", () => {
      const handlers = captureContextLossHandlers();

      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");
      manager.ensureContext("t1", managed);

      // Fire all three stale handlers — must NOT trip the breaker
      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      const before = WebglAddonMock.mock.calls.length;
      const m2 = makeManagedTerminal();
      manager.ensureContext("t2", m2);
      expect(WebglAddonMock.mock.calls.length).toBe(before + 1);
      expect(manager.isActive("t2")).toBe(true);
    });

    it("does not log the software-GPU warning after the breaker trips", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);

      const softwareWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("software-only GPU")
      );
      expect(softwareWarnings).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("coalesces a same-frame loss burst across pool entries into one breaker tick", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      const m4 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);
      manager.ensureContext("t4", m4);

      // Bulk GPU eviction (e.g. Chromium 146 D3D11on12 memory pressure) fires
      // webglcontextlost on every pool entry within one animation frame. Queue
      // the rAF so the burst collapses into a single breaker tick.
      rafMode = "queued";
      handlers[0]!();
      handlers[1]!();
      handlers[2]!();
      handlers[3]!();

      expect(flushRafFrame()).toBe(true);
      // The burst collapsed to one frame — nothing else queued.
      expect(flushRafFrame()).toBe(false);

      // One coalesced tick — far below LOSS_THRESHOLD, so the breaker must NOT
      // have tripped and a new ensure must still attach. Flip rAF back to sync
      // so the drain runs inline (matching how this suite's other tests work).
      rafMode = "sync";
      const before = WebglAddonMock.mock.calls.length;
      const m5 = makeManagedTerminal();
      manager.ensureContext("t5", m5);
      expect(WebglAddonMock.mock.calls.length).toBe(before + 1);
      expect(manager.isActive("t5")).toBe(true);
    });

    it("still trips on LOSS_THRESHOLD bursts across distinct frames", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      // Three genuinely distinct GPU events — one per frame — must each tick
      // the breaker so the issue #6163 persistent-fault path still trips.
      rafMode = "queued";
      handlers[0]!();
      flushRafFrame();
      handlers[1]!();
      flushRafFrame();
      handlers[2]!();
      flushRafFrame();

      const before = WebglAddonMock.mock.calls.length;
      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);
      expect(WebglAddonMock.mock.calls.length).toBe(before);
      expect(manager.isActive("t4")).toBe(false);
    });

    it("dispose cancels a pending loss flush before it records a tick", () => {
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      rafMode = "queued";
      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      manager.dispose();
      // The queued rAF callback must be a no-op — pendingLossCount cleared and
      // the rAF id cancelled, so flushing the queue records no breaker ticks.
      flushRafFrame();

      // Fresh manager should still acquire — the disposed manager's state is
      // local to that instance, but a stray flush on the queue must not have
      // tripped any console.warn breaker log either.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      flushRafFrame();
      const breakerWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("circuit breaker")
      );
      expect(breakerWarnings).toHaveLength(0);
      warnSpy.mockRestore();
    });

    it("logs the breaker-trip warning only once", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handlers = captureContextLossHandlers();

      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      handlers[0]!();
      handlers[1]!();
      handlers[2]!();

      // Re-acquire and trip again — should not log a second time
      const m4 = makeManagedTerminal();
      const m5 = makeManagedTerminal();
      const m6 = makeManagedTerminal();
      manager.setHardwareAvailable(true);
      manager.ensureContext("t4", m4);
      manager.ensureContext("t5", m5);
      manager.ensureContext("t6", m6);
      handlers[3]?.();
      handlers[4]?.();
      handlers[5]?.();

      const breakerWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("circuit breaker")
      );
      expect(breakerWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });

  describe("LRU eviction", () => {
    // These tests fill the pool to MAX_CONTEXTS (12), past the passive gate.
    // Pin the threshold above the pool cap so eviction — not passive-mode
    // suppression — is what's under test here.
    beforeEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      mod.TerminalWebGLManager.setPassiveThreshold(999);
    });

    it("evicts the least recently used entry when pool reaches MAX_CONTEXTS", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const maxContexts = TerminalWebGLManager.MAX_CONTEXTS;

      const disposes: ReturnType<typeof vi.fn>[] = [];
      WebglAddonMock.mockImplementation(function () {
        const d = vi.fn();
        disposes.push(d);
        return { dispose: d, onContextLoss: mockOnContextLoss };
      });

      const localManager = new TerminalWebGLManager();

      for (let i = 0; i < maxContexts; i++) {
        const m = makeManagedTerminal({ lastActiveTime: i });
        localManager.ensureContext(`t${i}`, m);
      }

      expect(disposes).toHaveLength(maxContexts);
      disposes.forEach((d) => expect(d).not.toHaveBeenCalled());

      // Add one more — should evict t0 (oldest in LRU order)
      const extra = makeManagedTerminal({ lastActiveTime: maxContexts });
      localManager.ensureContext(`t${maxContexts}`, extra);

      expect(disposes[0]).toHaveBeenCalledTimes(1);
      expect(localManager.isActive("t0")).toBe(false);
      expect(localManager.isActive(`t${maxContexts}`)).toBe(true);

      // t1 through t{maxContexts-1} should still be active
      for (let i = 1; i < maxContexts; i++) {
        expect(localManager.isActive(`t${i}`)).toBe(true);
      }
    });

    it("touching an entry moves it to the end of LRU", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const maxContexts = TerminalWebGLManager.MAX_CONTEXTS;

      const disposes: ReturnType<typeof vi.fn>[] = [];
      WebglAddonMock.mockImplementation(function () {
        const d = vi.fn();
        disposes.push(d);
        return { dispose: d, onContextLoss: mockOnContextLoss };
      });

      const localManager = new TerminalWebGLManager();

      for (let i = 0; i < maxContexts; i++) {
        const m = makeManagedTerminal({ lastActiveTime: i });
        localManager.ensureContext(`t${i}`, m);
      }

      // Touch t0 — should move it to end of LRU
      const m0 = makeManagedTerminal({ lastActiveTime: maxContexts + 1 });
      localManager.ensureContext("t0", m0);

      // Add one more — should evict t1 (now the oldest), not t0
      const extra = makeManagedTerminal({ lastActiveTime: maxContexts + 2 });
      localManager.ensureContext(`t${maxContexts}`, extra);

      expect(localManager.isActive("t0")).toBe(true);
      expect(localManager.isActive("t1")).toBe(false);
      expect(disposes[1]).toHaveBeenCalledTimes(1);
    });
  });

  describe("eviction priority", () => {
    // Same as LRU eviction: these fill the pool past the passive gate, so the
    // threshold is pinned above the pool cap to isolate eviction behaviour.
    beforeEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      mod.TerminalWebGLManager.setPassiveThreshold(999);
    });

    // Builds a fresh manager whose addons each carry an id-tagged dispose mock,
    // so a test can assert exactly which pooled terminal lost its slot.
    async function makePriorityManager(): Promise<{
      localManager: import("../TerminalWebGLManager").TerminalWebGLManager;
      disposeFor: (id: string) => ReturnType<typeof vi.fn>;
    }> {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const disposeById = new Map<string, ReturnType<typeof vi.fn>>();
      let pendingId: string | null = null;
      WebglAddonMock.mockImplementation(function () {
        const d = vi.fn();
        if (pendingId) disposeById.set(pendingId, d);
        return { dispose: d, onContextLoss: mockOnContextLoss };
      });
      const localManager = new TerminalWebGLManager();
      const origEnsure = localManager.ensureContext.bind(localManager);
      // Tag the next-constructed addon with the id being ensured.
      localManager.ensureContext = (id: string, m: ManagedTerminal): void => {
        pendingId = id;
        origEnsure(id, m);
        pendingId = null;
      };
      return {
        localManager,
        disposeFor: (id: string) => {
          const d = disposeById.get(id);
          if (!d) throw new Error(`no addon constructed for ${id}`);
          return d;
        },
      };
    }

    it("evicts the idle terminal over actively-working ones regardless of LRU order", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const max = TerminalWebGLManager.MAX_CONTEXTS;
      const { localManager, disposeFor } = await makePriorityManager();

      // Oldest LRU entries are actively streaming (tier 5). Pure LRU would evict
      // t0; the priority scorer must instead evict the idle terminal even though
      // it is the newest entry.
      for (let i = 0; i < max - 1; i++) {
        localManager.ensureContext(
          `work${i}`,
          makeManagedTerminal({ agentState: "working", pendingWrites: 2, isFocused: false })
        );
      }
      localManager.ensureContext(
        "idle",
        makeManagedTerminal({ agentState: "idle", pendingWrites: 0, isFocused: false })
      );

      localManager.ensureContext("extra", makeManagedTerminal({ agentState: "working" }));

      expect(localManager.isActive("idle")).toBe(false);
      expect(disposeFor("idle")).toHaveBeenCalledTimes(1);
      expect(localManager.isActive("work0")).toBe(true);
      expect(localManager.isActive("extra")).toBe(true);
    });

    it("treats undefined agentState as tier-0 and evicts it before a working terminal", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const max = TerminalWebGLManager.MAX_CONTEXTS;
      const { localManager, disposeFor } = await makePriorityManager();

      for (let i = 0; i < max - 1; i++) {
        localManager.ensureContext(
          `work${i}`,
          makeManagedTerminal({ agentState: "working", pendingWrites: 1 })
        );
      }
      // No agentState at all (non-agent terminal).
      localManager.ensureContext("plain", makeManagedTerminal());

      localManager.ensureContext("extra", makeManagedTerminal());

      expect(localManager.isActive("plain")).toBe(false);
      expect(disposeFor("plain")).toHaveBeenCalledTimes(1);
    });

    it("protects a streaming terminal (tier 5) over a focused-idle one (tier 4)", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const max = TerminalWebGLManager.MAX_CONTEXTS;
      const { localManager, disposeFor } = await makePriorityManager();

      for (let i = 0; i < max - 1; i++) {
        localManager.ensureContext(
          `work${i}`,
          makeManagedTerminal({ agentState: "working", pendingWrites: 3, isFocused: false })
        );
      }
      // Focused but idle — the user clicked through it but it isn't doing work.
      localManager.ensureContext(
        "focused",
        makeManagedTerminal({ agentState: "waiting", pendingWrites: 0, isFocused: true })
      );

      localManager.ensureContext("extra", makeManagedTerminal({ agentState: "working" }));

      expect(localManager.isActive("focused")).toBe(false);
      expect(disposeFor("focused")).toHaveBeenCalledTimes(1);
      for (let i = 0; i < max - 1; i++) {
        expect(localManager.isActive(`work${i}`)).toBe(true);
      }
    });

    it("classifies recent-write recency at the WRITE_BURST_RECENCY_MS boundary", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      installRafShim();
      try {
        const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
        const { WRITE_BURST_RECENCY_MS } = await import("../types");
        const max = TerminalWebGLManager.MAX_CONTEXTS;
        const { localManager, disposeFor } = await makePriorityManager();

        const now = Date.now();
        // Filler: streaming terminals (tier 5) — never the eviction target.
        for (let i = 0; i < max - 2; i++) {
          localManager.ensureContext(
            `work${i}`,
            makeManagedTerminal({ agentState: "working", pendingWrites: 2 })
          );
        }
        // A: waiting, wrote just inside the window → recently-writing → tier 3.
        localManager.ensureContext(
          "recent",
          makeManagedTerminal({
            agentState: "waiting",
            pendingWrites: 0,
            isFocused: false,
            lastWriteAt: now - (WRITE_BURST_RECENCY_MS - 1),
          })
        );
        // B: waiting, wrote just outside the window → not recently-writing → tier 1.
        localManager.ensureContext(
          "stale",
          makeManagedTerminal({
            agentState: "waiting",
            pendingWrites: 0,
            isFocused: false,
            lastWriteAt: now - (WRITE_BURST_RECENCY_MS + 1),
          })
        );

        localManager.ensureContext("extra", makeManagedTerminal({ agentState: "working" }));

        // Tier 1 (stale) outranks tier 3 (recent) for eviction.
        expect(localManager.isActive("stale")).toBe(false);
        expect(disposeFor("stale")).toHaveBeenCalledTimes(1);
        expect(localManager.isActive("recent")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to LRU order to break ties within the same tier", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      const max = TerminalWebGLManager.MAX_CONTEXTS;
      const { localManager, disposeFor } = await makePriorityManager();

      // Every entry is tier 0 (idle). Oldest LRU entry must lose its slot.
      for (let i = 0; i < max; i++) {
        localManager.ensureContext(`idle${i}`, makeManagedTerminal({ agentState: "idle" }));
      }
      localManager.ensureContext("extra", makeManagedTerminal({ agentState: "idle" }));

      expect(localManager.isActive("idle0")).toBe(false);
      expect(disposeFor("idle0")).toHaveBeenCalledTimes(1);
      expect(localManager.isActive("idle1")).toBe(true);
    });

    it("evicts a recently-flushed done terminal (tier 0) before a waiting one (tier 1)", async () => {
      // Regression: an exited/completed agent that just printed a final line
      // has a recent lastWriteAt, but that flush is not an ongoing burst — it
      // must stay tier 0 and be evicted before an idle "waiting" terminal.
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      installRafShim();
      try {
        const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
        const max = TerminalWebGLManager.MAX_CONTEXTS;
        const { localManager, disposeFor } = await makePriorityManager();

        // Filler streaming terminals (tier 5) — never the target.
        for (let i = 0; i < max - 2; i++) {
          localManager.ensureContext(
            `work${i}`,
            makeManagedTerminal({ agentState: "working", pendingWrites: 2 })
          );
        }
        // Waiting, no recent write → tier 1.
        localManager.ensureContext(
          "waiting",
          makeManagedTerminal({ agentState: "waiting", pendingWrites: 0, isFocused: false })
        );
        // Exited, just flushed a final line → must remain tier 0, not tier 3.
        localManager.ensureContext(
          "exited",
          makeManagedTerminal({
            agentState: "exited",
            pendingWrites: 0,
            isFocused: false,
            lastWriteAt: Date.now() - 1,
          })
        );

        localManager.ensureContext("extra", makeManagedTerminal({ agentState: "working" }));

        expect(localManager.isActive("exited")).toBe(false);
        expect(disposeFor("exited")).toHaveBeenCalledTimes(1);
        expect(localManager.isActive("waiting")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats exactly WRITE_BURST_RECENCY_MS ago as stale (strict < boundary)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      installRafShim();
      try {
        const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
        const { WRITE_BURST_RECENCY_MS } = await import("../types");
        const max = TerminalWebGLManager.MAX_CONTEXTS;
        const { localManager, disposeFor } = await makePriorityManager();

        const now = Date.now();
        for (let i = 0; i < max - 2; i++) {
          localManager.ensureContext(
            `work${i}`,
            makeManagedTerminal({ agentState: "working", pendingWrites: 2 })
          );
        }
        // Exactly at the window edge → stale (tier 1), since the check is `<`.
        localManager.ensureContext(
          "edge",
          makeManagedTerminal({
            agentState: "waiting",
            pendingWrites: 0,
            isFocused: false,
            lastWriteAt: now - WRITE_BURST_RECENCY_MS,
          })
        );
        // One millisecond inside the window → recent (tier 3).
        localManager.ensureContext(
          "inside",
          makeManagedTerminal({
            agentState: "waiting",
            pendingWrites: 0,
            isFocused: false,
            lastWriteAt: now - WRITE_BURST_RECENCY_MS + 1,
          })
        );

        localManager.ensureContext("extra", makeManagedTerminal({ agentState: "working" }));

        expect(localManager.isActive("edge")).toBe(false);
        expect(disposeFor("edge")).toHaveBeenCalledTimes(1);
        expect(localManager.isActive("inside")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rate-limits the pool-pressure warning to once per minute", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      installRafShim();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
        const max = TerminalWebGLManager.MAX_CONTEXTS;
        const { localManager } = await makePriorityManager();

        for (let i = 0; i < max; i++) {
          localManager.ensureContext(`idle${i}`, makeManagedTerminal({ agentState: "idle" }));
        }

        const poolWarnings = () =>
          warnSpy.mock.calls.filter(
            (args) => typeof args[0] === "string" && args[0].includes("Pool pressure")
          );

        // First eviction warns immediately.
        localManager.ensureContext("e1", makeManagedTerminal({ agentState: "idle" }));
        expect(poolWarnings()).toHaveLength(1);

        // Second eviction within the same minute is suppressed.
        localManager.ensureContext("e2", makeManagedTerminal({ agentState: "idle" }));
        expect(poolWarnings()).toHaveLength(1);

        // After the interval elapses, the next eviction warns again.
        vi.setSystemTime(60_001);
        localManager.ensureContext("e3", makeManagedTerminal({ agentState: "idle" }));
        expect(poolWarnings()).toHaveLength(2);
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe("passive mode gate (#8378)", () => {
    it("suppresses new acquisitions once pool+queue reaches the threshold", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setPassiveThreshold(2);

      manager.ensureContext("t1", makeManagedTerminal());
      manager.ensureContext("t2", makeManagedTerminal());
      expect(WebglAddonMock).toHaveBeenCalledTimes(2);
      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(true);

      // 3rd request — pool is already at the threshold, so this is suppressed
      // and the terminal stays on the DOM renderer.
      manager.ensureContext("t3", makeManagedTerminal());
      expect(WebglAddonMock).toHaveBeenCalledTimes(2);
      expect(manager.isActive("t3")).toBe(false);
    });

    it("lets a re-ensure of an already-pooled terminal pass through (LRU touch)", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setPassiveThreshold(2);

      const m1 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", makeManagedTerminal());

      // Pool is full at the threshold; re-ensuring a pooled terminal must not
      // be gated (it adds no new context) and must not evict anything.
      manager.ensureContext("t1", m1);
      expect(WebglAddonMock).toHaveBeenCalledTimes(2);
      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(true);
    });

    it("resumes acquisition once a release drops the count below the threshold", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setPassiveThreshold(2);

      manager.ensureContext("t1", makeManagedTerminal());
      manager.ensureContext("t2", makeManagedTerminal());
      manager.ensureContext("t3", makeManagedTerminal());
      expect(manager.isActive("t3")).toBe(false);

      manager.releaseContext("t1");
      expect(manager.isActive("t1")).toBe(false);

      // Slot freed — a newly-visible terminal now passes the gate.
      manager.ensureContext("t3", makeManagedTerminal());
      expect(manager.isActive("t3")).toBe(true);
      expect(WebglAddonMock).toHaveBeenCalledTimes(3);
    });

    it("keeps a suppressed terminal on DOM until the caller re-ensures it", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setPassiveThreshold(2);

      manager.ensureContext("t1", makeManagedTerminal());
      manager.ensureContext("t2", makeManagedTerminal());
      manager.ensureContext("t3", makeManagedTerminal());
      expect(manager.isActive("t3")).toBe(false);

      // Releasing t1 frees a slot, but t3 must NOT auto-resume — the gate only
      // suppresses, it doesn't track suppressed terminals. The caller drives
      // re-acquisition on the next attach/focus signal.
      manager.releaseContext("t1");
      expect(manager.isActive("t3")).toBe(false);

      manager.ensureContext("t3", makeManagedTerminal());
      expect(manager.isActive("t3")).toBe(true);
    });

    it("clamps the threshold to a minimum of 1", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setPassiveThreshold(0);

      // Clamped to 1 (not 0): the first acquisition still succeeds, the second
      // is suppressed. A threshold of 0 would have suppressed even the first.
      manager.ensureContext("t1", makeManagedTerminal());
      manager.ensureContext("t2", makeManagedTerminal());
      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(false);
      expect(WebglAddonMock).toHaveBeenCalledTimes(1);
    });

    it("does not evict existing pooled contexts when the threshold is crossed", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setPassiveThreshold(2);

      const disposes: ReturnType<typeof vi.fn>[] = [];
      WebglAddonMock.mockImplementation(function () {
        const d = vi.fn();
        disposes.push(d);
        return { dispose: d, onContextLoss: mockOnContextLoss };
      });
      const localManager = new TerminalWebGLManager();

      localManager.ensureContext("t1", makeManagedTerminal());
      localManager.ensureContext("t2", makeManagedTerminal());
      // Suppressed — must not trigger eviction of t1/t2 to make room.
      localManager.ensureContext("t3", makeManagedTerminal());

      expect(localManager.isActive("t1")).toBe(true);
      expect(localManager.isActive("t2")).toBe(true);
      expect(disposes).toHaveLength(2);
      disposes.forEach((d) => expect(d).not.toHaveBeenCalled());
    });
  });

  describe("lazy WebglAddon loading", () => {
    // These tests exercise the dynamic-import path. They reset loader state in
    // beforeEach so the queue behavior runs against a real (mocked) import().
    beforeEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      mod.__testing.resetLoaderState();
    });

    afterEach(async () => {
      // Restore the preload that the outer suite relies on.
      const webglMod = await import("@xterm/addon-webgl");
      const mod = await import("../TerminalWebGLManager");
      mod.__testing.setWebglAddonClass(
        webglMod.WebglAddon as unknown as new () => InstanceType<typeof webglMod.WebglAddon>
      );
    });

    it("does not construct the addon synchronously when not yet loaded", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed = makeManagedTerminal();

      localManager.ensureContext("t1", managed);

      expect(WebglAddonMock).not.toHaveBeenCalled();
      expect(localManager.isActive("t1")).toBe(false);
    });

    it("flushes the queued request after the addon resolves", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed = makeManagedTerminal();

      localManager.ensureContext("t1", managed);
      // Allow the dynamic import + microtask chain to drain.
      await flushDynamicImport();

      expect(WebglAddonMock).toHaveBeenCalledTimes(1);
      expect(localManager.isActive("t1")).toBe(true);
    });

    it("dedupes repeated ensure calls for the same id while loading", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed1 = makeManagedTerminal();
      const managed2 = makeManagedTerminal();

      localManager.ensureContext("t1", managed1);
      localManager.ensureContext("t1", managed2);

      await flushDynamicImport();

      expect(WebglAddonMock).toHaveBeenCalledTimes(1);
      expect(managed1.terminal.loadAddon).not.toHaveBeenCalled();
      expect(managed2.terminal.loadAddon).toHaveBeenCalledTimes(1);
    });

    it("releaseContext discards a queued request before the addon resolves", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed = makeManagedTerminal();

      localManager.ensureContext("t1", managed);
      localManager.releaseContext("t1");

      await flushDynamicImport();

      expect(WebglAddonMock).not.toHaveBeenCalled();
      expect(localManager.isActive("t1")).toBe(false);
    });

    it("onTerminalDestroyed discards a queued request before the addon resolves", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed = makeManagedTerminal();

      localManager.ensureContext("t1", managed);
      localManager.onTerminalDestroyed("t1");

      await flushDynamicImport();

      expect(WebglAddonMock).not.toHaveBeenCalled();
    });

    it("dispose clears any queued requests", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed = makeManagedTerminal();

      localManager.ensureContext("t1", managed);
      localManager.dispose();

      await flushDynamicImport();

      expect(WebglAddonMock).not.toHaveBeenCalled();
    });

    it("skips queued requests if hardware was marked unavailable while loading", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed = makeManagedTerminal();

      localManager.ensureContext("t1", managed);
      localManager.setHardwareAvailable(false);

      await flushDynamicImport();

      expect(WebglAddonMock).not.toHaveBeenCalled();
      expect(localManager.isActive("t1")).toBe(false);
    });

    it("skips queued requests for terminals that closed while loading", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed = makeManagedTerminal();

      localManager.ensureContext("t1", managed);
      managed.isOpened = false;

      await flushDynamicImport();

      expect(WebglAddonMock).not.toHaveBeenCalled();
    });

    it("flushes multiple distinct ids queued during the load window", async () => {
      const { TerminalWebGLManager: ManagerClass } = await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();

      localManager.ensureContext("t1", m1);
      localManager.ensureContext("t2", m2);

      await flushDynamicImport();

      expect(WebglAddonMock).toHaveBeenCalledTimes(2);
      expect(localManager.isActive("t1")).toBe(true);
      expect(localManager.isActive("t2")).toBe(true);
    });

    it("retries the load after a rejection, then attaches the queued terminal", async () => {
      const { TerminalWebGLManager: ManagerClass, __testing } =
        await import("../TerminalWebGLManager");
      const localManager = new ManagerClass();
      const managed = makeManagedTerminal();

      // Simulate a rejected load: the production loader's catch clears
      // webglAddonLoadPromise so the next ensureContext call can retry.
      // Drive that branch by manually clearing loader state once after the
      // first request queues — mirrors what the catch arm does on rejection.
      localManager.ensureContext("t1", managed);
      await flushDynamicImport();
      // Sanity: with the mock, the first attempt should have succeeded.
      expect(localManager.isActive("t1")).toBe(true);
      localManager.releaseContext("t1");
      __testing.resetLoaderState();

      // After a forced reset, ensureContext should re-load and re-attach.
      localManager.ensureContext("t1", managed);
      await flushDynamicImport();

      expect(localManager.isActive("t1")).toBe(true);
    });
  });

  describe("rAF drain queue (#7467)", () => {
    // Ensures bulk attaches are spaced one-per-frame so Chromium's
    // 16-context-per-renderer cap is not over-subscribed in a single tick.

    it("attaches one queued terminal per animation frame", () => {
      rafMode = "queued";
      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();

      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      expect(WebglAddonMock).not.toHaveBeenCalled();

      flushRafFrame();
      expect(WebglAddonMock).toHaveBeenCalledTimes(1);
      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(false);

      flushRafFrame();
      expect(WebglAddonMock).toHaveBeenCalledTimes(2);
      expect(manager.isActive("t2")).toBe(true);
      expect(manager.isActive("t3")).toBe(false);

      flushRafFrame();
      expect(WebglAddonMock).toHaveBeenCalledTimes(3);
      expect(manager.isActive("t3")).toBe(true);

      // Queue drained — no further frame should be scheduled.
      expect(flushRafFrame()).toBe(false);
    });

    it("dedupes repeat ensure calls for the same id within the queue window", () => {
      rafMode = "queued";
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      manager.ensureContext("t1", managed);
      manager.ensureContext("t1", managed);

      flushRafFrame();
      expect(WebglAddonMock).toHaveBeenCalledTimes(1);
    });

    it("skips queued attach if releaseContext fires before drain", () => {
      rafMode = "queued";
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");

      flushRafFrame();
      expect(WebglAddonMock).not.toHaveBeenCalled();
      expect(manager.isActive("t1")).toBe(false);
    });

    it("skips queued attach if terminal closes before drain", () => {
      rafMode = "queued";
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      managed.isOpened = false;

      flushRafFrame();
      expect(WebglAddonMock).not.toHaveBeenCalled();
    });

    it("skips queued attach if pool already holds the id by drain time", () => {
      rafMode = "queued";
      const managed = makeManagedTerminal();
      // First ensure and drain.
      manager.ensureContext("t1", managed);
      flushRafFrame();
      expect(WebglAddonMock).toHaveBeenCalledTimes(1);

      // Second ensure for the same id arrives — no new attach should happen.
      manager.ensureContext("t1", managed);
      flushRafFrame();
      expect(WebglAddonMock).toHaveBeenCalledTimes(1);
    });

    it("drain clears all pending if hardware becomes unavailable mid-queue", () => {
      rafMode = "queued";
      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);

      manager.setHardwareAvailable(false);
      flushRafFrame();

      expect(WebglAddonMock).not.toHaveBeenCalled();
      expect(flushRafFrame()).toBe(false);
    });

    it("dispose cancels a pending rAF and clears the queue", () => {
      rafMode = "queued";
      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);

      manager.dispose();
      // After dispose the cancel should have removed the scheduled frame.
      expect(flushRafFrame()).toBe(false);
      expect(WebglAddonMock).not.toHaveBeenCalled();
    });
  });

  describe("capture-phase webglcontextlost handler (#7467)", () => {
    function captureContextLossHandlers(): Array<() => void> {
      const handlers: Array<() => void> = [];
      WebglAddonMock.mockImplementation(function () {
        return {
          dispose: vi.fn(),
          onContextLoss: vi.fn((handler: () => void) => {
            handlers.push(handler);
            return { dispose: vi.fn() };
          }),
        };
      });
      return handlers;
    }

    it("releases the context immediately on capture-phase webglcontextlost", () => {
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      expect(manager.isActive("t1")).toBe(true);

      const element = managed.terminal.element as HTMLElement;
      const event = new Event("webglcontextlost");
      element.dispatchEvent(event);

      expect(manager.isActive("t1")).toBe(false);
      expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
    });

    it("subsequent stale onContextLoss for the same id is a no-op", () => {
      const handlers = captureContextLossHandlers();
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);

      const element = managed.terminal.element as HTMLElement;
      element.dispatchEvent(new Event("webglcontextlost"));
      expect(manager.isActive("t1")).toBe(false);

      // The addon's deferred onContextLoss still fires ~3s later — should be inert.
      expect(() => handlers[0]!()).not.toThrow();
      expect(manager.isActive("t1")).toBe(false);
    });

    it("contributes to the circuit breaker after threshold real evictions", () => {
      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      (m1.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));
      (m2.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));
      (m3.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));

      const before = WebglAddonMock.mock.calls.length;
      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);
      expect(WebglAddonMock.mock.calls.length).toBe(before);
      expect(manager.isActive("t4")).toBe(false);
    });

    it("does not re-fire after release (handler is removed)", () => {
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");

      const element = managed.terminal.element as HTMLElement;
      element.dispatchEvent(new Event("webglcontextlost"));

      // Handler removed on release → refresh must NOT have fired.
      expect(managed.terminal.refresh).not.toHaveBeenCalled();
    });

    it("ignores capture event when terminal lacks an element", () => {
      const managed = makeManagedTerminal();
      (managed.terminal as unknown as { element: HTMLElement | undefined }).element = undefined;
      // Should still attach (just without a capture handler) and not throw.
      expect(() => manager.ensureContext("t1", managed)).not.toThrow();
      expect(manager.isActive("t1")).toBe(true);
    });

    it("registers in the capture phase, not bubble", () => {
      // Bubble-only dispatch must NOT fire the manager's handler — proves the
      // listener was registered with { capture: true } so it can pre-empt
      // xterm's canvas-target listener and its 3s restore timer.
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);

      const el = managed.terminal.element as unknown as ReturnType<typeof makeFakeElement> & {
        __dispatchBubbleOnly(e: Event): void;
        __listenerCount(t: string): number;
      };
      el.__dispatchBubbleOnly(new Event("webglcontextlost"));

      expect(manager.isActive("t1")).toBe(true);
      expect(managed.terminal.refresh).not.toHaveBeenCalled();
    });

    it("releaseContext removes the capture listener with matching options", () => {
      // Verifies addEventListener and removeEventListener used the same
      // capture flag — a mismatch would leak the listener in production.
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);

      const el = managed.terminal.element as unknown as { __listenerCount(t: string): number };
      expect(el.__listenerCount("webglcontextlost")).toBe(1);

      manager.releaseContext("t1");
      expect(el.__listenerCount("webglcontextlost")).toBe(0);
    });
  });

  describe("doRelease forces synchronous GPU release (#7467)", () => {
    it("calls WEBGL_lose_context.loseContext on the addon's GL context", () => {
      const loseContext = vi.fn();
      const getExtension = vi.fn().mockReturnValue({ loseContext });
      const fakeGl = { getExtension } as unknown as WebGL2RenderingContext;

      WebglAddonMock.mockImplementation(function () {
        const addon: Record<string, unknown> = {
          dispose: vi.fn(),
          onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
        };
        // Mirror the @xterm/addon-webgl 0.19 internal shape so the
        // narrow private cast in doRelease can locate the GL context.
        addon._renderer = { _gl: fakeGl };
        return addon;
      });

      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      manager.releaseContext("t1");

      expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
      expect(loseContext).toHaveBeenCalledTimes(1);
    });

    it("onTerminalDestroyed also forces synchronous GPU slot release", () => {
      // Hibernation calls onTerminalDestroyed without addon.dispose() (xterm
      // tears the addon down via terminal.dispose()). Without the explicit
      // loseContext, a hibernate-then-bulk-recreate cycle would stall on the
      // 16-slot Chromium budget the same way #7467 stalled the attach path.
      const loseContext = vi.fn();
      const getExtension = vi.fn().mockReturnValue({ loseContext });
      const fakeGl = { getExtension } as unknown as WebGL2RenderingContext;

      WebglAddonMock.mockImplementation(function () {
        const addon: Record<string, unknown> = {
          dispose: vi.fn(),
          onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
        };
        addon._renderer = { _gl: fakeGl };
        return addon;
      });

      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      manager.onTerminalDestroyed("t1");

      expect(loseContext).toHaveBeenCalledTimes(1);
      expect(manager.isActive("t1")).toBe(false);
    });

    it("release proceeds cleanly when WEBGL_lose_context is unavailable", () => {
      WebglAddonMock.mockImplementation(function () {
        return {
          dispose: vi.fn(),
          onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
          // No _renderer — narrow cast resolves to undefined; release must still succeed.
        };
      });

      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      expect(() => manager.releaseContext("t1")).not.toThrow();
      expect(manager.isActive("t1")).toBe(false);
    });
  });
});
