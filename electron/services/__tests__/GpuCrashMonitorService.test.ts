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

import {
  isGpuDisabledByFlag,
  writeGpuDisabledFlag,
  clearGpuDisabledFlag,
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

    it("does not relaunch on fewer than 3 GPU crashes", async () => {
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();
    });

    it("relaunches after 3 GPU crashes", async () => {
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(appMock.exit).toHaveBeenCalledWith(0);
      expect(isGpuDisabledByFlag(tmpDir)).toBe(true);
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

    it("does not relaunch if flag already exists (already disabled)", async () => {
      writeGpuDisabledFlag(tmpDir);
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      expect(appMock.relaunch).not.toHaveBeenCalled();
      expect(appMock.exit).not.toHaveBeenCalled();
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("counts oom, launch-failed, and abnormal-exit as crashes", async () => {
      await loadAndInit();
      emitGpuCrash("oom");
      emitGpuCrash("launch-failed");
      emitGpuCrash("abnormal-exit");
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(appMock.exit).toHaveBeenCalledWith(0);
    });

    it("persists store state on relaunch", async () => {
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      expect(storeMock.set).toHaveBeenCalledWith("gpu", {
        hardwareAccelerationDisabled: true,
      });
    });

    it("only relaunches once even with additional crashes after threshold", async () => {
      await loadAndInit();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      emitGpuCrash();
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(appMock.exit).toHaveBeenCalledTimes(1);
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
