import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { store } from "../store.js";
import { closeTelemetry } from "./TelemetryService.js";

const GPU_DISABLED_FLAG = "gpu-disabled.flag";
const GPU_CRASH_THRESHOLD = 3;

export function isGpuDisabledByFlag(userDataPath: string): boolean {
  return fs.existsSync(path.join(userDataPath, GPU_DISABLED_FLAG));
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

class GpuCrashMonitorService {
  private crashCount = 0;
  private initialized = false;
  private relaunching = false;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    const alreadyDisabled = isGpuDisabledByFlag(app.getPath("userData"));

    app.on("child-process-gone", async (_event, details) => {
      if (details.type !== "GPU") {
        if (details.reason !== "clean-exit" && details.reason !== "killed") {
          console.warn(
            `[ChildProcess] Process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}, name=${details.name}`
          );
        }
        return;
      }
      if (details.reason === "clean-exit" || details.reason === "killed") return;

      this.crashCount++;
      console.warn(
        `[GPU] GPU process crash #${this.crashCount}: reason=${details.reason}, exitCode=${details.exitCode}`
      );

      if (this.crashCount >= GPU_CRASH_THRESHOLD && !alreadyDisabled && !this.relaunching) {
        this.relaunching = true;
        console.error(
          `[GPU] ${GPU_CRASH_THRESHOLD} GPU crashes detected — writing disable flag and relaunching`
        );
        try {
          const userDataPath = app.getPath("userData");
          writeGpuDisabledFlag(userDataPath);
          store.set("gpu", { hardwareAccelerationDisabled: true });
        } catch (err) {
          console.error("[GPU] Failed to write disable flag:", err);
        }
        app.relaunch();
        await closeTelemetry();
        app.exit(0);
      }
    });

    if (alreadyDisabled) {
      console.log("[GPU] Hardware acceleration disabled by crash fallback flag");
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
