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

    appWebContents.loadURL(`app://daintree/index.html?reason=${reason}`);

    if (!win.isDestroyed()) win.show();
  };
}

describe("window show sequence", () => {
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

    expect(appView.setBackgroundColor).toHaveBeenCalledWith("#0e0e0d");
    const bgOrder = appView.setBackgroundColor.mock.invocationCallOrder[0];
    const showOrder = win.show.mock.invocationCallOrder[0];
    expect(bgOrder).toBeLessThan(showOrder);
  });

  it("calls win.show after loadURL, not after did-finish-load", () => {
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

    expect(appView.webContents.loadURL).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();

    const loadOrder = appView.webContents.loadURL.mock.invocationCallOrder[0];
    const showOrder = win.show.mock.invocationCallOrder[0];
    expect(loadOrder).toBeLessThan(showOrder);

    // No did-finish-load listener is registered — show must not depend on it.
    expect(listeners.has("did-finish-load")).toBe(false);
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

    const domReadyHandlers = listeners.get("dom-ready") ?? [];
    expect(domReadyHandlers).toHaveLength(1);

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

    const domReadyHandlers = listeners.get("dom-ready") ?? [];
    expect(domReadyHandlers).toHaveLength(1);

    // First load
    domReadyHandlers[0]();
    // Renderer crash → appWebContents.reload() → second dom-ready
    domReadyHandlers[0]();

    expect(injectSkeletonCss).toHaveBeenCalledTimes(2);
    expect(appView.webContents.on).toHaveBeenCalledWith("dom-ready", expect.any(Function));
  });

  it("does not set a fallback timer — window is already shown", () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
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

      expect(setTimeoutSpy).not.toHaveBeenCalled();
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
