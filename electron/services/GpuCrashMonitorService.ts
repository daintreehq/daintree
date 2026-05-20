import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { store } from "../store.js";
import { createLogger } from "../utils/logger.js";
import { closeTelemetry } from "./TelemetryService.js";
import { getCrashLoopGuard } from "./CrashLoopGuardService.js";

const GPU_DISABLED_FLAG = "gpu-disabled.flag";
const GPU_ANGLE_FALLBACK_FLAG = "gpu-angle-fallback.flag";
const GPU_CRASH_THRESHOLD = 3;
export const GPU_CRASH_WINDOW_MS = 5 * 60 * 1000;

const logger = createLogger("main:GpuCrashMonitor");

let cachedGpuDisabledByFlag: boolean | null = null;
let cachedUserDataPath: string | null = null;

export function isGpuDisabledByFlag(userDataPath: string): boolean {
  if (cachedGpuDisabledByFlag !== null && cachedUserDataPath === userDataPath) {
    return cachedGpuDisabledByFlag;
  }
  cachedGpuDisabledByFlag = fs.existsSync(path.join(userDataPath, GPU_DISABLED_FLAG));
  cachedUserDataPath = userDataPath;
  return cachedGpuDisabledByFlag;
}

export function writeGpuDisabledFlag(userDataPath: string): void {
  fs.writeFileSync(path.join(userDataPath, GPU_DISABLED_FLAG), String(Date.now()), "utf8");
}

export function clearGpuDisabledFlag(userDataPath: string): void {
  const flagPath = path.join(userDataPath, GPU_DISABLED_FLAG);
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

export function isGpuAngleFallbackByFlag(userDataPath: string): boolean {
  return fs.existsSync(path.join(userDataPath, GPU_ANGLE_FALLBACK_FLAG));
}

/**
 * True only when the app is *actually* running with ANGLE/Vulkan fallback.
 * The crash listener writes `gpu-angle-fallback.flag` on any platform after
 * the first GPU crash, but `electron/setup/environment.ts` only appends the
 * ANGLE switches on Linux Wayland (and only when hardware acceleration is
 * still on). Use this for UI surfaces so macOS / Linux X11 / Windows don't
 * show a misleading "running in ANGLE mode" warning when ANGLE was never
 * engaged. Keep `isGpuAngleFallbackByFlag` for raw-flag inspection
 * (diagnostics, environment-module bootstrap).
 */
export function isGpuAngleFallbackApplied(userDataPath: string): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.XDG_SESSION_TYPE !== "wayland") return false;
  if (isGpuDisabledByFlag(userDataPath)) return false;
  return isGpuAngleFallbackByFlag(userDataPath);
}

export function writeGpuAngleFallbackFlag(userDataPath: string): void {
  fs.writeFileSync(path.join(userDataPath, GPU_ANGLE_FALLBACK_FLAG), String(Date.now()), "utf8");
}

export function clearGpuAngleFallbackFlag(userDataPath: string): void {
  const flagPath = path.join(userDataPath, GPU_ANGLE_FALLBACK_FLAG);
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

class GpuCrashMonitorService {
  private crashTimestamps: number[] = [];
  private initialized = false;
  private relaunching = false;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    const userDataPath = app.getPath("userData");
    const alreadyDisabled = isGpuDisabledByFlag(userDataPath);
    const alreadyHasAngleFallback = isGpuAngleFallbackByFlag(userDataPath);

    app.on("child-process-gone", async (_event, details) => {
      if (details.type !== "GPU") {
        if (details.reason !== "clean-exit" && details.reason !== "killed") {
          logger.warn("gpu-non-crash-exit-detected", {
            type: details.type,
            reason: details.reason,
            exitCode: details.exitCode,
            name: details.name,
          });
        }
        return;
      }
      if (details.reason === "clean-exit" || details.reason === "killed") return;

      // Sliding window: prune crashes older than the window and push the
      // current crash, then cap at the operational threshold (entries past
      // the nuclear-disable count are dead weight).
      const now = Date.now();
      this.crashTimestamps = this.crashTimestamps.filter((ts) => now - ts < GPU_CRASH_WINDOW_MS);
      this.crashTimestamps.push(now);
      if (this.crashTimestamps.length > GPU_CRASH_THRESHOLD) {
        this.crashTimestamps = this.crashTimestamps.slice(-GPU_CRASH_THRESHOLD);
      }
      const effectiveCount = this.crashTimestamps.length;

      logger.warn("gpu-crash-detected", {
        crashCount: effectiveCount,
        reason: details.reason,
        exitCode: details.exitCode,
      });

      if (this.relaunching || alreadyDisabled) return;

      // First-strike soft fallback: when the system has not yet been moved to
      // ANGLE/Vulkan, the first crash relaunches with the fallback flags. The
      // `alreadyHasAngleFallback` guard prevents an infinite relaunch loop on
      // hardware where Vulkan itself crashes — in that case the strikes
      // accumulate normally toward the nuclear path below.
      if (effectiveCount === 1 && !alreadyHasAngleFallback) {
        try {
          writeGpuAngleFallbackFlag(userDataPath);
        } catch (err) {
          // If the flag write fails (read-only fs, permissions), do NOT
          // relaunch — that would loop every session. Let strikes accumulate
          // toward the nuclear path on subsequent crashes.
          logger.error("gpu-crash-relaunching-skip", err, {
            path: "angle-fallback",
          });
          return;
        }
        this.relaunching = true;
        // Honor the crash-loop hard stop even when GPU crashes are the
        // trigger — otherwise back-to-back GPU crashes can blow past the
        // process-wide HARD_STOP_THRESHOLD that globalErrorHandlers respects.
        if (!getCrashLoopGuard().shouldRelaunch()) {
          logger.warn("gpu-crash-loop-hard-stop", {
            path: "angle-fallback",
            crashCount: effectiveCount,
          });
          await closeTelemetry();
          app.exit(0);
          return;
        }
        logger.warn("gpu-crash-soft-fallback", { crashCount: effectiveCount });
        app.relaunch();
        await closeTelemetry();
        app.exit(0);
        return;
      }

      if (effectiveCount >= GPU_CRASH_THRESHOLD) {
        try {
          writeGpuDisabledFlag(userDataPath);
          clearGpuAngleFallbackFlag(userDataPath);
          store.set("gpu", { hardwareAccelerationDisabled: true });
        } catch (err) {
          // Same rationale as the soft path: never relaunch without
          // persisting state, or the next session loops back to here.
          logger.error("gpu-crash-relaunching-skip", err, {
            path: "disable",
          });
          return;
        }
        this.relaunching = true;
        if (!getCrashLoopGuard().shouldRelaunch()) {
          logger.warn("gpu-crash-loop-hard-stop", {
            path: "nuclear-disable",
            crashCount: effectiveCount,
          });
          await closeTelemetry();
          app.exit(0);
          return;
        }
        logger.warn("gpu-crash-nuclear-disable", { crashCount: effectiveCount });
        app.relaunch();
        await closeTelemetry();
        app.exit(0);
      }
    });

    if (alreadyDisabled) {
      logger.info("gpu-crash-disable-flag-active");
    } else if (alreadyHasAngleFallback) {
      logger.info("gpu-angle-fallback-flag-active");
    }
  }
}

let instance: GpuCrashMonitorService | null = null;

export function getGpuCrashMonitorService(): GpuCrashMonitorService {
  if (!instance) {
    instance = new GpuCrashMonitorService();
  }
  return instance;
}

export function initializeGpuCrashMonitor(): GpuCrashMonitorService {
  const service = getGpuCrashMonitorService();
  service.initialize();
  return service;
}
