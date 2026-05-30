import { describe, it, expect, vi } from "vitest";

type Handler = (...args: unknown[]) => void;
type ListenerMap = Map<string, Handler[]>;

function createMockAppView(listeners: ListenerMap) {
  const register = (event: string, handler: Handler) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(handler);
  };
  return {
    setBackgroundColor: vi.fn(),
    webContents: {
      on: vi.fn(register),
      once: vi.fn(register),
      loadURL: vi.fn(),
    },
  };
}

function createMockWindow() {
  return {
    show: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

interface SetupArgs {
  win: ReturnType<typeof createMockWindow>;
  appView: ReturnType<typeof createMockAppView>;
  windowBg: string;
  injectSkeletonCss: (wc: unknown) => void;
}

const SHOW_FALLBACK_MS = 5_000;

/**
 * Replicates the production `loadRenderer` show/CSS sequence from
 * `createWindow.ts` so the ordering can be verified without bringing the
 * whole Electron surface into the unit test.
 */
function buildLoadRenderer({ win, appView, windowBg, injectSkeletonCss }: SetupArgs) {
  appView.setBackgroundColor(windowBg);
  const appWebContents = appView.webContents;

  let rendererLoadRequested = false;
  return (reason: string): void => {
    if (win.isDestroyed() || rendererLoadRequested) return;
    rendererLoadRequested = true;

    appWebContents.on("dom-ready", () => {
      injectSkeletonCss(appWebContents);
    });

    let shown = false;
    const showOnce = (): void => {
      if (shown) return;
      shown = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (!win.isDestroyed()) win.show();
    };
    let fallbackTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      fallbackTimer = null;
      showOnce();
    }, SHOW_FALLBACK_MS);
    appWebContents.once("dom-ready", showOnce);

    appWebContents.loadURL(`app://daintree/index.html?reason=${reason}`);
  };
}

function fireDomReady(listeners: ListenerMap): void {
  const handlers = listeners.get("dom-ready") ?? [];
  for (const h of handlers) h();
}

describe("window show sequence", () => {
  it("does not show the window until dom-ready fires", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      injectSkeletonCss: vi.fn(),
    });

    loadRenderer("startup");

    // loadURL has been called but the window stays hidden until dom-ready.
    expect(appView.webContents.loadURL).toHaveBeenCalledOnce();
    expect(win.show).not.toHaveBeenCalled();

    fireDomReady(listeners);

    expect(win.show).toHaveBeenCalledOnce();

    // loadURL ordering: the dom-ready/once gate is wired BEFORE loadURL so
    // a synchronous dom-ready from a cached navigation can't slip past it.
    expect(appView.webContents.once).toHaveBeenCalledWith("dom-ready", expect.any(Function));
    const onceOrder = appView.webContents.once.mock.invocationCallOrder[0];
    const loadOrder = appView.webContents.loadURL.mock.invocationCallOrder[0];
    expect(onceOrder).toBeLessThan(loadOrder);
  });

  it("sets appView background before showing the window", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);
    const injectSkeletonCss = vi.fn();

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      injectSkeletonCss,
    });

    loadRenderer("startup");
    fireDomReady(listeners);

    expect(appView.setBackgroundColor).toHaveBeenCalledWith("#0e0e0d");
    const bgOrder = appView.setBackgroundColor.mock.invocationCallOrder[0];
    const showOrder = win.show.mock.invocationCallOrder[0];
    expect(bgOrder).toBeLessThan(showOrder);
  });

  it("registers a persistent dom-ready listener for skeleton CSS injection", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);
    const injectSkeletonCss = vi.fn();

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      injectSkeletonCss,
    });

    loadRenderer("startup");

    // CSS is not injected before the document parses.
    expect(injectSkeletonCss).not.toHaveBeenCalled();

    // Two dom-ready listeners are wired: one persistent (.on) for CSS
    // re-injection on every parse, one .once for win.show().
    const domReadyHandlers = listeners.get("dom-ready") ?? [];
    expect(domReadyHandlers).toHaveLength(2);
    expect(appView.webContents.on).toHaveBeenCalledWith("dom-ready", expect.any(Function));
    expect(appView.webContents.once).toHaveBeenCalledWith("dom-ready", expect.any(Function));

    // The persistent listener (registered via `.on`) is the CSS one.
    domReadyHandlers[0]();
    expect(injectSkeletonCss).toHaveBeenCalledOnce();
    expect(injectSkeletonCss).toHaveBeenCalledWith(appView.webContents);
  });

  it("re-injects skeleton CSS on every dom-ready so crash-reloads stay themed", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);
    const injectSkeletonCss = vi.fn();

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      injectSkeletonCss,
    });

    loadRenderer("startup");

    // The first dom-ready listener (.on) is the CSS one — fire it twice to
    // simulate the initial load and a renderer-crash auto-reload.
    const domReadyHandlers = listeners.get("dom-ready") ?? [];
    const persistentCssHandler = domReadyHandlers[0];

    persistentCssHandler();
    persistentCssHandler();

    expect(injectSkeletonCss).toHaveBeenCalledTimes(2);
  });

  it("shows the window via the 5s fallback timer when dom-ready never fires", () => {
    vi.useFakeTimers();
    try {
      const listeners: ListenerMap = new Map();
      const win = createMockWindow();
      const appView = createMockAppView(listeners);

      const loadRenderer = buildLoadRenderer({
        win,
        appView,
        windowBg: "#0e0e0d",
        injectSkeletonCss: vi.fn(),
      });

      loadRenderer("startup");

      // Just before the deadline: still hidden.
      vi.advanceTimersByTime(SHOW_FALLBACK_MS - 1);
      expect(win.show).not.toHaveBeenCalled();

      // At the deadline: window shows anyway.
      vi.advanceTimersByTime(1);
      expect(win.show).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the fallback timer when dom-ready fires — no double-show", () => {
    vi.useFakeTimers();
    try {
      const listeners: ListenerMap = new Map();
      const win = createMockWindow();
      const appView = createMockAppView(listeners);

      const loadRenderer = buildLoadRenderer({
        win,
        appView,
        windowBg: "#0e0e0d",
        injectSkeletonCss: vi.fn(),
      });

      loadRenderer("startup");

      // dom-ready arrives before the deadline.
      fireDomReady(listeners);
      expect(win.show).toHaveBeenCalledOnce();

      // Advancing past the deadline must NOT re-fire show.
      vi.advanceTimersByTime(SHOW_FALLBACK_MS * 2);
      expect(win.show).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent — repeated loadRenderer calls do not show the window twice", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      injectSkeletonCss: vi.fn(),
    });

    loadRenderer("startup");
    loadRenderer("startup");
    loadRenderer("startup");

    fireDomReady(listeners);

    expect(appView.webContents.loadURL).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
  });

  it("does not show a destroyed window", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    win.isDestroyed.mockReturnValue(true);
    const appView = createMockAppView(listeners);

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      injectSkeletonCss: vi.fn(),
    });

    loadRenderer("startup");

    expect(appView.webContents.loadURL).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
  });
});
