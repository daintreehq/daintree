import { app, dialog, shell } from "electron";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { readSystemMemorySnapshot } from "../../utils/systemMemory.js";
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
import type * as DiagnosticsBundleModule from "../../services/diagnosticsBundle.js";
import {
  recordBlinkSample,
  recordEluSample,
  type RendererLoafReport,
} from "../../services/ProcessMemoryMonitor.js";
import { parseInputBlockingSnapshot } from "../../utils/inputBlockingSnapshot.js";
import { getAppMetricsSnapshot } from "../../utils/appMetricsSnapshot.js";
import { getPressureMemoryKb, getProcessMemoryKb } from "../../utils/processMemory.js";
import { getRegisteredProjectViews } from "../../window/webContentsRegistry.js";
import { projectStore } from "../../services/ProjectStore.js";

let cachedDiagnosticsCollector: typeof DiagnosticsCollectorModule | null = null;
async function getDiagnosticsCollector(): Promise<typeof DiagnosticsCollectorModule> {
  if (!cachedDiagnosticsCollector) {
    cachedDiagnosticsCollector = await import("../../services/DiagnosticsCollector.js");
  }
  return cachedDiagnosticsCollector;
}
let cachedDiagnosticsBundle: typeof DiagnosticsBundleModule | null = null;
async function getDiagnosticsBundle(): Promise<typeof DiagnosticsBundleModule> {
  if (!cachedDiagnosticsBundle) {
    cachedDiagnosticsBundle = await import("../../services/diagnosticsBundle.js");
  }
  return cachedDiagnosticsBundle;
}
import { getLogFilePath, getLogDirectory } from "../../utils/logger.js";
import { readOldestRetainedLogMs } from "../../utils/logRetention.js";
import { getVersionFirstRunBoundary } from "../../services/versionFirstRun.js";
import { safeStringify } from "../../utils/safeStringify.js";
import {
  filterSections,
  filterLogEntriesByTime,
  applyReplacements,
  computeTimeWindowStart,
  getTimeWindowIds,
  type ReplacementRule,
} from "../../../shared/utils/diagnosticsTransform.js";
import { typedHandle, typedHandleWithContext } from "../utils.js";

let eventLoopHistogram: IntervalHistogram | null = null;
let eventLoopHistogramIdleTimer: NodeJS.Timeout | null = null;
// The resource popover polls DIAGNOSTICS_GET_INFO while it is open. Once reads
// stop for this long the fine-grained histogram is released, so its 20ms
// sampling timer only runs while someone is looking at the reading (#12515).
const EVENT_LOOP_HISTOGRAM_IDLE_MS = 60_000;

// Approximate epoch the app process started. Captured at module evaluation
// (the diagnostics handler is eagerly imported during startup) rather than
// from `Date.now() - process.uptime() * 1000` at call time, which drifts
// because `process.uptime()` pauses during OS sleep while `Date.now()` does
// not. Backs the "Since application launch" time-window option.
const APP_LAUNCH_TIMESTAMP = Date.now();

function optionalDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// The log files a review read, held so its save writes exactly what the dialog
// listed instead of rereading files that may have rotated or grown since. A
// cancelled review never tells main it closed, so the hold also expires.
const REVIEW_SOURCES_TTL_MS = 15 * 60_000;
let reviewSources: {
  collectedAtMs: number;
  sources: DiagnosticsBundleModule.BundleSources;
} | null = null;
let reviewSourcesTimer: NodeJS.Timeout | null = null;

function releaseReviewSources(): void {
  if (reviewSourcesTimer) {
    clearTimeout(reviewSourcesTimer);
    reviewSourcesTimer = null;
  }
  reviewSources = null;
}

function holdReviewSources(
  collectedAtMs: number,
  sources: DiagnosticsBundleModule.BundleSources
): void {
  releaseReviewSources();
  reviewSources = { collectedAtMs, sources };
  reviewSourcesTimer = setTimeout(releaseReviewSources, REVIEW_SOURCES_TTL_MS);
  reviewSourcesTimer.unref?.();
}

function getBundleDirs(): DiagnosticsBundleModule.BundleDirs {
  let crashesDir: string | null = null;
  try {
    crashesDir = path.join(app.getPath("userData"), "crashes");
  } catch {
    // No userData path — ship the bundle without crash records.
  }
  return { logDir: getLogDirectory(), logFile: getLogFilePath(), crashesDir };
}

const CPU_PROFILE_DURATION_MS = 15_000;
// 1000µs sampling keeps profiling overhead at ~1-2%; finer intervals cause
// observable stuttering in the renderer being measured.
const CPU_PROFILE_SAMPLING_INTERVAL_US = 1000;

interface RendererCpuProfileSession {
  wc: Electron.WebContents;
  webContentsId: number;
  /**
   * True until `Profiler.start` is acknowledged. The session holds its slot in
   * `cpuProfileSessions` from before the first CDP command, so a concurrent
   * start is refused instead of interleaving its commands with this one's.
   */
  starting: boolean;
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
  /** Latched by this session's own `detach` listener. */
  detached: boolean;
  onDetach: () => void;
  onDestroyed: () => void;
}

const cpuProfileSessions = new Map<number, RendererCpuProfileSession>();

function cleanupCpuProfileSession(session: RendererCpuProfileSession): void {
  // Identity, not id: a stale callback must never release a newer session.
  if (cpuProfileSessions.get(session.webContentsId) === session) {
    cpuProfileSessions.delete(session.webContentsId);
  }
  if (session.discarded) return;
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

// Electron clears the attachment, then rejects pending commands, then emits
// `detach`, so a rejection can be handled before the listener has run:
// `isAttached()` covers that window. The latch covers the reverse, another
// consumer reattaching the shared debugger before stop collects the failure.
function wasCpuProfileDebuggerDetached(session: RendererCpuProfileSession): boolean {
  if (session.detached) return true;
  try {
    return !session.wc.isDestroyed() && !session.wc.debugger.isAttached();
  } catch {
    return false;
  }
}

function beginCpuProfileCapture(session: RendererCpuProfileSession): Promise<unknown> {
  session.capture ??= (async () => {
    const result = (await session.wc.debugger.sendCommand("Profiler.stop")) as {
      profile: unknown;
    };
    // The debugger attachment is shared with webContentsLifecycle (freeze,
    // memory purge, CPU-rate reset), so only disable the Profiler domain —
    // never detach.
    if (!session.discarded) {
      session.wc.debugger.sendCommand("Profiler.disable").catch(() => {});
    }
    return result.profile;
  })();
  return session.capture;
}

function acquireEventLoopHistogram(): IntervalHistogram {
  if (!eventLoopHistogram) {
    eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    eventLoopHistogram.enable();
  }
  if (eventLoopHistogramIdleTimer) clearTimeout(eventLoopHistogramIdleTimer);
  eventLoopHistogramIdleTimer = setTimeout(releaseEventLoopHistogram, EVENT_LOOP_HISTOGRAM_IDLE_MS);
  eventLoopHistogramIdleTimer.unref?.();
  return eventLoopHistogram;
}

function releaseEventLoopHistogram(): void {
  if (eventLoopHistogramIdleTimer) {
    clearTimeout(eventLoopHistogramIdleTimer);
    eventLoopHistogramIdleTimer = null;
  }
  try {
    eventLoopHistogram?.disable();
  } catch {
    // Nothing left to release.
  }
  eventLoopHistogram = null;
}

/**
 * Snapshot total + available physical memory for the diagnostics popover.
 * `systemTotalMB` comes from os.totalmem() (always available). `systemAvailableMB`
 * = free (+ purgeable and file-backed on macOS) per process.getSystemMemoryInfo(), mirroring
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
    const memory = readSystemMemorySnapshot();
    if (memory) out.systemAvailableMB = Math.round(memory.availableMb);
    return out;
  } catch {
    return {};
  }
}

export function registerDiagnosticsHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [releaseEventLoopHistogram, releaseReviewSources];

  const handleGetAppMetrics = (): AppMetricsSummary => {
    try {
      const metrics = getAppMetricsSnapshot();
      let totalKB = 0;
      let pressureKB = 0;
      for (const proc of metrics) {
        totalKB += getProcessMemoryKb(proc);
        pressureKB += getPressureMemoryKb(proc);
      }
      return {
        totalMemoryMB: Math.round(totalKB / 1024),
        pressureMemoryMB: Math.round(pressureKB / 1024),
      };
    } catch {
      // Distinguish a real read failure from a genuine 0 reading so the badge
      // can suppress the value instead of rendering a misleading "0MB".
      return { totalMemoryMB: 0, unavailable: true };
    }
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_GET_APP_METRICS, handleGetAppMetrics));

  // OS pid → the projects rendering in it, keyed by project id: views share one
  // partition and URL, so Chromium may collapse several projects into one
  // renderer process. Keyed by id rather than name because names are not unique
  // — two projects both called "api" are two owners, not one. Each view is
  // resolved independently so a teardown race on one cannot blank the table.
  const collectProjectNamesByPid = (): Map<number, string[]> => {
    const byPid = new Map<number, Map<string, string>>();
    for (const { webContents, projectId } of getRegisteredProjectViews()) {
      try {
        // Re-checked here, not just in the registry: getOSProcessId() throws
        // once the webContents is destroyed, and destruction can race the
        // enumeration above.
        if (webContents.isDestroyed()) continue;
        // 0 means "no renderer process yet" (pre-spawn) or "crashed" — never a
        // real pid, so it must not group views together.
        const pid = webContents.getOSProcessId();
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const name = projectStore.getProjectById(projectId)?.name;
        if (!name) continue;
        const projects = byPid.get(pid) ?? new Map<string, string>();
        projects.set(projectId, name);
        byPid.set(pid, projects);
      } catch {
        // Torn down mid-read: leave this view unlabelled.
      }
    }
    // Plain lexical order, not localeCompare: the label must not reshuffle
    // between polls on a different OS locale or ICU build.
    return new Map(
      [...byPid].map(([pid, projects]) => [
        pid,
        [...projects.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ])
    );
  };

  const handleGetProcessMetrics = (): ProcessMetricEntry[] => {
    try {
      const metrics = getAppMetricsSnapshot();
      const projectNamesByPid = collectProjectNamesByPid();
      return metrics
        .map((proc) => {
          const entry: ProcessMetricEntry = {
            pid: proc.pid,
            type: proc.type,
            name: proc.name ?? proc.type,
            memoryMB: Math.round(getProcessMemoryKb(proc) / 1024),
            cpuPercent: Math.round((proc.cpu?.percentCPUUsage ?? 0) * 10) / 10,
          };
          const names = proc.type === "Tab" ? projectNamesByPid.get(proc.pid) : undefined;
          if (names?.length) {
            entry.projectNames = names;
          }
          return entry;
        })
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
      // Sampling starts on the first read, so that read reports ~0; the
      // popover's next poll carries real samples.
      const histogram = acquireEventLoopHistogram();
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
      if (ctx.event ? ctx.event.sender.isDestroyed() : ctx.endpoint.isClosed()) return;
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

  // Renderer long-animation-frame report (the channel predates the LoAF
  // naming). webContents id is taken from event.sender.id.
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
      if (ctx.event ? ctx.event.sender.isDestroyed() : ctx.endpoint.isClosed()) return;
      const report: RendererLoafReport = {
        blockingDurationMs: payload.blockingDurationMs,
        sampleWindowMs: payload.sampleWindowMs,
      };
      const longestFrameMs = optionalDurationMs(payload.longestFrameMs);
      if (longestFrameMs !== undefined) report.longestFrameMs = longestFrameMs;
      const longestBlockingMs = optionalDurationMs(payload.longestBlockingMs);
      if (longestBlockingMs !== undefined) report.longestBlockingMs = longestBlockingMs;
      const inputBlocking = parseInputBlockingSnapshot(payload.inputBlocking);
      if (inputBlocking) report.inputBlocking = inputBlocking;
      recordEluSample(ctx.webContentsId, report);
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
    // Taken before collecting, so lines the logger has yet to flush are on
    // disk by the time the log files are read for the listing below.
    const collectedAtMs = Date.now();
    const { collectDiagnosticsWithKeys } = await getDiagnosticsCollector();
    const { payload, sectionKeys } = await collectDiagnosticsWithKeys(deps);
    const previewJson = safeStringify(payload, 2);
    const boundaries = {
      appLaunchTimestamp: APP_LAUNCH_TIMESTAMP,
      versionFirstRun: getVersionFirstRunBoundary(),
      oldestRetainedLogMs: await readOldestRetainedLogMs(getLogDirectory(), getLogFilePath()),
    };
    const { readBundleSources, buildBundleManifests } = await getDiagnosticsBundle();
    const sources = await readBundleSources(getBundleDirs());
    holdReviewSources(collectedAtMs, sources);
    const logMembers = buildBundleManifests(
      sources,
      getTimeWindowIds(boundaries).map((id) => ({
        id,
        startMs: computeTimeWindowStart(id, boundaries, collectedAtMs),
      })),
      collectedAtMs
    );
    return { payload, sectionKeys, previewJson, ...boundaries, collectedAtMs, logMembers };
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
    // Taken before the native dialog, which can stay open past the hold's expiry.
    const held =
      reviewSources !== null && reviewSources.collectedAtMs === savePayload.collectedAtMs
        ? reviewSources
        : null;

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

    const { readBundleSources, buildBundleMembers, writeBundleZip } = await getDiagnosticsBundle();
    // Without the review's own read (it expired, or a review in another view
    // replaced it), the files are read again and the ceiling still keeps out
    // anything dated after the review.
    const members = includeLogs
      ? buildBundleMembers(
          held?.sources ?? (await readBundleSources(getBundleDirs())),
          { startMs: timeWindowStartMs, endMs: savePayload.collectedAtMs ?? null },
          savePayload.replacements as ReplacementRule[]
        )
      : [];
    await writeBundleZip(filePath, json, members);
    if (held && reviewSources === held) releaseReviewSources();
    shell.showItemInFolder(filePath);
    return true;
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_SAVE_DIAGNOSTICS_BUNDLE, handleSaveDiagnosticsBundle));

  const handleRendererCpuProfileStart = async (
    ctx: IpcContext
  ): Promise<RendererCpuProfileStartResult> => {
    const wc = ctx.event?.sender;
    if (!wc || wc.isDestroyed()) {
      return { status: "failed", reason: "webcontents-destroyed" };
    }

    const existing = cpuProfileSessions.get(wc.id);
    if (existing) {
      // A finished-but-uncollected session (auto-stop fired while Settings was
      // closed, so no stop IPC ever arrived) must not block re-recording.
      if (!existing.starting && existing.timer === null && !existing.stopping) {
        if (existing.capture) {
          console.warn(
            `[diagnostics] Discarding uncollected renderer CPU profile for webContents ${wc.id}`
          );
        }
        cleanupCpuProfileSession(existing);
      } else {
        return { status: "failed", reason: "already-recording" };
      }
    }

    const session: RendererCpuProfileSession = {
      wc,
      webContentsId: wc.id,
      starting: true,
      timer: null,
      capture: null,
      stopping: false,
      discarded: false,
      detached: false,
      onDetach: () => {
        session.detached = true;
        // A detach mid-start frees the slot so a retry can record; the start
        // sees `discarded` and sends nothing more.
        if (session.starting) {
          cleanupCpuProfileSession(session);
          return;
        }
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
      onDestroyed: () => cleanupCpuProfileSession(session),
    };
    // Claimed before the first await: invoke handlers aren't serialised, and a
    // second start interleaving its commands on the shared debugger can disable
    // or orphan this one's recording.
    cpuProfileSessions.set(wc.id, session);
    wc.debugger.on("detach", session.onDetach);
    wc.once("destroyed", session.onDestroyed);

    let startError: unknown = null;
    try {
      ensureAttached(wc);
      const steps = [
        () => wc.debugger.sendCommand("Profiler.enable"),
        () =>
          wc.debugger.sendCommand("Profiler.setSamplingInterval", {
            interval: CPU_PROFILE_SAMPLING_INTERVAL_US,
          }),
        () => wc.debugger.sendCommand("Profiler.start"),
      ];
      for (const step of steps) {
        if (session.discarded) break;
        await step();
      }
    } catch (err) {
      startError = err;
    }

    // Discarded mid-start, the Profiler domain may already belong to a retry,
    // so nothing here may disable it.
    if (session.discarded) {
      return wc.isDestroyed()
        ? { status: "failed", reason: "webcontents-destroyed" }
        : {
            status: "failed",
            reason: "cdp-error",
            message: "The debugger detached while the profiler was starting",
          };
    }

    if (startError !== null) {
      // Don't leave the Profiler domain enabled after a partial start.
      try {
        if (!wc.isDestroyed()) {
          wc.debugger.sendCommand("Profiler.disable").catch(() => {});
        }
      } catch {
        // detached between failure and cleanup — nothing left to disable
      }
      cleanupCpuProfileSession(session);
      return {
        status: "failed",
        reason: "cdp-error",
        message: formatErrorMessage(startError, "CPU profiler failed to start"),
      };
    }

    session.starting = false;
    session.timer = setTimeout(() => {
      session.timer = null;
      beginCpuProfileCapture(session).catch(() => {});
    }, CPU_PROFILE_DURATION_MS);

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
    if (!session || session.starting) return { status: "failed", reason: "not-recording" };
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
      cleanupCpuProfileSession(session);
      return {
        status: "failed",
        reason: wasCpuProfileDebuggerDetached(session) ? "devtools-detached" : "capture-failed",
        message: formatErrorMessage(err, "Profiler stopped unexpectedly"),
      };
    }
    cleanupCpuProfileSession(session);

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
