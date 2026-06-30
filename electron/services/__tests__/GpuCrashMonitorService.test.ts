import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const appListeners: Record<string, Array<(...args: unknown[]) => void>> = {};

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/fake/userData"),
  getVersion: vi.fn(() => "1.0.0"),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!appListeners[event]) appListeners[event] = [];
    appListeners[event].push(handler);
  }),
  relaunch: vi.fn(),
  exit: vi.fn(),
  // GPU feature status is empty until Chromium classifies the GPU; default to
  // undefined so the startup-status logger is a no-op unless a test opts in.
  getGPUFeatureStatus: vi.fn(() => undefined),
  getGPUInfo: vi.fn(() => Promise.resolve(null)),
}));

const loggerMethods = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  name: "main:GpuCrashMonitor",
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => loggerMethods),
}));

const telemetryServiceMock = vi.hoisted(() => ({
  closeTelemetry: vi.fn(() => Promise.resolve()),
}));

vi.mock("../TelemetryService.js", () => telemetryServiceMock);

const crashLoopGuardMock = vi.hoisted(() => ({
  shouldRelaunch: vi.fn(() => true),
  markCleanExit: vi.fn(),
}));

const crashRecoveryMock = vi.hoisted(() => ({
  cleanupOnExit: vi.fn(),
}));

const panelSuspectLedgerMock = vi.hoisted(() => ({
  markCleanLaunch: vi.fn(),
}));

vi.mock("../CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => crashLoopGuardMock,
}));

vi.mock("../CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => crashRecoveryMock,
}));

vi.mock("../PanelSuspectLedgerService.js", () => ({
  getPanelSuspectLedger: () => panelSuspectLedgerMock,
}));

import {
  isGpuDisabledByFlag,
  writeGpuDisabledFlag,
  clearGpuDisabledFlag,
  isGpuAngleFallbackByFlag,
  isGpuAngleFallbackApplied,
  writeGpuAngleFallbackFlag,
  clearGpuAngleFallbackFlag,
  GPU_CRASH_WINDOW_MS,
} from "../GpuCrashMonitorService.js";
import { readGpuDisabledFlagData } from "../gpuDisabledFlag.js";

describe("GpuCrashMonitorService", () => {
  let tmpDir: string;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(appListeners).forEach((k) => delete appListeners[k]);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-crash-test-"));
    appMock.getPath.mockReturnValue(tmpDir);
    crashLoopGuardMock.shouldRelaunch.mockReturnValue(true);
    // Default to linux so existing first-strike tests exercise the soft
    // fallback path. The "non-Linux first-strike no-op" describe overrides
    // this per-test.
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("flag file helpers", () => {
    it("isGpuDisabledByFlag returns false when no flag exists", () => {
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
    });

    it("writeGpuDisabledFlag creates the flag file", () => {
      writeGpuDisabledFlag(tmpDir, "crash");
      expect(fs.existsSync(path.join(tmpDir, "gpu-disabled.flag"))).toBe(true);
    });

    it("isGpuDisabledByFlag reflects a write that happens after a cached read", () => {
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
      writeGpuDisabledFlag(tmpDir, "crash");
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
    });

    it("isGpuDisabledByFlag reflects a clear that happens after a cached read", () => {
      writeGpuDisabledFlag(tmpDir, "crash");
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
      clearGpuDisabledFlag(tmpDir);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
    });

    it("writeGpuDisabledFlag persists the reason and writing app version", () => {
      appMock.getVersion.mockReturnValue("2.3.4");
      writeGpuDisabledFlag(tmpDir, "user");
      const data = readGpuDisabledFlagData(tmpDir);
      expect(data).toMatchObject({ reason: "user", version: "2.3.4" });
      expect(data!.timestamp).toBeGreaterThan(0);
    });

    it("isGpuDisabledByFlag returns true after writing flag", () => {
      writeGpuDisabledFlag(tmpDir, "crash");
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
    });

    it("clearGpuDisabledFlag removes the flag file", () => {
      writeGpuDisabledFlag(tmpDir, "crash");
      clearGpuDisabledFlag(tmpDir);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
    });

    it("clearGpuDisabledFlag is safe when no flag exists", () => {
      expect(() => clearGpuDisabledFlag(tmpDir)).not.toThrow();
    });

    it("isGpuAngleFallbackByFlag returns false when no flag exists", () => {
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
    });

    it("writeGpuAngleFallbackFlag creates the flag file", () => {
      writeGpuAngleFallbackFlag(tmpDir);
      expect(fs.existsSync(path.join(tmpDir, "gpu-angle-fallback.flag"))).toBe(true);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(true);
    });

    it("clearGpuAngleFallbackFlag removes the flag file", () => {
      writeGpuAngleFallbackFlag(tmpDir);
      clearGpuAngleFallbackFlag(tmpDir);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
    });

    it("clearGpuAngleFallbackFlag is safe when no flag exists", () => {
      expect(() => clearGpuAngleFallbackFlag(tmpDir)).not.toThrow();
    });

    it("disable and angle fallback flags coexist independently", () => {
      writeGpuDisabledFlag(tmpDir, "crash");
      writeGpuAngleFallbackFlag(tmpDir);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(true);
      clearGpuAngleFallbackFlag(tmpDir);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
    });
  });

  describe("isGpuAngleFallbackApplied (platform-gated)", () => {
    const originalPlatform = process.platform;
    const originalSessionType = process.env.XDG_SESSION_TYPE;

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      if (originalSessionType === undefined) {
        delete process.env.XDG_SESSION_TYPE;
      } else {
        process.env.XDG_SESSION_TYPE = originalSessionType;
      }
    });

    it("returns false on macOS even when the flag exists", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      writeGpuAngleFallbackFlag(tmpDir);
      expect(isGpuAngleFallbackApplied(tmpDir)).toBe(false);
    });

    it("returns false on Windows even when the flag exists", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      writeGpuAngleFallbackFlag(tmpDir);
      expect(isGpuAngleFallbackApplied(tmpDir)).toBe(false);
    });

    it("returns false on Linux X11 (XDG_SESSION_TYPE != wayland)", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.env.XDG_SESSION_TYPE = "x11";
      writeGpuAngleFallbackFlag(tmpDir);
      expect(isGpuAngleFallbackApplied(tmpDir)).toBe(false);
    });

    it("returns false on Linux Wayland when hardware acceleration is nuclear-disabled", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.env.XDG_SESSION_TYPE = "wayland";
      writeGpuAngleFallbackFlag(tmpDir);
      writeGpuDisabledFlag(tmpDir, "crash");
      expect(isGpuAngleFallbackApplied(tmpDir)).toBe(false);
    });

    it("returns true on Linux Wayland with the flag present and acceleration on", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.env.XDG_SESSION_TYPE = "wayland";
      writeGpuAngleFallbackFlag(tmpDir);
      expect(isGpuAngleFallbackApplied(tmpDir)).toBe(true);
    });

    it("returns false on Linux Wayland when the flag is absent", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.env.XDG_SESSION_TYPE = "wayland";
      expect(isGpuAngleFallbackApplied(tmpDir)).toBe(false);
    });
  });

  describe("crash monitoring", () => {
    async function loadAndInit() {
      vi.resetModules();
      const mod = await import("../GpuCrashMonitorService.js");
      mod.initializeGpuCrashMonitor();
    }

    function emitGpuCrash(reason = "crashed", exitCode = 1) {
      const handlers = appListeners["child-process-gone"] ?? [];
      for (const handler of handlers) {
        handler({}, { type: "GPU", reason, exitCode, serviceName: "", name: "" });
      }
    }

    function emitChildProcessGone(type: string, reason: string, exitCode: number, name = "") {
      const handlers = appListeners["child-process-gone"] ?? [];
      for (const handler of handlers) {
        handler({}, { type, reason, exitCode, serviceName: "", name });
      }
    }

    it("registers child-process-gone listener on initialize", async () => {
      await loadAndInit();
      expect(appMock.on).toHaveBeenCalledWith("child-process-gone", expect.any(Function));
    });

    it("first GPU crash writes ANGLE fallback flag and relaunches without disabling acceleration", async () => {
      await loadAndInit();
      emitGpuCrash();
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(true);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("does not enter the nuclear path on the first crash (soft fallback first)", async () => {
      await loadAndInit();
      emitGpuCrash();
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
      expect(storeMock.set).not.toHaveBeenCalledWith(
        "gpu",
        expect.objectContaining({ hardwareAccelerationDisabled: true })
      );
    });

    it("does NOT trigger first-crash relaunch when ANGLE fallback flag already exists (loop guard)", async () => {
      writeGpuAngleFallbackFlag(tmpDir);
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
    });

    it("escalates to nuclear disable at threshold when ANGLE fallback already active", async () => {
      writeGpuAngleFallbackFlag(tmpDir);
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
      expect(storeMock.set).toHaveBeenCalledWith("gpu", {
        hardwareAccelerationDisabled: true,
      });
    });

    it("ignores clean-exit and killed reasons", async () => {
      await loadAndInit();
      emitGpuCrash("clean-exit");
      emitGpuCrash("killed");
      emitGpuCrash("clean-exit");
      emitGpuCrash("clean-exit");
      expect(appMock.relaunch).not.toHaveBeenCalled();
    });

    it("logs non-GPU process crashes without triggering GPU relaunch", async () => {
      await loadAndInit();
      emitChildProcessGone("Utility", "crashed", 1, "daintree-pty-host");
      emitChildProcessGone("Utility", "crashed", 1, "daintree-pty-host");
      emitChildProcessGone("Utility", "crashed", 1, "daintree-pty-host");
      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(loggerMethods.warn).toHaveBeenCalledWith(
        "gpu-non-crash-exit-detected",
        expect.objectContaining({ name: "daintree-pty-host" })
      );
    });

    it("does not log non-GPU clean-exit or killed events", async () => {
      await loadAndInit();
      emitChildProcessGone("Utility", "clean-exit", 0, "daintree-pty-host");
      emitChildProcessGone("Utility", "killed", 137, "daintree-workspace-host");
      expect(loggerMethods.warn).not.toHaveBeenCalledWith(
        "gpu-non-crash-exit-detected",
        expect.anything()
      );
    });

    it("logs non-GPU crash with full process details", async () => {
      await loadAndInit();
      emitChildProcessGone("Utility", "oom", 137, "daintree-workspace-host");
      expect(loggerMethods.warn).toHaveBeenCalledWith(
        "gpu-non-crash-exit-detected",
        expect.objectContaining({
          type: "Utility",
          reason: "oom",
          exitCode: 137,
          name: "daintree-workspace-host",
        })
      );
    });

    it("does not relaunch if disable flag already exists (already disabled)", async () => {
      writeGpuDisabledFlag(tmpDir, "crash");
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("keeps counting crashes while disabled and logs the software-mode crash loop at threshold", async () => {
      writeGpuDisabledFlag(tmpDir, "crash");
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      expect(loggerMethods.warn).not.toHaveBeenCalledWith(
        "gpu-crash-loop-while-disabled",
        expect.anything()
      );
      emitGpuCrash();
      expect(loggerMethods.warn).toHaveBeenCalledWith(
        "gpu-crash-loop-while-disabled",
        expect.objectContaining({ crashCount: 3 })
      );
      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();
    });

    it("nuclear disable records the crash reason in the flag file", async () => {
      writeGpuAngleFallbackFlag(tmpDir);
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(readGpuDisabledFlagData(tmpDir)).toMatchObject({ reason: "crash" });
    });

    it("counts oom, launch-failed, and abnormal-exit as crashes (first crash → soft fallback)", async () => {
      await loadAndInit();
      emitGpuCrash("oom");
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(true);
    });

    it("logs soft fallback with structured logger", async () => {
      await loadAndInit();
      emitGpuCrash();
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(loggerMethods.warn).toHaveBeenCalledWith(
        "gpu-crash-soft-fallback",
        expect.objectContaining({ crashCount: 1 })
      );
    });

    it("logs nuclear disable with structured logger", async () => {
      writeGpuAngleFallbackFlag(tmpDir);
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(loggerMethods.warn).toHaveBeenCalledWith(
        "gpu-crash-nuclear-disable",
        expect.objectContaining({ crashCount: 3 })
      );
    });

    it("only relaunches once even with additional crashes after the first soft fallback", async () => {
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledTimes(1);
      });
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
    });

    it("does NOT relaunch when ANGLE flag write fails (prevents per-session loop)", async () => {
      vi.doMock("../../utils/fs.js", async () => {
        const actual =
          await vi.importActual<typeof import("../../utils/fs.js")>("../../utils/fs.js");
        return {
          ...actual,
          resilientAtomicWriteFileSync: vi.fn(() => {
            throw new Error("EROFS: read-only filesystem");
          }),
        };
      });
      try {
        await loadAndInit();
        emitGpuCrash();
        await new Promise((r) => setImmediate(r));
        expect(appMock.relaunch).not.toHaveBeenCalled();
        expect(appMock.exit).not.toHaveBeenCalled();
        expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-crash-relaunching-skip",
          expect.any(Error),
          expect.objectContaining({ path: "angle-fallback" })
        );
      } finally {
        vi.doUnmock("../../utils/fs.js");
      }
    });

    it("does NOT relaunch when nuclear disable flag write fails", async () => {
      writeGpuAngleFallbackFlag(tmpDir);
      vi.doMock("../../utils/fs.js", async () => {
        const actual =
          await vi.importActual<typeof import("../../utils/fs.js")>("../../utils/fs.js");
        return {
          ...actual,
          resilientAtomicWriteFileSync: vi.fn(() => {
            throw new Error("EROFS: read-only filesystem");
          }),
        };
      });
      try {
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await new Promise((r) => setImmediate(r));
        expect(appMock.relaunch).not.toHaveBeenCalled();
        expect(appMock.exit).not.toHaveBeenCalled();
        expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-crash-relaunching-skip",
          expect.any(Error),
          expect.objectContaining({ path: "disable" })
        );
      } finally {
        vi.doUnmock("../../utils/fs.js");
      }
    });

    it("waits for closeTelemetry to resolve before app.exit(0) on first-crash relaunch", async () => {
      let resolveClose!: () => void;
      const deferred = new Promise<void>((r) => {
        resolveClose = r;
      });
      telemetryServiceMock.closeTelemetry.mockReturnValueOnce(deferred);

      await loadAndInit();
      emitGpuCrash();

      await vi.waitFor(() => {
        expect(telemetryServiceMock.closeTelemetry).toHaveBeenCalled();
      });
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(appMock.exit).not.toHaveBeenCalled();
      // Issue #10065: markers must commit before telemetry drain (shutdown.ts
      // invariant). Lock the order so a future refactor can't invert it.
      const cleanupOrder = crashRecoveryMock.cleanupOnExit.mock.invocationCallOrder[0];
      const markExitOrder = crashLoopGuardMock.markCleanExit.mock.invocationCallOrder[0];
      const markLaunchOrder = panelSuspectLedgerMock.markCleanLaunch.mock.invocationCallOrder[0];
      const telemetryOrder = telemetryServiceMock.closeTelemetry.mock.invocationCallOrder[0];
      expect(cleanupOrder).toBeLessThan(telemetryOrder);
      expect(markExitOrder).toBeLessThan(telemetryOrder);
      expect(markLaunchOrder).toBeLessThan(telemetryOrder);

      resolveClose();

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
    });

    it("does not register duplicate listeners on double initialize", async () => {
      vi.resetModules();
      const mod = await import("../GpuCrashMonitorService.js");
      mod.initializeGpuCrashMonitor();
      mod.initializeGpuCrashMonitor();
      const listenerCount = (appListeners["child-process-gone"] ?? []).length;
      expect(listenerCount).toBe(1);
    });

    describe("non-Linux first-strike no-op", () => {
      function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
        const original = process.platform;
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        return fn().finally(() => {
          Object.defineProperty(process, "platform", { value: original, configurable: true });
        });
      }

      async function trackAtomicWriter(): Promise<ReturnType<typeof vi.fn>> {
        const writeSpy = vi.fn();
        vi.doMock("../../utils/fs.js", async () => {
          const actual =
            await vi.importActual<typeof import("../../utils/fs.js")>("../../utils/fs.js");
          return {
            ...actual,
            resilientAtomicWriteFileSync: (
              ...args: Parameters<typeof actual.resilientAtomicWriteFileSync>
            ) => {
              writeSpy(...args);
              return actual.resilientAtomicWriteFileSync(...args);
            },
          };
        });
        return writeSpy;
      }

      it("darwin: first crash does not write ANGLE flag, does not relaunch", async () => {
        await withPlatform("darwin", async () => {
          const writeSpy = await trackAtomicWriter();
          try {
            await loadAndInit();
            emitGpuCrash();
            await new Promise((r) => setImmediate(r));
            expect(appMock.relaunch).not.toHaveBeenCalled();
            expect(appMock.exit).not.toHaveBeenCalled();
            expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
            expect(writeSpy).not.toHaveBeenCalled();
            expect(loggerMethods.info).toHaveBeenCalledWith(
              "gpu-crash-soft-fallback-skip-nonlinux",
              expect.objectContaining({ platform: "darwin", crashCount: 1 })
            );
          } finally {
            vi.doUnmock("../../utils/fs.js");
          }
        });
      });

      it("win32: first crash does not write ANGLE flag, does not relaunch", async () => {
        await withPlatform("win32", async () => {
          const writeSpy = await trackAtomicWriter();
          try {
            await loadAndInit();
            emitGpuCrash();
            await new Promise((r) => setImmediate(r));
            expect(appMock.relaunch).not.toHaveBeenCalled();
            expect(appMock.exit).not.toHaveBeenCalled();
            expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
            expect(writeSpy).not.toHaveBeenCalled();
            expect(loggerMethods.info).toHaveBeenCalledWith(
              "gpu-crash-soft-fallback-skip-nonlinux",
              expect.objectContaining({ platform: "win32", crashCount: 1 })
            );
          } finally {
            vi.doUnmock("../../utils/fs.js");
          }
        });
      });

      it("darwin: strikes still accumulate to nuclear disable across crashes", async () => {
        await withPlatform("darwin", async () => {
          await loadAndInit();
          emitGpuCrash();
          emitGpuCrash();
          emitGpuCrash();
          await vi.waitFor(() => {
            expect(appMock.exit).toHaveBeenCalledWith(0);
          });
          expect(appMock.relaunch).toHaveBeenCalledTimes(1);
          expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
          expect(storeMock.set).toHaveBeenCalledWith("gpu", {
            hardwareAccelerationDisabled: true,
          });
        });
      });

      it("win32: strikes still accumulate to nuclear disable across crashes", async () => {
        await withPlatform("win32", async () => {
          await loadAndInit();
          emitGpuCrash();
          emitGpuCrash();
          emitGpuCrash();
          await vi.waitFor(() => {
            expect(appMock.exit).toHaveBeenCalledWith(0);
          });
          expect(appMock.relaunch).toHaveBeenCalledTimes(1);
          expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
        });
      });
    });

    describe("crash-loop guard integration", () => {
      it("ANGLE path: does not relaunch when guard hard-stops, but exits cleanly", async () => {
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(false);
        await loadAndInit();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(appMock.relaunch).not.toHaveBeenCalled();
        // The fallback flag is still written — the next session starts cold
        // with ANGLE active so a restored launch (after the guard resets)
        // doesn't immediately repeat the original Vulkan crash.
        expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(true);
        expect(loggerMethods.warn).toHaveBeenCalledWith(
          "gpu-crash-loop-hard-stop",
          expect.objectContaining({ path: "angle-fallback" })
        );
      });

      it("ANGLE path: relaunches when guard allows", async () => {
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(true);
        await loadAndInit();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      });

      it("Nuclear path: does not relaunch when guard hard-stops, but exits cleanly", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(false);
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(appMock.relaunch).not.toHaveBeenCalled();
        // Disable flag and store flip still happen — once the guard window
        // clears the user gets booted into software-rendering mode rather
        // than back into the crashing GPU stack.
        expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
        expect(storeMock.set).toHaveBeenCalledWith("gpu", {
          hardwareAccelerationDisabled: true,
        });
        expect(loggerMethods.warn).toHaveBeenCalledWith(
          "gpu-crash-loop-hard-stop",
          expect.objectContaining({ path: "nuclear-disable" })
        );
      });

      it("Nuclear path: relaunches when guard allows", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(true);
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      });
    });

    // Issue #10065: GPU-mitigation exits skip the before-quit cleanup chain
    // (app.exit does not emit before-quit / will-quit), so the next boot was
    // treating the deliberate relaunch as a crash. Verify the three clean-exit
    // markers are written in shutdown.ts order, in independent try/catch, and
    // BEFORE app.relaunch() / app.exit(0) so the writes are not no-op'd by the
    // process tear-down.
    describe("clean-exit marker wiring (issue #10065)", () => {
      it("soft relaunch writes all three markers in order before app.relaunch()", async () => {
        await loadAndInit();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        const cleanupOrder = crashRecoveryMock.cleanupOnExit.mock.invocationCallOrder[0];
        const markExitOrder = crashLoopGuardMock.markCleanExit.mock.invocationCallOrder[0];
        const markLaunchOrder = panelSuspectLedgerMock.markCleanLaunch.mock.invocationCallOrder[0];
        const relaunchOrder = appMock.relaunch.mock.invocationCallOrder[0];
        const exitOrder = appMock.exit.mock.invocationCallOrder[0];
        expect(cleanupOrder).toBeLessThan(markExitOrder);
        expect(markExitOrder).toBeLessThan(markLaunchOrder);
        expect(markLaunchOrder).toBeLessThan(relaunchOrder);
        expect(relaunchOrder).toBeLessThan(exitOrder);
      });

      it("nuclear relaunch writes all three markers in order before app.relaunch()", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        const cleanupOrder = crashRecoveryMock.cleanupOnExit.mock.invocationCallOrder[0];
        const markExitOrder = crashLoopGuardMock.markCleanExit.mock.invocationCallOrder[0];
        const markLaunchOrder = panelSuspectLedgerMock.markCleanLaunch.mock.invocationCallOrder[0];
        const relaunchOrder = appMock.relaunch.mock.invocationCallOrder[0];
        const exitOrder = appMock.exit.mock.invocationCallOrder[0];
        expect(cleanupOrder).toBeLessThan(markExitOrder);
        expect(markExitOrder).toBeLessThan(markLaunchOrder);
        expect(markLaunchOrder).toBeLessThan(relaunchOrder);
        expect(relaunchOrder).toBeLessThan(exitOrder);
      });

      it("soft hard-stop writes all three markers in order before app.exit(0)", async () => {
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(false);
        await loadAndInit();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(appMock.relaunch).not.toHaveBeenCalled();
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        const cleanupOrder = crashRecoveryMock.cleanupOnExit.mock.invocationCallOrder[0];
        const markExitOrder = crashLoopGuardMock.markCleanExit.mock.invocationCallOrder[0];
        const markLaunchOrder = panelSuspectLedgerMock.markCleanLaunch.mock.invocationCallOrder[0];
        const exitOrder = appMock.exit.mock.invocationCallOrder[0];
        expect(cleanupOrder).toBeLessThan(markExitOrder);
        expect(markExitOrder).toBeLessThan(markLaunchOrder);
        expect(markLaunchOrder).toBeLessThan(exitOrder);
      });

      it("nuclear hard-stop writes all three markers in order before app.exit(0)", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(false);
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(appMock.relaunch).not.toHaveBeenCalled();
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        const cleanupOrder = crashRecoveryMock.cleanupOnExit.mock.invocationCallOrder[0];
        const markExitOrder = crashLoopGuardMock.markCleanExit.mock.invocationCallOrder[0];
        const markLaunchOrder = panelSuspectLedgerMock.markCleanLaunch.mock.invocationCallOrder[0];
        const exitOrder = appMock.exit.mock.invocationCallOrder[0];
        expect(cleanupOrder).toBeLessThan(markExitOrder);
        expect(markExitOrder).toBeLessThan(markLaunchOrder);
        expect(markLaunchOrder).toBeLessThan(exitOrder);
      });

      it("soft relaunch: marker writes still complete when cleanupOnExit throws", async () => {
        crashRecoveryMock.cleanupOnExit.mockImplementationOnce(() => {
          throw new Error("cleanupOnExit failed");
        });
        await loadAndInit();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        expect(appMock.relaunch).toHaveBeenCalledTimes(1);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-mitigation-cleanup-on-exit-failed",
          expect.any(Error),
          expect.objectContaining({ path: "angle-fallback" })
        );
      });

      it("soft relaunch: marker writes still complete when markCleanExit throws", async () => {
        crashLoopGuardMock.markCleanExit.mockImplementationOnce(() => {
          throw new Error("markCleanExit failed");
        });
        await loadAndInit();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        expect(appMock.relaunch).toHaveBeenCalledTimes(1);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-mitigation-mark-clean-exit-failed",
          expect.any(Error),
          expect.objectContaining({ path: "angle-fallback" })
        );
      });

      it("soft relaunch: relaunch still happens when markCleanLaunch throws", async () => {
        panelSuspectLedgerMock.markCleanLaunch.mockImplementationOnce(() => {
          throw new Error("markCleanLaunch failed");
        });
        await loadAndInit();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(appMock.relaunch).toHaveBeenCalledTimes(1);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-mitigation-mark-clean-launch-failed",
          expect.any(Error),
          expect.objectContaining({ path: "angle-fallback" })
        );
      });

      it("nuclear hard-stop: marker writes still complete when cleanupOnExit throws", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(false);
        crashRecoveryMock.cleanupOnExit.mockImplementationOnce(() => {
          throw new Error("cleanupOnExit failed");
        });
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        expect(appMock.relaunch).not.toHaveBeenCalled();
      });

      it("nuclear relaunch: marker writes still complete when markCleanExit throws", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        crashLoopGuardMock.markCleanExit.mockImplementationOnce(() => {
          throw new Error("markCleanExit failed");
        });
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        expect(appMock.relaunch).toHaveBeenCalledTimes(1);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-mitigation-mark-clean-exit-failed",
          expect.any(Error),
          expect.objectContaining({ path: "nuclear-disable" })
        );
      });

      it("nuclear relaunch: relaunch still happens when markCleanLaunch throws", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        panelSuspectLedgerMock.markCleanLaunch.mockImplementationOnce(() => {
          throw new Error("markCleanLaunch failed");
        });
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(appMock.relaunch).toHaveBeenCalledTimes(1);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-mitigation-mark-clean-launch-failed",
          expect.any(Error),
          expect.objectContaining({ path: "nuclear-disable" })
        );
      });

      it("soft hard-stop: app.exit(0) still happens when closeTelemetry rejects", async () => {
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(false);
        telemetryServiceMock.closeTelemetry.mockRejectedValueOnce(
          new Error("telemetry drain failed")
        );
        await loadAndInit();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(appMock.relaunch).not.toHaveBeenCalled();
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-mitigation-close-telemetry-failed",
          expect.any(Error),
          expect.objectContaining({ path: "angle-fallback" })
        );
      });

      it("nuclear hard-stop: app.exit(0) still happens when closeTelemetry rejects", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        crashLoopGuardMock.shouldRelaunch.mockReturnValue(false);
        telemetryServiceMock.closeTelemetry.mockRejectedValueOnce(
          new Error("telemetry drain failed")
        );
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        await vi.waitFor(() => {
          expect(appMock.exit).toHaveBeenCalledWith(0);
        });
        expect(appMock.relaunch).not.toHaveBeenCalled();
        expect(crashRecoveryMock.cleanupOnExit).toHaveBeenCalledTimes(1);
        expect(crashLoopGuardMock.markCleanExit).toHaveBeenCalledTimes(1);
        expect(panelSuspectLedgerMock.markCleanLaunch).toHaveBeenCalledTimes(1);
        expect(loggerMethods.error).toHaveBeenCalledWith(
          "gpu-mitigation-close-telemetry-failed",
          expect.any(Error),
          expect.objectContaining({ path: "nuclear-disable" })
        );
      });

      it("non-GPU crashes do not call the cleanup helper", async () => {
        await loadAndInit();
        emitChildProcessGone("Utility", "crashed", 1, "daintree-pty-host");
        emitChildProcessGone("Utility", "crashed", 1, "daintree-pty-host");
        emitChildProcessGone("Utility", "crashed", 1, "daintree-pty-host");
        expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
        expect(crashLoopGuardMock.markCleanExit).not.toHaveBeenCalled();
        expect(panelSuspectLedgerMock.markCleanLaunch).not.toHaveBeenCalled();
      });

      it("clean-exit / killed GPU exits do not call the cleanup helper", async () => {
        await loadAndInit();
        emitGpuCrash("clean-exit");
        emitGpuCrash("killed");
        emitGpuCrash("clean-exit");
        expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
        expect(crashLoopGuardMock.markCleanExit).not.toHaveBeenCalled();
        expect(panelSuspectLedgerMock.markCleanLaunch).not.toHaveBeenCalled();
      });

      it("already-disabled path does not call the cleanup helper", async () => {
        writeGpuDisabledFlag(tmpDir, "crash");
        await loadAndInit();
        emitGpuCrash();
        emitGpuCrash();
        emitGpuCrash();
        expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
        expect(crashLoopGuardMock.markCleanExit).not.toHaveBeenCalled();
        expect(panelSuspectLedgerMock.markCleanLaunch).not.toHaveBeenCalled();
      });

      it("failed ANGLE flag write does not call the cleanup helper", async () => {
        vi.doMock("../../utils/fs.js", async () => {
          const actual =
            await vi.importActual<typeof import("../../utils/fs.js")>("../../utils/fs.js");
          return {
            ...actual,
            resilientAtomicWriteFileSync: vi.fn(() => {
              throw new Error("EROFS: read-only filesystem");
            }),
          };
        });
        try {
          await loadAndInit();
          emitGpuCrash();
          await new Promise((r) => setImmediate(r));
          expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
          expect(crashLoopGuardMock.markCleanExit).not.toHaveBeenCalled();
          expect(panelSuspectLedgerMock.markCleanLaunch).not.toHaveBeenCalled();
          expect(appMock.relaunch).not.toHaveBeenCalled();
        } finally {
          vi.doUnmock("../../utils/fs.js");
        }
      });

      it("failed nuclear disable write does not call the cleanup helper", async () => {
        writeGpuAngleFallbackFlag(tmpDir);
        vi.doMock("../../utils/fs.js", async () => {
          const actual =
            await vi.importActual<typeof import("../../utils/fs.js")>("../../utils/fs.js");
          return {
            ...actual,
            resilientAtomicWriteFileSync: vi.fn(() => {
              throw new Error("EROFS: read-only filesystem");
            }),
          };
        });
        try {
          await loadAndInit();
          emitGpuCrash();
          emitGpuCrash();
          emitGpuCrash();
          await new Promise((r) => setImmediate(r));
          expect(crashRecoveryMock.cleanupOnExit).not.toHaveBeenCalled();
          expect(crashLoopGuardMock.markCleanExit).not.toHaveBeenCalled();
          expect(panelSuspectLedgerMock.markCleanLaunch).not.toHaveBeenCalled();
          expect(appMock.relaunch).not.toHaveBeenCalled();
        } finally {
          vi.doUnmock("../../utils/fs.js");
        }
      });
    });
  });

  describe("sliding window decay", () => {
    async function loadAndInit() {
      vi.resetModules();
      const mod = await import("../GpuCrashMonitorService.js");
      mod.initializeGpuCrashMonitor();
    }

    function emitGpuCrash(reason = "crashed", exitCode = 1) {
      const handlers = appListeners["child-process-gone"] ?? [];
      for (const handler of handlers) {
        handler({}, { type: "GPU", reason, exitCode, serviceName: "", name: "" });
      }
    }

    it("three crashes within window trigger nuclear disable", async () => {
      writeGpuAngleFallbackFlag(tmpDir);
      await loadAndInit();

      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();

      await vi.waitFor(() => {
        expect(appMock.exit).toHaveBeenCalledWith(0);
      });
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
      expect(loggerMethods.warn).toHaveBeenCalledWith(
        "gpu-crash-nuclear-disable",
        expect.objectContaining({ crashCount: 3 })
      );
    });

    it("does NOT trigger nuclear disable when first crash falls outside window", async () => {
      writeGpuAngleFallbackFlag(tmpDir);

      let now = Date.now();
      const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

      await loadAndInit();

      // 2 crashes at T+0
      emitGpuCrash();
      emitGpuCrash();

      // Advance past the window
      now += GPU_CRASH_WINDOW_MS + 1;

      // 3rd crash at T+5min+1ms — first 2 pruned, effectiveCount = 1
      emitGpuCrash();

      await new Promise((r) => setImmediate(r));

      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();

      dateSpy.mockRestore();
    });

    it("does NOT trigger nuclear when only 2 crashes remain in window", async () => {
      writeGpuAngleFallbackFlag(tmpDir);

      let now = Date.now();
      const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

      await loadAndInit();

      // 1 crash at T+0
      emitGpuCrash();

      // Advance past window
      now += GPU_CRASH_WINDOW_MS + 1000;

      // 2 crashes at T+5min+1s — first pruned, effectiveCount = 2
      emitGpuCrash();
      emitGpuCrash();

      await new Promise((r) => setImmediate(r));

      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();

      dateSpy.mockRestore();
    });

    it("logs disable-flag-active at init when flag exists", async () => {
      writeGpuDisabledFlag(tmpDir, "crash");
      await loadAndInit();
      expect(loggerMethods.info).toHaveBeenCalledWith("gpu-crash-disable-flag-active");
    });

    it("logs angle-fallback-flag-active at init when flag exists", async () => {
      writeGpuAngleFallbackFlag(tmpDir);
      await loadAndInit();
      expect(loggerMethods.info).toHaveBeenCalledWith("gpu-angle-fallback-flag-active");
      expect(loggerMethods.info).not.toHaveBeenCalledWith("gpu-crash-disable-flag-active");
    });

    it("crashes exactly at window boundary are excluded", async () => {
      writeGpuAngleFallbackFlag(tmpDir);

      let now = Date.now();
      const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

      await loadAndInit();

      emitGpuCrash();
      emitGpuCrash();

      // Advance to exactly the window boundary
      now += GPU_CRASH_WINDOW_MS;

      // At exact boundary, `now - ts < GPU_CRASH_WINDOW_MS` is false for the
      // old crashes (difference equals the window, not less than)
      emitGpuCrash();

      await new Promise((r) => setImmediate(r));

      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();

      dateSpy.mockRestore();
    });
  });

  describe("startup GPU status logging", () => {
    async function initFresh() {
      vi.resetModules();
      const mod = await import("../GpuCrashMonitorService.js");
      mod.initializeGpuCrashMonitor();
      return mod;
    }

    it("logs gpu-startup-status once webgl2 is classified", async () => {
      appMock.getGPUFeatureStatus.mockReturnValue({
        webgl2: "enabled",
        webgl: "enabled",
        gpu_compositing: "enabled",
      });
      await initFresh();
      expect(loggerMethods.info).toHaveBeenCalledWith("gpu-startup-status", {
        webgl2: "enabled",
        webgl: "enabled",
        gpu_compositing: "enabled",
      });
    });

    it("skips logging while the GPU is not yet classified (no webgl2)", async () => {
      // Chromium has not yet classified the GPU — the sample has no webgl2, so
      // the logger must stay silent rather than emitting an empty trace.
      appMock.getGPUFeatureStatus.mockReturnValue({});
      await initFresh();
      expect(loggerMethods.info).not.toHaveBeenCalledWith("gpu-startup-status", expect.anything());
    });

    it("binds the gpu-info-update refresh listener at most once across re-init", async () => {
      // initializeGpuCrashMonitor can be called more than once (tests); the
      // refresh listener must not stack on every call.
      appMock.getGPUFeatureStatus.mockReturnValue({});
      const mod = await initFresh();
      mod.initializeGpuCrashMonitor();
      mod.initializeGpuCrashMonitor();
      const gpuInfoBinds = appMock.on.mock.calls.filter((call) => call[0] === "gpu-info-update");
      expect(gpuInfoBinds.length).toBe(1);
    });
  });
});
