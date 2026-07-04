import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { app, screen } from "electron";
import { sanitizePath } from "./TelemetryService.js";
import { logBuffer } from "./LogBuffer.js";
import type { PtyClient } from "./PtyClient.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import { store, windowStatesStore } from "../store.js";
import { isRunningUnderRosetta } from "../utils/rosettaDetection.js";
import { getFocusThrottlePollMultiplier, isFocusThrottled } from "../window/focusThrottleState.js";
import { getRendererTerminalDiagnosticsSamples } from "./RendererTerminalDiagnosticsCache.js";
import type { HandlerDependencies } from "../ipc/types.js";
import type {
  WhySlowFocusThrottleSnapshot,
  WhySlowPtySummary,
  WhySlowResourceSnapshot,
  WhySlowSnapshot,
  WhySlowWorkerSummary,
  WhySlowWorktreeSummary,
} from "../../shared/types/whySlow.js";

const execFileAsync = promisify(execFile);

const SECTION_TIMEOUT_MS = 5_000;
const GPU_TIMEOUT_MS = 2_000;
// Per-collector bound for the live why-slow pull; below SECTION_TIMEOUT_MS so it
// also resolves within the full-export section timeout.
const WHY_SLOW_ASYNC_TIMEOUT_MS = 4_000;
const MAX_DIAGNOSTIC_STRING_LENGTH = 16_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const SENSITIVE_KEY_PATTERN =
  /token|password|secret|apiKey|api_key|credential|authorization|private_key|passphrase/i;

function sanitizeString(value: string): string {
  return scrubSecrets(sanitizePath(value));
}

function redactDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = "<redacted>";
      } else {
        result[key] = redactDeep(val);
      }
    }
    return result;
  }

  return value;
}

// Reconstructs `process.report.getReport().header` with PII removed. Whitelist
// over spread: `networkInterfaces` carries real MAC/IP addresses not caught by
// any redaction pass, `host` is the system hostname, `cwd`/`filename` embed
// the username, and `commandLine` may contain secret flags.
function redactReportHeader(header: unknown): Record<string, unknown> | unknown {
  if (!header || typeof header !== "object") return header;
  const h = header as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  const passthroughKeys = [
    "reportVersion",
    "event",
    "trigger",
    "dumpEventTime",
    "dumpEventTimeStamp",
    "processId",
    "threadId",
    "nodejsVersion",
    "wordSize",
    "arch",
    "platform",
    "componentVersions",
    "release",
    "osName",
    "osRelease",
    "osVersion",
    "osMachine",
    "cpus",
    "glibcVersionRuntime",
    "glibcVersionCompiler",
  ];
  for (const key of passthroughKeys) {
    if (key in h) safe[key] = h[key];
  }
  safe.host = "<hostname>";
  if (typeof h.cwd === "string") safe.cwd = sanitizePath(h.cwd);
  if (typeof h.filename === "string") safe.filename = sanitizePath(h.filename);
  if (Array.isArray(h.commandLine)) {
    safe.commandLine = h.commandLine.map((entry) =>
      typeof entry === "string" ? sanitizeString(entry) : entry
    );
  } else if (typeof h.commandLine === "string") {
    safe.commandLine = sanitizeString(h.commandLine);
  }
  return safe;
}

function truncateDiagnosticString(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_STRING_LENGTH) {
    return value;
  }

  const truncatedLength = value.length - MAX_DIAGNOSTIC_STRING_LENGTH;
  return (
    value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH) +
    `… [truncated ${truncatedLength.toString()} chars]`
  );
}

function truncateDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateDiagnosticString(value);
  }

  if (Array.isArray(value)) {
    return value.map(truncateDeep);
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = truncateDeep(entry);
    }
    return result;
  }

  return value;
}

async function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = SECTION_TIMEOUT_MS
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: process.env,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function collectMetadata() {
  return {
    timestamp: new Date().toISOString(),
    collectorVersion: 1,
    appVersion: app.getVersion(),
    appName: app.getName(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    v8Version: process.versions.v8,
  };
}

async function collectRuntime() {
  return {
    platform: process.platform,
    arch: process.arch,
    runningUnderRosetta: isRunningUnderRosetta(),
    execPath: sanitizePath(app.getPath("exe")),
    appPath: sanitizePath(app.getAppPath()),
    userData: sanitizePath(app.getPath("userData")),
    logs: sanitizePath(app.getPath("logs")),
    temp: sanitizePath(app.getPath("temp")),
    pid: process.pid,
    uptime: process.uptime(),
    argv: process.argv.map(sanitizeString),
    env: {
      NODE_ENV: process.env.NODE_ENV ?? null,
      DAINTREE_DEBUG: process.env.DAINTREE_DEBUG ?? null,
      SHELL: process.env.SHELL ?? null,
      TERM: process.env.TERM ?? null,
      PATH: process.env.PATH ? sanitizePath(process.env.PATH) : null,
      HOME: process.env.HOME ? sanitizePath(process.env.HOME) : null,
      LANG: process.env.LANG ?? null,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ? true : false,
    },
  };
}

async function collectOs() {
  return {
    type: os.type(),
    platform: os.platform(),
    release: os.release(),
    version: os.version(),
    arch: os.arch(),
    hostname: "<hostname>",
    cpus: os.cpus().map((cpu) => ({
      model: cpu.model,
      speed: cpu.speed,
    })),
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    loadavg: os.loadavg(),
  };
}

async function collectDisplay() {
  try {
    const displays = screen.getAllDisplays();
    return displays.map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      rotation: d.rotation,
      internal: d.internal,
    }));
  } catch {
    return { error: "Failed to get display info" };
  }
}

async function collectGpu() {
  const result: Record<string, unknown> = {};

  try {
    const { isGpuDisabledByFlag, isGpuAngleFallbackByFlag, isGpuAngleFallbackApplied } =
      await import("./GpuCrashMonitorService.js");
    const { readGpuDisabledFlagData } = await import("./gpuDisabledFlag.js");
    const userDataPath = app.getPath("userData");
    result.hardwareAccelerationDisabled = isGpuDisabledByFlag(userDataPath);
    // Reason/version/timestamp distinguish a crash-fallback victim from a
    // deliberate Settings toggle in support exports (#10379).
    const disabledFlagData = readGpuDisabledFlagData(userDataPath);
    result.gpuDisabledReason = disabledFlagData?.reason ?? null;
    result.gpuDisabledFlagVersion = disabledFlagData?.version ?? null;
    result.gpuDisabledFlagTimestamp = disabledFlagData?.timestamp ?? null;
    // Both surfaced: `angleFallbackActive` reflects what the app is actually
    // running with (platform-gated, matches the renderer signal). The raw
    // flag is also reported so support can tell when a non-Linux-Wayland
    // user has tripped the crash listener even though ANGLE wasn't engaged.
    result.angleFallbackActive = isGpuAngleFallbackApplied(userDataPath);
    result.angleFallbackFlag = isGpuAngleFallbackByFlag(userDataPath);
  } catch {
    result.hardwareAccelerationDisabled = "unknown";
    result.angleFallbackActive = "unknown";
    result.angleFallbackFlag = "unknown";
    result.gpuDisabledReason = "unknown";
    result.gpuDisabledFlagVersion = "unknown";
    result.gpuDisabledFlagTimestamp = "unknown";
  }

  try {
    result.featureStatus = app.getGPUFeatureStatus();
  } catch {
    result.featureStatus = { error: "Failed to get GPU feature status" };
  }

  try {
    result.info = await withTimeout(app.getGPUInfo("basic") as Promise<unknown>, GPU_TIMEOUT_MS, {
      error: "GPU info timed out",
    });
  } catch {
    result.info = { error: "Failed to get GPU info" };
  }

  return result;
}

async function collectProcess() {
  const result: Record<string, unknown> = {};

  try {
    result.memoryUsage = process.memoryUsage();
  } catch {
    result.memoryUsage = { error: "Failed to get memory usage" };
  }

  try {
    result.cpuUsage = process.cpuUsage();
  } catch {
    result.cpuUsage = { error: "Failed to get CPU usage" };
  }

  try {
    result.appMetrics = app.getAppMetrics();
  } catch {
    result.appMetrics = { error: "Failed to get app metrics" };
  }

  try {
    const report = process.report?.getReport?.();
    if (report && typeof report === "object") {
      const r = report as Record<string, unknown>;
      result.nodeReport = {
        header: redactReportHeader(r.header),
        resourceUsage: r.resourceUsage,
        libuv: r.libuv,
        environmentVariables: "<redacted>",
      };
    }
  } catch {
    result.nodeReport = { error: "Failed to get process report" };
  }

  return result;
}

async function collectTools() {
  const tools = ["git", "node", "npm", "npx", "gh"];
  const checkCmd = process.platform === "win32" ? "where" : "which";

  const results = await Promise.allSettled(
    tools.map(async (tool) => {
      const path = await runCommand(checkCmd, [tool], 3000);
      if (!path) return { tool, available: false, path: null, version: null };

      const version = await runCommand(tool, ["--version"], 3000);
      return {
        tool,
        available: true,
        path: path ? sanitizePath(path) : null,
        version: version
          ? tool === "git"
            ? version.replace(/^git version\s+/, "")
            : version.replace(/^v/, "")
          : null,
      };
    })
  );

  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { tool: "unknown", available: false, error: String(r.reason) }
  );
}

async function collectGit() {
  const result: Record<string, unknown> = {};

  const configOutput = await runCommand("git", ["config", "--list", "--show-origin"]);
  if (configOutput) {
    const lines = configOutput.split("\n").filter(Boolean);
    const safeConfig: string[] = [];
    for (const line of lines) {
      if (SENSITIVE_KEY_PATTERN.test(line)) {
        const eqIdx = line.indexOf("=");
        if (eqIdx !== -1) {
          safeConfig.push(line.slice(0, eqIdx + 1) + "<redacted>");
        } else {
          safeConfig.push("<redacted>");
        }
      } else {
        safeConfig.push(sanitizePath(line));
      }
    }
    result.config = safeConfig;
  } else {
    result.config = { error: "Failed to get git config" };
  }

  const remoteOutput = await runCommand("git", ["remote", "-v"]);
  if (remoteOutput) {
    result.remotes = remoteOutput
      .split("\n")
      .filter(Boolean)
      .map((line) => sanitizeString(line));
  }

  const versionOutput = await runCommand("git", ["--version"]);
  result.version = versionOutput;

  return result;
}

const SAFE_STORE_KEYS = [
  "appState",
  "hibernation",
  "terminalConfig",
  "keybindingOverrides",
  "worktreeConfig",
  "notificationSettings",
  "onboarding",
  "voiceInput",
  "appTheme",
  "crashRecovery",
] as const;

async function collectStoreConfig() {
  try {
    const result: Record<string, unknown> = {};
    for (const key of SAFE_STORE_KEYS) {
      try {
        result[key] = store.get(key);
      } catch {
        result[key] = { error: `Failed to read ${key}` };
      }
    }
    try {
      result.windowStates = windowStatesStore.get("windowStates");
    } catch {
      result.windowStates = { error: "Failed to read window states" };
    }
    return redactDeep(result);
  } catch {
    return { error: "Failed to read store config" };
  }
}

async function collectTerminals(ptyClient?: PtyClient) {
  try {
    if (!ptyClient) return [];
    const terminals = await ptyClient.getAllTerminalsAsync();
    return terminals.map((t) => ({
      id: t.id,
      kind: t.kind,
      agentState: t.agentState,
      cwd: t.cwd ? sanitizePath(t.cwd) : null,
      isExited: t.hasPty === false,
    }));
  } catch {
    return { error: "Failed to get terminal info" };
  }
}

async function collectFlowControl(ptyClient?: PtyClient) {
  try {
    if (!ptyClient) return { error: "PtyClient not available" };
    return await ptyClient.getFlowControlSnapshotAsync();
  } catch {
    return { error: "Failed to get flow-control snapshot" };
  }
}

async function collectLogs() {
  try {
    const entries = logBuffer.getAll();
    const recent = entries.slice(-100);
    return {
      totalEntries: entries.length,
      recentEntries: recent.map((e) => ({
        ...e,
        message: truncateDiagnosticString(sanitizeString(e.message)),
        context: e.context ? truncateDeep(redactDeep(e.context)) : undefined,
      })),
    };
  } catch {
    return { error: "Failed to get logs" };
  }
}

async function collectEvents(deps: HandlerDependencies) {
  try {
    if (!deps.eventBuffer) {
      return { error: "Event buffer not available" };
    }
    const events = deps.eventBuffer.getAll();
    const recent = events.slice(-100);
    return {
      totalEvents: events.length,
      recentEvents: recent.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        category: e.category,
        source: e.source,
      })),
    };
  } catch {
    return { error: "Failed to get events" };
  }
}

// Gather every window's ProjectViewManager: the per-window `deps.projectViewManager`
// only covers the requesting window, so fan out across `windowRegistry.all()` to
// capture all open projects (lesson #8607). Falls back to the single PVM when no
// registry is wired (older call paths / tests).
function collectProjectViewManagers(
  deps: HandlerDependencies
): Array<{ windowId: number | null; pvm: ProjectViewManager }> {
  const managers: Array<{ windowId: number | null; pvm: ProjectViewManager }> = [];
  for (const ctx of deps.windowRegistry?.all() ?? []) {
    const pvm = ctx.services.projectViewManager;
    if (pvm) managers.push({ windowId: ctx.windowId, pvm });
  }
  if (managers.length === 0 && deps.projectViewManager) {
    managers.push({ windowId: null, pvm: deps.projectViewManager });
  }
  return managers;
}

// Per-window project→renderer inventory: which projects have views, their
// webContentsId (the join key to the Blink/ELU renderer samples), lifecycle
// state, and cache policy. projectPath is sanitized by the final redactDeep pass.
async function collectProjectViews(deps: HandlerDependencies) {
  try {
    // Per-window try/catch: a PVM mid-teardown in one window must not erase
    // every other window's inventory.
    return collectProjectViewManagers(deps).map(({ windowId, pvm }) => {
      try {
        const cache = pvm.getCacheConfig();
        return {
          windowId,
          maxCachedViews: cache.maxCachedViews,
          activeProjectId: cache.activeProjectId,
          views: pvm.getViewInventory(),
        };
      } catch {
        return { windowId, error: "Failed to read project views for window" };
      }
    });
  } catch {
    return { error: "Failed to collect project views" };
  }
}

// Per-renderer Blink heap and event-loop-utilization samples, keyed by
// webContentsId. Already-collected module-level maps — no new sampling loop.
// Cross-reference webContentsId with `projectViews` to attribute to a project.
async function collectRendererMemory() {
  try {
    const { getBlinkSamples, getEluSamples } = await import("./ProcessMemoryMonitor.js");
    const blink = Array.from(getBlinkSamples().entries()).map(([webContentsId, s]) => ({
      webContentsId,
      // Electron's BlinkMemoryInfo reports KB, not bytes.
      allocatedKb: s.allocated,
      totalKb: s.total,
      timestamp: s.timestamp,
    }));
    const elu = Array.from(getEluSamples().entries()).map(([webContentsId, s]) => ({
      webContentsId,
      blockingDurationMs: Math.round(s.blockingDurationMs),
      sampleWindowMs: s.sampleWindowMs,
      ratio: Math.round(s.ratio * 100) / 100,
      timestamp: s.timestamp,
    }));
    return { blink, elu };
  } catch {
    return { error: "Failed to collect renderer memory" };
  }
}

// Bounded rolling main/utility memory trend — the EMA history the monitor
// already maintains, capped at BUCKET_WINDOW entries per pid. PID-keyed:
// Electron's ProcessMetric carries no webContentsId, so trends can't be joined
// to a renderer directly.
async function collectMemoryTrends() {
  try {
    const { getTrendSnapshot } = await import("./ProcessMemoryMonitor.js");
    return { processes: getTrendSnapshot() };
  } catch {
    return { error: "Failed to collect memory trends" };
  }
}

// Hibernation + resource-profile runtime state. Both are global singletons
// reached via their own getters — not threaded through HandlerDependencies.
async function collectResourceState() {
  const result: Record<string, unknown> = {};
  try {
    const { getHibernationService } = await import("./HibernationService.js");
    result.hibernation = getHibernationService().getSnapshot();
  } catch {
    result.hibernation = { error: "Failed to get hibernation state" };
  }
  try {
    const { getResourceProfileService } = await import("../window/serviceRefs.js");
    const svc = getResourceProfileService();
    result.resourceProfile = svc ? svc.getSnapshot() : null;
  } catch {
    result.resourceProfile = { error: "Failed to get resource profile" };
  }
  return result;
}

// Top-level summary counts: open projects and views (by lifecycle state) across
// all windows, plus terminals grouped by agentState. Derived from the same PVM
// inventory and PtyClient the other sections use.
async function collectCounts(deps: HandlerDependencies) {
  const result: Record<string, unknown> = {};
  try {
    const contexts = deps.windowRegistry?.all() ?? [];
    let total = 0;
    let active = 0;
    let cached = 0;
    let loading = 0;
    const projectIds = new Set<string>();
    for (const { pvm } of collectProjectViewManagers(deps)) {
      // Skip a PVM that throws mid-read rather than zeroing every window's count.
      let inventory: ReturnType<ProjectViewManager["getViewInventory"]>;
      try {
        inventory = pvm.getViewInventory();
      } catch {
        continue;
      }
      for (const v of inventory) {
        total++;
        projectIds.add(v.projectId);
        if (v.state === "active") active++;
        else if (v.state === "cached") cached++;
        else loading++;
      }
    }
    result.windows = contexts.length;
    result.openProjects = projectIds.size;
    result.views = { total, active, cached, loading };
  } catch {
    result.views = { error: "Failed to count views" };
  }

  try {
    if (deps.ptyClient) {
      const terminals = await deps.ptyClient.getAllTerminalsAsync();
      const byAgentState: Record<string, number> = {};
      for (const t of terminals) {
        const key = t.agentState ?? "none";
        byAgentState[key] = (byAgentState[key] ?? 0) + 1;
      }
      result.terminals = { total: terminals.length, byAgentState };
    } else {
      result.terminals = { total: 0, byAgentState: {} };
    }
  } catch {
    result.terminals = { error: "Failed to count terminals" };
  }

  return result;
}

// ── "Why am I slow?" snapshot (#10910) ──
// One at-a-glance view of the app's self-throttling governance state. Each
// section degrades to null on failure rather than failing the whole snapshot;
// the renderer-terminal section reads a passively-maintained push cache (never a
// live renderer pull, which would hang under the very slowdown this diagnoses).

async function collectWhySlowResource(): Promise<WhySlowResourceSnapshot | null> {
  try {
    const { getResourceProfileService } = await import("../window/serviceRefs.js");
    const svc = getResourceProfileService();
    return svc ? svc.getWhySlowResourceSnapshot() : null;
  } catch {
    return null;
  }
}

function collectWhySlowFocusThrottle(): WhySlowFocusThrottleSnapshot {
  try {
    return { throttled: isFocusThrottled(), pollMultiplier: getFocusThrottlePollMultiplier() };
  } catch {
    return { throttled: false, pollMultiplier: 1 };
  }
}

function collectWhySlowRendererTerminals() {
  try {
    return getRendererTerminalDiagnosticsSamples();
  } catch {
    return [];
  }
}

async function collectWhySlowPty(ptyClient?: PtyClient): Promise<WhySlowPtySummary | null> {
  try {
    if (!ptyClient) return null;
    const snapshot = await ptyClient.getFlowControlSnapshotAsync();
    let pausedCount = 0;
    let suspendedCount = 0;
    let maxPausedDurationMs = 0;
    for (const t of snapshot.terminals) {
      if (t.pausedDurationMs !== null) {
        pausedCount++;
        if (t.pausedDurationMs > maxPausedDurationMs) maxPausedDurationMs = t.pausedDurationMs;
      }
      if (t.isSuspended) suspendedCount++;
    }
    return {
      totalPendingBytes: snapshot.totalPendingBytes,
      terminalCount: snapshot.terminals.length,
      pausedCount,
      suspendedCount,
      maxPausedDurationMs,
      eventLoopP99Ms: snapshot.eventLoop?.p99Ms ?? null,
      eventLoopMaxMs: snapshot.eventLoop?.maxMs ?? null,
      eventLoopUtilization: snapshot.eventLoop?.utilization ?? null,
    };
  } catch {
    return null;
  }
}

// Bounded persistent-worker resource report: analysis pool slots, DB worker,
// copytree workers, plugin workers, and the utility hosts themselves. Provider
// isolation and time-boxing live inside the service; this wrapper only guards
// the import/singleton path.
async function collectWorkerGovernance() {
  try {
    const { getWorkerGovernanceService } = await import("./WorkerGovernanceService.js");
    return await getWorkerGovernanceService().collectReport();
  } catch {
    return { error: "Failed to collect worker governance report" };
  }
}

async function collectWhySlowWorkers(): Promise<WhySlowWorkerSummary | null> {
  try {
    const { getWorkerGovernanceService } = await import("./WorkerGovernanceService.js");
    const service = getWorkerGovernanceService();
    return service.summarize(await service.collectReport());
  } catch {
    return null;
  }
}

async function collectWhySlowWorktrees(): Promise<WhySlowWorktreeSummary | null> {
  try {
    const { getWorkspaceClientRef } = await import("../window/serviceRefs.js");
    const client = getWorkspaceClientRef();
    if (!client) return null;
    // Derive counts from the existing all-states fan-out rather than adding a
    // dedicated workspace-host round-trip: monitors that emit no state are the
    // rare edge here and acceptable for a diagnostics count.
    const states = await client.getAllStatesAsync();
    return {
      monitorCount: states.length,
      fetchInFlightCount: states.filter((s) => s.isFetchInFlight).length,
    };
  } catch {
    return null;
  }
}

/**
 * Assemble the "why am I slow?" snapshot (#10910): resource profile + reasons,
 * event-loop-lag latch, focus throttle, terminal WebGL/tier state (from the
 * renderer push cache), PTY flow-control summary, and worktree monitor load.
 * Backing both the diagnostics `whySlow` section and the live dock IPC pull.
 */
export async function collectWhySlowSnapshot(deps: HandlerDependencies): Promise<WhySlowSnapshot> {
  // Bound the cross-process awaits: the full diagnostics export wraps each
  // section in withTimeout, but the live dock pull calls this directly. A hung
  // pty-host or workspace-host must not wedge the very snapshot meant to explain
  // a slowdown — degrade the stuck section to null instead.
  const [resource, pty, worktrees, workers] = await Promise.all([
    withTimeout(collectWhySlowResource(), WHY_SLOW_ASYNC_TIMEOUT_MS, null),
    withTimeout(collectWhySlowPty(deps.ptyClient), WHY_SLOW_ASYNC_TIMEOUT_MS, null),
    withTimeout(collectWhySlowWorktrees(), WHY_SLOW_ASYNC_TIMEOUT_MS, null),
    withTimeout(collectWhySlowWorkers(), WHY_SLOW_ASYNC_TIMEOUT_MS, null),
  ]);
  return {
    timestamp: Date.now(),
    resource,
    focusThrottle: collectWhySlowFocusThrottle(),
    rendererTerminals: collectWhySlowRendererTerminals(),
    pty,
    worktrees,
    workers,
  };
}

export async function collectDiagnostics(deps: HandlerDependencies): Promise<unknown> {
  const { payload } = await collectDiagnosticsWithKeys(deps);
  return payload;
}

export async function collectDiagnosticsWithKeys(
  deps: HandlerDependencies
): Promise<{ payload: Record<string, unknown>; sectionKeys: string[] }> {
  const sections = [
    { key: "metadata", fn: collectMetadata },
    { key: "runtime", fn: collectRuntime },
    { key: "os", fn: collectOs },
    { key: "display", fn: collectDisplay },
    { key: "gpu", fn: collectGpu },
    { key: "process", fn: collectProcess },
    { key: "tools", fn: collectTools },
    { key: "git", fn: collectGit },
    { key: "config", fn: collectStoreConfig },
    { key: "terminals", fn: () => collectTerminals(deps.ptyClient) },
    { key: "flowControl", fn: () => collectFlowControl(deps.ptyClient) },
    { key: "projectViews", fn: () => collectProjectViews(deps) },
    { key: "rendererMemory", fn: collectRendererMemory },
    { key: "memoryTrends", fn: collectMemoryTrends },
    { key: "resourceState", fn: collectResourceState },
    { key: "workerGovernance", fn: collectWorkerGovernance },
    { key: "whySlow", fn: () => collectWhySlowSnapshot(deps) },
    { key: "counts", fn: () => collectCounts(deps) },
    { key: "logs", fn: collectLogs },
    { key: "events", fn: () => collectEvents(deps) },
  ];

  const results = await Promise.allSettled(
    sections.map(async (section) => ({
      key: section.key,
      value: await withTimeout(
        section.fn(),
        section.key === "gpu" ? GPU_TIMEOUT_MS : SECTION_TIMEOUT_MS,
        { error: "timed out" }
      ),
    }))
  );

  const payload: Record<string, unknown> = {};
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const key = sections[i].key;
    if (result.status === "fulfilled") {
      payload[result.value.key] = result.value.value;
    } else {
      payload[key] = { error: String(result.reason) };
    }
  }

  return {
    payload: redactDeep(payload) as Record<string, unknown>,
    sectionKeys: sections.map((s) => s.key),
  };
}
