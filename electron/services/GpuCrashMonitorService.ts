import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { store } from "../store.js";

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

  initialize(): void {
    const alreadyDisabled = isGpuDisabledByFlag(app.getPath("userData"));

    app.on("child-process-gone", (_event, details) => {
      if (details.type !== "GPU") return;
      if (details.reason === "clean-exit" || details.reason === "killed") return;

      this.crashCount++;
      console.warn(
        `[GPU] GPU process crash #${this.crashCount}: reason=${details.reason}, exitCode=${details.exitCode}`
      );

      if (this.crashCount >= GPU_CRASH_THRESHOLD && !alreadyDisabled) {
        console.error(
          `[GPU] ${GPU_CRASH_THRESHOLD} GPU crashes detected — writing disable flag and relaunching`
        );
        const userDataPath = app.getPath("userData");
        writeGpuDisabledFlag(userDataPath);
        store.set("gpu", { hardwareAccelerationDisabled: true });
        app.relaunch();
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
