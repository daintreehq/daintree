/**
 * Idle harness (#12521) — what the whole Daintree process tree costs while the
 * user does nothing, measured over minutes with GPU compositing on.
 *
 * The freeze harness's idle leg reads one renderer's CPU for ten seconds with
 * the GPU off. That misses almost everything that drains a laptop: the
 * compositor, periodic work on 30 s / 60 s / 180 s cadences, the pty-host's
 * `ps` forks (charged to short-lived children, not to Daintree), fleet-size
 * scaling, and wakeups. This harness boots the real app, builds a fixture of
 * projects and terminals through the production paths — the project-switch IPC
 * and saved-state hydration — then brackets a quiet window with two samples of
 * every process in the tree (`scripts/idle-harness-sampler.c`) and reports
 * where the CPU and wakeups went.
 *
 * It reports; it does not judge. There are no thresholds: the issue asks for
 * baselines from repeated real-hardware runs first. The run fails only when
 * the fixture did not materialise as requested or a measurement was unusable,
 * because a number from the wrong fixture is worse than no number.
 *
 * Nothing polls during the window. Observers are passive event listeners, and
 * every IPC round-trip, renderer script and inventory read happens before the
 * opening sample or after the closing one.
 */

import { app, BrowserWindow, powerMonitor, screen, type WebContentsView } from "electron";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import { hasActiveAgent } from "../window/ProjectViewAgentStateCache.js";
import { getDeferredQueueState } from "../window/deferredInitQueue.js";
import {
  getPtyClient,
  getResourceProfileService,
  getWorkspaceClientRef,
} from "../window/serviceRefs.js";
import { refreshAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import {
  isSpawnCensusInstalled,
  runUncounted,
  SPAWN_CENSUS_DIR_ENV,
} from "../utils/spawnCensus.js";
import { getRendererTerminalDiagnosticsSamples } from "./RendererTerminalDiagnosticsCache.js";
import { projectStore } from "./ProjectStore.js";
import { events } from "./events.js";
import { store } from "../store.js";
import { computeDefaultCachedViews } from "../utils/cachedProjectViews.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { ProjectState } from "../../shared/types/project.js";
import type { PtyClient } from "./PtyClient.js";
import type { ResourceProfileService } from "./ResourceProfileService.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import {
  checkMaterialised,
  checkRendererContinuity,
  checkWindowEvents,
  checkWindowTiming,
  censusCoverage,
  computeTreeUsage,
  cpuPercent,
  IDLE_HARNESS_CONFIG_ENV,
  parseDaemonCpu,
  parseIdleHarnessConfig,
  parseSamplerOutput,
  sliceSpawnCensus,
  type CellObservation,
  type CensusFileLike,
  type DaemonCpuReading,
  type EndpointLabels,
  type IdleHarnessConfig,
  type SamplerSnapshot,
  type TreeUsage,
} from "./idleHarnessMeasurement.js";

const execFileAsync = promisify(execFile);

export const IDLE_HARNESS_LOG_PREFIX = "[IDLE-HARNESS]";
export const IDLE_HARNESS_RESULT_SCHEMA = 1;

const READY_TIMEOUT_MS = 90_000;
const SWITCH_TIMEOUT_MS = 60_000;
const TERMINALS_TIMEOUT_MS = 90_000;
const AGENT_STATE_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
const RENDERER_SCRIPT_TIMEOUT_MS = 5_000;
const FOCUS_SETTLE_MS = 2_000;
/** Bounds each window-edge command; an edge that drifts further fails the run anyway. */
const EDGE_COMMAND_TIMEOUT_MS = 5_000;
/** One census flush interval plus slack, so the closing second is on disk. */
const CENSUS_DRAIN_MS = 6_500;
const CLEANUP_KILL_TIMEOUT_MS = 10_000;
const DAEMONS = ["sysmond", "fseventsd"] as const;
/** In-app processes that install the spawn census; one alive all window must have a file. */
const CENSUS_ROLES = new Set(["main", "pty-host", "workspace-host"]);
/** Deterministic shell: the user's rc files (prompt daemons, plugins) are not app cost. */
const FIXTURE_SHELL = "/bin/sh";

/**
 * Fixed-rate output with no per-line fork — ten 80-byte lines a second, about
 * what an agent's status line and log output produce. Runs under Electron's own
 * Node so it does not depend on `node` being on PATH.
 */
const STREAM_WORKLOAD_JS =
  'let n=0;setInterval(()=>{process.stdout.write("idle-harness stream "+String(n++).padStart(8,"0")+" "+"x".repeat(50)+"\\n")},100)';

function log(message: string, ...args: unknown[]): void {
  // console.error, not console.log: production builds strip console.log.
  console.error(`${IDLE_HARNESS_LOG_PREFIX} ${message}`, ...args);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref();
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor<T>(
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number,
  what: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await delay(POLL_MS);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function round(value: number, digits = 2): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

interface FixtureProject {
  index: number;
  id: string;
  path: string;
  terminals: number;
}

interface FixtureTerminal {
  id: string;
  projectIndex: number;
  spawnedAt: number;
  shellPid: number | null;
  role: "shell" | "stream" | "agent";
}

interface Observations {
  profileTransitions: Array<{ atMs: number; from: string; to: string }>;
  workspaceHostRestarts: Array<{ atMs: number }>;
  workspaceHostCrashes: Array<{ atMs: number; code: unknown }>;
  ptyHostCrashes: Array<{ atMs: number }>;
  terminalExits: Array<{ atMs: number; id: string }>;
  agentStateChanges: Array<{ atMs: number; terminalId: string; state: string }>;
  focusChanges: Array<{ atMs: number; event: "focus" | "blur" }>;
  processesGone: Array<{ atMs: number; type: string; reason: string }>;
}

function inWindow<T extends { atMs: number }>(list: T[], startMs: number, endMs: number): T[] {
  return list.filter((entry) => entry.atMs >= startMs && entry.atMs < endMs);
}

async function createFixtureRepo(root: string, name: string): Promise<string> {
  const repoPath = path.join(root, name);
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), `# ${name}\n`, "utf8");
  await execFileAsync("git", ["init"], { cwd: repoPath });
  return repoPath;
}

function projectState(project: FixtureProject): ProjectState {
  const terminals = Array.from({ length: project.terminals }, (_, n) => ({
    id: `idle-harness-p${project.index + 1}-t${String(n + 1).padStart(2, "0")}`,
    kind: "terminal" as const,
    title: `Idle ${project.index + 1}.${n + 1}`,
    titleMode: "user" as const,
    cwd: project.path,
    worktreeId: project.path,
    location: "grid" as const,
  }));
  return {
    projectId: project.id,
    activeWorktreeId: project.path,
    sidebarWidth: 350,
    terminals,
    tabGroups: [],
    terminalSizes: Object.fromEntries(terminals.map((t) => [t.id, { cols: 80, rows: 24 }])),
  };
}

/** The view the window is showing, falling back to the unbound welcome view. */
function visibleWebContents(
  pvm: ProjectViewManager,
  appView: WebContentsView
): Electron.WebContents {
  return (pvm.getActiveView() ?? appView).webContents;
}

/**
 * Switch through the renderer's own bridge, which runs the full production
 * switch: workspace-host load, PTY routing, persistence. Fire and forget — the
 * outgoing renderer may be frozen before the promise resolves, so completion is
 * read from main-side state instead, and a rejection is parked on the outgoing
 * page for the timeout message. "Active and loaded" only proves the skeleton
 * painted; the view's own hydration signal proves its panels were restored.
 */
async function switchToProject(
  pvm: ProjectViewManager,
  appView: WebContentsView,
  project: FixtureProject
): Promise<void> {
  const wc = visibleWebContents(pvm, appView);
  await waitFor(
    async () =>
      !wc.isDestroyed() &&
      !wc.isLoading() &&
      (await withTimeout(
        wc.executeJavaScript(
          "typeof window.electron?.project?.switch === 'function'"
        ) as Promise<boolean>,
        RENDERER_SCRIPT_TIMEOUT_MS,
        "bridge probe timed out"
      ).catch(() => false)),
    SWITCH_TIMEOUT_MS,
    "the project-switch bridge"
  );
  await wc.executeJavaScript(
    `void window.electron.project.switch(${JSON.stringify(project.id)}).catch((error) => {
       window.__daintreeIdleSwitchError = String(error?.message ?? error);
     }); true`
  );
  const entry = await waitFor(
    () => {
      if (pvm.getActiveProjectId() !== project.id) return null;
      const view = pvm.getAllViews().find((candidate) => candidate.projectId === project.id);
      return view?.state === "active" &&
        !view.view.webContents.isDestroyed() &&
        !view.view.webContents.isLoading()
        ? view
        : null;
    },
    SWITCH_TIMEOUT_MS,
    `project ${project.index + 1} to become active`
  ).catch(async (error: unknown) => {
    const reason = wc.isDestroyed()
      ? null
      : await withTimeout(
          wc.executeJavaScript("window.__daintreeIdleSwitchError ?? null") as Promise<
            string | null
          >,
          RENDERER_SCRIPT_TIMEOUT_MS,
          "no answer"
        ).catch(() => null);
    throw reason ? new Error(`project switch rejected: ${reason}`) : error;
  });
  const hydration = await pvm.waitForViewHydrated(entry.view.webContents.id, {
    timeoutMs: SWITCH_TIMEOUT_MS,
  });
  // "hydrated" means hydration ran — the renderer reports from a `finally` —
  // and teardown settles the same way, so the view must still be this one.
  const current = pvm.getAllViews().find((view) => view.projectId === project.id);
  if (hydration !== "hydrated" || current !== entry || entry.view.webContents.isDestroyed()) {
    throw new Error(`project ${project.index + 1}'s view never finished hydrating (${hydration})`);
  }
}

async function liveTerminalsByProject(
  pty: PtyClient,
  projects: readonly FixtureProject[]
): Promise<{
  counts: number[];
  degraded: boolean;
  byProject: Map<
    string,
    Array<{ id: string; spawnedAt: number; lastOutputTime?: number; agentState?: string }>
  >;
}> {
  const inventory = await pty.getAllTerminalsWithCompletenessAsync();
  const byProject = new Map<
    string,
    Array<{ id: string; spawnedAt: number; lastOutputTime?: number; agentState?: string }>
  >();
  for (const terminal of inventory.terminals) {
    if (!terminal.projectId || terminal.hasPty === false || terminal.isTrashed) continue;
    const list = byProject.get(terminal.projectId) ?? [];
    list.push({
      id: terminal.id,
      spawnedAt: terminal.spawnedAt,
      lastOutputTime: terminal.lastOutputTime,
      agentState: terminal.agentState,
    });
    byProject.set(terminal.projectId, list);
  }
  for (const list of byProject.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return {
    counts: projects.map((project) => byProject.get(project.id)?.length ?? 0),
    degraded: inventory.degraded,
    byProject,
  };
}

async function runSampler(
  samplerPath: string
): Promise<{ snapshot: SamplerSnapshot; pid: number }> {
  return new Promise((resolve, reject) => {
    // Uncounted: the harness's own forks are not idle cost.
    const child = runUncounted(() =>
      execFile(
        samplerPath,
        [],
        { maxBuffer: 16 * 1024 * 1024, timeout: EDGE_COMMAND_TIMEOUT_MS },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            resolve({ snapshot: parseSamplerOutput(stdout), pid: child.pid ?? 0 });
          } catch (parseError) {
            reject(parseError);
          }
        }
      )
    );
  });
}

async function readDaemons(): Promise<{
  atMs: number;
  readings: Record<string, DaemonCpuReading>;
}> {
  const { stdout } = await runUncounted(() =>
    execFileAsync("ps", ["-axo", "pid=,time=,comm="], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: EDGE_COMMAND_TIMEOUT_MS,
    })
  );
  return { atMs: Date.now(), readings: parseDaemonCpu(stdout, DAEMONS) };
}

function utilityLabel(metric: Electron.ProcessMetric): string {
  const service = metric.serviceName ?? metric.name ?? "unknown";
  if (service.startsWith("daintree-pty-host")) return "pty-host";
  if (service.startsWith("daintree-workspace-host")) return "workspace-host";
  return `utility:${service.split(":")[0]}`;
}

/**
 * Role labels, not project ids or pids, so repeated runs aggregate by what a
 * process is. Unlabelled descendants inherit their nearest ancestor's label.
 */
function collectLabels(
  pvm: ProjectViewManager,
  projects: readonly FixtureProject[],
  terminals: readonly FixtureTerminal[],
  protectedProjectIndex: number | null,
  labels: Map<number, string>
): void {
  labels.set(process.pid, "main");
  // Fresh, not the shared cache: a host born seconds before an edge must carry
  // its role, or it escapes the census coverage check as an anonymous child.
  for (const metric of refreshAppMetricsSnapshot()) {
    if (metric.type === "GPU") labels.set(metric.pid, "gpu");
    else if (metric.type === "Utility") labels.set(metric.pid, utilityLabel(metric));
    else if (metric.type === "Tab" && !labels.has(metric.pid))
      labels.set(metric.pid, "renderer:other");
    else if (metric.type !== "Browser" && metric.type !== "Tab") {
      labels.set(metric.pid, `chromium:${metric.type.toLowerCase()}`);
    }
  }
  for (const project of projects) {
    const entry = pvm.getAllViews().find((view) => view.projectId === project.id);
    if (!entry || entry.view.webContents.isDestroyed()) continue;
    const role =
      project.index === 0
        ? "renderer:active"
        : project.index === protectedProjectIndex
          ? "renderer:protected"
          : "renderer:cached";
    labels.set(entry.view.webContents.getOSProcessId(), role);
  }
  for (const terminal of terminals) {
    if (terminal.shellPid) labels.set(terminal.shellPid, `terminal:${terminal.role}`);
  }
}

function observeCell(
  config: IdleHarnessConfig,
  pvm: ProjectViewManager,
  projects: readonly FixtureProject[],
  live: { counts: number[]; degraded: boolean },
  win: BrowserWindow,
  documentHasFocus: boolean | null,
  streamWorkloadAlive: boolean | null
): CellObservation {
  return {
    views: projects.map((project) => {
      const entry = pvm.getAllViews().find((view) => view.projectId === project.id);
      const wc = entry?.view.webContents;
      return {
        state: entry?.state ?? null,
        rendererPid: wc && !wc.isDestroyed() ? wc.getOSProcessId() || null : null,
      };
    }),
    liveTerminals: live.counts,
    inventoryDegraded: live.degraded,
    windowCount: BrowserWindow.getAllWindows().length,
    windowVisible: win.isVisible(),
    windowMinimized: win.isMinimized(),
    windowFocused: win.isFocused(),
    documentHasFocus,
    protectedAgentActive:
      config.protectedProjectIndex === null
        ? null
        : hasActiveAgent(pvm, projects[config.protectedProjectIndex]!.id),
    streamWorkloadAlive,
  };
}

async function readDocumentFocus(pvm: ProjectViewManager): Promise<boolean | null> {
  const view = pvm.getActiveView();
  if (!view || view.webContents.isDestroyed()) return null;
  return withTimeout(
    view.webContents.executeJavaScript("document.hasFocus()") as Promise<boolean>,
    RENDERER_SCRIPT_TIMEOUT_MS,
    "focus probe timed out"
  ).catch(() => null);
}

async function readCensus(dir: string): Promise<CensusFileLike[]> {
  const files: CensusFileLike[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, name), "utf8")) as CensusFileLike;
      if (
        parsed &&
        typeof parsed.role === "string" &&
        typeof parsed.pid === "number" &&
        typeof parsed.startedAtMs === "number" &&
        parsed.buckets
      ) {
        files.push(parsed);
      }
    } catch {
      // A torn or foreign file is reported as missing coverage below.
    }
  }
  return files;
}

function streamWorkloadRunning(
  snapshot: SamplerSnapshot,
  terminals: readonly FixtureTerminal[]
): boolean | null {
  const stream = terminals.find((terminal) => terminal.role === "stream");
  if (!stream) return null;
  if (!stream.shellPid) return false;
  for (const sample of snapshot.processes.values()) {
    if (sample.ppid === stream.shellPid) return true;
  }
  return false;
}

function summariseUsage(usage: TreeUsage) {
  const seconds = usage.elapsedMs / 1000;
  const perSecond = (count: number) => round(count / seconds, 1);
  return {
    elapsedMs: round(usage.elapsedMs, 0),
    cpuPercent: round(cpuPercent(usage.totalCpuNs, usage.elapsedMs), 3),
    idleWakeupsPerSec: perSecond(usage.totalIdleWakeups),
    interruptWakeupsPerSec: perSecond(usage.totalInterruptWakeups),
    byLabel: Object.fromEntries(
      Object.entries(usage.byLabel)
        .sort(([, a], [, b]) => b.cpuNs - a.cpuNs)
        .map(([label, value]) => [
          label,
          {
            processes: value.processes,
            cpuPercent: round(cpuPercent(value.cpuNs, usage.elapsedMs), 3),
            idleWakeupsPerSec: perSecond(value.idleWakeups),
            interruptWakeupsPerSec: perSecond(value.interruptWakeups),
          },
        ])
    ),
    processes: usage.processes.map((p) => ({
      pid: p.pid,
      name: p.name,
      label: p.label,
      born: p.born,
      cpuPercent: round(cpuPercent(p.cpuNs, usage.elapsedMs), 3),
      reapedChildCpuPercent: round(cpuPercent(p.reapedChildCpuNs, usage.elapsedMs), 3),
      idleWakeupsPerSec: perSecond(p.idleWakeups),
      interruptWakeupsPerSec: perSecond(p.interruptWakeups),
      reapedChildIdleWakeupsPerSec: perSecond(p.reapedChildIdleWakeups),
    })),
    departed: usage.departed,
    unattributedMs: round(usage.unattributedNs / 1e6, 1),
    uncertainMs: round(usage.uncertainNs / 1e6, 1),
  };
}

function environmentReport(win: BrowserWindow) {
  const bounds = win.getBounds();
  let scaleFactor: number | null = null;
  try {
    scaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
  } catch {
    // Report without it.
  }
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    totalMemGb: round(os.totalmem() / 1024 ** 3, 1),
    onBattery: powerMonitor.isOnBatteryPower(),
    thermalState: powerMonitor.getCurrentThermalState(),
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    windowBounds: bounds,
    displayScaleFactor: scaleFactor,
    defaultCachedViews: computeDefaultCachedViews(os.totalmem()),
  };
}

interface HarnessServices {
  pty: PtyClient;
  workspace: WorkspaceClient;
  profiles: ResourceProfileService;
}

async function waitForApp(): Promise<HarnessServices> {
  const pty = await waitFor(() => getPtyClient(), READY_TIMEOUT_MS, "the PTY client");
  await pty.waitForReady();
  const workspace = await waitFor(
    () => getWorkspaceClientRef(),
    READY_TIMEOUT_MS,
    "the workspace client"
  );
  const profiles = await waitFor(
    () => getResourceProfileService(),
    READY_TIMEOUT_MS,
    "the resource profile service"
  );
  await waitFor(
    () => getDeferredQueueState().drainState === "drained",
    READY_TIMEOUT_MS,
    "deferred startup work to drain"
  );
  return { pty, workspace, profiles };
}

/**
 * Give one terminal a live agent state so the efficiency freeze skips its
 * project's view. Done while the view is active, so its deactivation already
 * sees the agent. `cat` is a foreground process the pty-host's probes can find,
 * standing in for the agent CLI; it reads a TTY nothing writes, so it is idle.
 */
async function protectWithAgent(
  pvm: ProjectViewManager,
  pty: PtyClient,
  project: FixtureProject,
  terminal: { id: string; spawnedAt: number }
): Promise<void> {
  pty.write(terminal.id, "cat\r");
  const accepted = await pty.transitionState(
    terminal.id,
    { type: "start" },
    "activity",
    1,
    terminal.spawnedAt
  );
  if (!accepted) throw new Error("the pty-host rejected the protected terminal's agent state");
  await waitFor(
    () => hasActiveAgent(pvm, project.id),
    AGENT_STATE_TIMEOUT_MS,
    "the view manager to see the protected project's agent"
  );
  // Passive record of the Page Lifecycle `freeze`/`resume` events, read after
  // the window: no task loop in the view, and a frozen view that never thaws
  // shows up as a view that does not answer.
  const entry = pvm.getAllViews().find((view) => view.projectId === project.id)!;
  await entry.view.webContents.executeJavaScript(
    `(() => { if (window.__daintreeIdleLifecycle) return true;
       const log = []; window.__daintreeIdleLifecycle = log;
       for (const type of ["freeze", "resume"]) document.addEventListener(type, () => log.push([type, Date.now()]), true);
       return true; })()`
  );
}

/**
 * Create the projects and their saved state, then open them through the
 * production switch. Appends to `projects` and `terminals` as it goes, so the
 * caller's teardown covers whatever exists even when a later step throws.
 */
async function buildFixture(
  config: IdleHarnessConfig,
  pvm: ProjectViewManager,
  appView: WebContentsView,
  pty: PtyClient,
  tempRoot: string,
  projects: FixtureProject[],
  terminals: FixtureTerminal[]
): Promise<void> {
  for (const [index, count] of config.terminalsPerProject.entries()) {
    const repoPath = await createFixtureRepo(tempRoot, `project-${index + 1}`);
    const project = await projectStore.addProject(repoPath);
    const fixture: FixtureProject = { index, id: project.id, path: repoPath, terminals: count };
    projects.push(fixture);
    const settings = await projectStore.getProjectSettings(project.id);
    await projectStore.saveProjectSettings(project.id, {
      ...settings,
      terminalSettings: { ...settings.terminalSettings, shell: FIXTURE_SHELL },
    });
    await projectStore.saveProjectState(project.id, projectState(fixture));
  }

  // The requested project count is part of the cell. The RAM-derived default
  // can be lower, which would evict a project out of the fixture; pressure
  // eviction stays live and fails the run if it fires.
  const terminalConfig = store.get("terminalConfig");
  store.set("terminalConfig", { ...terminalConfig, cachedProjectViews: projects.length });
  pvm.setCachedViewLimit(projects.length);

  // Last project first, so the first ends active and the rest are cached.
  for (const project of [...projects].reverse()) {
    await switchToProject(pvm, appView, project);
    const live = await waitFor(
      async () => {
        const inventory = await liveTerminalsByProject(pty, projects);
        return !inventory.degraded && inventory.counts[project.index] === project.terminals
          ? inventory
          : null;
      },
      TERMINALS_TIMEOUT_MS,
      `project ${project.index + 1}'s ${project.terminals} terminals`
    );
    if (project.index === config.protectedProjectIndex) {
      const agent = live.byProject.get(project.id)![0]!;
      await protectWithAgent(pvm, pty, project, agent);
      terminals.push({ ...agent, projectIndex: project.index, shellPid: null, role: "agent" });
    }
  }

  const live = await liveTerminalsByProject(pty, projects);
  for (const project of projects) {
    for (const terminal of live.byProject.get(project.id) ?? []) {
      if (terminals.some((known) => known.id === terminal.id)) continue;
      const stream =
        config.stream && project.index === 0 && !terminals.some((t) => t.role === "stream");
      terminals.push({
        id: terminal.id,
        spawnedAt: terminal.spawnedAt,
        projectIndex: project.index,
        shellPid: null,
        role: stream ? "stream" : "shell",
      });
    }
  }
  for (const terminal of terminals) {
    terminal.shellPid = (await pty.getTerminalInfo(terminal.id))?.ptyPid ?? null;
  }
  const stream = terminals.find((terminal) => terminal.role === "stream");
  if (stream) {
    pty.write(
      stream.id,
      `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} -e ${shellQuote(STREAM_WORKLOAD_JS)}\r`
    );
  }
  log(
    "CHECK: fixture materialised — projects=%d terminals=%s stream=%s protected=%s",
    projects.length,
    JSON.stringify(live.counts),
    String(config.stream),
    config.protectedProjectIndex === null ? "none" : `project ${config.protectedProjectIndex + 1}`
  );
}

async function applyFocus(
  config: IdleHarnessConfig,
  win: BrowserWindow,
  pvm: ProjectViewManager
): Promise<boolean> {
  if (config.blurred) {
    win.blur();
  } else {
    app.focus({ steal: true });
    win.show();
    win.focus();
    pvm.getActiveView()?.webContents.focus();
  }
  await delay(FOCUS_SETTLE_MS);
  return win.isFocused() !== config.blurred;
}

/** Passive listeners only; each records a timestamp and nothing else. */
function installObservers(
  { pty, workspace, profiles }: HarnessServices,
  win: BrowserWindow,
  terminals: readonly FixtureTerminal[]
): { observed: Observations; dispose: () => void } {
  const observed: Observations = {
    profileTransitions: [],
    workspaceHostRestarts: [],
    workspaceHostCrashes: [],
    ptyHostCrashes: [],
    terminalExits: [],
    agentStateChanges: [],
    focusChanges: [],
    processesGone: [],
  };
  const disposers: Array<() => void> = [];

  disposers.push(
    profiles.onProfileChanged(({ from, to }) =>
      observed.profileTransitions.push({ atMs: Date.now(), from, to })
    )
  );

  const onRestart = () => observed.workspaceHostRestarts.push({ atMs: Date.now() });
  const onWorkspaceCrash = (code: unknown) =>
    observed.workspaceHostCrashes.push({ atMs: Date.now(), code });
  workspace.on("host-restarted", onRestart);
  workspace.on("host-crash", onWorkspaceCrash);
  disposers.push(() => {
    workspace.off("host-restarted", onRestart);
    workspace.off("host-crash", onWorkspaceCrash);
  });

  const fixtureTerminalIds = new Set(terminals.map((terminal) => terminal.id));
  const onExit = (id: string) => {
    if (fixtureTerminalIds.has(id)) observed.terminalExits.push({ atMs: Date.now(), id });
  };
  const onPtyCrash = () => observed.ptyHostCrashes.push({ atMs: Date.now() });
  pty.on("exit", onExit);
  pty.on("host-crash", onPtyCrash);
  disposers.push(() => {
    pty.off("exit", onExit);
    pty.off("host-crash", onPtyCrash);
  });

  const agentTerminalId = terminals.find((terminal) => terminal.role === "agent")?.id;
  disposers.push(
    events.on("agent:state-changed", (payload) => {
      if (agentTerminalId && payload.terminalId === agentTerminalId) {
        observed.agentStateChanges.push({
          atMs: Date.now(),
          terminalId: agentTerminalId,
          state: payload.state,
        });
      }
    })
  );

  const onFocus = () => observed.focusChanges.push({ atMs: Date.now(), event: "focus" });
  const onBlur = () => observed.focusChanges.push({ atMs: Date.now(), event: "blur" });
  win.on("focus", onFocus);
  win.on("blur", onBlur);
  disposers.push(() => {
    if (win.isDestroyed()) return;
    win.off("focus", onFocus);
    win.off("blur", onBlur);
  });

  // A clean exit is a utility retiring on schedule, not a crash.
  const onChildGone = (_event: unknown, details: Electron.Details) => {
    if (details.reason === "clean-exit") return;
    observed.processesGone.push({ atMs: Date.now(), type: details.type, reason: details.reason });
  };
  const onRenderGone = (
    _event: unknown,
    _wc: unknown,
    details: Electron.RenderProcessGoneDetails
  ) => observed.processesGone.push({ atMs: Date.now(), type: "renderer", reason: details.reason });
  app.on("child-process-gone", onChildGone);
  app.on("render-process-gone", onRenderGone);
  disposers.push(() => {
    app.off("child-process-gone", onChildGone);
    app.off("render-process-gone", onRenderGone);
  });

  return {
    observed,
    dispose: () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // best-effort
        }
      }
    },
  };
}

interface WindowReading {
  startMs: number;
  endMs: number;
  start: SamplerSnapshot;
  end: SamplerSnapshot;
  labels: EndpointLabels;
  startObservation: CellObservation;
  endObservation: CellObservation;
  endLive: Awaited<ReturnType<typeof liveTerminalsByProject>>;
  daemonsStart: Awaited<ReturnType<typeof readDaemons>>;
  daemonsEnd: Awaited<ReturnType<typeof readDaemons>>;
  profile: { atStart: string; atEnd: string; freezeAtStart: boolean; freezeAtEnd: boolean };
}

/**
 * The window itself. Everything that talks to a renderer or the pty-host
 * happens before the opening sample or after the closing one, so none of the
 * harness's own IPC lands inside it.
 */
async function measureWindow(
  config: IdleHarnessConfig,
  { pty, profiles }: HarnessServices,
  win: BrowserWindow,
  pvm: ProjectViewManager,
  projects: readonly FixtureProject[],
  terminals: readonly FixtureTerminal[]
): Promise<WindowReading> {
  const labels = { start: new Map<number, string>(), end: new Map<number, string>() };
  collectLabels(pvm, projects, terminals, config.protectedProjectIndex, labels.start);
  const startObservation = observeCell(
    config,
    pvm,
    projects,
    await liveTerminalsByProject(pty, projects),
    win,
    await readDocumentFocus(pvm),
    null
  );
  const atStart = profiles.getProfile();
  const freezeAtStart = pvm.efficiencyFreezeEnabled;

  // Whole seconds, so the spawn census's one-second buckets slice exactly.
  const startMs = Math.ceil(Date.now() / 1000) * 1000;
  const endMs = startMs + config.windowMs;
  await delay(startMs - Date.now());
  // Daemon reads sit outside the process samples at both edges, so their own
  // `ps` fork never falls inside the tree's window.
  const daemonsStart = await readDaemons();
  const start = await runSampler(config.samplerPath);
  labels.start.set(start.pid, "harness:sampler");
  startObservation.streamWorkloadAlive = streamWorkloadRunning(start.snapshot, terminals);
  log("CHECK: window open — %dms", config.windowMs);

  await delay(endMs - Date.now());
  const end = await runSampler(config.samplerPath);
  // The closing sampler's CPU so far is the harness's, not the app's. Dropped
  // here, it is reaped after the window instead. The opening sampler stays: its
  // pre-sample CPU is charged back when it departs, leaving only its exit.
  end.snapshot.processes.delete(end.pid);
  const daemonsEnd = await readDaemons();
  log("CHECK: window closed");

  const atEnd = profiles.getProfile();
  const freezeAtEnd = pvm.efficiencyFreezeEnabled;
  collectLabels(pvm, projects, terminals, config.protectedProjectIndex, labels.end);
  const endLive = await liveTerminalsByProject(pty, projects);
  const endObservation = observeCell(
    config,
    pvm,
    projects,
    endLive,
    win,
    await readDocumentFocus(pvm),
    streamWorkloadRunning(end.snapshot, terminals)
  );
  return {
    startMs,
    endMs,
    start: start.snapshot,
    end: end.snapshot,
    labels,
    startObservation,
    endObservation,
    endLive,
    daemonsStart,
    daemonsEnd,
    profile: { atStart, atEnd, freezeAtStart, freezeAtEnd },
  };
}

async function readProtectedLifecycle(
  pvm: ProjectViewManager,
  project: FixtureProject
): Promise<Array<[string, number]> | string> {
  const entry = pvm.getAllViews().find((view) => view.projectId === project.id);
  if (!entry || entry.view.webContents.isDestroyed()) return "view missing";
  return withTimeout(
    entry.view.webContents.executeJavaScript("window.__daintreeIdleLifecycle ?? []") as Promise<
      Array<[string, number]>
    >,
    RENDERER_SCRIPT_TIMEOUT_MS,
    "no answer"
  ).catch(() => "no answer — the view is frozen or gone");
}

/**
 * Launches inside the window by role and command. Every census-bearing process
 * alive at the close must have its own census that kept flushing through it —
 * a gap fails the run rather than reading as zero launches. One that departed
 * mid-window may have lost its last seconds to a kill; that is reported.
 */
async function spawnReport(
  censusDir: string,
  usage: TreeUsage,
  reading: WindowReading
): Promise<{ report: unknown; failures: string[] }> {
  await delay(CENSUS_DRAIN_MS);
  const files = await readCensus(censusDir);
  const slice = sliceSpawnCensus(files, reading.startMs, reading.endMs);
  const coverage = censusCoverage({
    alive: usage.processes.filter((p) => CENSUS_ROLES.has(p.label)),
    departed: usage.departed.filter((p) => CENSUS_ROLES.has(p.label)),
    files,
    windowEndMs: reading.endMs,
  });
  const failures: string[] = [];
  if (coverage.missing.length > 0) {
    failures.push(
      `no spawn census from ${coverage.missing.map((m) => `${m.label} ${m.pid}`).join(", ")}`
    );
  }
  if (coverage.stalled.length > 0) {
    failures.push(
      `spawn census stopped flushing in ${coverage.stalled.map((m) => `${m.label} ${m.pid}`).join(", ")}`
    );
  }
  return {
    report: {
      total: slice.total,
      perSecond: round(slice.total / ((reading.endMs - reading.startMs) / 1000), 2),
      byCommand: Object.fromEntries(Object.entries(slice.byCommand).sort(([, a], [, b]) => b - a)),
      departedCoverage: coverage.departed,
    },
    failures,
  };
}

function daemonReport(reading: WindowReading) {
  const { daemonsStart, daemonsEnd } = reading;
  const seconds = (daemonsEnd.atMs - daemonsStart.atMs) / 1000;
  return Object.fromEntries(
    DAEMONS.map((name) => {
      const before = daemonsStart.readings[name];
      const after = daemonsEnd.readings[name];
      if (!before || !after || before.pid !== after.pid) return [name, null];
      const percent = ((after.cpuSeconds - before.cpuSeconds) / seconds) * 100;
      return [name, { pid: after.pid, cpuPercent: round(percent, 3) }];
    })
  );
}

function rendererTerminalReport(pvm: ProjectViewManager, projects: readonly FixtureProject[]) {
  const samples = getRendererTerminalDiagnosticsSamples();
  return projects.map((project) => {
    const entry = pvm.getAllViews().find((view) => view.projectId === project.id);
    const sample = entry
      ? samples.find((s) => s.webContentsId === entry.view.webContents.id)
      : undefined;
    return sample
      ? {
          project: project.index + 1,
          terminalCount: sample.terminalCount,
          countsByTier: sample.countsByTier,
          webglMode: sample.webglMode,
          ageMs: sample.ageMs,
        }
      : { project: project.index + 1, sample: null };
  });
}

async function teardownFixture(
  projects: readonly FixtureProject[],
  tempRoot: string | null
): Promise<void> {
  const pty = getPtyClient();
  for (const project of projects) {
    try {
      if (pty) {
        await withTimeout(pty.killByProject(project.id), CLEANUP_KILL_TIMEOUT_MS, "kill timed out");
      }
    } catch {
      // best-effort
    }
    try {
      await projectStore.removeProject(project.id);
    } catch {
      // best-effort
    }
  }
  if (!tempRoot) return;
  try {
    await rm(tempRoot, { recursive: true, force: true });
  } catch (error) {
    log("WARN — could not remove %s: %s", tempRoot, formatErrorMessage(error, "unknown"));
  }
}

/**
 * Runs one cell and reports it. Returns false when the fixture did not
 * materialise or the measurement was unusable; true otherwise, whatever the
 * numbers are.
 */
export async function runIdleHarness(
  win: BrowserWindow,
  pvm: ProjectViewManager,
  appView: WebContentsView
): Promise<boolean> {
  const parsed = parseIdleHarnessConfig(process.env[IDLE_HARNESS_CONFIG_ENV]);
  if ("errors" in parsed) {
    for (const error of parsed.errors) log("FAILED — config: %s", error);
    return false;
  }
  const config = parsed.config;
  const censusDir = process.env[SPAWN_CENSUS_DIR_ENV] ?? null;

  let tempRoot: string | null = null;
  const projects: FixtureProject[] = [];
  const terminals: FixtureTerminal[] = [];
  let disposeObservers: (() => void) | null = null;

  try {
    const services = await waitForApp();
    if (censusDir && !isSpawnCensusInstalled()) {
      log("FAILED — %s is set but main's spawn census is not installed", SPAWN_CENSUS_DIR_ENV);
      return false;
    }
    log("CHECK: app ready — OK");

    // realpath: macOS tmpdir is a symlink, and git reports worktrees by their
    // real path. Worktree ids are paths, so the seeded state must match it.
    tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "daintree-idle-harness-")));
    await buildFixture(config, pvm, appView, services.pty, tempRoot, projects, terminals);

    if (!(await applyFocus(config, win, pvm))) {
      log("FAILED — could not make the window %s", config.blurred ? "blurred" : "focused");
      return false;
    }
    const { observed, dispose } = installObservers(services, win, terminals);
    disposeObservers = dispose;

    log("settling for %dms", config.settleMs);
    await delay(config.settleMs);
    const reading = await measureWindow(config, services, win, pvm, projects, terminals);
    const sampledStartMs = reading.start.atUs / 1000;
    const sampledEndMs = reading.end.atUs / 1000;
    // Events count up to whichever edge is later, so nothing that touched the
    // CPU samples escapes the checks.
    const closedAtMs = Math.max(reading.endMs, sampledEndMs);
    const within = <T extends { atMs: number }>(list: T[]) =>
      inWindow(list, reading.startMs, closedAtMs);

    const usage = computeTreeUsage({
      start: reading.start,
      end: reading.end,
      rootPid: process.pid,
      labels: reading.labels,
    });

    const stream = terminals.find((terminal) => terminal.role === "stream");
    const workload = stream
      ? usage.processes.filter((p) => stream.shellPid && p.ppid === stream.shellPid)
      : [];
    const protectedLifecycle =
      config.protectedProjectIndex === null
        ? undefined
        : await readProtectedLifecycle(pvm, projects[config.protectedProjectIndex]!);
    const failures = [
      ...checkMaterialised(config, reading.startObservation, "start"),
      ...checkMaterialised(config, reading.endObservation, "end"),
      ...checkRendererContinuity(reading.startObservation, reading.endObservation),
      ...checkWindowTiming({
        nominalStartMs: reading.startMs,
        nominalEndMs: reading.endMs,
        sampledStartMs,
        sampledEndMs,
      }),
      ...checkWindowEvents({
        windowStartMs: reading.startMs,
        windowEndMs: closedAtMs,
        terminalExits: within(observed.terminalExits).length,
        focusChanges: within(observed.focusChanges).length,
        processesGone:
          within(observed.processesGone).length + within(observed.ptyHostCrashes).length,
        protectedAgentStates: within(observed.agentStateChanges).map((change) => change.state),
        streamLastOutputAt: stream
          ? (reading.endLive.byProject.get(projects[0]!.id)?.find((t) => t.id === stream.id)
              ?.lastOutputTime ?? 0)
          : undefined,
        streamWorkloadCpuNs:
          workload.length > 0 ? workload.reduce((sum, p) => sum + p.cpuNs, 0) : undefined,
        protectedLifecycle,
      }),
    ];

    let spawns: unknown = null;
    if (censusDir) {
      const census = await spawnReport(censusDir, usage, reading);
      spawns = census.report;
      failures.push(...census.failures);
    }

    const result = {
      schema: IDLE_HARNESS_RESULT_SCHEMA,
      cell: config.cell,
      config: {
        terminalsPerProject: config.terminalsPerProject,
        stream: config.stream,
        blurred: config.blurred,
        protectedProjectIndex: config.protectedProjectIndex,
        windowMs: config.windowMs,
        settleMs: config.settleMs,
      },
      valid: failures.length === 0,
      failures,
      environment: environmentReport(win),
      window: { startMs: reading.startMs, endMs: reading.endMs, sampledStartMs, sampledEndMs },
      tree: summariseUsage(usage),
      daemons: daemonReport(reading),
      spawns,
      workspaceHosts: {
        restarts: within(observed.workspaceHostRestarts).length,
        crashes: within(observed.workspaceHostCrashes).length,
      },
      resourceProfile: {
        ...reading.profile,
        transitions: within(observed.profileTransitions),
      },
      protectedLifecycle: protectedLifecycle ?? null,
      rendererTerminals: rendererTerminalReport(pvm, projects),
    };
    log("RESULT %s", JSON.stringify(result));

    if (failures.length > 0) {
      for (const failure of failures) log("FAILED — %s", failure);
      return false;
    }
    log("COMPLETE");
    return true;
  } catch (error) {
    log("FAILED — %s", formatErrorMessage(error, "idle harness threw"));
    return false;
  } finally {
    disposeObservers?.();
    await teardownFixture(projects, tempRoot);
  }
}

/**
 * Entry point from `main.ts`. `app.exit` is in the finally for the same reason
 * as the freeze harness: nothing between here and it may strand a booted app
 * with the runner waiting out its timeout.
 */
export async function runIdleHarnessAndExit(
  win: BrowserWindow,
  pvm: ProjectViewManager,
  appView: WebContentsView
): Promise<void> {
  let passed = false;
  try {
    passed = await runIdleHarness(win, pvm, appView);
  } catch (error) {
    log("FAILED — harness threw: %s", formatErrorMessage(error, "unknown"));
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
    try {
      getWorkspaceClientRef()?.dispose();
    } catch {
      /* ignore */
    }
    try {
      getPtyClient()?.dispose();
    } catch {
      /* ignore */
    }
    app.exit(passed ? 0 : 1);
  }
}
