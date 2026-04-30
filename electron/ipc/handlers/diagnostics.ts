import { app, dialog, shell } from "electron";
import os from "node:os";
import v8 from "node:v8";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { promises as fs, createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type {
  AppMetricsSummary,
  HardwareInfo,
  ProcessMetricEntry,
  HeapStats,
  DiagnosticsInfo,
  DiagnosticsReviewPayload,
  DiagnosticsBundleSavePayload,
} from "../../../shared/types/ipc/system.js";
import type * as DiagnosticsCollectorModule from "../../services/DiagnosticsCollector.js";
import { recordBlinkSample } from "../../services/ProcessMemoryMonitor.js";

let cachedDiagnosticsCollector: typeof DiagnosticsCollectorModule | null = null;
async function getDiagnosticsCollector(): Promise<typeof DiagnosticsCollectorModule> {
  if (!cachedDiagnosticsCollector) {
    cachedDiagnosticsCollector = await import("../../services/DiagnosticsCollector.js");
  }
  return cachedDiagnosticsCollector;
}
import { getLogFilePath, getLogDirectory } from "../../utils/logger.js";
import { safeStringify } from "../../utils/safeStringify.js";
import {
  filterSections,
  applyReplacements,
  type ReplacementRule,
} from "../../../shared/utils/diagnosticsTransform.js";
import { typedHandle, typedHandleWithContext } from "../utils.js";

let eventLoopHistogram: IntervalHistogram | null = null;

async function writeBundleZip(
  zipPath: string,
  jsonContent: string,
  includeLogs: boolean,
  replacements: ReplacementRule[]
): Promise<void> {
  const logDir = getLogDirectory();
  const logFile = getLogFilePath();

  const logEntries: Array<{ name: string; content: string }> = [];

  if (includeLogs) {
    if (existsSync(logFile)) {
      const raw = await fs.readFile(logFile, "utf-8");
      logEntries.push({ name: "daintree.log", content: applyReplacements(raw, replacements) });
    }

    for (let i = 1; i <= 5; i++) {
      const rotated = path.join(logDir, `daintree.log.${i}`);
      if (existsSync(rotated)) {
        const raw = await fs.readFile(rotated, "utf-8");
        logEntries.push({
          name: `daintree.log.${i}`,
          content: applyReplacements(raw, replacements),
        });
      }
    }
  }

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.append(jsonContent, { name: "diagnostics.json" });

    for (const entry of logEntries) {
      archive.append(entry.content, { name: entry.name });
    }

    void archive.finalize();
  });
}

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
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_APP_METRICS, handleGetAppMetrics));

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
  handlers.push(typedHandle(CHANNELS.DIAGNOSTICS_GET_PROCESS_METRICS, handleGetProcessMetrics));

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
  handlers.push(typedHandle(CHANNELS.DIAGNOSTICS_GET_HEAP_STATS, handleGetHeapStats));

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
  handlers.push(typedHandle(CHANNELS.DIAGNOSTICS_GET_INFO, handleGetDiagnosticsInfo));

  // Renderer report → ProcessMemoryMonitor. webContents id is taken from
  // event.sender.id (cannot be spoofed by the renderer payload).
  handlers.push(
    typedHandleWithContext(CHANNELS.SYSTEM_REPORT_BLINK_MEMORY, (ctx, payload) => {
      // Number.isFinite filters NaN/Infinity that `typeof === "number"` would
      // otherwise accept; observability data should not be silently corrupted.
      if (!payload || !Number.isFinite(payload.allocated)) return;
      // Late IPC reply against an evicted view: don't reinsert into the
      // sample map (forgetBlinkSample already cleaned it up on cleanupEntry).
      if (ctx.event.sender.isDestroyed()) return;
      const optionalKb = (v: unknown): number | undefined =>
        Number.isFinite(v) ? (v as number) : undefined;
      recordBlinkSample(ctx.webContentsId, {
        allocated: payload.allocated,
        marked: optionalKb(payload.marked),
        total: optionalKb(payload.total),
        partitionAlloc: optionalKb(payload.partitionAlloc),
      });
    })
  );

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
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_HARDWARE_INFO, handleGetHardwareInfo));

  const handleDownloadDiagnostics = async (): Promise<boolean> => {
    const { collectDiagnosticsWithKeys } = await getDiagnosticsCollector();
    const { payload } = await collectDiagnosticsWithKeys(deps);
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
  handlers.push(typedHandle(CHANNELS.SYSTEM_DOWNLOAD_DIAGNOSTICS, handleDownloadDiagnostics));

  const handleCollectDiagnosticsForReview = async (): Promise<DiagnosticsReviewPayload> => {
    const { collectDiagnosticsWithKeys } = await getDiagnosticsCollector();
    const { payload, sectionKeys } = await collectDiagnosticsWithKeys(deps);
    const previewJson = safeStringify(payload, 2);
    return { payload, sectionKeys, previewJson };
  };
  handlers.push(
    typedHandle(CHANNELS.SYSTEM_COLLECT_DIAGNOSTICS_FOR_REVIEW, handleCollectDiagnosticsForReview)
  );

  const handleSaveDiagnosticsBundle = async (
    savePayload: DiagnosticsBundleSavePayload
  ): Promise<boolean> => {
    const filtered = filterSections(savePayload.payload, savePayload.enabledSections);
    let json = safeStringify(filtered, 2);
    json = applyReplacements(json, savePayload.replacements as ReplacementRule[]);

    const includeLogs = savePayload.enabledSections.logs !== false;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const win = deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;
    const dialogOpts = {
      title: "Save Diagnostics Bundle",
      defaultPath: `daintree-diagnostics-${timestamp}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    };
    const { filePath, canceled } = win
      ? await dialog.showSaveDialog(win, dialogOpts)
      : await dialog.showSaveDialog(dialogOpts);

    if (canceled || !filePath) return false;

    await writeBundleZip(
      filePath,
      json,
      includeLogs,
      savePayload.replacements as ReplacementRule[]
    );
    shell.showItemInFolder(filePath);
    return true;
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_SAVE_DIAGNOSTICS_BUNDLE, handleSaveDiagnosticsBundle));

  return () => handlers.forEach((cleanup) => cleanup());
}
