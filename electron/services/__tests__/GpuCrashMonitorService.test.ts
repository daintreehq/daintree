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
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("electron", () => ({
  app: appMock,
}));

const telemetryServiceMock = vi.hoisted(() => ({
  closeTelemetry: vi.fn(() => Promise.resolve()),
}));

vi.mock("../TelemetryService.js", () => telemetryServiceMock);

import {
  isGpuDisabledByFlag,
  writeGpuDisabledFlag,
  clearGpuDisabledFlag,
  isGpuAngleFallbackByFlag,
  writeGpuAngleFallbackFlag,
  clearGpuAngleFallbackFlag,
} from "../GpuCrashMonitorService.js";

describe("GpuCrashMonitorService", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(appListeners).forEach((k) => delete appListeners[k]);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-crash-test-"));
    appMock.getPath.mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("flag file helpers", () => {
    it("isGpuDisabledByFlag returns false when no flag exists", () => {
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
    });

    it("writeGpuDisabledFlag creates the flag file", () => {
      writeGpuDisabledFlag(tmpDir);
      expect(fs.existsSync(path.join(tmpDir, "gpu-disabled.flag"))).toBe(true);
    });

    it("isGpuDisabledByFlag returns true after writing flag", () => {
      writeGpuDisabledFlag(tmpDir);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
    });

    it("clearGpuDisabledFlag removes the flag file", () => {
      writeGpuDisabledFlag(tmpDir);
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
      writeGpuDisabledFlag(tmpDir);
      writeGpuAngleFallbackFlag(tmpDir);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(true);
      clearGpuAngleFallbackFlag(tmpDir);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
      expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
    });
  });

  describe("crash monitoring", () => {
    async function loadAndInit() {
      // Reset module to get a fresh singleton
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
      // No disable flag, no store update — only the soft ANGLE fallback.
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
      // Two crashes is below the nuclear threshold; with the angle flag
      // already present, the first-crash path is suppressed too.
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
      // The angle flag is cleared so the next launch goes straight to the
      // disabled-acceleration path without redundant ANGLE switches.
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
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[ChildProcess]"));
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("name=daintree-pty-host"));
    });

    it("does not log non-GPU clean-exit or killed events", async () => {
      await loadAndInit();
      emitChildProcessGone("Utility", "clean-exit", 0, "daintree-pty-host");
      emitChildProcessGone("Utility", "killed", 137, "daintree-workspace-host");
      expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("[ChildProcess]"));
    });

    it("logs non-GPU crash with full process details", async () => {
      await loadAndInit();
      emitChildProcessGone("Utility", "oom", 137, "daintree-workspace-host");
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "type=Utility, reason=oom, exitCode=137, name=daintree-workspace-host"
        )
      );
    });

    it("does not relaunch if disable flag already exists (already disabled)", async () => {
      writeGpuDisabledFlag(tmpDir);
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();
      expect(storeMock.set).not.toHaveBeenCalled();
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
      // Only the soft fallback path ran — disable flag must not be written
      // when crash count was reset by an unmodelled relaunch.
      expect(isGpuDisabledByFlag(tmpDir)).toBe(false);
    });

    it("does NOT relaunch when ANGLE flag write fails (prevents per-session loop)", async () => {
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
        throw new Error("EROFS: read-only filesystem");
      });
      try {
        await loadAndInit();
        emitGpuCrash();
        await new Promise((r) => setImmediate(r));
        expect(appMock.relaunch).not.toHaveBeenCalled();
        expect(appMock.exit).not.toHaveBeenCalled();
        expect(isGpuAngleFallbackByFlag(tmpDir)).toBe(false);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining("Failed to write ANGLE fallback flag"),
          expect.any(Error)
        );
      } finally {
        writeSpy.mockRestore();
      }
    });

    it("does NOT relaunch when nuclear disable flag write fails", async () => {
      writeGpuAngleFallbackFlag(tmpDir);
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
        throw new Error("EROFS: read-only filesystem");
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
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining("Failed to persist disable flag"),
          expect.any(Error)
        );
      } finally {
        writeSpy.mockRestore();
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
  });
});
