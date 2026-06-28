// eager-import-allow: reads diagnostics files via sync fs in the IPC handler
import { app, dialog, shell } from "electron";
import os from "node:os";
import v8 from "node:v8";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { promises as fs, createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { CHANNELS } from "../channels.js";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { ensureAttached } from "../../utils/webContentsLifecycle.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type {
  AppMetricsSummary,
  HardwareInfo,
  ProcessMetricEntry,
  HeapStats,
  DiagnosticsInfo,
  DiagnosticsReviewPayload,
  DiagnosticsBundleSavePayload,
  ReportIssueEnrichment,
  RendererCpuProfileStartResult,
  RendererCpuProfileStopResult,
} from "../../../shared/types/ipc/system.js";
import { getActionBreadcrumbService } from "../../services/ActionBreadcrumbService.js";
import type * as DiagnosticsCollectorModule from "../../services/DiagnosticsCollector.js";
import { recordBlinkSample, recordEluSample } from "../../services/ProcessMemoryMonitor.js";
import { getAppMetricsSnapshot } from "../../utils/appMetricsSnapshot.js";

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
  filterLogEntriesByTime,
  applyReplacements,
  type ReplacementRule,
} from "../../../shared/utils/diagnosticsTransform.js";
import { typedHandle, typedHandleWithContext } from "../utils.js";

let eventLoopHistogram: IntervalHistogram | null = null;

// Approximate epoch the app process started. Captured at module evaluation
// (the diagnostics handler is eagerly imported during startup) rather than
// from `Date.now() - process.uptime() * 1000` at call time, which drifts
// because `process.uptime()` pauses during OS sleep while `Date.now()` does
// not. Backs the "Since application launch" time-window option.
const APP_LAUNCH_TIMESTAMP = Date.now();

async function writeBundleZip(
  zipPath: string,
  jsonContent: string,
  includeLogs: boolean,
  replacements: ReplacementRule[],
  timeWindowStartMs: number | null
): Promise<void> {
  const { ZipArchive } = await import("archiver");
  const logDir = getLogDirectory();
  const logFile = getLogFilePath();

  const logEntries: Array<{ name: string; content: string }> = [];

  if (includeLogs) {
    // The active log is always current, so it's never time-filtered here.
    if (existsSync(logFile)) {
      const raw = await fs.readFile(logFile, "utf-8");
      logEntries.push({ name: "daintree.log", content: applyReplacements(raw, replacements) });
    }

    for (let i = 1; i <= 5; i++) {
      const rotated = path.join(logDir, `daintree.log.${i}`);
      if (!existsSync(rotated)) continue;

      if (timeWindowStartMs !== null) {
        try {
          const stat = await fs.stat(rotated);
          // Skip rotated files last written before the window. `mtime`
          // over-includes a freshly-rotated file holding mostly old lines —
          // the accepted failure mode (over-include rather than drop).
          if (stat.mtimeMs < timeWindowStartMs) continue;
        } catch {
          // stat failed — include rather than silently drop relevant lines.
        }
      }

      const raw = await fs.readFile(rotated, "utf-8");
      logEntries.push({
        name: `daintree.log.${i}`,
        content: applyReplacements(raw, replacements),
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath, { mode: 0o600 });
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on("close", () => {
      resolve();
    });
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.append(jsonContent, { name: "diagnostics.json" });

    for (const entry of logEntries) {
      archive.append(entry.content, { name: entry.name });
    }

    void archive.finalize();
  });

  // Belt-and-suspenders: createWriteStream's `mode` is only applied when the
  // file is freshly created. If the user picked an existing path, the prior
  // mode (e.g. 0o644) survives. POSIX-only — chmod is a no-op on Windows.
  if (process.platform !== "win32") {
    await fs.chmod(zipPath, 0o600);
  }
}

const CPU_PROFILE_DURATION_MS = 15_000;
// 1000µs sampling keeps profiling overhead at ~1-2%; finer intervals cause
// observable stuttering in the renderer being measured.
const CPU_PROFILE_SAMPLING_INTERVAL_US = 1000;

interface RendererCpuProfileSession {
  wc: Electron.WebContents;
  timer: NodeJS.Timeout | null;
  /**
   * Memoized `Profiler.stop` call. Both the auto-stop timer and the renderer's
   * stop IPC funnel through this so the profiler is stopped exactly once even
   * when they race; the stop handler awaits whichever capture won.
   */
  capture: Promise<unknown> | null;
  stopping: boolean;
  /**
   * Set on cleanup. An in-flight capture from a discarded session must not
   * fire its trailing `Profiler.disable` — the renderer may have started a
   * new recording on the same debugger, and the stale disable would kill it.
   */
  discarded: boolean;
  onDetach: () => void;
  onDestroyed: () => void;
}

const cpuProfileSessions = new Map<number, RendererCpuProfileSession>();

function cleanupCpuProfileSession(webContentsId: number): void {
  const session = cpuProfileSessions.get(webContentsId);
  if (!session) return;
  cpuProfileSessions.delete(webContentsId);
  session.discarded = true;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  const { wc } = session;
  if (!wc.isDestroyed()) {
    wc.debugger.removeListener("detach", session.onDetach);
    wc.removeListener("destroyed", session.onDestroyed);
  }
}

function beginCpuProfileCapture(session: RendererCpuProfileSession): Promise<unknown> {
  session.capture ??= (async () => {
    const result = (await session.wc.debugger.sendCommand("Profiler.stop")) as {
      profile: unknown;
    };
    // The debugger attachment is shared with webContentsLifecycle (freeze/
    // throttle), so only disable the Profiler domain — never detach.
    if (!session.discarded) {
      session.wc.debugger.sendCommand("Profiler.disable").catch(() => {});
    }
    return result.profile;
  })();
  return session.capture;
}

function ensureEventLoopHistogram(): IntervalHistogram {
  if (!eventLoopHistogram) {
    eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    eventLoopHistogram.enable();
  }
  return eventLoopHistogram;
}

/**
 * Snapshot total + available physical memory for the diagnostics popover.
 * `systemTotalMB` comes from os.totalmem() (always available). `systemAvailableMB`
 * = free (+ purgeable on macOS) per process.getSystemMemoryInfo(), mirroring
 * ProcessMemoryMonitor.readAvailableMemoryMb so the two stay in sync; it is
 * omitted when that Chromium API is unavailable (e.g. test mocks), so the
 * renderer hides the row rather than showing 0.
 */
function readSystemMemoryMB(): { systemTotalMB?: number; systemAvailableMB?: number } {
  try {
    const out: { systemTotalMB?: number; systemAvailableMB?: number } = {};
    const totalBytes = os.totalmem();
    if (Number.isFinite(totalBytes) && totalBytes > 0) {
      out.systemTotalMB = Math.round(totalBytes / 1024 / 1024);
    }
    const getInfo = (
      process as {
        getSystemMemoryInfo?: () => { free: number; purgeable?: number; total: number };
      }
    ).getSystemMemoryInfo;
    if (typeof getInfo === "function") {
      const info = getInfo.call(process);
      const freeKb = typeof info.free === "number" ? info.free : 0;
      const purgeableKb = typeof info.purgeable === "number" ? info.purgeable : 0;
      const availableKb = freeKb + purgeableKb;
      if (availableKb > 0) out.systemAvailableMB = Math.round(availableKb / 1024);
    }
    return out;
  } catch {
    return {};
  }
}

export function registerDiagnosticsHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const histogram = ensureEventLoopHistogram();

  const handleGetAppMetrics = (): AppMetricsSummary => {
    try {
      const metrics = getAppMetricsSnapshot();
      let totalKB = 0;
      for (const proc of metrics) {
        // workingSetSize is the only cross-platform field: privateBytes is
        // Windows-only and reports 0 on macOS/Linux, so a `?? workingSetSize`
        // fallback never fires there and silently sums to zero (lesson #8646).
        totalKB += proc.memory.workingSetSize;
      }
      return { totalMemoryMB: Math.round(totalKB / 1024) };
    } catch {
      // Distinguish a real read failure from a genuine 0 reading so the badge
      // can suppress the value instead of rendering a misleading "0MB".
      return { totalMemoryMB: 0, unavailable: true };
    }
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_APP_METRICS, handleGetAppMetrics));

  const handleGetProcessMetrics = (): ProcessMetricEntry[] => {
    try {
      const metrics = getAppMetricsSnapshot();
      return metrics
        .map((proc) => ({
          pid: proc.pid,
          type: proc.type,
          name: proc.name ?? proc.type,
          // workingSetSize only — privateBytes is Windows-only and reports 0
          // on macOS/Linux (lesson #8646).
          memoryMB: Math.round(proc.memory.workingSetSize / 1024),
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
        ...readSystemMemoryMB(),
      };
    } catch {
      return { uptimeSeconds: 0, eventLoopP99Ms: 0 };
    }
  };
  handlers.push(typedHandle(CHANNELS.DIAGNOSTICS_GET_INFO, handleGetDiagnosticsInfo));

  const handleGetReportEnrichment = async (): Promise<ReportIssueEnrichment> => {
    let gpuFlag: "off" | "angle" | "on" | "unknown";
    try {
      const { isGpuDisabledByFlag, isGpuAngleFallbackApplied } =
        await import("../../services/GpuCrashMonitorService.js");
      const userDataPath = app.getPath("userData");
      if (isGpuDisabledByFlag(userDataPath)) {
        gpuFlag = "off";
      } else if (isGpuAngleFallbackApplied(userDataPath)) {
        gpuFlag = "angle";
      } else {
        gpuFlag = "on";
      }
    } catch {
      gpuFlag = "unknown";
    }

    const mem = process.memoryUsage();
    const totalMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMB = Math.round(os.freemem() / 1024 / 1024);
    const heapMB = Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10;

    const lines = [
      `App: ${app.getVersion()} | Electron: ${process.versions.electron ?? "?"} | Node: ${process.versions.node ?? "?"}`,
      `OS: ${process.platform} ${os.release()} ${process.arch}`,
      `Memory: ${totalMB} MB total, ${freeMB} MB free, heap ${heapMB} MB`,
      `GPU: ${gpuFlag}`,
    ];

    const recentActions = getActionBreadcrumbService().getRecentActions().slice(-10);
    return { systemInfo: lines.join("\n"), recentActions };
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_REPORT_ENRICHMENT, handleGetReportEnrichment));

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

  // Renderer ELU report. webContents id is taken from event.sender.id.
  handlers.push(
    typedHandleWithContext(CHANNELS.SYSTEM_REPORT_RENDERER_ELU, (ctx, payload) => {
      if (!payload) return;
      if (
        !Number.isFinite(payload.blockingDurationMs) ||
        !Number.isFinite(payload.sampleWindowMs) ||
        payload.blockingDurationMs < 0 ||
        payload.sampleWindowMs <= 0
      ) {
        return;
      }
      if (ctx.event.sender.isDestroyed()) return;
      recordEluSample(ctx.webContentsId, {
        blockingDurationMs: payload.blockingDurationMs,
        sampleWindowMs: payload.sampleWindowMs,
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

    await resilientAtomicWriteFile(filePath, json, "utf-8", { mode: 0o600 });
    return true;
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_DOWNLOAD_DIAGNOSTICS, handleDownloadDiagnostics));

  const handleCollectDiagnosticsForReview = async (): Promise<DiagnosticsReviewPayload> => {
    const { collectDiagnosticsWithKeys } = await getDiagnosticsCollector();
    const { payload, sectionKeys } = await collectDiagnosticsWithKeys(deps);
    const previewJson = safeStringify(payload, 2);
    return { payload, sectionKeys, previewJson, appLaunchTimestamp: APP_LAUNCH_TIMESTAMP };
  };
  handlers.push(
    typedHandle(CHANNELS.SYSTEM_COLLECT_DIAGNOSTICS_FOR_REVIEW, handleCollectDiagnosticsForReview)
  );

  const handleSaveDiagnosticsBundle = async (
    savePayload: DiagnosticsBundleSavePayload
  ): Promise<boolean> => {
    const timeWindowStartMs = savePayload.timeWindowStartMs ?? null;
    const filtered = filterLogEntriesByTime(
      filterSections(savePayload.payload, savePayload.enabledSections),
      timeWindowStartMs
    );
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
      savePayload.replacements as ReplacementRule[],
      timeWindowStartMs
    );
    shell.showItemInFolder(filePath);
    return true;
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_SAVE_DIAGNOSTICS_BUNDLE, handleSaveDiagnosticsBundle));

  const handleRendererCpuProfileStart = async (
    ctx: IpcContext
  ): Promise<RendererCpuProfileStartResult> => {
    const wc = ctx.event.sender;
    if (wc.isDestroyed()) {
      return { status: "failed", reason: "webcontents-destroyed" };
    }

    const existing = cpuProfileSessions.get(wc.id);
    if (existing) {
      // A finished-but-uncollected session (auto-stop fired while Settings was
      // closed, so no stop IPC ever arrived) must not block re-recording.
      if (existing.timer === null && !existing.stopping) {
        if (existing.capture) {
          console.warn(
            `[diagnostics] Discarding uncollected renderer CPU profile for webContents ${wc.id}`
          );
        }
        cleanupCpuProfileSession(wc.id);
      } else {
        return { status: "failed", reason: "already-recording" };
      }
    }

    try {
      ensureAttached(wc);
      await wc.debugger.sendCommand("Profiler.enable");
      await wc.debugger.sendCommand("Profiler.setSamplingInterval", {
        interval: CPU_PROFILE_SAMPLING_INTERVAL_US,
      });
      await wc.debugger.sendCommand("Profiler.start");
    } catch (err) {
      // Don't leave the Profiler domain enabled after a partial start.
      try {
        if (!wc.isDestroyed()) {
          wc.debugger.sendCommand("Profiler.disable").catch(() => {});
        }
      } catch {
        // detached between failure and cleanup — nothing left to disable
      }
      return {
        status: "failed",
        reason: "cdp-error",
        message: formatErrorMessage(err, "CPU profiler failed to start"),
      };
    }

    const session: RendererCpuProfileSession = {
      wc,
      timer: null,
      capture: null,
      stopping: false,
      discarded: false,
      onDetach: () => {
        // DevTools (or another client) stole the CDP session — an in-flight
        // recording is unrecoverable. Stop the timer and poison the capture so
        // the stop handler reports the failure; an already-completed capture
        // is kept (??=) since its data was extracted before the detach.
        if (session.timer) {
          clearTimeout(session.timer);
          session.timer = null;
        }
        session.capture ??= Promise.reject(new Error("Debugger detached during recording"));
        session.capture.catch(() => {});
      },
      onDestroyed: () => cleanupCpuProfileSession(wc.id),
    };
    session.timer = setTimeout(() => {
      session.timer = null;
      beginCpuProfileCapture(session).catch(() => {});
    }, CPU_PROFILE_DURATION_MS);
    wc.debugger.on("detach", session.onDetach);
    wc.once("destroyed", session.onDestroyed);
    cpuProfileSessions.set(wc.id, session);

    return { status: "started", expiresAt: Date.now() + CPU_PROFILE_DURATION_MS };
  };
  handlers.push(
    // eslint-disable-next-line no-restricted-syntax -- legacy helper retained for consistency with existing diagnostics handlers; consider refactoring to defineIpcNamespace in #8577 unified surface
    typedHandleWithContext(
      CHANNELS.SYSTEM_RENDERER_CPU_PROFILE_START,
      handleRendererCpuProfileStart
    )
  );

  const handleRendererCpuProfileStop = async (
    ctx: IpcContext
  ): Promise<RendererCpuProfileStopResult> => {
    const session = cpuProfileSessions.get(ctx.webContentsId);
    if (!session) return { status: "failed", reason: "not-recording" };
    if (session.stopping) return { status: "failed", reason: "already-stopping" };
    session.stopping = true;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    let profile: unknown;
    try {
      profile = await beginCpuProfileCapture(session);
    } catch (err) {
      cleanupCpuProfileSession(ctx.webContentsId);
      return {
        status: "failed",
        reason: "devtools-detached",
        message: formatErrorMessage(err, "Profiler stopped unexpectedly"),
      };
    }
    cleanupCpuProfileSession(ctx.webContentsId);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const win =
      ctx.senderWindow ?? deps.windowRegistry?.getPrimary()?.browserWindow ?? deps.mainWindow;
    const dialogOpts = {
      title: "Save CPU Profile",
      defaultPath: `daintree-renderer-profile-${timestamp}.cpuprofile`,
      filters: [{ name: "CPU Profile", extensions: ["cpuprofile"] }],
    };
    let filePath: string | undefined;
    let canceled: boolean;
    try {
      ({ filePath, canceled } = win
        ? await dialog.showSaveDialog(win, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts));
    } catch (err) {
      return {
        status: "failed",
        reason: "save-failed",
        message: formatErrorMessage(err, "Couldn't open the save dialog"),
      };
    }
    if (canceled || !filePath) return { status: "canceled" };

    try {
      await resilientAtomicWriteFile(filePath, JSON.stringify(profile), "utf-8", { mode: 0o600 });
    } catch (err) {
      return {
        status: "failed",
        reason: "save-failed",
        message: formatErrorMessage(err, "Couldn't save the profile"),
      };
    }
    shell.showItemInFolder(filePath);
    return { status: "saved" };
  };
  handlers.push(
    // eslint-disable-next-line no-restricted-syntax -- legacy helper retained for consistency with existing diagnostics handlers; consider refactoring to defineIpcNamespace in #8577 unified surface
    typedHandleWithContext(CHANNELS.SYSTEM_RENDERER_CPU_PROFILE_STOP, handleRendererCpuProfileStop)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
