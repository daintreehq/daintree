// eager-import-allow: reads/writes the GPU-crash sentinel via sync fs
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { store } from "../store.js";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { closeTelemetry } from "./TelemetryService.js";
import { getCrashLoopGuard } from "./CrashLoopGuardService.js";
import { getCrashRecoveryService } from "./CrashRecoveryService.js";
import { getPanelSuspectLedger } from "./PanelSuspectLedgerService.js";
import { GPU_DISABLED_FLAG_FILENAME, writeGpuDisabledFlagFile } from "./gpuDisabledFlag.js";
import { withTimeout } from "../utils/withTimeout.js";
import type { GpuDisabledReason } from "../../shared/types/ipc/app.js";

const GPU_DISABLED_FLAG = GPU_DISABLED_FLAG_FILENAME;
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

export function writeGpuDisabledFlag(userDataPath: string, reason: GpuDisabledReason): void {
  writeGpuDisabledFlagFile(userDataPath, {
    reason,
    version: app.getVersion(),
    timestamp: Date.now(),
  });
  cachedGpuDisabledByFlag = null;
}

export function clearGpuDisabledFlag(userDataPath: string): void {
  const flagPath = path.join(userDataPath, GPU_DISABLED_FLAG);
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
  cachedGpuDisabledByFlag = null;
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
  resilientAtomicWriteFileSync(
    path.join(userDataPath, GPU_ANGLE_FALLBACK_FLAG),
    String(Date.now()),
    "utf8"
  );
}

export function clearGpuAngleFallbackFlag(userDataPath: string): void {
  const flagPath = path.join(userDataPath, GPU_ANGLE_FALLBACK_FLAG);
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

// Issue #10065: GPU-mitigation exits (soft ANGLE fallback, nuclear disable,
// and their respective crash-loop hard-stops) all go through `app.exit(0)`
// which skips the `before-quit` cleanup chain. Without the three clean-exit
// markers, the next boot treats the deliberate relaunch as a crash:
// `running.lock` is left on disk, `crash-loop-state.json` keeps
// `cleanExit: false` (accumulating strikes toward safe mode), and
// `PanelSuspectLedger` never advances its decay counters. Mirror the
// AutoUpdater #9638 pattern: each marker in its own try/catch so a single
// failure cannot skip the next (lesson #7158). Markers are synchronous
// `writeFileSync` calls, so they commit before any `app.relaunch()` or
// `app.exit(0)` we return to.
type GpuMitigationPath = "angle-fallback" | "nuclear-disable";

function writeCleanGpuMitigationMarkers(path: GpuMitigationPath): void {
  try {
    getCrashRecoveryService().cleanupOnExit();
  } catch (err) {
    logger.error("gpu-mitigation-cleanup-on-exit-failed", err, { path });
  }
  try {
    getCrashLoopGuard().markCleanExit();
  } catch (err) {
    logger.error("gpu-mitigation-mark-clean-exit-failed", err, { path });
  }
  try {
    getPanelSuspectLedger().markCleanLaunch();
  } catch (err) {
    logger.error("gpu-mitigation-mark-clean-launch-failed", err, { path });
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

      if (this.relaunching) return;

      // Acceleration already off: there is no further mitigation tier to
      // escalate to, but keep the sliding-window count above running so a GPU
      // process that crash-loops in software mode stays visible in logs
      // instead of vanishing behind an early return (#10379).
      if (alreadyDisabled) {
        if (effectiveCount >= GPU_CRASH_THRESHOLD) {
          logger.warn("gpu-crash-loop-while-disabled", {
            crashCount: effectiveCount,
            reason: details.reason,
            exitCode: details.exitCode,
          });
        }
        return;
      }

      // First-strike soft fallback: when the system has not yet been moved to
      // ANGLE/Vulkan, the first crash relaunches with the fallback flags. The
      // `alreadyHasAngleFallback` guard prevents an infinite relaunch loop on
      // hardware where Vulkan itself crashes — in that case the strikes
      // accumulate normally toward the nuclear path below.
      if (effectiveCount === 1 && !alreadyHasAngleFallback) {
        // The ANGLE/Vulkan switches are only applied on Linux+Wayland (see
        // `electron/setup/environment.ts`). On macOS/Windows the relaunch
        // would be a no-op — let the strike accumulate toward the nuclear
        // path instead of burning a session restart for no behavior change.
        if (process.platform !== "linux") {
          logger.info("gpu-crash-soft-fallback-skip-nonlinux", {
            platform: process.platform,
            crashCount: effectiveCount,
          });
          return;
        }
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
          writeCleanGpuMitigationMarkers("angle-fallback");
          try {
            await closeTelemetry();
          } catch (err) {
            // Hard-stop has no queued relaunch, so a telemetry rejection
            // would skip the exit and hang the process. Match the shutdown.ts
            // pattern (L497-501): log and fall through to app.exit(0).
            logger.error("gpu-mitigation-close-telemetry-failed", err, {
              path: "angle-fallback",
            });
          }
          app.exit(0);
          return;
        }
        logger.warn("gpu-crash-soft-fallback", { crashCount: effectiveCount });
        writeCleanGpuMitigationMarkers("angle-fallback");
        app.relaunch();
        try {
          await closeTelemetry();
        } catch (err) {
          logger.error("gpu-mitigation-close-telemetry-failed", err, {
            path: "angle-fallback",
          });
        }
        app.exit(0);
        return;
      }

      if (effectiveCount >= GPU_CRASH_THRESHOLD) {
        try {
          writeGpuDisabledFlag(userDataPath, "crash");
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
          writeCleanGpuMitigationMarkers("nuclear-disable");
          try {
            await closeTelemetry();
          } catch (err) {
            logger.error("gpu-mitigation-close-telemetry-failed", err, {
              path: "nuclear-disable",
            });
          }
          app.exit(0);
          return;
        }
        logger.warn("gpu-crash-nuclear-disable", { crashCount: effectiveCount });
        writeCleanGpuMitigationMarkers("nuclear-disable");
        app.relaunch();
        try {
          await closeTelemetry();
        } catch (err) {
          logger.error("gpu-mitigation-close-telemetry-failed", err, {
            path: "nuclear-disable",
          });
        }
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

// Once-per-process trace of the GPU path the session actually started on, so a
// "terminal scroll feels janky" report can be triaged without a blind
// investigation. The happy hardware-accelerated path is otherwise silent — only
// the readback/software branch logs at hydration. getGPUFeatureStatus() is
// empty until Chromium classifies the GPU, so emit on the first valid sample;
// gpu-info-update is the documented signal that the status is now meaningful.
let startupGpuStatusLogged = false;
let startupGpuListenerBound = false;
function logStartupGpuStatus(): void {
  const emit = (): void => {
    if (startupGpuStatusLogged) return;
    // Read app.getGPUFeatureStatus() directly rather than via the cached
    // getGpuFeatureStatus() helper: that helper latches the FIRST sample, which
    // is empty until Chromium classifies the GPU at boot, so a cached empty
    // value would never refresh on later gpu-info-update events. This path
    // polls, so it wants a fresh read each event.
    const status = app.getGPUFeatureStatus();
    if (!status || !status.webgl2) return;
    startupGpuStatusLogged = true;
    logger.info("gpu-startup-status", {
      webgl2: status.webgl2,
      webgl: status.webgl,
      gpu_compositing: status.gpu_compositing,
    });
    // getGPUInfo can hang on some drivers (and is absent in some test/host
    // environments) — guard + bound it so diagnostics never wedge boot.
    if (typeof app.getGPUInfo !== "function") return;
    void withTimeout(app.getGPUInfo("basic"), 5000, "gpu-info-timeout")
      .then((info) => {
        const renderer = (info as { auxAttributes?: { renderer?: string } } | null)?.auxAttributes
          ?.renderer;
        if (typeof renderer === "string" && renderer.length > 0) {
          logger.info("gpu-startup-renderer", { renderer });
        }
      })
      .catch(() => {
        /* timeout/unavailable — the status log above is the durable trace */
      });
  };
  emit();
  // Bind the refresh listener once per process: initializeGpuCrashMonitor can
  // be called more than once (tests), and an unguarded app.on would stack
  // listeners. The startupGpuStatusLogged guard makes repeated emits no-ops
  // anyway, but a stacked listener is still a leak.
  if (!startupGpuListenerBound) {
    startupGpuListenerBound = true;
    app.on("gpu-info-update", emit);
  }
}

export function initializeGpuCrashMonitor(): GpuCrashMonitorService {
  const service = getGpuCrashMonitorService();
  service.initialize();
  logStartupGpuStatus();
  return service;
}
