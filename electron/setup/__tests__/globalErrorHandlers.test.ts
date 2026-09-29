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
  get: vi.fn((): unknown[] | undefined => []),
  set: vi.fn(),
}));

const broadcastToRendererMock = vi.hoisted(() => vi.fn());

const crashLoopGuardMock = vi.hoisted(() => ({
  shouldRelaunch: vi.fn(() => true),
}));

const closeTelemetryMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("../../services/CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => crashLoopGuardMock,
}));

vi.mock("../../utils/emergencyLog.js", () => ({
  emergencyLogMainFatal: emergencyLogMock.emergencyLogMainFatal,
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => crashRecoveryMock,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  closeTelemetry: closeTelemetryMock,
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { ERROR_NOTIFY: "error:notify" },
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

import {
  registerGlobalErrorHandlers,
  _resetHandlingFatalForTesting,
} from "../globalErrorHandlers.js";

describe("globalErrorHandlers", () => {
  let uncaughtHandler: (error: Error) => void;
  let rejectionHandler: (reason: unknown) => void;
  const originalListeners = {
    uncaughtException: [] as NodeJS.UncaughtExceptionListener[],
    unhandledRejection: [] as NodeJS.UnhandledRejectionListener[],
  };

  // The fatal handler now drains Sentry asynchronously before exiting, so
  // observable state (app.exit, process.exit fallback) settles after the
  // microtask queue flushes. flushMicrotasks() yields twice to cover the
  // closeTelemetry().catch().finally() chain.
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetHandlingFatalForTesting();

    // Reset mock return values
    storeMock.get.mockReturnValue([]);
    closeTelemetryMock.mockReset();
    closeTelemetryMock.mockReturnValue(Promise.resolve());

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

      expect(crashRecoveryMock.recordCrash).toHaveBeenCalledWith(error, "uncaught-exception");
    });

    it("persists error to pendingErrors store with full payload", () => {
      const error = new Error("test crash");
      uncaughtHandler(error);

      expect(storeMock.set).toHaveBeenCalledWith(
        "pendingErrors",
        expect.arrayContaining([
          expect.objectContaining({
            type: "unknown",
            message: expect.stringContaining("test crash"),
            source: "main-process",
            retryability: "none",
            dismissed: false,
            fromPreviousSession: true,
            recoveryHint: "The application encountered a fatal error and will restart.",
          }),
        ])
      );
    });

    it("persists error when store.get returns undefined", () => {
      storeMock.get.mockReturnValue(undefined);
      uncaughtHandler(new Error("crash"));

      expect(storeMock.set).toHaveBeenCalledWith(
        "pendingErrors",
        expect.arrayContaining([expect.objectContaining({ fromPreviousSession: true })])
      );
    });

    it("caps persisted pendingErrors at 50 when store already holds 50 entries", () => {
      const seeded = Array.from({ length: 50 }, (_, i) => ({
        id: `seeded-${i}`,
        timestamp: i,
        type: "unknown",
        message: `seeded ${i}`,
        source: "main-process",
        retryability: "none",
        dismissed: false,
      }));
      storeMock.get.mockReturnValue(seeded);

      uncaughtHandler(new Error("new crash"));

      const persisted = storeMock.set.mock.calls.find(
        ([key]) => key === "pendingErrors"
      )?.[1] as Array<{ id: string }>;
      expect(persisted).toHaveLength(50);
      expect(persisted[0].id).toBe("seeded-1");
      expect(persisted[persisted.length - 1].id).toMatch(/^fatal-/);
    });

    it("sends error notification to renderer via broadcast", () => {
      const error = new Error("test crash");
      uncaughtHandler(error);

      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "error:notify",
        expect.objectContaining({
          type: "unknown",
          source: "main-process",
        })
      );
    });

    it("calls app.relaunch then app.exit(1)", async () => {
      uncaughtHandler(new Error("crash"));
      await flushMicrotasks();

      expect(appMock.relaunch).toHaveBeenCalled();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("skips app.relaunch when crash loop guard disallows it", async () => {
      crashLoopGuardMock.shouldRelaunch.mockReturnValueOnce(false);
      _resetHandlingFatalForTesting();
      uncaughtHandler(new Error("crash"));
      await flushMicrotasks();

      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("does not throw when emergencyLogMainFatal throws", async () => {
      emergencyLogMock.emergencyLogMainFatal.mockImplementation(() => {
        throw new Error("log failed");
      });

      expect(() => uncaughtHandler(new Error("crash"))).not.toThrow();
      await flushMicrotasks();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("does not throw when recordCrash throws", async () => {
      crashRecoveryMock.recordCrash.mockImplementation(() => {
        throw new Error("record failed");
      });

      expect(() => uncaughtHandler(new Error("crash"))).not.toThrow();
      await flushMicrotasks();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("does not throw when broadcast fails", async () => {
      broadcastToRendererMock.mockImplementation(() => {
        throw new Error("broadcast failed");
      });

      expect(() => uncaughtHandler(new Error("crash"))).not.toThrow();
      await flushMicrotasks();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("re-entrant call skips full handler and exits immediately", () => {
      uncaughtHandler(new Error("first crash"));
      vi.clearAllMocks();

      // Second call hits the re-entrancy guard and exits synchronously —
      // a second crash mid-flush should not wait another 2s for closeTelemetry.
      uncaughtHandler(new Error("second crash"));

      expect(emergencyLogMock.emergencyLogMainFatal).not.toHaveBeenCalled();
      expect(crashRecoveryMock.recordCrash).not.toHaveBeenCalled();
      expect(storeMock.set).not.toHaveBeenCalled();
      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(closeTelemetryMock).not.toHaveBeenCalled();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("calls closeTelemetry before app.exit so Sentry can flush in-flight crash reports", async () => {
      const order: string[] = [];
      closeTelemetryMock.mockImplementationOnce(() => {
        order.push("closeTelemetry");
        return Promise.resolve();
      });
      appMock.exit.mockImplementationOnce(() => {
        order.push("exit");
      });

      uncaughtHandler(new Error("crash"));
      // exit must NOT have happened synchronously — it waits for the flush
      expect(order).toEqual(["closeTelemetry"]);

      await flushMicrotasks();
      expect(order).toEqual(["closeTelemetry", "exit"]);
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("still exits when closeTelemetry rejects", async () => {
      closeTelemetryMock.mockReturnValueOnce(Promise.reject(new Error("flush failed")));

      uncaughtHandler(new Error("crash"));
      await flushMicrotasks();

      expect(closeTelemetryMock).toHaveBeenCalled();
      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("falls back to process.exit(1) when app.exit throws", async () => {
      // mockImplementationOnce so the throwing impl is consumed by this test
      // and does not leak into subsequent tests (vi.clearAllMocks resets call
      // history but not implementations).
      appMock.exit.mockImplementationOnce(() => {
        throw new Error("exit unavailable");
      });
      const processExitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(((_code?: number) => undefined) as never);

      uncaughtHandler(new Error("crash"));
      await flushMicrotasks();

      expect(appMock.exit).toHaveBeenCalledWith(1);
      expect(processExitSpy).toHaveBeenCalledWith(1);
      processExitSpy.mockRestore();
    });

    it("builds AppError with correct message from Error", () => {
      uncaughtHandler(new Error("specific error message"));

      const sentPayload = broadcastToRendererMock.mock.calls[0]?.[1];
      expect(sentPayload.message).toContain("specific error message");
      expect(sentPayload.message).toContain("UNCAUGHT_EXCEPTION");
      expect(sentPayload.details).toBeDefined();
      expect(sentPayload.id).toMatch(/^fatal-/);
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

    it("sends error notification to renderer with correct payload", () => {
      rejectionHandler(new Error("rejected"));

      const sentPayload = broadcastToRendererMock.mock.calls[0]?.[1];
      expect(sentPayload.type).toBe("unknown");
      expect(sentPayload.source).toBe("main-process");
      expect(sentPayload.message).toContain("rejected");
      expect(sentPayload.recoveryHint).toContain("degraded state");
      expect(sentPayload.retryability).toBe("none");
      expect(sentPayload.dismissed).toBe(false);
    });

    it("does NOT call app.exit or app.relaunch", () => {
      rejectionHandler(new Error("rejected"));

      expect(appMock.exit).not.toHaveBeenCalled();
      expect(appMock.relaunch).not.toHaveBeenCalled();
    });

    it("does NOT call CrashRecoveryService.recordCrash (transient rejections must not poison the crash marker)", () => {
      const reason = new Error("rejected");
      rejectionHandler(reason);

      expect(crashRecoveryMock.recordCrash).not.toHaveBeenCalled();
    });

    it("persists error to pendingErrors store with UNHANDLED_REJECTION payload", () => {
      rejectionHandler(new Error("rejected"));

      expect(storeMock.set).toHaveBeenCalledWith(
        "pendingErrors",
        expect.arrayContaining([
          expect.objectContaining({
            type: "unknown",
            message: expect.stringContaining("rejected"),
            source: "main-process",
            retryability: "none",
            dismissed: false,
            fromPreviousSession: true,
            recoveryHint: expect.stringContaining("degraded state"),
          }),
        ])
      );
    });

    it("persists error when store.get returns undefined", () => {
      storeMock.get.mockReturnValue(undefined);
      rejectionHandler(new Error("rejected"));

      expect(storeMock.set).toHaveBeenCalledWith(
        "pendingErrors",
        expect.arrayContaining([expect.objectContaining({ fromPreviousSession: true })])
      );
    });

    it("caps persisted pendingErrors at 50 when store already holds 50 entries", () => {
      const seeded = Array.from({ length: 50 }, (_, i) => ({
        id: `seeded-${i}`,
        timestamp: i,
        type: "unknown",
        message: `seeded ${i}`,
        source: "main-process",
        retryability: "none",
        dismissed: false,
      }));
      storeMock.get.mockReturnValue(seeded);

      rejectionHandler(new Error("rejected"));

      const persisted = storeMock.set.mock.calls.find(
        ([key]) => key === "pendingErrors"
      )?.[1] as Array<{ id: string }>;
      expect(persisted).toHaveLength(50);
      expect(persisted[0].id).toBe("seeded-1");
      expect(persisted[persisted.length - 1].id).toMatch(/^fatal-/);
    });

    it("handles non-Error rejection reasons", () => {
      rejectionHandler("string reason");

      expect(emergencyLogMock.emergencyLogMainFatal).toHaveBeenCalledWith(
        "UNHANDLED_REJECTION",
        "string reason"
      );
    });

    it("handles null and undefined rejection reasons", () => {
      expect(() => rejectionHandler(null)).not.toThrow();
      expect(() => {
        _resetHandlingFatalForTesting();
        rejectionHandler(undefined);
      }).not.toThrow();

      expect(emergencyLogMock.emergencyLogMainFatal).toHaveBeenCalledWith(
        "UNHANDLED_REJECTION",
        null
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
