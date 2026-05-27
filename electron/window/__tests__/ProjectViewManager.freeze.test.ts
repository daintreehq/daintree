import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 100;

function createMockWebContents() {
  const id = nextWebContentsId++;
  return {
    id,
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    session: { flushStorageData: vi.fn() },
    navigationHistory: { clear: vi.fn() },
    on: vi.fn(() => {}),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "did-finish-load") {
        Promise.resolve().then(() => handler());
      }
    }),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
  };
}

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = createMockWebContents();
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
  injectSkeletonProjectIdentity: vi.fn(),
  INITIAL_COLOR_SCHEME_ARG: "--daintree-initial-color-scheme-id",
  INITIAL_PROJECT_ID_ARG: "--daintree-initial-project-id",
  resolveInitialColorSchemeId: vi.fn(() => "daintree"),
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: vi.fn(() => null) },
}));

vi.mock("../../utils/webContentsLifecycle.js", () => ({
  freezeWebContents: vi.fn().mockResolvedValue(undefined),
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
  throttleCpuWebContents: vi.fn().mockResolvedValue(undefined),
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

import { ProjectViewManager } from "../ProjectViewManager.js";
import { freezeWebContents, unfreezeWebContents } from "../../utils/webContentsLifecycle.js";

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

describe("ProjectViewManager — efficiency freeze", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    nextWebContentsId = 100;
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
    });
    // Stub the paint gate to resolve immediately — this suite uses fake timers
    // so the gate's setTimeout cannot fire on its own.
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not freeze immediately on setEfficiencyFreeze(true) — debounce delays the work", () => {
    manager.setEfficiencyFreeze(true);
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("freezes cached views after 500ms debounce", async () => {
    await manager.switchTo("proj-b", "/path/b");
    // proj-a is now cached, proj-b is active.

    manager.setEfficiencyFreeze(true);
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("skips the active view when batch-freezing", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const activeWc = manager.getActiveView()!.webContents;

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    const freezeCalls = vi.mocked(freezeWebContents).mock.calls;
    // The active view's wc must never appear in freeze calls.
    expect(freezeCalls.every((call) => call[0] !== activeWc)).toBe(true);
  });

  it("skips destroyed wc when batch-freezing", async () => {
    await manager.switchTo("proj-b", "/path/b");
    initialWc.isDestroyed.mockReturnValue(true);

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("setEfficiencyFreeze(false) unfreezes cached views immediately", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    vi.mocked(unfreezeWebContents).mockClear();

    manager.setEfficiencyFreeze(false);
    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("setEfficiencyFreeze(false) cancels a pending freeze timer", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);

    manager.setEfficiencyFreeze(false);
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("rapid setEfficiencyFreeze(true) calls debounce to a single freeze pass", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(100);
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(100);
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledTimes(1);
  });

  it("activateView always unfreezes the activating view, even when efficiency is off", async () => {
    await manager.switchTo("proj-b", "/path/b");
    vi.mocked(unfreezeWebContents).mockClear();

    // Switch back to proj-a — its cached view should be unfrozen on activate.
    await manager.switchTo("proj-a", "/path/a");

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("deactivateCurrentView calls freezeWebContents only when efficiency is on, and AFTER GC", async () => {
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    vi.mocked(freezeWebContents).mockClear();
    initialWc.executeJavaScript.mockClear();

    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);

    const gcOrder = initialWc.executeJavaScript.mock.invocationCallOrder[0];
    const freezeOrder = vi.mocked(freezeWebContents).mock.invocationCallOrder[0];
    expect(gcOrder).toBeLessThan(freezeOrder);
  });

  it("deactivateCurrentView does not freeze when efficiency is off", async () => {
    await manager.switchTo("proj-b", "/path/b");
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("inline deactivation freeze fires immediately without waiting for the batch debounce", async () => {
    // Enter efficiency but do NOT advance timers — still inside the 500ms debounce.
    manager.setEfficiencyFreeze(true);

    await manager.switchTo("proj-b", "/path/b");

    // The deactivated view (proj-a) must be frozen inline at deactivation time —
    // the debounce only gates the batch sweep of pre-existing cached views.
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("rapid setEfficiencyFreeze(true) re-arms the debounce window", async () => {
    await manager.switchTo("proj-b", "/path/b");

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(400);
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(400);
    // 800ms elapsed from the first call, but only 400ms from the second —
    // batch freeze must not have fired yet.
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledTimes(1);
  });

  it("dispose() clears a pending freeze timer", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);

    manager.dispose();
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("setEfficiencyFreeze with no cached views is a safe no-op (timer still clears)", () => {
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();

    // Re-toggle off — no unfreeze call expected (no cached views).
    manager.setEfficiencyFreeze(false);
    expect(vi.mocked(unfreezeWebContents)).not.toHaveBeenCalled();
  });
});
