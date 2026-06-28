import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const crashServiceMock = vi.hoisted(() => ({
  restoreBackup: vi.fn(() => false),
  setPanelFilter: vi.fn(),
  resetToFresh: vi.fn(),
  clearPendingCrash: vi.fn(),
  getPendingCrash: vi.fn(),
  getConfig: vi.fn(() => ({ autoRestoreOnCrash: false })),
  setConfig: vi.fn(),
  scheduleBackup: vi.fn(),
  startBackupTimer: vi.fn(),
  consumePanelFilter: vi.fn(),
  unlinkCrashedBackup: vi.fn(),
}));

const crashLoopGuardMock = vi.hoisted(() => ({
  isSafeMode: vi.fn(() => false),
  getCrashCount: vi.fn(() => 0),
  resetForNormalBoot: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

vi.mock("../../../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => crashServiceMock,
}));

vi.mock("../../../../services/CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => crashLoopGuardMock,
}));

vi.mock("../../../../utils/performance.js", () => ({
  isPerformanceCaptureEnabled: vi.fn(() => false),
  markPerformance: vi.fn(),
  sampleIpcTiming: vi.fn(),
}));

import { registerCrashRecoveryHandlers } from "../crashRecovery.js";

function getHandlerFn(channelName: string): (...args: unknown[]) => unknown {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channelName);
  if (!call) throw new Error(`No handler registered for ${channelName}`);
  return call[1] as (...args: unknown[]) => unknown;
}

const FAKE_EVENT = { sender: { id: 1, getURL: () => "" } } as never;

describe("registerCrashRecoveryHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    crashServiceMock.restoreBackup.mockReturnValue(false);
    crashServiceMock.setPanelFilter.mockClear();
    crashServiceMock.resetToFresh.mockClear();
  });

  it("registers all four crash-recovery channels", () => {
    registerCrashRecoveryHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "crash-recovery:get-pending",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith("crash-recovery:resolve", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "crash-recovery:get-config",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "crash-recovery:set-config",
      expect.any(Function)
    );
  });

  describe("crash-recovery:resolve", () => {
    describe("restore action", () => {
      it("resolves with undefined and applies the panel filter when restoreBackup returns true", async () => {
        crashServiceMock.restoreBackup.mockReturnValue(true);
        registerCrashRecoveryHandlers();
        const handler = getHandlerFn("crash-recovery:resolve");

        const result = await handler(FAKE_EVENT, { kind: "restore", panelIds: ["p1", "p2"] });

        expect(result).toBeUndefined();
        expect(crashServiceMock.restoreBackup).toHaveBeenCalledWith(["p1", "p2"]);
        expect(crashServiceMock.setPanelFilter).toHaveBeenCalledWith(["p1", "p2"]);
        expect(crashServiceMock.resetToFresh).not.toHaveBeenCalled();
        // Clears the in-memory pending-crash record so a cold-rebooted
        // WebContentsView on project switch-back does not re-present the
        // dialog (#10809).
        expect(crashServiceMock.clearPendingCrash).toHaveBeenCalledTimes(1);
      });

      it("rejects with 'Crash recovery restore failed' when restoreBackup returns false", async () => {
        crashServiceMock.restoreBackup.mockReturnValue(false);
        registerCrashRecoveryHandlers();
        const handler = getHandlerFn("crash-recovery:resolve");

        // The empty filter is one of the documented `false` exit paths
        // (zero-match filter, per
        // FILTER_WITH_NO_MATCHES_KEEPS_RECOVERY_SOURCE_FOR_RETRY). The handler
        // must propagate the failure to the renderer so the dialog can show
        // its existing "Recovery failed" banner and the auto-restore path
        // can skip the false "Session restored" confirmation. In production
        // the IPC `ipcMain.handle` returns a rejected Promise for the
        // renderer — in this test we wrap the sync handler call in
        // Promise.resolve().then() so the assertion operates on a real
        // rejected promise.
        await expect(
          Promise.resolve().then(() => handler(FAKE_EVENT, { kind: "restore", panelIds: [] }))
        ).rejects.toThrow("Crash recovery restore failed");
      });

      it("does NOT call setPanelFilter when restoreBackup returns false", async () => {
        crashServiceMock.restoreBackup.mockReturnValue(false);
        registerCrashRecoveryHandlers();
        const handler = getHandlerFn("crash-recovery:resolve");

        await expect(
          Promise.resolve().then(() => handler(FAKE_EVENT, { kind: "restore", panelIds: ["p1"] }))
        ).rejects.toThrow("Crash recovery restore failed");

        expect(crashServiceMock.setPanelFilter).not.toHaveBeenCalled();
      });

      it("does NOT clear the pending crash when restoreBackup returns false", async () => {
        crashServiceMock.restoreBackup.mockReturnValue(false);
        registerCrashRecoveryHandlers();
        const handler = getHandlerFn("crash-recovery:resolve");

        // Recovery has not succeeded, so the record must persist — a later
        // LRU eviction should re-present the dialog so the user can retry.
        await expect(
          Promise.resolve().then(() => handler(FAKE_EVENT, { kind: "restore", panelIds: ["p1"] }))
        ).rejects.toThrow("Crash recovery restore failed");

        expect(crashServiceMock.clearPendingCrash).not.toHaveBeenCalled();
      });
    });

    describe("fresh action", () => {
      it("resets the recovery state without invoking restoreBackup", async () => {
        registerCrashRecoveryHandlers();
        const handler = getHandlerFn("crash-recovery:resolve");

        const result = await handler(FAKE_EVENT, { kind: "fresh" });

        expect(result).toBeUndefined();
        expect(crashServiceMock.resetToFresh).toHaveBeenCalledTimes(1);
        expect(crashServiceMock.restoreBackup).not.toHaveBeenCalled();
        expect(crashServiceMock.setPanelFilter).not.toHaveBeenCalled();
        expect(crashServiceMock.clearPendingCrash).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("crash-recovery:get-pending", () => {
    it("returns null in safe mode even when a crash is pending", () => {
      crashLoopGuardMock.isSafeMode.mockReturnValue(true);
      crashServiceMock.getPendingCrash.mockReturnValue({
        logPath: "/tmp/crash.json",
        entry: {} as never,
        hasBackup: true,
        panels: [],
      });
      registerCrashRecoveryHandlers();
      const handler = getHandlerFn("crash-recovery:get-pending");

      const result = handler({} as never);

      expect(result).toBeNull();
      expect(crashServiceMock.getPendingCrash).not.toHaveBeenCalled();
    });

    it("returns null when no crash is pending", () => {
      crashServiceMock.getPendingCrash.mockReturnValue(null);
      registerCrashRecoveryHandlers();
      const handler = getHandlerFn("crash-recovery:get-pending");

      const result = handler({} as never);

      expect(result).toBeNull();
    });
  });
});
