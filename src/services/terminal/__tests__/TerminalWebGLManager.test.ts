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
    // Thresholds are module-level state that survives across tests. Reset to
    // a tight band that's high enough for any single-suite tests to attach
    // freely; the mode-switch describe block raises/lowers them as needed.
    mod.TerminalWebGLManager.setWebglThresholds(32, 28);
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

  describe("repairAtlasForReactivation", () => {
    it("resets the local renderer and repaints a pooled, sized terminal", () => {
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      const addon = addonAt(0);

      const repaired = manager.repairAtlasForReactivation("t1");

      expect(repaired).toBe(true);
      // Local resize-like reset only — never the shared-atlas clear (which would
      // perturb co-owning tiled terminals) and never a reacquire (breaker tick).
      expect(addon._renderer.handleResize).toHaveBeenCalledWith(80, 24);
      expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
      expect(mockAddonDispose).not.toHaveBeenCalled();
      expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
      // The context stays live — repair must not drop the pool entry.
      expect(manager.isActive("t1")).toBe(true);
    });

    it("falls back to local model clear when resize-like reset is unavailable", () => {
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      const addon = addonAt(0);
      delete (addon._renderer as { handleResize?: unknown }).handleResize;

      const repaired = manager.repairAtlasForReactivation("t1");

      expect(repaired).toBe(true);
      expect(addon._renderer._clearModel).toHaveBeenCalledWith(true);
      expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
      expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
    });

    it("is a no-op for a terminal with no active WebGL context (DOM renderer)", () => {
      // Never ensureContext'd — no pool entry, so nothing to repair.
      const repaired = manager.repairAtlasForReactivation("never-attached");
      expect(repaired).toBe(false);
      expect(WebglAddonMock).not.toHaveBeenCalled();
    });

    it("skips the repair when the terminal has no rows yet", () => {
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

      const repaired = manager.repairAtlasForReactivation("t1");

      expect(repaired).toBe(false);
      // No model touched and no repaint for an unsized grid — the wake resize
      // rebuilds it from scratch.
      expect(addon._renderer.handleResize).not.toHaveBeenCalled();
      expect(addon._renderer._clearModel).not.toHaveBeenCalled();
      expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
      expect(managed.terminal.refresh).not.toHaveBeenCalled();
    });

    it("returns false when the local reset cannot run", () => {
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      const addon = addonAt(0);
      // Neither the resize-like path nor the model-clear fallback is available.
      delete (addon._renderer as { handleResize?: unknown }).handleResize;
      delete (addon._renderer as { _clearModel?: unknown })._clearModel;

      const repaired = manager.repairAtlasForReactivation("t1");

      expect(repaired).toBe(false);
      expect(managed.terminal.refresh).not.toHaveBeenCalled();
      expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
    });
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

  it("context loss keeps the terminal in `wants` so future mode flips include it (regression)", () => {
    // The old (LRU) manager called releaseContext() on loss, which under the
    // new mode-switch model would also decrement wants and silently drop the
    // terminal from future dom→webgl flips. This pins the new semantic:
    // context loss drops the dead pool entry but leaves the want intact so
    // the next consumer re-ensure (visibility change, tier transition, mode
    // flip) restores WebGL automatically. We deliberately do NOT auto-requeue
    // here — re-queuing in response to a Chromium-bulk-eviction loss would
    // immediately re-trigger the eviction and loop until the breaker trips.
    let contextLossHandler: (() => void) | undefined;
    mockOnContextLoss.mockImplementation((handler: () => void) => {
      contextLossHandler = handler;
      return { dispose: vi.fn() };
    });

    const managed = makeManagedTerminal();
    manager.ensureContext("t1", managed);
    expect(manager.getWantsSize()).toBe(1);

    contextLossHandler!();

    // Pool entry dropped, but want preserved across the loss.
    expect(manager.isActive("t1")).toBe(false);
    expect(manager.getWantsSize()).toBe(1);
    // No auto-reattach — addon constructor called exactly once.
    expect(WebglAddonMock).toHaveBeenCalledTimes(1);
    // A consumer re-ensure brings WebGL back without flipping mode.
    manager.ensureContext("t1", managed);
    expect(manager.isActive("t1")).toBe(true);
    expect(WebglAddonMock).toHaveBeenCalledTimes(2);
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

  describe("threshold setters", () => {
    let originalUpper: number;
    let originalLower: number;

    beforeEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      originalUpper = mod.TerminalWebGLManager.UPPER_THRESHOLD;
      originalLower = mod.TerminalWebGLManager.LOWER_THRESHOLD;
    });

    afterEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      mod.TerminalWebGLManager.setWebglThresholds(originalUpper, originalLower);
    });

    it("setWebglUpperThreshold clamps zero to 1", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setWebglUpperThreshold(0);
      expect(TerminalWebGLManager.UPPER_THRESHOLD).toBe(1);
    });

    it("setWebglUpperThreshold clamps negative values to 1", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setWebglUpperThreshold(-5);
      expect(TerminalWebGLManager.UPPER_THRESHOLD).toBe(1);
    });

    it("setWebglUpperThreshold accepts positive values verbatim", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setWebglUpperThreshold(8);
      expect(TerminalWebGLManager.UPPER_THRESHOLD).toBe(8);
    });

    it("lowering upper below the current lower clamps lower down", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setWebglUpperThreshold(20);
      TerminalWebGLManager.setWebglLowerThreshold(15);
      TerminalWebGLManager.setWebglUpperThreshold(10);
      expect(TerminalWebGLManager.UPPER_THRESHOLD).toBe(10);
      expect(TerminalWebGLManager.LOWER_THRESHOLD).toBe(10);
    });

    it("raising lower above the current upper clamps lower up to upper", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setWebglUpperThreshold(5);
      TerminalWebGLManager.setWebglLowerThreshold(100);
      expect(TerminalWebGLManager.LOWER_THRESHOLD).toBe(5);
    });

    it("setWebglThresholds atomically sets both, applying clamps", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setWebglThresholds(12, 10);
      expect(TerminalWebGLManager.UPPER_THRESHOLD).toBe(12);
      expect(TerminalWebGLManager.LOWER_THRESHOLD).toBe(10);
    });

    it("setWebglLowerThreshold clamps negative values to zero", async () => {
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setWebglUpperThreshold(10);
      TerminalWebGLManager.setWebglLowerThreshold(-3);
      expect(TerminalWebGLManager.LOWER_THRESHOLD).toBe(0);
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

    it("setting hardware unavailable releases active contexts (mode-switch model)", () => {
      // Under the mode-switch design, hardware-unavailable is a wholesale
      // transition — every WebGL terminal flips to DOM, not a mixed state.
      // The previous LRU-pool implementation left existing contexts alone;
      // the new model coordinates the change across the fleet.
      const managed = makeManagedTerminal();
      manager.ensureContext("t1", managed);
      expect(manager.isActive("t1")).toBe(true);

      manager.setHardwareAvailable(false);
      expect(manager.isActive("t1")).toBe(false);
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

    it("releases every active context when the breaker trips (mode-switch model)", () => {
      // Under the mode-switch design, a breaker trip is wholesale: WebGL is
      // declared unreliable for the session, so every active context flips to
      // DOM together. The previous LRU implementation left them in place,
      // betting they were still healthy — that bet stops mattering once we've
      // already decided not to use WebGL going forward.
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

      expect(manager.isActive("t1")).toBe(false);
      expect(manager.isActive("t2")).toBe(false);
      expect(manager.isActive("t3")).toBe(false);
      expect(manager.isActive("t4")).toBe(false);
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
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      // dispose must cancel the queued flush — not just zero pendingLossCount.
      // If the rAF survived, flushRafFrame would still find an entry. The
      // distinction matters: a future change that drops cancelAnimationFrame
      // but keeps the count reset would silently leak rAF callbacks, and only
      // this empty-queue assertion catches it.
      expect(flushRafFrame()).toBe(false);

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

  describe("mode switch", () => {
    // Tight thresholds so the count manipulation here is small enough to
    // follow. Real defaults are 12/10 (balanced profile); the test layer
    // controls them directly.
    beforeEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      mod.TerminalWebGLManager.setWebglThresholds(3, 2);
    });

    it("starts in webgl mode and attaches every want", () => {
      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);

      expect(manager.getMode()).toBe("webgl");
      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(true);
      expect(manager.isActive("t3")).toBe(true);
    });

    it("flips to dom mode and releases every context when wants exceeds upper", () => {
      const terms = Array.from({ length: 4 }, () => makeManagedTerminal());
      manager.ensureContext("t1", terms[0]!);
      manager.ensureContext("t2", terms[1]!);
      manager.ensureContext("t3", terms[2]!);
      expect(manager.getMode()).toBe("webgl");

      // The 4th want crosses the upper threshold (3) → flip to dom.
      manager.ensureContext("t4", terms[3]!);

      expect(manager.getMode()).toBe("dom");
      expect(manager.isActive("t1")).toBe(false);
      expect(manager.isActive("t2")).toBe(false);
      expect(manager.isActive("t3")).toBe(false);
      expect(manager.isActive("t4")).toBe(false);
      // All four still tracked as wanting WebGL — they get it back on flip.
      expect(manager.getWantsSize()).toBe(4);
    });

    it("paces dom-mode release to one active context per animation frame", () => {
      const terms = Array.from({ length: 4 }, () => makeManagedTerminal());
      manager.ensureContext("t1", terms[0]!);
      manager.ensureContext("t2", terms[1]!);
      manager.ensureContext("t3", terms[2]!);

      rafMode = "queued";
      manager.ensureContext("t4", terms[3]!);
      expect(manager.getMode()).toBe("dom");

      // The downgrade is visible immediately, but expensive WebGL teardown is
      // paced so a 16-panel fleet does not lose every context in one task.
      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(true);
      expect(manager.isActive("t3")).toBe(true);

      flushRafFrame();
      const activeAfterFrame1 = [
        manager.isActive("t1"),
        manager.isActive("t2"),
        manager.isActive("t3"),
      ].filter(Boolean);
      expect(activeAfterFrame1).toHaveLength(2);

      flushRafFrame();
      const activeAfterFrame2 = [
        manager.isActive("t1"),
        manager.isActive("t2"),
        manager.isActive("t3"),
      ].filter(Boolean);
      expect(activeAfterFrame2).toHaveLength(1);

      flushRafFrame();
      expect(manager.isActive("t1")).toBe(false);
      expect(manager.isActive("t2")).toBe(false);
      expect(manager.isActive("t3")).toBe(false);
      expect(flushRafFrame()).toBe(false);
    });

    it("flipping to dom refreshes every visible formerly-pooled terminal", () => {
      // Visible terminals must repaint so the renderer swap (WebGL→DOM) happens
      // in the same frame, not deferred to the next write. A regression that
      // drops the refresh call would leave visible panes blank until output.
      const terms = Array.from({ length: 4 }, () =>
        makeManagedTerminal({ isOpened: true, isVisible: true })
      );
      manager.ensureContext("t1", terms[0]!);
      manager.ensureContext("t2", terms[1]!);
      manager.ensureContext("t3", terms[2]!);
      // Reset refresh-call history from any attach-time paints.
      terms.forEach((t) => (t.terminal.refresh as ReturnType<typeof vi.fn>).mockClear());

      manager.ensureContext("t4", terms[3]!);
      expect(manager.getMode()).toBe("dom");

      // The three previously-pooled terminals each got a refresh; t4 never
      // entered the pool (ensureContext evaluated mode before queueAttach) so
      // it isn't refreshed by flipToDom.
      expect(terms[0]!.terminal.refresh).toHaveBeenCalled();
      expect(terms[1]!.terminal.refresh).toHaveBeenCalled();
      expect(terms[2]!.terminal.refresh).toHaveBeenCalled();
    });

    it("does not attach new wants while in dom mode", () => {
      // Push past upper to land in dom mode.
      for (let i = 0; i < 4; i++) {
        manager.ensureContext(`t${i}`, makeManagedTerminal());
      }
      expect(manager.getMode()).toBe("dom");

      const before = WebglAddonMock.mock.calls.length;
      manager.ensureContext("t5", makeManagedTerminal());
      expect(WebglAddonMock.mock.calls.length).toBe(before);
      expect(manager.isActive("t5")).toBe(false);
    });

    it("flips back to webgl when wants drops to the lower threshold", () => {
      // Push to dom mode at 4 wants.
      for (let i = 0; i < 4; i++) {
        manager.ensureContext(`t${i}`, makeManagedTerminal());
      }
      expect(manager.getMode()).toBe("dom");

      // Drop two wants → at 2, which is the lower threshold → flip back.
      manager.releaseContext("t0");
      manager.releaseContext("t1");

      expect(manager.getMode()).toBe("webgl");
      // Surviving wants get reattached (rAF mode is sync in this suite).
      expect(manager.isActive("t2")).toBe(true);
      expect(manager.isActive("t3")).toBe(true);
    });

    it("hysteresis: oscillating one above/below upper does not flap", () => {
      // Land exactly at upper (3 wants, webgl mode).
      manager.ensureContext("a", makeManagedTerminal());
      manager.ensureContext("b", makeManagedTerminal());
      manager.ensureContext("c", makeManagedTerminal());
      expect(manager.getMode()).toBe("webgl");

      // 3 → 4 flips to dom.
      manager.ensureContext("d", makeManagedTerminal());
      expect(manager.getMode()).toBe("dom");

      // 4 → 3 must NOT flip back — lower threshold is 2.
      manager.releaseContext("d");
      expect(manager.getMode()).toBe("dom");

      // 3 → 4 again — already dom, no behavior change beyond tracking.
      manager.ensureContext("d", makeManagedTerminal());
      expect(manager.getMode()).toBe("dom");

      // Now drop all the way to the lower band (2).
      manager.releaseContext("d");
      manager.releaseContext("c");
      expect(manager.getMode()).toBe("webgl");
    });

    it("logs the downgrade warning only once per dom-mode trip", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // First downgrade.
      for (let i = 0; i < 4; i++) {
        manager.ensureContext(`t${i}`, makeManagedTerminal());
      }
      expect(manager.getMode()).toBe("dom");

      const downgradeWarnings = (): Array<unknown[]> =>
        warnSpy.mock.calls.filter(
          (args) => typeof args[0] === "string" && args[0].includes("Switching to DOM renderer")
        );
      expect(downgradeWarnings()).toHaveLength(1);

      // Adding another want stays in dom — no second warning.
      manager.ensureContext("t99", makeManagedTerminal());
      expect(downgradeWarnings()).toHaveLength(1);

      // Recover to webgl, then trip again — second downgrade IS logged.
      manager.releaseContext("t0");
      manager.releaseContext("t1");
      manager.releaseContext("t2");
      manager.releaseContext("t3");
      manager.releaseContext("t99");
      expect(manager.getMode()).toBe("webgl");

      for (let i = 0; i < 4; i++) {
        manager.ensureContext(`u${i}`, makeManagedTerminal());
      }
      expect(downgradeWarnings()).toHaveLength(2);

      warnSpy.mockRestore();
    });

    it("dom→webgl flip queues every want via the rAF drain (no synchronous bulk attach)", () => {
      // Push to dom mode at 4 wants.
      for (let i = 0; i < 4; i++) {
        manager.ensureContext(`t${i}`, makeManagedTerminal());
      }
      expect(manager.getMode()).toBe("dom");

      // Switch to queued rAF so the drain steps are visible one frame at a time.
      rafMode = "queued";

      // Drop to lower threshold (2) → flip back to webgl. Two wants survive.
      manager.releaseContext("t0");
      manager.releaseContext("t1");
      expect(manager.getMode()).toBe("webgl");

      // Both surviving wants are queued, none attached yet.
      expect(manager.isActive("t2")).toBe(false);
      expect(manager.isActive("t3")).toBe(false);

      flushRafFrame();
      // Exactly one attached per frame.
      const activeAfterFrame1 = [manager.isActive("t2"), manager.isActive("t3")].filter(Boolean);
      expect(activeAfterFrame1).toHaveLength(1);

      flushRafFrame();
      expect(manager.isActive("t2")).toBe(true);
      expect(manager.isActive("t3")).toBe(true);

      // Queue drained.
      expect(flushRafFrame()).toBe(false);
    });

    it("hardware-unavailable forces dom mode even when count is below lower threshold", () => {
      manager.setHardwareAvailable(false);
      expect(manager.getMode()).toBe("dom");

      // Wants do not flip back even at zero — hardware is gone for the session.
      manager.ensureContext("t1", makeManagedTerminal());
      manager.releaseContext("t1");
      expect(manager.getMode()).toBe("dom");
    });

    it("refreshMode() re-evaluates against current thresholds (profile change)", async () => {
      // Populate to 3 wants under the (3, 2) thresholds — still in webgl.
      manager.ensureContext("a", makeManagedTerminal());
      manager.ensureContext("b", makeManagedTerminal());
      manager.ensureContext("c", makeManagedTerminal());
      expect(manager.getMode()).toBe("webgl");

      // Simulate a profile downgrade narrowing the band BELOW the current
      // wants count. Without refreshMode(), the manager would stay in webgl
      // until the next ensure/release. With it, the mode flips on the spot.
      const { TerminalWebGLManager } = await import("../TerminalWebGLManager");
      TerminalWebGLManager.setWebglThresholds(2, 1);
      manager.refreshMode();

      expect(manager.getMode()).toBe("dom");
      expect(manager.isActive("a")).toBe(false);
      expect(manager.isActive("b")).toBe(false);
      expect(manager.isActive("c")).toBe(false);
    });
  });

  describe("focus pin (single context in dom mode)", () => {
    beforeEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      mod.TerminalWebGLManager.setWebglThresholds(3, 2);
    });

    function fillToDomMode(): ManagedTerminal[] {
      const terms = Array.from({ length: 4 }, () => makeManagedTerminal());
      terms.forEach((t, i) => manager.ensureContext(`t${i}`, t));
      expect(manager.getMode()).toBe("dom");
      return terms;
    }

    it("keeps the pinned terminal's context through a flip to dom mode", () => {
      const pinned = makeManagedTerminal();
      manager.ensureContext("pinned", pinned);
      manager.pinFocus("pinned", pinned);
      manager.ensureContext("a", makeManagedTerminal());
      manager.ensureContext("b", makeManagedTerminal());
      expect(manager.isActive("pinned")).toBe(true);

      // Fourth want crosses upper (3) → dom mode; pin survives.
      manager.ensureContext("c", makeManagedTerminal());
      expect(manager.getMode()).toBe("dom");
      expect(manager.isActive("pinned")).toBe(true);
      expect(manager.isActive("a")).toBe(false);
      expect(manager.isActive("b")).toBe(false);
    });

    it("attaches a context for a terminal pinned while already in dom mode", () => {
      const terms = fillToDomMode();
      expect(manager.isActive("t1")).toBe(false);

      manager.pinFocus("t1", terms[1]!);

      expect(manager.isActive("t1")).toBe(true);
      expect(manager.getMode()).toBe("dom");
    });

    it("moving the pin releases the previous context and attaches the new one", () => {
      const terms = fillToDomMode();
      manager.pinFocus("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      manager.pinFocus("t2", terms[2]!);

      expect(manager.isActive("t1")).toBe(false);
      expect(manager.isActive("t2")).toBe(true);
      expect(manager.getPinnedId()).toBe("t2");
    });

    it("pinning does not change the wants count or trigger a mode flip", () => {
      const terms = fillToDomMode();
      const before = manager.getWantsSize();

      manager.pinFocus("t0", terms[0]!);
      manager.pinFocus("t1", terms[1]!);

      expect(manager.getWantsSize()).toBe(before);
      expect(manager.getMode()).toBe("dom");
    });

    it("releaseContext on the pinned terminal clears the pin and its context", () => {
      const terms = fillToDomMode();
      manager.pinFocus("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      // Drop one want first so the release below cannot flip the mode back.
      manager.releaseContext("t3");
      manager.releaseContext("t1");

      expect(manager.getPinnedId()).toBe(null);
      expect(manager.isActive("t1")).toBe(false);
    });

    it("onTerminalDestroyed clears the pin", () => {
      const terms = fillToDomMode();
      manager.pinFocus("t1", terms[1]!);

      manager.onTerminalDestroyed("t1");

      expect(manager.getPinnedId()).toBe(null);
      expect(manager.isActive("t1")).toBe(false);
    });

    it("does not attach for a pin that is not (yet) a want, then attaches on ensure", () => {
      fillToDomMode();
      const newcomer = makeManagedTerminal();

      manager.pinFocus("t9", newcomer);
      expect(manager.isActive("t9")).toBe(false);

      manager.ensureContext("t9", newcomer);
      expect(manager.isActive("t9")).toBe(true);
    });

    it("ignores the pin attach when hardware is unavailable", () => {
      const terms = fillToDomMode();
      manager.setHardwareAvailable(false);

      manager.pinFocus("t1", terms[1]!);

      expect(manager.isActive("t1")).toBe(false);
    });

    it("hardware loss drops the pinned context — no exemption survives the breaker", () => {
      const terms = fillToDomMode();
      manager.pinFocus("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      manager.setHardwareAvailable(false);

      expect(manager.isActive("t1")).toBe(false);
      expect(manager.getPinnedId()).toBe(null);
    });

    it("flip back to webgl reattaches every want including the pin exactly once", () => {
      const terms = fillToDomMode();
      manager.pinFocus("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      manager.releaseContext("t0");
      manager.releaseContext("t3");
      expect(manager.getMode()).toBe("webgl");

      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(true);
    });

    it("pin set before the flip keeps its context out of the paced release queue", () => {
      const pinned = makeManagedTerminal();
      manager.ensureContext("pinned", pinned);
      manager.pinFocus("pinned", pinned);
      manager.ensureContext("a", makeManagedTerminal());
      manager.ensureContext("b", makeManagedTerminal());

      rafMode = "queued";
      manager.ensureContext("c", makeManagedTerminal());
      expect(manager.getMode()).toBe("dom");

      // Drain every queued release frame — the pin must survive all of them.
      while (flushRafFrame()) {
        // drain
      }
      expect(manager.isActive("pinned")).toBe(true);
      expect(manager.isActive("a")).toBe(false);
      expect(manager.isActive("b")).toBe(false);
    });
  });

  describe("alt-buffer pin (keeps alt-screen TUIs on WebGL — #10768)", () => {
    beforeEach(async () => {
      const mod = await import("../TerminalWebGLManager");
      mod.TerminalWebGLManager.setWebglThresholds(3, 2);
    });

    function fillToDomMode(): ManagedTerminal[] {
      const terms = Array.from({ length: 4 }, () => makeManagedTerminal());
      terms.forEach((t, i) => manager.ensureContext(`t${i}`, t));
      expect(manager.getMode()).toBe("dom");
      return terms;
    }

    it("keeps an alt-buffer-pinned terminal's context through a flip to dom mode", () => {
      const alt = makeManagedTerminal();
      manager.ensureContext("alt", alt);
      manager.pinAltBuffer("alt", alt);
      manager.ensureContext("a", makeManagedTerminal());
      manager.ensureContext("b", makeManagedTerminal());
      expect(manager.isActive("alt")).toBe(true);

      // Fourth want crosses upper (3) → dom mode; alt-buffer pin survives.
      manager.ensureContext("c", makeManagedTerminal());
      expect(manager.getMode()).toBe("dom");
      expect(manager.isActive("alt")).toBe(true);
      expect(manager.isActive("a")).toBe(false);
      expect(manager.isActive("b")).toBe(false);
      expect(manager.isAltBufferPinned("alt")).toBe(true);
    });

    it("attaches a context for a terminal pinned while already in dom mode", () => {
      const terms = fillToDomMode();
      expect(manager.isActive("t1")).toBe(false);

      manager.pinAltBuffer("t1", terms[1]!);

      expect(manager.isActive("t1")).toBe(true);
      expect(manager.getMode()).toBe("dom");
    });

    it("supports multiple simultaneous alt-buffer pins (unlike the single focus pin)", () => {
      const terms = fillToDomMode();

      manager.pinAltBuffer("t1", terms[1]!);
      manager.pinAltBuffer("t2", terms[2]!);

      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(true);
      expect(manager.isAltBufferPinned("t1")).toBe(true);
      expect(manager.isAltBufferPinned("t2")).toBe(true);
    });

    it("unpinAltBuffer releases the context when the terminal returns to its normal buffer", () => {
      const terms = fillToDomMode();
      manager.pinAltBuffer("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      manager.unpinAltBuffer("t1");

      expect(manager.isActive("t1")).toBe(false);
      expect(manager.isAltBufferPinned("t1")).toBe(false);
    });

    it("unpinAltBuffer keeps the context when the terminal is also the focus pin", () => {
      const terms = fillToDomMode();
      manager.pinAltBuffer("t1", terms[1]!);
      manager.pinFocus("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      manager.unpinAltBuffer("t1");

      // Focus pin still holds the single dom-mode context.
      expect(manager.isActive("t1")).toBe(true);
      expect(manager.getPinnedId()).toBe("t1");
    });

    it("pinning does not change the wants count or trigger a mode flip", () => {
      const terms = fillToDomMode();
      const before = manager.getWantsSize();

      manager.pinAltBuffer("t0", terms[0]!);
      manager.pinAltBuffer("t1", terms[1]!);

      expect(manager.getWantsSize()).toBe(before);
      expect(manager.getMode()).toBe("dom");
    });

    it("is idempotent — re-pinning an already-pinned terminal constructs no second addon", () => {
      const terms = fillToDomMode();
      manager.pinAltBuffer("t1", terms[1]!);
      const addonsAfterFirst = WebglAddonMock.mock.calls.length;

      manager.pinAltBuffer("t1", terms[1]!);

      expect(WebglAddonMock.mock.calls.length).toBe(addonsAfterFirst);
      expect(manager.isActive("t1")).toBe(true);
    });

    it("alt-buffer pin survives a hide/show cycle so the revealed pane returns to WebGL", () => {
      const terms = fillToDomMode();
      manager.pinAltBuffer("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      // Hiding the pane (releaseContext) drops its want + context but must KEEP
      // the pin: no buffer-mode transition re-fires on reveal, so the pin is the
      // only thing that lets ensureContext re-attach it in dom mode. 4→3 wants
      // stays above the lower threshold (2), so the fleet stays in dom mode.
      manager.releaseContext("t1");
      expect(manager.isActive("t1")).toBe(false);
      expect(manager.isAltBufferPinned("t1")).toBe(true);
      expect(manager.getMode()).toBe("dom");

      // Revealing the pane re-ensures WebGL — the intact pin gets it a context.
      manager.ensureContext("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);
    });

    it("unpinAltBuffer is the only visibility-independent way the pin is cleared", () => {
      const terms = fillToDomMode();
      manager.pinAltBuffer("t1", terms[1]!);

      manager.releaseContext("t1"); // hide — pin survives
      expect(manager.isAltBufferPinned("t1")).toBe(true);

      manager.unpinAltBuffer("t1"); // buffer → normal — pin cleared
      expect(manager.isAltBufferPinned("t1")).toBe(false);
    });

    it("onTerminalDestroyed clears the alt-buffer pin", () => {
      const terms = fillToDomMode();
      manager.pinAltBuffer("t1", terms[1]!);

      manager.onTerminalDestroyed("t1");

      expect(manager.isAltBufferPinned("t1")).toBe(false);
      expect(manager.isActive("t1")).toBe(false);
    });

    it("ignores the pin (and records nothing) when hardware is unavailable", () => {
      const terms = fillToDomMode();
      manager.setHardwareAvailable(false);

      manager.pinAltBuffer("t1", terms[1]!);

      expect(manager.isActive("t1")).toBe(false);
      // The breaker is a one-way session trip; tracking a pin that can never
      // attach would only churn the watchdog. Nothing is recorded.
      expect(manager.isAltBufferPinned("t1")).toBe(false);
    });

    it("releases the context when the focus pin moves away after the alt-buffer pin was cleared", () => {
      const terms = fillToDomMode();
      // t1 is both focus-pinned and alt-buffer-pinned.
      manager.pinAltBuffer("t1", terms[1]!);
      manager.pinFocus("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      // Buffer → normal clears the alt pin, but the focus pin still holds it.
      manager.unpinAltBuffer("t1");
      expect(manager.isActive("t1")).toBe(true);

      // Focus moves to t2 — t1 now has neither pin, so its context is released.
      manager.pinFocus("t2", terms[2]!);
      expect(manager.isActive("t1")).toBe(false);
      expect(manager.isActive("t2")).toBe(true);
    });

    it("survives a mode-switch teardown then a hide/show cycle", () => {
      // Pin before the flip so the alt pane keeps WebGL through the paced
      // release drain, then hide (releaseContext) and re-reveal (ensureContext).
      const alt = makeManagedTerminal();
      manager.ensureContext("alt", alt);
      manager.pinAltBuffer("alt", alt);
      manager.ensureContext("a", makeManagedTerminal());
      manager.ensureContext("b", makeManagedTerminal());
      manager.ensureContext("c", makeManagedTerminal());
      expect(manager.getMode()).toBe("dom");
      expect(manager.isActive("alt")).toBe(true);

      manager.releaseContext("alt"); // hide
      expect(manager.isActive("alt")).toBe(false);
      expect(manager.isAltBufferPinned("alt")).toBe(true);

      manager.ensureContext("alt", alt); // reveal
      expect(manager.isActive("alt")).toBe(true);
    });

    it("handles a rapid alt→normal→alt toggle without leaking the pin", () => {
      const terms = fillToDomMode();

      manager.pinAltBuffer("t1", terms[1]!);
      expect(manager.isAltBufferPinned("t1")).toBe(true);
      manager.unpinAltBuffer("t1");
      expect(manager.isAltBufferPinned("t1")).toBe(false);
      manager.pinAltBuffer("t1", terms[1]!);

      expect(manager.isAltBufferPinned("t1")).toBe(true);
      expect(manager.isActive("t1")).toBe(true);
    });

    it("hardware loss drops every alt-buffer-pinned context — no exemption survives the breaker", () => {
      const terms = fillToDomMode();
      manager.pinAltBuffer("t1", terms[1]!);
      manager.pinAltBuffer("t2", terms[2]!);
      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(true);

      manager.setHardwareAvailable(false);

      expect(manager.isActive("t1")).toBe(false);
      expect(manager.isActive("t2")).toBe(false);
      expect(manager.isAltBufferPinned("t1")).toBe(false);
      expect(manager.isAltBufferPinned("t2")).toBe(false);
    });

    it("flip back to webgl reattaches every want including alt-buffer pins exactly once", () => {
      const terms = fillToDomMode();
      manager.pinAltBuffer("t1", terms[1]!);
      expect(manager.isActive("t1")).toBe(true);

      manager.releaseContext("t0");
      manager.releaseContext("t3");
      expect(manager.getMode()).toBe("webgl");

      expect(manager.isActive("t1")).toBe(true);
      expect(manager.isActive("t2")).toBe(true);
    });

    it("alt-buffer pin set before the flip stays out of the paced release queue", () => {
      const alt = makeManagedTerminal();
      manager.ensureContext("alt", alt);
      manager.pinAltBuffer("alt", alt);
      manager.ensureContext("a", makeManagedTerminal());
      manager.ensureContext("b", makeManagedTerminal());

      rafMode = "queued";
      manager.ensureContext("c", makeManagedTerminal());
      expect(manager.getMode()).toBe("dom");

      // Drain every queued release frame — the alt-buffer pin survives all.
      while (flushRafFrame()) {
        // drain
      }
      expect(manager.isActive("alt")).toBe(true);
      expect(manager.isActive("a")).toBe(false);
      expect(manager.isActive("b")).toBe(false);
    });

    it("a focus pin and an alt-buffer pin on different terminals both survive dom mode", () => {
      const focus = makeManagedTerminal();
      const alt = makeManagedTerminal();
      manager.ensureContext("focus", focus);
      manager.ensureContext("alt", alt);
      manager.pinFocus("focus", focus);
      manager.pinAltBuffer("alt", alt);
      manager.ensureContext("a", makeManagedTerminal());

      // Cross the upper threshold (3) → dom mode.
      manager.ensureContext("b", makeManagedTerminal());
      expect(manager.getMode()).toBe("dom");

      expect(manager.isActive("focus")).toBe(true);
      expect(manager.isActive("alt")).toBe(true);
      expect(manager.isActive("a")).toBe(false);
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

      // Sync rAF here — three distinct events each flush inline as one tick
      // apiece, matching production where each DOM event arrives in its own
      // frame on a persistent-fault display (issue #6163 path).
      (m1.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));
      (m2.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));
      (m3.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));

      const before = WebglAddonMock.mock.calls.length;
      const m4 = makeManagedTerminal();
      manager.ensureContext("t4", m4);
      expect(WebglAddonMock.mock.calls.length).toBe(before);
      expect(manager.isActive("t4")).toBe(false);
    });

    it("coalesces a same-frame DOM-event burst across pool entries (#8541)", () => {
      const m1 = makeManagedTerminal();
      const m2 = makeManagedTerminal();
      const m3 = makeManagedTerminal();
      const m4 = makeManagedTerminal();
      manager.ensureContext("t1", m1);
      manager.ensureContext("t2", m2);
      manager.ensureContext("t3", m3);
      manager.ensureContext("t4", m4);

      // Queued rAF — mirrors the production path where Chromium dispatches
      // webglcontextlost synchronously to every pool entry within one frame
      // on a bulk GPU eviction. Must coalesce to one tick, well below the
      // 3-loss threshold, so a new ensure still attaches.
      rafMode = "queued";
      (m1.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));
      (m2.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));
      (m3.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));
      (m4.terminal.element as HTMLElement).dispatchEvent(new Event("webglcontextlost"));

      expect(flushRafFrame()).toBe(true);
      expect(flushRafFrame()).toBe(false);

      rafMode = "sync";
      const before = WebglAddonMock.mock.calls.length;
      const m5 = makeManagedTerminal();
      manager.ensureContext("t5", m5);
      expect(WebglAddonMock.mock.calls.length).toBe(before + 1);
      expect(manager.isActive("t5")).toBe(true);
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
