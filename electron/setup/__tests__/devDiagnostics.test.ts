import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  exit: vi.fn(),
  eventNames: vi.fn<() => Array<string | symbol>>(() => []),
  listenerCount: vi.fn<(name: string | symbol) => number>(() => 0),
}));

const ipcMainMock = vi.hoisted(() => ({
  eventNames: vi.fn<() => Array<string | symbol>>(() => []),
  listenerCount: vi.fn<(name: string | symbol) => number>(() => 0),
}));

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn<(path: string) => string[]>(() => []),
}));

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
}));

vi.mock("node:fs", () => ({
  default: fsMock,
}));

import {
  _resetDevDiagnosticsForTesting,
  startDevDiagnostics,
  stopDevDiagnostics,
} from "../devDiagnostics.js";

const SWEEP_INTERVAL_MS = 10_000;

describe("devDiagnostics", () => {
  let originalPlatform: NodeJS.Platform;
  let originalTraceProcessWarnings: boolean;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalWarningListeners: NodeJS.WarningListener[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    originalTraceProcessWarnings = process.traceProcessWarnings;
    process.traceProcessWarnings = false;

    originalWarningListeners = process.listeners("warning") as NodeJS.WarningListener[];
    process.removeAllListeners("warning");

    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    fsMock.readdirSync.mockReturnValue([]);
    appMock.eventNames.mockReturnValue([]);
    appMock.listenerCount.mockReturnValue(0);
    ipcMainMock.eventNames.mockReturnValue([]);
    ipcMainMock.listenerCount.mockReturnValue(0);
  });

  afterEach(() => {
    stopDevDiagnostics();
    _resetDevDiagnosticsForTesting();

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    process.traceProcessWarnings = originalTraceProcessWarnings;

    process.removeAllListeners("warning");
    for (const listener of originalWarningListeners) {
      process.on("warning", listener);
    }

    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  describe("startDevDiagnostics", () => {
    it("enables process.traceProcessWarnings", () => {
      startDevDiagnostics();
      expect(process.traceProcessWarnings).toBe(true);
    });

    it("registers a single warning handler", () => {
      startDevDiagnostics();
      expect(process.listeners("warning")).toHaveLength(1);
    });

    it("is idempotent — second call does not re-register", () => {
      startDevDiagnostics();
      startDevDiagnostics();
      expect(process.listeners("warning")).toHaveLength(1);
    });

    it("captures fd baseline at start", () => {
      fsMock.readdirSync.mockReturnValueOnce(["0", "1", "2", "3", "4"]);
      startDevDiagnostics();
      expect(fsMock.readdirSync).toHaveBeenCalledWith("/proc/self/fd");
    });

    it("uses /dev/fd on macOS", () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      fsMock.readdirSync.mockReturnValueOnce(["0", "1", "2"]);
      startDevDiagnostics();
      expect(fsMock.readdirSync).toHaveBeenCalledWith("/dev/fd");
    });

    it("skips fd sweep on unsupported platforms", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      startDevDiagnostics();
      // Only listener sweep is scheduled; fd sweep is not.
      // Advance and verify readdirSync is never called for fd sweep.
      fsMock.readdirSync.mockClear();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
      expect(fsMock.readdirSync).not.toHaveBeenCalled();
    });
  });

  describe("warning handler", () => {
    it("calls app.exit(1) on MaxListenersExceededWarning", () => {
      startDevDiagnostics();
      const warning = new Error("too many listeners");
      warning.name = "MaxListenersExceededWarning";

      process.emit("warning", warning);

      expect(appMock.exit).toHaveBeenCalledWith(1);
    });

    it("logs warning stack on MaxListenersExceededWarning", () => {
      startDevDiagnostics();
      const warning = new Error("too many listeners");
      warning.name = "MaxListenersExceededWarning";
      warning.stack = "stack-trace-here";

      process.emit("warning", warning);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("MaxListenersExceededWarning"),
        "stack-trace-here"
      );
    });

    it("ignores non-MaxListeners warnings", () => {
      startDevDiagnostics();
      const warning = new Error("experimental feature");
      warning.name = "ExperimentalWarning";

      process.emit("warning", warning);

      expect(appMock.exit).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("listener sweep", () => {
    it("warns when an ipcMain channel exceeds the threshold", () => {
      ipcMainMock.eventNames.mockReturnValue(["leaky:channel"]);
      ipcMainMock.listenerCount.mockReturnValue(6);

      startDevDiagnostics();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Listener leak suspected on ipcMain")
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("leaky:channel"));
    });

    it("warns when an app event exceeds the threshold", () => {
      appMock.eventNames.mockReturnValue(["window-all-closed"]);
      appMock.listenerCount.mockReturnValue(7);

      startDevDiagnostics();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Listener leak suspected on app")
      );
    });

    it("does not warn at the threshold boundary (count === 5)", () => {
      ipcMainMock.eventNames.mockReturnValue(["normal:channel"]);
      ipcMainMock.listenerCount.mockReturnValue(5);

      startDevDiagnostics();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("handles symbol event names", () => {
      const symbolName = Symbol("internal-event");
      appMock.eventNames.mockReturnValue([symbolName]);
      appMock.listenerCount.mockReturnValue(10);

      startDevDiagnostics();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(String(symbolName)));
    });

    it("reschedules itself after a sweep", () => {
      ipcMainMock.eventNames.mockReturnValue(["c"]);
      ipcMainMock.listenerCount.mockReturnValue(6);

      startDevDiagnostics();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      // Both sweeps fired
      const leakWarnings = warnSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("Listener leak suspected")
      );
      expect(leakWarnings.length).toBeGreaterThanOrEqual(2);
    });

    it("does not throw when emitter introspection fails", () => {
      ipcMainMock.eventNames.mockImplementation(() => {
        throw new Error("introspection failed");
      });

      startDevDiagnostics();
      expect(() => vi.advanceTimersByTime(SWEEP_INTERVAL_MS)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Listener sweep failed for ipcMain"),
        expect.any(Error)
      );
    });

    it("still checks ipcMain when app introspection throws", () => {
      appMock.eventNames.mockImplementation(() => {
        throw new Error("app failed");
      });
      ipcMainMock.eventNames.mockReturnValue(["leaky"]);
      ipcMainMock.listenerCount.mockReturnValue(6);

      startDevDiagnostics();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Listener sweep failed for app"),
        expect.any(Error)
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Listener leak suspected on ipcMain")
      );
    });

    it("only reports the leaky channel when multiple are present", () => {
      appMock.eventNames.mockReturnValue(["safe", "leaky"]);
      appMock.listenerCount.mockImplementation((name) => (name === "leaky" ? 6 : 2));

      startDevDiagnostics();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      const leakWarnings = warnSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("Listener leak suspected")
      );
      expect(leakWarnings).toHaveLength(1);
      expect(String(leakWarnings[0][0])).toContain("leaky");
      expect(String(leakWarnings[0][0])).not.toContain("'safe'");
    });
  });

  describe("fd sweep", () => {
    it("warns when fd count grows beyond the threshold", () => {
      // Baseline = 5 fds
      fsMock.readdirSync.mockReturnValueOnce(["0", "1", "2", "3", "4"]);
      startDevDiagnostics();

      // Sweep returns 16 fds — growth of 11, > threshold 10
      fsMock.readdirSync.mockReturnValueOnce(Array.from({ length: 16 }, (_, i) => String(i)));
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fd leak suspected"));
    });

    it("does not warn for growth at or below the threshold", () => {
      fsMock.readdirSync.mockReturnValueOnce(["0", "1", "2", "3", "4"]);
      startDevDiagnostics();

      // Growth of exactly 10 — at threshold, not >
      fsMock.readdirSync.mockReturnValueOnce(Array.from({ length: 15 }, (_, i) => String(i)));
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

      const fdWarnings = warnSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("fd leak suspected")
      );
      expect(fdWarnings).toHaveLength(0);
    });

    it("does not throw or warn when readdirSync fails mid-sweep", () => {
      fsMock.readdirSync.mockReturnValueOnce(["0", "1", "2"]);
      startDevDiagnostics();

      fsMock.readdirSync.mockImplementationOnce(() => {
        throw new Error("EACCES");
      });
      expect(() => vi.advanceTimersByTime(SWEEP_INTERVAL_MS)).not.toThrow();
      const fdWarnings = warnSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("fd leak suspected")
      );
      expect(fdWarnings).toHaveLength(0);
    });

    it("does not produce false positives when baseline read failed", () => {
      // Baseline read throws — fd sweep must be disabled, not start with baseline=0
      fsMock.readdirSync.mockImplementationOnce(() => {
        throw new Error("EACCES");
      });
      startDevDiagnostics();

      // Subsequent successful reads should not trigger spurious warnings
      fsMock.readdirSync.mockReturnValue(Array.from({ length: 50 }, (_, i) => String(i)));
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);

      const fdWarnings = warnSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("fd leak suspected")
      );
      expect(fdWarnings).toHaveLength(0);
    });
  });

  describe("stopDevDiagnostics", () => {
    it("removes the warning handler", () => {
      startDevDiagnostics();
      expect(process.listeners("warning")).toHaveLength(1);

      stopDevDiagnostics();
      expect(process.listeners("warning")).toHaveLength(0);
    });

    it("stops the listener sweep timer", () => {
      ipcMainMock.eventNames.mockReturnValue(["c"]);
      ipcMainMock.listenerCount.mockReturnValue(6);

      startDevDiagnostics();
      stopDevDiagnostics();

      vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);
      const leakWarnings = warnSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("Listener leak suspected")
      );
      expect(leakWarnings).toHaveLength(0);
    });

    it("stops the fd sweep timer", () => {
      fsMock.readdirSync.mockReturnValue(["0", "1"]);
      startDevDiagnostics();
      stopDevDiagnostics();

      fsMock.readdirSync.mockClear();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);
      expect(fsMock.readdirSync).not.toHaveBeenCalled();
    });

    it("is a no-op when called twice", () => {
      startDevDiagnostics();
      stopDevDiagnostics();
      expect(() => stopDevDiagnostics()).not.toThrow();
    });

    it("allows clean restart after stop", () => {
      startDevDiagnostics();
      stopDevDiagnostics();
      startDevDiagnostics();
      expect(process.listeners("warning")).toHaveLength(1);
    });

    it("does not call app.exit when warning fires after stop", () => {
      startDevDiagnostics();
      stopDevDiagnostics();

      const warning = new Error("too many listeners");
      warning.name = "MaxListenersExceededWarning";
      process.emit("warning", warning);

      expect(appMock.exit).not.toHaveBeenCalled();
    });
  });

  describe("_resetDevDiagnosticsForTesting", () => {
    it("removes the warning handler", () => {
      startDevDiagnostics();
      expect(process.listeners("warning")).toHaveLength(1);

      _resetDevDiagnosticsForTesting();
      expect(process.listeners("warning")).toHaveLength(0);
    });

    it("prevents app.exit on warnings emitted after reset", () => {
      startDevDiagnostics();
      _resetDevDiagnosticsForTesting();

      const warning = new Error("too many listeners");
      warning.name = "MaxListenersExceededWarning";
      process.emit("warning", warning);

      expect(appMock.exit).not.toHaveBeenCalled();
    });
  });
});
