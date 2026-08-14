// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";

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
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
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

// The replacement Terminal the rebuild constructs. Faked so the test controls
// whether the fresh instance paints, which is the branch under test — a real
// xterm in jsdom would decide that for us.
//
// Built inside vi.hoisted: vi.mock factories are hoisted above the module body,
// so a class declared here normally would still be in its temporal dead zone
// when the factory runs.
const xtermHarness = vi.hoisted(() => {
  const rebuiltTerminals: XtermFake[] = [];
  const control = { opensCleanly: true, disposeCounter: 0 };

  class XtermFake {
    open = vi.fn(() => {
      this.opened = true;
    });
    dispose = vi.fn(() => {
      this.disposeOrder = ++control.disposeCounter;
    });
    resize = vi.fn();
    refresh = vi.fn();
    blur = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    loadAddon = vi.fn();
    onRender = vi.fn(() => ({ dispose: vi.fn() }));
    element = document.createElement("div");
    rows = 24;
    cols = 80;
    options: Record<string, unknown> = { fontSize: 13 };
    buffer = { active: { length: 0 } };
    opened = false;
    disposeOrder = 0;
    opensCleanly = control.opensCleanly;

    constructor() {
      rebuiltTerminals.push(this);
    }

    get dimensions(): unknown {
      return this.opened && this.opensCleanly
        ? { css: { cell: { width: 8, height: 16 } } }
        : undefined;
    }
  }

  return { rebuiltTerminals, control, XtermFake };
});

const { rebuiltTerminals, control } = xtermHarness;

vi.mock("@xterm/xterm", () => ({
  Terminal: xtermHarness.XtermFake,
}));

vi.mock("@shared/utils/xtermReflowFastpath", () => ({
  applyXtermReflowFastpath: vi.fn(),
}));

vi.mock("../TerminalListenerInstaller", () => ({
  installTerminalBoundListeners: vi.fn(
    (_terminal: unknown, managed: ManagedTerminal, _id: string) => {
      managed.listeners.push(() => {});
    }
  ),
}));

vi.mock("../TerminalParserHandler", () => ({
  // A class, not vi.fn(() => ...): the service calls it with `new`, and an
  // arrow function is not constructible.
  TerminalParserHandler: class {
    dispose = vi.fn();
  },
}));

const createImageAddonMock = vi.fn(async () => ({ dispose: vi.fn() }));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(async () => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: null,
    searchAddon: {},
    fileLinksDisposable: null,
    imageLinksDisposable: null,
    webLinksAddon: null,
  })),
  createImageAddon: createImageAddonMock,
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createImageLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

const setAttachError = vi.fn();
const clearAttachError = vi.fn();

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      setTerminalAttachError: setAttachError,
      clearTerminalAttachError: clearAttachError,
      panelsById: {},
    }),
  },
}));

interface RecoveryTestService {
  instances: Map<string, ManagedTerminal>;
  attach: (id: string, container: HTMLElement) => ManagedTerminal | null;
  recoverPoisonedTerminal: (id: string, options?: { manual?: boolean }) => Promise<boolean>;
  restoreController: { fetchAndRestore: (id: string) => Promise<boolean> };
  rendererPolicy: { applyRendererPolicy: (id: string, tier: number) => void };
  webGLManager: { onTerminalDestroyed: (id: string) => void };
  resizeController: { fit: (id: string) => void };
}

describe("TerminalInstanceService attach failure recovery (#11776)", () => {
  let service: RecoveryTestService;

  /**
   * A terminal whose `open()` behaves like the poisoned instance: it may or may
   * not throw, but either way it never produces dimensions — exactly what
   * xterm's early-return path leaves behind once `_renderService` is missing.
   */
  const makeManaged = (
    id: string,
    terminalOverrides: Record<string, unknown> = {}
  ): ManagedTerminal => {
    const hostElement = document.createElement("div");
    const ptyUnsubA = vi.fn();
    const ptyUnsubB = vi.fn();
    return {
      id,
      terminal: {
        open: vi.fn(),
        dispose: vi.fn(),
        resize: vi.fn(),
        refresh: vi.fn(),
        blur: vi.fn(),
        attachCustomKeyEventHandler: vi.fn(),
        onRender: vi.fn(() => ({ dispose: vi.fn() })),
        element: document.createElement("div"),
        rows: 24,
        options: { fontSize: 13 },
        buffer: { active: { length: 0 } },
        get dimensions() {
          return undefined;
        },
        ...terminalOverrides,
      },
      hostElement,
      isOpened: false,
      // Two PTY-bound listeners then, conceptually, the terminal-bound tail.
      listeners: [ptyUnsubA, ptyUnsubB],
      ipcListenerCount: 2,
      isVisible: true,
      isDetached: false,
      lastAttachAt: 0,
      lastDetachAt: 0,
      lastWidth: 0,
      lastHeight: 0,
      latestCols: 80,
      latestRows: 24,
      attachGeneration: 0,
      attachRevealToken: 0,
      exitSubscribers: new Set(),
      agentStateSubscribers: new Set(),
      altBufferListeners: new Set(),
      keyHandlerInstalled: true,
    } as unknown as ManagedTerminal;
  };

  /** Give the host a real layout box so the rebuild is allowed to proceed. */
  const makeHostRenderable = (managed: ManagedTerminal) => {
    const el = managed.hostElement;
    document.body.appendChild(el);
    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    el.checkVisibility = () => true;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    rebuiltTerminals.length = 0;
    control.disposeCounter = 0;
    control.opensCleanly = true;
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: RecoveryTestService;
      });
    service.instances.clear();
    vi.spyOn(service.restoreController, "fetchAndRestore").mockResolvedValue(true);
    vi.spyOn(service.rendererPolicy, "applyRendererPolicy").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "fit").mockImplementation(() => {});
  });

  afterEach(() => {
    service.instances.clear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("classifying the open", () => {
    it("does not mark a terminal opened when open() throws", () => {
      const managed = makeManaged("t1", {
        open: vi.fn(() => {
          throw new TypeError("Cannot read properties of undefined (reading 'setRenderer')");
        }),
      });
      service.instances.set("t1", managed);

      service.attach("t1", document.createElement("div"));

      expect(managed.isOpened).toBe(false);
      expect(managed.lastAttachError).toContain("setRenderer");
    });

    it("does not mark a terminal opened when open() returns but builds no renderer", () => {
      // The silent half of #11776. xterm's re-entry guard early-returns without
      // throwing on an already-poisoned instance, so "no exception" is NOT
      // evidence the pane can paint — trusting it is what set isOpened=true on
      // a terminal that stayed blank forever.
      const managed = makeManaged("t2");
      service.instances.set("t2", managed);

      service.attach("t2", document.createElement("div"));

      expect(managed.terminal.open).toHaveBeenCalled();
      expect(managed.isOpened).toBe(false);
      expect(managed.lastAttachError).toBeDefined();
    });

    it("marks a terminal opened when it produces a renderer", () => {
      const managed = makeManaged("t3", {
        get dimensions() {
          return { css: { cell: { width: 8, height: 16 } } };
        },
      });
      service.instances.set("t3", managed);

      service.attach("t3", document.createElement("div"));

      expect(managed.isOpened).toBe(true);
      expect(managed.lastAttachError).toBeUndefined();
    });

    it("publishes the failure to the pane and clears it once an open succeeds", () => {
      const failing = makeManaged("t4");
      service.instances.set("t4", failing);
      service.attach("t4", document.createElement("div"));
      expect(setAttachError).toHaveBeenCalledWith("t4", expect.any(String));

      const healthy = makeManaged("t5", {
        get dimensions() {
          return { css: { cell: { width: 8, height: 16 } } };
        },
      });
      healthy.lastAttachError = "stale failure";
      service.instances.set("t5", healthy);
      service.attach("t5", document.createElement("div"));

      expect(clearAttachError).toHaveBeenCalledWith("t5");
      expect(healthy.lastAttachError).toBeUndefined();
    });
  });

  describe("rebuilding", () => {
    it("replaces the xterm instance and disposes the old one", async () => {
      const managed = makeManaged("r1");
      makeHostRenderable(managed);
      service.instances.set("r1", managed);
      const original = managed.terminal;

      const rebuilt = await service.recoverPoisonedTerminal("r1", { manual: true });

      expect(rebuilt).toBe(true);
      expect(original.dispose).toHaveBeenCalled();
      expect(managed.terminal).not.toBe(original);
      expect(managed.isOpened).toBe(true);
    });

    it("keeps the PTY listeners and re-installs only the terminal-bound ones", async () => {
      const managed = makeManaged("r2");
      makeHostRenderable(managed);
      // A terminal-bound listener sitting past the PTY prefix.
      const boundUnsub = vi.fn();
      managed.listeners.push(boundUnsub);
      const [ptyA, ptyB] = managed.listeners;
      service.instances.set("r2", managed);

      await service.recoverPoisonedTerminal("r2", { manual: true });

      // The xterm-bound tail is torn down; the PTY prefix is untouched, because
      // dropping it would silently detach the pane from its live process.
      expect(boundUnsub).toHaveBeenCalled();
      expect(ptyA).not.toHaveBeenCalled();
      expect(ptyB).not.toHaveBeenCalled();
      expect(managed.listeners[0]).toBe(ptyA);
      expect(managed.listeners[1]).toBe(ptyB);
      expect(managed.listeners).not.toContain(boundUnsub);
    });

    it("disposes the image addon before the terminal it patched", async () => {
      // ImageAddon.dispose() is what restores the `_core.open` it monkey-patched.
      // Disposing the terminal first would strand the patch on a dead object.
      const managed = makeManaged("r3");
      makeHostRenderable(managed);
      let imageAddonDisposeOrder = 0;
      const staleAddon = {
        dispose: vi.fn(() => {
          imageAddonDisposeOrder = ++control.disposeCounter;
        }),
      } as unknown as ManagedTerminal["imageAddon"];
      managed.imageAddon = staleAddon;
      const original = managed.terminal as unknown as { dispose: ReturnType<typeof vi.fn> };
      let terminalDisposeOrder = 0;
      original.dispose = vi.fn(() => {
        terminalDisposeOrder = ++control.disposeCounter;
      });
      service.instances.set("r3", managed);

      await service.recoverPoisonedTerminal("r3", { manual: true });

      expect(imageAddonDisposeOrder).toBeGreaterThan(0);
      expect(terminalDisposeOrder).toBeGreaterThan(imageAddonDisposeOrder);
      // The slot may be repopulated for the NEW terminal, but it must never
      // still hold the addon bound to the disposed one.
      expect(managed.imageAddon).not.toBe(staleAddon);
    });

    it("re-attaches the custom key handler to the replacement terminal", async () => {
      // Without this the rebuilt pane accepts no keyboard input: XtermAdapter's
      // effect does not re-run, so nothing else would ever install one.
      const managed = makeManaged("r4");
      makeHostRenderable(managed);
      const handler = vi.fn(() => true);
      managed.customKeyEventHandler = handler;
      service.instances.set("r4", managed);

      await service.recoverPoisonedTerminal("r4", { manual: true });

      expect(managed.terminal.attachCustomKeyEventHandler).toHaveBeenCalledWith(handler);
      expect(managed.keyHandlerInstalled).toBe(true);
    });

    it("replays scrollback from the headless mirror after rebuilding", async () => {
      const managed = makeManaged("r5");
      makeHostRenderable(managed);
      service.instances.set("r5", managed);

      await service.recoverPoisonedTerminal("r5", { manual: true });

      expect(service.restoreController.fetchAndRestore).toHaveBeenCalledWith("r5");
    });

    it("defers while the host has no measurable box", async () => {
      // Opening against a zero-box host is a plausible cause of the original
      // failure, so rebuilding into one would just poison the fresh instance.
      const managed = makeManaged("r6");
      service.instances.set("r6", managed);
      const original = managed.terminal;

      const rebuilt = await service.recoverPoisonedTerminal("r6", { manual: true });

      expect(rebuilt).toBe(false);
      expect(original.dispose).not.toHaveBeenCalled();
      expect(managed.terminal).toBe(original);
    });

    it("shares one rebuild between concurrent callers", async () => {
      const managed = makeManaged("r7");
      makeHostRenderable(managed);
      service.instances.set("r7", managed);

      const [a, b] = await Promise.all([
        service.recoverPoisonedTerminal("r7", { manual: true }),
        service.recoverPoisonedTerminal("r7", { manual: true }),
      ]);

      expect(a).toBe(true);
      expect(b).toBe(true);
      // One replacement, not two — a second Terminal would leave an orphan
      // holding the PTY's listeners.
      expect(rebuiltTerminals).toHaveLength(1);
    });

    it("stops automatic rebuilds once the budget is spent but still honours Retry", async () => {
      control.opensCleanly = false; // every replacement stays unpaintable
      const managed = makeManaged("r8");
      makeHostRenderable(managed);
      service.instances.set("r8", managed);

      for (let i = 0; i < 6; i++) {
        await service.recoverPoisonedTerminal("r8");
      }
      const automaticBuilds = rebuiltTerminals.length;

      // The automatic budget is bounded — a pane that cannot be rebuilt must
      // degrade to a banner rather than loop forever.
      expect(automaticBuilds).toBeLessThanOrEqual(3);

      // A manual Retry is the user asserting something changed, so it is not
      // blocked by the exhausted automatic budget.
      await service.recoverPoisonedTerminal("r8", { manual: true });
      expect(rebuiltTerminals.length).toBeGreaterThan(automaticBuilds);
    });
  });

  describe("preventing the poisoning", () => {
    it("does not build the image addon against a terminal with no renderer", async () => {
      // ImageAddon's constructor patches `_core.open` with a wrapper that
      // dereferences `_renderService` unconditionally. Installed pre-open it
      // turns one failed open into a permanent, self-re-throwing wedge.
      const managed = makeManaged("p1");
      service.instances.set("p1", managed);

      service.attach("p1", document.createElement("div"));
      await Promise.resolve();
      await Promise.resolve();

      expect(managed.isOpened).toBe(false);
      expect(createImageAddonMock).not.toHaveBeenCalled();
    });

    it("builds the image addon once the terminal actually paints", async () => {
      const managed = makeManaged("p2", {
        get dimensions() {
          return { css: { cell: { width: 8, height: 16 } } };
        },
      });
      service.instances.set("p2", managed);

      service.attach("p2", document.createElement("div"));
      await vi.waitFor(() => expect(createImageAddonMock).toHaveBeenCalled());
    });
  });
});
