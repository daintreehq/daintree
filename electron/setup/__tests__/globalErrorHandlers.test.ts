import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  exit: vi.fn(),
  relaunch: vi.fn(),
}));

const crashRecoveryMock = vi.hoisted(() => ({
  recordCrash: vi.fn(),
}));

const emergencyLogMock = vi.hoisted(() => ({
  emergencyLogMainFatal: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => []),
  set: vi.fn(),
}));

const webContentsMock = vi.hoisted(() => ({
  send: vi.fn(),
  isDestroyed: vi.fn(() => false),
}));

const windowMock = vi.hoisted(() => ({
  isDestroyed: vi.fn(() => false),
  webContents: webContentsMock,
}));

const getMainWindowMock = vi.hoisted(() => vi.fn(() => windowMock));

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("../../utils/emergencyLog.js", () => ({
  emergencyLogMainFatal: emergencyLogMock.emergencyLogMainFatal,
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => crashRecoveryMock,
}));

vi.mock("../../window/windowRef.js", () => ({
  getMainWindow: getMainWindowMock,
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { ERROR_NOTIFY: "error:notify" },
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

import { registerGlobalErrorHandlers } from "../globalErrorHandlers.js";

describe("globalErrorHandlers", () => {
  let uncaughtHandler: (error: Error) => void;
  let rejectionHandler: (reason: unknown) => void;
  const originalListeners = {
    uncaughtException: [] as NodeJS.UncaughtExceptionListener[],
    unhandledRejection: [] as NodeJS.UnhandledRejectionListener[],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Save existing listeners
    originalListeners.uncaughtException = process.listeners(
      "uncaughtException"
    ) as NodeJS.UncaughtExceptionListener[];
    originalListeners.unhandledRejection = process.listeners(
      "unhandledRejection"
    ) as NodeJS.UnhandledRejectionListener[];

    // Remove all listeners to avoid test interference
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");

    registerGlobalErrorHandlers();

    // Capture the registered handlers
    const uncaughtListeners = process.listeners("uncaughtException");
    const rejectionListeners = process.listeners("unhandledRejection");
    uncaughtHandler = uncaughtListeners[uncaughtListeners.length - 1] as (error: Error) => void;
    rejectionHandler = rejectionListeners[rejectionListeners.length - 1] as (
      reason: unknown
    ) => void;

    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Remove test listeners and restore original ones
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    for (const listener of originalListeners.uncaughtException) {
      process.on("uncaughtException", listener);
    }
    for (const listener of originalListeners.unhandledRejection) {
      process.on("unhandledRejection", listener);
    }
    vi.restoreAllMocks();
  });

  describe("uncaughtException", () => {
    it("calls emergencyLogMainFatal with the error", () => {
      const error = new Error("test crash");
      uncaughtHandler(error);

      expect(emergencyLogMock.emergencyLogMainFatal).toHaveBeenCalledWith(
        "UNCAUGHT_EXCEPTION",
        error
      );
    });

    it("calls CrashRecoveryService.recordCrash", () => {
      const error = new Error("test crash");
      uncaughtHandler(error);

      expect(crashRecoveryMock.recordCrash).toHaveBeenCalledWith(error);
    });

    it("persists error to pendingErrors store", () => {
      const error = new Error("test crash");
      uncaughtHandler(error);

      expect(storeMock.set).toHaveBeenCalledWith(
        "pendingErrors",
        expect.arrayContaining([
          expect.objectContaining({
            type: "unknown",
            source: "main-process",
            fromPreviousSession: true,
          }),
        ])
      );
    });

    it("sends error notification to renderer", () => {
      const error = new Error("test crash");
      uncaughtHandler(error);

      expect(webContentsMock.send).toHaveBeenCalledWith(
        "error:notify",
        expect.objectContaining({
          type: "unknown",
          source: "main-process",
        })
      );
    });

    it("calls app.relaunch then app.exit(1)", () => {
      uncaughtHandler(new Error("crash"));

      expect(appMock.relaunch).toHaveBeenCalled();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("does not throw when emergencyLogMainFatal throws", () => {
      emergencyLogMock.emergencyLogMainFatal.mockImplementation(() => {
        throw new Error("log failed");
      });

      expect(() => uncaughtHandler(new Error("crash"))).not.toThrow();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("does not throw when recordCrash throws", () => {
      crashRecoveryMock.recordCrash.mockImplementation(() => {
        throw new Error("record failed");
      });

      expect(() => uncaughtHandler(new Error("crash"))).not.toThrow();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("does not throw when window is null", () => {
      getMainWindowMock.mockReturnValue(null);

      expect(() => uncaughtHandler(new Error("crash"))).not.toThrow();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("does not throw when window is destroyed", () => {
      windowMock.isDestroyed.mockReturnValue(true);

      expect(() => uncaughtHandler(new Error("crash"))).not.toThrow();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });
  });

  describe("unhandledRejection", () => {
    it("calls emergencyLogMainFatal with the reason", () => {
      const reason = new Error("rejected");
      rejectionHandler(reason);

      expect(emergencyLogMock.emergencyLogMainFatal).toHaveBeenCalledWith(
        "UNHANDLED_REJECTION",
        reason
      );
    });

    it("sends error notification to renderer", () => {
      rejectionHandler(new Error("rejected"));

      expect(webContentsMock.send).toHaveBeenCalledWith(
        "error:notify",
        expect.objectContaining({
          type: "unknown",
          source: "main-process",
        })
      );
    });

    it("does NOT call app.exit or app.relaunch", () => {
      rejectionHandler(new Error("rejected"));

      expect(appMock.exit).not.toHaveBeenCalled();
      expect(appMock.relaunch).not.toHaveBeenCalled();
    });

    it("handles non-Error rejection reasons", () => {
      rejectionHandler("string reason");

      expect(emergencyLogMock.emergencyLogMainFatal).toHaveBeenCalledWith(
        "UNHANDLED_REJECTION",
        "string reason"
      );
    });

    it("does not throw when emergencyLogMainFatal throws", () => {
      emergencyLogMock.emergencyLogMainFatal.mockImplementation(() => {
        throw new Error("log failed");
      });

      expect(() => rejectionHandler(new Error("rejected"))).not.toThrow();
    });
  });
});
