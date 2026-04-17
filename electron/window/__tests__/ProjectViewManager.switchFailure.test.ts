import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 200;

type Handler = (...args: unknown[]) => void;

interface MockWc {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  setBackgroundThrottling: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  setIgnoreMenuShortcuts: ReturnType<typeof vi.fn>;
  _handlers: Map<string, Handler[]>;
  _fireOnce: (event: string, ...args: unknown[]) => void;
}

function createMockWebContents(opts?: { autoFinishLoad?: boolean }): MockWc {
  const id = nextWebContentsId++;
  const handlers = new Map<string, Handler[]>();
  const autoFinish = opts?.autoFinishLoad ?? true;

  const wc: MockWc = {
    id,
    isDestroyed: vi.fn(() => false),
    setBackgroundThrottling: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    on: vi.fn((_event: string, _handler: Handler) => {}),
    once: vi.fn((event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      if (event === "did-finish-load" && autoFinish) {
        Promise.resolve().then(() => wc._fireOnce("did-finish-load"));
      }
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    }),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    _handlers: handlers,
    _fireOnce(event: string, ...args: unknown[]) {
      const list = handlers.get(event);
      if (list && list.length > 0) {
        const h = list.shift()!;
        h(...args);
      }
    },
  };
  return wc;
}

let wcQueue: MockWc[] = [];

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = wcQueue.shift();
    return { webContents: wc, setBounds: vi.fn() };
  }
  return {
    app: { isPackaged: false, commandLine: { appendSwitch: vi.fn() } },
    BrowserWindow: vi.fn(),
    WebContentsView: MockWebContentsView,
    session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn() } })) },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    nativeTheme: { shouldUseDarkColors: true },
  };
});

vi.mock("../webContentsRegistry.js", () => ({
  registerWebContents: vi.fn(),
  registerAppView: vi.fn(),
  unregisterWebContents: vi.fn(),
  registerProjectView: vi.fn(),
  unregisterProjectView: vi.fn(),
}));

vi.mock("../../setup/protocols.js", () => ({
  registerProtocolsForSession: vi.fn(),
  getDistPath: vi.fn(() => "/dist"),
}));

vi.mock("../../../shared/config/devServer.js", () => ({
  getDevServerUrl: vi.fn(() => "http://localhost:5173"),
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../shared/utils/urlUtils.js", () => ({
  isLocalhostUrl: vi.fn().mockReturnValue(true),
}));

vi.mock("../../utils/openExternal.js", () => ({
  canOpenExternalUrl: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: vi.fn(() => ({ recordCrash: vi.fn() })),
}));

vi.mock("../../ipc/errorHandlers.js", () => ({
  notifyError: vi.fn(),
}));

vi.mock("../skeletonCss.js", () => ({
  injectSkeletonCss: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
}));

import { ProjectViewManager } from "../ProjectViewManager.js";
import { notifyError } from "../../ipc/errorHandlers.js";
import { logInfo } from "../../utils/logger.js";

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      children: [] as unknown[],
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    webContents: createMockWebContents(),
  };
}

/** Await a promise expected to reject, returning the error. Prevents unhandled-rejection noise. */
async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (err) {
    return err as Error;
  }
}

describe("ProjectViewManager — switch failure rollback", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: MockWc;

  beforeEach(() => {
    vi.useFakeTimers();
    nextWebContentsId = 200;
    wcQueue = [];
    vi.mocked(notifyError).mockClear();
    vi.mocked(logInfo).mockClear();

    win = createMockWindow();
    manager = new ProjectViewManager(win as never, { dirname: "/test", cachedProjectViews: 3 });

    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rolls back to previous view when preload-error fires", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    // Attach .catch immediately to prevent unhandled rejection warning
    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    failWc._fireOnce("preload-error", {}, "/test/preload.cjs", new Error("Cannot find module"));

    const err = await errPromise;
    expect(err.message).toBe("Cannot find module");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(win.contentView.addChildView).toHaveBeenLastCalledWith(
      expect.objectContaining({ webContents: initialWc })
    );
    expect(failWc.close).toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "project-switch" })
    );
    expect(
      vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
    ).toHaveLength(0);
  });

  it("rolls back when did-fail-load fires", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    failWc._fireOnce("did-fail-load", {}, -3, "ERR_ABORTED");

    const err = await errPromise;
    expect(err.message).toBe("View load failed: ERR_ABORTED (-3)");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(failWc.close).toHaveBeenCalled();
    expect(
      vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
    ).toHaveLength(0);
  });

  it("rolls back when render-process-gone fires during load", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    failWc._fireOnce("render-process-gone", {}, { reason: "crashed", exitCode: 1 });

    const err = await errPromise;
    expect(err.message).toBe("Renderer process gone during load: crashed");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(
      vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
    ).toHaveLength(0);
  });

  it("rolls back when load times out (10s)", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(10_001);

    const err = await errPromise;
    expect(err.message).toBe("View load timed out");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(
      vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
    ).toHaveLength(0);
  });

  it("sets activeProjectId to null when no previous view exists", async () => {
    const freshManager = new ProjectViewManager(win as never, { dirname: "/test" });

    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = freshManager.switchTo("proj-x", "/path/x");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(10_001);

    const err = await errPromise;
    expect(err.message).toBe("View load timed out");
    expect(freshManager.getActiveProjectId()).toBeNull();
    expect(notifyError).toHaveBeenCalled();
  });

  it("switchChain continues after rollback — second switch succeeds", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    const succeedWc = createMockWebContents({ autoFinishLoad: true });
    wcQueue.push(failWc, succeedWc);

    const first = manager.switchTo("proj-b", "/path/b");
    const firstErr = expectRejection(first);

    await vi.advanceTimersByTimeAsync(10_001);
    await firstErr;

    const second = manager.switchTo("proj-c", "/path/c");
    await vi.advanceTimersByTimeAsync(0);

    const result = await second;
    expect(result.isNew).toBe(true);
    expect(manager.getActiveProjectId()).toBe("proj-c");
  });

  it("only settles once when multiple events fire", async () => {
    const wc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(wc);

    const p = manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(0);

    // Fire did-finish-load first (success)
    wc._fireOnce("did-finish-load");

    // Then fire preload-error (should be ignored by settle guard)
    wc._fireOnce("preload-error", {}, "/test/preload.cjs", new Error("Should be ignored"));

    const result = await p;
    expect(result.isNew).toBe(true);
  });
});
