import { describe, it, expect, vi } from "vitest";

type Handler = (...args: unknown[]) => void;
type ListenerMap = Map<string, Handler[]>;

const SKELETON_PARSED_CHANNEL = "app:skeleton-parsed";

function createMockAppView(listeners: ListenerMap, ipcListeners: ListenerMap = new Map()) {
  const register = (event: string, handler: Handler) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(handler);
  };
  const registerIpc = (channel: string, handler: Handler) => {
    if (!ipcListeners.has(channel)) ipcListeners.set(channel, []);
    ipcListeners.get(channel)!.push(handler);
  };
  return {
    setBackgroundColor: vi.fn(),
    webContents: {
      on: vi.fn(register),
      once: vi.fn(register),
      ipc: {
        once: vi.fn(registerIpc),
        removeAllListeners: vi.fn(),
      },
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
  buildSkeletonCss?: (
    project: unknown | null,
    themeConfig?: unknown,
    options?: { instantReveal?: boolean }
  ) => string;
  insertSkeletonCss?: (wc: unknown, css: string) => void;
  injectSkeletonCss?: (wc: unknown, project: unknown | null) => void;
  injectSkeletonProjectIdentity?: (wc: unknown, project: unknown | null) => void;
  readLastActiveProjectIdentity?: (projectId: string) => unknown | null;
}

const SHOW_FALLBACK_MS = 5_000;

/**
 * Replicates the production `loadRenderer` show/CSS sequence from
 * `createWindow.ts` so the ordering can be verified without bringing the
 * whole Electron surface into the unit test.
 */
function buildLoadRenderer({
  win,
  appView,
  windowBg,
  buildSkeletonCss = () => "precomputed",
  insertSkeletonCss = vi.fn(),
  injectSkeletonCss = vi.fn(),
  injectSkeletonProjectIdentity = vi.fn(),
  readLastActiveProjectIdentity = () => null,
}: SetupArgs) {
  appView.setBackgroundColor(windowBg);
  const appWebContents = appView.webContents;
  const themeConfig = {}; // fixture — production holds the pre-read appTheme config

  let rendererLoadRequested = false;
  return (reason: string, projectId?: string): void => {
    if (win.isDestroyed() || rendererLoadRequested) return;
    rendererLoadRequested = true;

    // Resolve the persisted last-active project's identity via the standalone
    // read-only reader so the boot skeleton matches a cold project switch
    // (#10942). Mirrors createWindow.ts.
    const initialProject = projectId ? readLastActiveProjectIdentity(projectId) : null;
    const precomputedSkeletonCss = buildSkeletonCss(initialProject, themeConfig);
    let firstDomReady = true;
    appWebContents.on("dom-ready", () => {
      const crashReload = !firstDomReady;
      // Re-read on crash auto-reload so a renamed/recolored project stays fresh.
      const project =
        crashReload && projectId ? readLastActiveProjectIdentity(projectId) : initialProject;
      firstDomReady = false;
      if (!crashReload) {
        insertSkeletonCss(appWebContents, precomputedSkeletonCss);
      } else {
        injectSkeletonCss(appWebContents, project);
      }
      injectSkeletonProjectIdentity(appWebContents, project);
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
    appWebContents.ipc.once(SKELETON_PARSED_CHANNEL, showOnce);
    appWebContents.once("dom-ready", showOnce);

    appWebContents.loadURL(`app://daintree/index.html?reason=${reason}`);
  };
}

function fireDomReady(listeners: ListenerMap): void {
  const handlers = listeners.get("dom-ready") ?? [];
  for (const h of handlers) h();
}

function fireSkeletonParsed(ipcListeners: ListenerMap): void {
  const handlers = ipcListeners.get(SKELETON_PARSED_CHANNEL) ?? [];
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

  it("shows the window on the skeleton-parsed IPC signal before dom-ready", () => {
    const listeners: ListenerMap = new Map();
    const ipcListeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners, ipcListeners);

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
    });

    loadRenderer("startup");

    expect(win.show).not.toHaveBeenCalled();

    // The skeleton-parsed signal arrives before dom-ready (classic script
    // runs as soon as the skeleton markup is parsed).
    fireSkeletonParsed(ipcListeners);
    expect(win.show).toHaveBeenCalledOnce();

    // dom-ready arriving later must not re-show.
    fireDomReady(listeners);
    expect(win.show).toHaveBeenCalledOnce();

    // The IPC gate is wired BEFORE loadURL.
    const ipcOnceOrder = appView.webContents.ipc.once.mock.invocationCallOrder[0];
    const loadOrder = appView.webContents.loadURL.mock.invocationCallOrder[0];
    expect(ipcOnceOrder).toBeLessThan(loadOrder);
  });

  it("sets appView background before showing the window", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
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
    const insertSkeletonCss = vi.fn();
    const injectSkeletonCss = vi.fn();

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      buildSkeletonCss: () => "precomputed",
      insertSkeletonCss,
      injectSkeletonCss,
    });

    loadRenderer("startup");

    // CSS is not injected before the document parses.
    expect(insertSkeletonCss).not.toHaveBeenCalled();
    expect(injectSkeletonCss).not.toHaveBeenCalled();

    // Two dom-ready listeners are wired: one persistent (.on) for CSS
    // re-injection on every parse, one .once for win.show().
    const domReadyHandlers = listeners.get("dom-ready") ?? [];
    expect(domReadyHandlers).toHaveLength(2);
    expect(appView.webContents.on).toHaveBeenCalledWith("dom-ready", expect.any(Function));
    expect(appView.webContents.once).toHaveBeenCalledWith("dom-ready", expect.any(Function));

    // The persistent listener (registered via `.on`) is the CSS one — the
    // first dom-ready uses the precomputed string (no config re-read).
    domReadyHandlers[0]();
    expect(insertSkeletonCss).toHaveBeenCalledOnce();
    expect(insertSkeletonCss).toHaveBeenCalledWith(appView.webContents, "precomputed");
    expect(injectSkeletonCss).not.toHaveBeenCalled();
  });

  it("rebuilds skeleton CSS on later dom-ready events so crash-reloads stay themed", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);
    const insertSkeletonCss = vi.fn();
    const injectSkeletonCss = vi.fn();

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      buildSkeletonCss: () => "precomputed",
      insertSkeletonCss,
      injectSkeletonCss,
    });

    loadRenderer("startup");

    // The first dom-ready listener (.on) is the CSS one — fire it twice to
    // simulate the initial load and a renderer-crash auto-reload.
    const domReadyHandlers = listeners.get("dom-ready") ?? [];
    const persistentCssHandler = domReadyHandlers[0];

    persistentCssHandler();
    persistentCssHandler();

    // First parse uses the precomputed string; the crash-reload re-resolves
    // theme/sidebar/focus state via the full injection path, threading the
    // (null here — no projectId supplied) project through.
    expect(insertSkeletonCss).toHaveBeenCalledOnce();
    expect(injectSkeletonCss).toHaveBeenCalledOnce();
    expect(injectSkeletonCss).toHaveBeenCalledWith(appView.webContents, null);
  });

  it("threads the persisted project's accent + identity into the boot skeleton (#10942)", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);
    const project = { name: "Daintree", emoji: "🌳", color: "#11a06b" };
    const buildSkeletonCss = vi.fn((p: unknown | null) =>
      p ? "css-with-project-accent" : "css-anonymous"
    );
    const insertSkeletonCss = vi.fn();
    const injectSkeletonProjectIdentity = vi.fn();
    const readLastActiveProjectIdentity = vi.fn((id: string) => (id === "proj-1" ? project : null));

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      buildSkeletonCss,
      insertSkeletonCss,
      injectSkeletonProjectIdentity,
      readLastActiveProjectIdentity,
    });

    loadRenderer("startup", "proj-1");

    // The project is resolved before the CSS precompute, threaded in alongside
    // the pre-read themeConfig. The boot path must NOT pass instantReveal — the
    // 400ms Doherty gate belongs on the initial launch (3rd arg undefined).
    expect(buildSkeletonCss).toHaveBeenCalledWith(project, expect.anything());
    expect(buildSkeletonCss.mock.calls[0][2]).toBeUndefined();
    expect(readLastActiveProjectIdentity).toHaveBeenCalledWith("proj-1");

    const domReadyHandlers = listeners.get("dom-ready") ?? [];
    domReadyHandlers[0]();

    // First parse inserts the project-accented precomputed CSS and paints identity.
    expect(insertSkeletonCss).toHaveBeenCalledWith(appView.webContents, "css-with-project-accent");
    expect(injectSkeletonProjectIdentity).toHaveBeenCalledWith(appView.webContents, project);
  });

  it("keeps the anonymous skeleton when no persisted project id is present (#10942)", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);
    const buildSkeletonCss = vi.fn((p: unknown | null) =>
      p ? "css-with-project-accent" : "css-anonymous"
    );
    const readLastActiveProjectIdentity = vi.fn();

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      buildSkeletonCss,
      readLastActiveProjectIdentity,
    });

    loadRenderer("startup"); // no projectId — first launch / no last-active project

    expect(readLastActiveProjectIdentity).not.toHaveBeenCalled();
    expect(buildSkeletonCss).toHaveBeenCalledWith(null, expect.anything());
  });

  it("keeps the anonymous skeleton when the persisted project is no longer in the DB", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);
    const buildSkeletonCss = vi.fn((p: unknown | null) =>
      p ? "css-with-project-accent" : "css-anonymous"
    );

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      buildSkeletonCss,
      readLastActiveProjectIdentity: () => null, // project row gone (deleted)
    });

    loadRenderer("startup", "proj-1");

    expect(buildSkeletonCss).toHaveBeenCalledWith(null, expect.anything());
  });

  it("re-reads fresh project identity + accent on a renderer-crash reload (#10942)", () => {
    const listeners: ListenerMap = new Map();
    const win = createMockWindow();
    const appView = createMockAppView(listeners);
    const initial = { name: "Beta", emoji: "β", color: "#ff0000" };
    const renamed = { name: "Beta Renamed", emoji: "🟢", color: "#00ff00" };
    const buildSkeletonCss = vi.fn((p: unknown | null) =>
      p ? "css-with-project-accent" : "css-anonymous"
    );
    const insertSkeletonCss = vi.fn();
    const injectSkeletonCss = vi.fn();
    const injectSkeletonProjectIdentity = vi.fn();
    let readCount = 0;
    const readLastActiveProjectIdentity = vi.fn(() => (readCount++ === 0 ? initial : renamed));

    const loadRenderer = buildLoadRenderer({
      win,
      appView,
      windowBg: "#0e0e0d",
      buildSkeletonCss,
      insertSkeletonCss,
      injectSkeletonCss,
      injectSkeletonProjectIdentity,
      readLastActiveProjectIdentity,
    });

    loadRenderer("startup", "proj-1");

    // One read at boot for the precomputed CSS.
    expect(readLastActiveProjectIdentity).toHaveBeenCalledTimes(1);

    const persistentCssHandler = (listeners.get("dom-ready") ?? [])[0];
    persistentCssHandler(); // initial parse
    persistentCssHandler(); // crash auto-reload

    // Initial parse uses the boot-read project's precomputed CSS + identity.
    expect(insertSkeletonCss).toHaveBeenCalledWith(appView.webContents, "css-with-project-accent");
    expect(injectSkeletonProjectIdentity).toHaveBeenCalledWith(appView.webContents, initial);

    // Crash reload re-reads (now renamed) and rebuilds via the injection path,
    // so a renamed/recolored project stays current instead of going stale.
    expect(readLastActiveProjectIdentity).toHaveBeenCalledTimes(2);
    expect(injectSkeletonCss).toHaveBeenCalledWith(appView.webContents, renamed);
    expect(injectSkeletonProjectIdentity).toHaveBeenLastCalledWith(appView.webContents, renamed);
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
    });

    loadRenderer("startup");

    expect(appView.webContents.loadURL).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
  });
});
