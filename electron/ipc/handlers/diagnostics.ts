import { app, ipcMain, dialog } from "electron";
import os from "node:os";
import v8 from "node:v8";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type {
  AppMetricsSummary,
  HardwareInfo,
  ProcessMetricEntry,
  HeapStats,
  DiagnosticsInfo,
} from "../../../shared/types/ipc/system.js";
import { collectDiagnostics } from "../../services/DiagnosticsCollector.js";

let eventLoopHistogram: IntervalHistogram | null = null;

function ensureEventLoopHistogram(): IntervalHistogram {
  if (!eventLoopHistogram) {
    eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    eventLoopHistogram.enable();
  }
  return eventLoopHistogram;
}

export function registerDiagnosticsHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const histogram = ensureEventLoopHistogram();

  const handleGetAppMetrics = (): AppMetricsSummary => {
    try {
      const metrics = app.getAppMetrics();
      let totalKB = 0;
      for (const proc of metrics) {
        totalKB += proc.memory.privateBytes ?? proc.memory.workingSetSize;
      }
      return { totalMemoryMB: Math.round(totalKB / 1024) };
    } catch {
      return { totalMemoryMB: 0 };
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_APP_METRICS, handleGetAppMetrics);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_APP_METRICS));

  const handleGetProcessMetrics = (): ProcessMetricEntry[] => {
    try {
      const metrics = app.getAppMetrics();
      return metrics
        .map((proc) => ({
          pid: proc.pid,
          type: proc.type,
          name: proc.name ?? proc.type,
          memoryMB: Math.round((proc.memory.privateBytes ?? proc.memory.workingSetSize) / 1024),
          cpuPercent: Math.round((proc.cpu?.percentCPUUsage ?? 0) * 10) / 10,
        }))
        .sort((a, b) => b.memoryMB - a.memoryMB);
    } catch {
      return [];
    }
  };
  ipcMain.handle(CHANNELS.DIAGNOSTICS_GET_PROCESS_METRICS, handleGetProcessMetrics);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DIAGNOSTICS_GET_PROCESS_METRICS));

  const handleGetHeapStats = (): HeapStats => {
    try {
      const mem = process.memoryUsage();
      const heapStats = v8.getHeapStatistics();
      const usedMB = mem.heapUsed / 1024 / 1024;
      const limitMB = heapStats.heap_size_limit / 1024 / 1024;
      return {
        usedMB: Math.round(usedMB * 10) / 10,
        limitMB: Math.round(limitMB),
        percent: limitMB > 0 ? Math.round((usedMB / limitMB) * 100 * 10) / 10 : 0,
        externalMB: Math.round(((mem.external + mem.arrayBuffers) / 1024 / 1024) * 10) / 10,
      };
    } catch {
      return { usedMB: 0, limitMB: 0, percent: 0, externalMB: 0 };
    }
  };
  ipcMain.handle(CHANNELS.DIAGNOSTICS_GET_HEAP_STATS, handleGetHeapStats);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DIAGNOSTICS_GET_HEAP_STATS));

  const handleGetDiagnosticsInfo = (): DiagnosticsInfo => {
    try {
      return {
        uptimeSeconds: Math.floor(process.uptime()),
        eventLoopP99Ms: Math.round(histogram.percentile(99) / 1_000_000),
      };
    } catch {
      return { uptimeSeconds: 0, eventLoopP99Ms: 0 };
    }
  };
  ipcMain.handle(CHANNELS.DIAGNOSTICS_GET_INFO, handleGetDiagnosticsInfo);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DIAGNOSTICS_GET_INFO));

  const handleGetHardwareInfo = (): HardwareInfo => {
    try {
      return {
        totalMemoryBytes: os.totalmem(),
        logicalCpuCount: os.cpus().length,
      };
    } catch {
      return { totalMemoryBytes: 0, logicalCpuCount: 0 };
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_HARDWARE_INFO, handleGetHardwareInfo);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_HARDWARE_INFO));

  const handleDownloadDiagnostics = async (): Promise<boolean> => {
    const payload = await collectDiagnostics(deps);
    const json = JSON.stringify(payload, null, 2);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const win = deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;
    const dialogOpts = {
      title: "Save Diagnostics",
      defaultPath: `daintree-diagnostics-${timestamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const { filePath, canceled } = win
      ? await dialog.showSaveDialog(win, dialogOpts)
      : await dialog.showSaveDialog(dialogOpts);

    if (canceled || !filePath) return false;

    await fs.writeFile(filePath, json, "utf-8");
    return true;
  };
  ipcMain.handle(CHANNELS.SYSTEM_DOWNLOAD_DIAGNOSTICS, handleDownloadDiagnostics);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_DOWNLOAD_DIAGNOSTICS));

  return () => handlers.forEach((cleanup) => cleanup());
}
