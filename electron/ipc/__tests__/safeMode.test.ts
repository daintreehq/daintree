import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

const dialogMock = vi.hoisted(() => ({
  showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 0 })),
}));

vi.mock("electron", () => ({
  app: { getVersion: vi.fn(() => "1.0.0"), getPath: vi.fn(() => "/tmp") },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  dialog: dialogMock,
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
  },
}));

const panelSuspectLedger = {
  clearQuarantinedPanel: vi.fn((_panelId: string) => false),
};

vi.mock("../../services/PanelSuspectLedgerService.js", () => ({
  getPanelSuspectLedger: () => panelSuspectLedger,
}));

const crashLoopGuard = vi.hoisted(() => ({
  requestSafeModeBoot: vi.fn(),
  cancelSafeModeBootRequest: vi.fn(),
}));

vi.mock("../../services/CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => crashLoopGuard,
}));

const relaunchMock = vi.hoisted(() => ({
  relaunchApp: vi.fn((_reason: string): string => "started"),
}));

vi.mock("../../lifecycle/appRelaunch.js", () => relaunchMock);

const shutdownMock = vi.hoisted(() => ({
  getActiveShutdown: vi.fn((): unknown => null),
}));

vi.mock("../../lifecycle/shutdownCoordinator.js", () => shutdownMock);

const loggerMock = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("../../utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/logger.js")>()),
  logWarn: loggerMock.logWarn,
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    assertIpcSecurityReady: vi.fn(),
  };
});

import { registerSafeModeHandlers } from "../handlers/safeMode.js";
import {
  _resetStartupInvokeTrackerForTesting,
  startupStepper,
  trackStartupInvoke,
} from "../startupInvokeTracker.js";

async function invokeClear(panelId: unknown) {
  const cleanup = registerSafeModeHandlers();
  const handler = ipcHandlers.get("app:clear-quarantined-panel");
  if (!handler) throw new Error("app:clear-quarantined-panel handler not registered");
  // ipcMain.handle passes (event, ...args); the test's stub captures the wrapped
  // callback so we must reproduce the IPC-event arg.
  const result = (await handler({}, panelId)) as { cleared: boolean };
  cleanup();
  return result;
}

describe("app:clear-quarantined-panel handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    panelSuspectLedger.clearQuarantinedPanel.mockReset();
  });

  it("forwards the request to the ledger when given a non-empty string id", async () => {
    panelSuspectLedger.clearQuarantinedPanel.mockReturnValue(true);
    const result = await invokeClear("panel-1");
    expect(panelSuspectLedger.clearQuarantinedPanel).toHaveBeenCalledWith("panel-1");
    expect(result).toEqual({ cleared: true });
  });

  it("rejects an empty string id without calling the ledger", async () => {
    const result = await invokeClear("");
    expect(panelSuspectLedger.clearQuarantinedPanel).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: false });
  });

  it("rejects non-string ids without calling the ledger", async () => {
    const result = await invokeClear(42);
    expect(panelSuspectLedger.clearQuarantinedPanel).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: false });
  });
});

describe("app:restart-in-safe-mode handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    dialogMock.showMessageBox.mockResolvedValue({ response: 0 });
    relaunchMock.relaunchApp.mockReturnValue("started");
    shutdownMock.getActiveShutdown.mockReturnValue(null);
  });

  async function invokeRestart(): Promise<{ started: boolean }> {
    const cleanup = registerSafeModeHandlers();
    const handler = ipcHandlers.get("app:restart-in-safe-mode");
    if (!handler) throw new Error("app:restart-in-safe-mode handler not registered");
    try {
      return (await handler({ sender: { id: 7 } })) as { started: boolean };
    } finally {
      cleanup();
    }
  }

  it("writes the request before restarting, once the user confirms", async () => {
    const result = await invokeRestart();

    expect(result).toEqual({ started: true });
    expect(crashLoopGuard.requestSafeModeBoot).toHaveBeenCalledTimes(1);
    expect(relaunchMock.relaunchApp).toHaveBeenCalledWith("safe-mode-request");
    expect(crashLoopGuard.requestSafeModeBoot.mock.invocationCallOrder[0]).toBeLessThan(
      relaunchMock.relaunchApp.mock.invocationCallOrder[0]
    );
    expect(crashLoopGuard.cancelSafeModeBootRequest).not.toHaveBeenCalled();
  });

  it("changes nothing when the user cancels", async () => {
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 });

    expect(await invokeRestart()).toEqual({ started: false });
    expect(crashLoopGuard.requestSafeModeBoot).not.toHaveBeenCalled();
    expect(relaunchMock.relaunchApp).not.toHaveBeenCalled();
  });

  it("leaves an exit already in flight alone, request and all", async () => {
    shutdownMock.getActiveShutdown.mockReturnValue({
      initiator: "app-relaunch",
      phase: "cleaning",
    });

    expect(await invokeRestart()).toEqual({ started: false });
    expect(crashLoopGuard.requestSafeModeBoot).not.toHaveBeenCalled();
    expect(crashLoopGuard.cancelSafeModeBootRequest).not.toHaveBeenCalled();
    expect(relaunchMock.relaunchApp).not.toHaveBeenCalled();
  });

  it("leaves an exit that began while the confirm was open alone", async () => {
    let answer: (value: { response: number }) => void = () => {};
    dialogMock.showMessageBox.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const pending = invokeRestart();
    await vi.waitFor(() => expect(dialogMock.showMessageBox).toHaveBeenCalled());

    shutdownMock.getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });
    answer({ response: 0 });

    expect(await pending).toEqual({ started: false });
    expect(crashLoopGuard.requestSafeModeBoot).not.toHaveBeenCalled();
    expect(crashLoopGuard.cancelSafeModeBootRequest).not.toHaveBeenCalled();
    expect(relaunchMock.relaunchApp).not.toHaveBeenCalled();
  });

  it("withdraws the request when the relaunch is refused", async () => {
    relaunchMock.relaunchApp.mockReturnValue("unavailable");

    expect(await invokeRestart()).toEqual({ started: false });
    expect(crashLoopGuard.requestSafeModeBoot).toHaveBeenCalledTimes(1);
    expect(crashLoopGuard.cancelSafeModeBootRequest).toHaveBeenCalledTimes(1);
  });

  it("does not restart on a request that never reached disk", async () => {
    crashLoopGuard.requestSafeModeBoot.mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });

    await expect(invokeRestart()).rejects.toThrow();
    expect(relaunchMock.relaunchApp).not.toHaveBeenCalled();
  });
});

describe("app:report-startup-stuck handler", () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    _resetStartupInvokeTrackerForTesting();
    cleanup = registerSafeModeHandlers();
    handlers = ipcHandlers;
  });

  afterEach(() => {
    cleanup();
  });

  function call(channel: string, sender: { id: number }, ...args: unknown[]): unknown {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`${channel} handler not registered`);
    return handler({ sender }, ...args);
  }

  it("logs the invokes a stuck view is still waiting on, with the boot step, once", async () => {
    const sender = { id: 11 };
    // A boot payload stuck in main, as the dispatcher records it.
    trackStartupInvoke(sender, "app:boot", () => {
      startupStepper(11)("project-state-read");
      return new Promise(() => {});
    });

    await call("app:report-startup-stuck", sender, "booting");
    await call("app:report-startup-stuck", sender, "booting");

    expect(loggerMock.logWarn).toHaveBeenCalledTimes(1);
    const [, context] = loggerMock.logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context).toMatchObject({
      webContentsId: 11,
      rendererStage: "booting",
      bootRequested: true,
      pendingCount: 1,
      pending: [{ channel: "app:boot", step: "project-state-read" }],
    });
  });

  it("reports a document that never booted on its own, not the previous document's boot", async () => {
    const sender = { id: 13 };
    trackStartupInvoke(sender, "app:boot", () => new Promise(() => {}));

    await call("app:report-startup-stuck", sender, "before-boot");

    const [, context] = loggerMock.logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context).toMatchObject({
      rendererStage: "before-boot",
      bootRequested: false,
      pending: [],
    });
  });

  it("says when the view never asked for its boot payload, and drops unknown stages", async () => {
    await call("app:report-startup-stuck", { id: 12 }, "<script>");

    const [, context] = loggerMock.logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context).toMatchObject({
      rendererStage: "unknown",
      bootRequested: false,
      sinceBootMs: null,
      pending: [],
    });
  });
});
