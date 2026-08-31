import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorktreeMonitor as WorktreeMonitorType } from "../../../electron/workspace-host/WorktreeMonitor";
import type { WorktreeMonitorConfig } from "../../../electron/workspace-host/WorktreeMonitor";
import type { WorkspaceService as WorkspaceServiceType } from "../../../electron/workspace-host/WorkspaceService";
import type {
  MonitorConfig,
  WorkspaceHostEvent,
  WorktreeEventVersion,
  WorktreeSnapshot,
} from "../../../shared/types/workspace-host";
import type { Worktree } from "../../../shared/types/worktree";
import {
  gitSpawnMark,
  gitSpawnsSince,
  installGitSpawnCounter,
  loadPipelineModules,
  sleep,
} from "./gitPipelineFixture";
import { createPerfTempRoot, releasePerfTempRoot } from "./tempRoots";

/**
 * Fixture + instrumentation for the worktree-sidebar latency scenarios
 * (PERF-130..141). Where PERF-100..104 measure the COST of the git pipeline,
 * this suite measures its LATENCY and fan-out: wall-time from a filesystem
 * mutation to the host-side snapshot emit (the exact moment the subprocess
 * would push a worktree-update over the MessagePort), external-worktree
 * pickup through the real TopologyWatcher + WorkspaceService reconcile, and
 * the renderer store's ingestion/coalescing cost against the real
 * createWorktreeStore.
 *
 * Three harness layers, all lazy (nothing is built at module import):
 * - Recording monitors: real WorktreeMonitor with a timestamping onUpdate.
 * - Topology harness: a real WorkspaceService (+ TopologyWatcher) headless,
 *   with a recording sendEvent and quieted monitor config.
 * - Store harness: the real createWorktreeStore, esbuild-bundled with its 4
 *   renderer-only leaf imports stubbed (they are unreachable from the
 *   applySnapshot/applyUpdate hot paths being measured).
 */

// The watcher pipeline's self-trigger cooldown is 1000ms
// (GIT_WATCH_SELF_TRIGGER_COOLDOWN_MS in WatcherController); a status pass's
// own .git/index touch can echo one extra pass up to ~1s after completion.
// Quiescing for longer than cooldown + pass guarantees a measurement window
// that starts outside any deferred-drain chain.
export const PIPELINE_QUIESCE_SETTLE_MS = 1300;

// --- Generic helpers ---------------------------------------------------------

let uidCounter = 0;

export function uid(): number {
  uidCounter += 1;
  return uidCounter;
}

export async function pollUntil(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 10
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await sleep(intervalMs);
  }
  return condition();
}

/**
 * Wait until no git subprocess has spawned for `settleMs` (process-wide).
 * Scenario code runs strictly sequentially in the harness, so during any one
 * scenario the only live git activity is its own fixtures'.
 */
export async function quiesceGitSpawns(
  settleMs: number = PIPELINE_QUIESCE_SETTLE_MS,
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const lastAt = gitSpawnsSince(0).lastAtMs;
    if (lastAt === null || performance.now() - lastAt >= settleMs) return true;
    await sleep(25);
  }
  return false;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "perf",
      GIT_AUTHOR_EMAIL: "perf@example.invalid",
      GIT_COMMITTER_NAME: "perf",
      GIT_COMMITTER_EMAIL: "perf@example.invalid",
    },
  });
}

export function writeEditFile(worktreePath: string, name: string): string {
  const filePath = join(worktreePath, name);
  writeFileSync(filePath, `bench edit ${name}\n`.repeat(5));
  return filePath;
}

export function removeFileQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Already gone — iteration cleanup is best-effort.
  }
}

// --- Recording monitor harness (Axis A: change-detection latency) -----------

export interface RecordedEmit {
  atMs: number;
  snapshot: WorktreeSnapshot;
}

export class EmitRecorder {
  readonly emits: RecordedEmit[] = [];

  record(snapshot: WorktreeSnapshot): void {
    this.emits.push({ atMs: performance.now(), snapshot });
  }

  cursor(): number {
    return this.emits.length;
  }

  /**
   * Wait for the first emit at index >= `from` whose snapshot matches. Poll
   * timers and echo passes can produce emits unrelated to the mutation under
   * measurement — always filter on the specific delta, never "any emit".
   */
  async waitFor(
    predicate: (snapshot: WorktreeSnapshot) => boolean,
    timeoutMs: number,
    from = 0
  ): Promise<RecordedEmit | null> {
    let index = from;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      while (index < this.emits.length) {
        const emit = this.emits[index];
        index += 1;
        if (predicate(emit.snapshot)) return emit;
      }
      await sleep(5);
    }
    return null;
  }
}

export function snapshotChangedFileCount(snapshot: WorktreeSnapshot): number {
  return snapshot.worktreeChanges?.changedFileCount ?? snapshot.modifiedCount ?? 0;
}

export interface RecordingMonitorOptions {
  isCurrent?: boolean;
  gitWatchEnabled?: boolean;
  basePollingInterval?: number;
}

export interface RecordingMonitor {
  monitor: WorktreeMonitorType;
  recorder: EmitRecorder;
}

/**
 * Real WorktreeMonitor with a timestamping onUpdate — the latency-rig variant
 * of gitPipelineFixture's createMonitorHarness (whose onUpdate is inert).
 */
export async function createRecordingMonitor(
  worktreePath: string,
  branch: string,
  options: RecordingMonitorOptions = {}
): Promise<RecordingMonitor> {
  const { WorktreeMonitor } = await loadPipelineModules();
  const recorder = new EmitRecorder();
  const worktree: Worktree = {
    id: worktreePath,
    path: worktreePath,
    name: branch,
    branch,
    isCurrent: options.isCurrent ?? false,
    isMainWorktree: false,
  };
  const basePollingInterval = options.basePollingInterval ?? 3_600_000;
  const config: WorktreeMonitorConfig = {
    basePollingInterval,
    adaptiveBackoff: false,
    pollIntervalMax: Math.max(basePollingInterval, 30_000),
    circuitBreakerThreshold: 3,
    gitWatchEnabled: options.gitWatchEnabled ?? true,
  };
  const monitor = new WorktreeMonitor(
    worktree,
    config,
    { onUpdate: (snapshot) => recorder.record(snapshot) },
    "main",
    undefined
  );
  return { monitor, recorder };
}

/**
 * Start a recording monitor deterministically: emit the initial clean
 * snapshot, run one forced status pass (no background-start jitter), and —
 * when a watcher is expected — wait until the async arm actually completed
 * (`hasArmedWatcher` flips only once the parcel/fs.watch subscription
 * resolved; `hasWatcher` is optimistic during an in-flight arm, and measuring
 * before the arm resolves measures watcher-arm latency, not detection).
 */
export async function startArmedMonitor(
  rm: RecordingMonitor,
  { requireWatcher }: { requireWatcher: boolean }
): Promise<void> {
  rm.monitor.startWithoutGitStatus();
  await rm.monitor.refresh();
  if (requireWatcher) {
    const armed = await pollUntil(() => rm.monitor.hasArmedWatcher, 8_000);
    if (!armed) {
      throw new Error(`watcher failed to arm for ${rm.monitor.path}`);
    }
  }
}

// --- Sidebar edit fixture (repos + worktrees for Axis A) --------------------

export const FAN_IN_WORKTREE_COUNT = 12;

export interface SidebarEditFixture {
  root: string;
  mainPath: string;
  /** PERF-130 focused-edit worktree. */
  focusPath: string;
  /** PERF-131 git-metadata worktree. */
  metaPath: string;
  /** PERF-132 poll-bound worktree. */
  pollPath: string;
  /** PERF-133 burst worktree. */
  burstPath: string;
  /** PERF-134 fan-in worktrees (FAN_IN_WORKTREE_COUNT). */
  fanInPaths: string[];
}

let editFixture: SidebarEditFixture | null = null;

export function getSidebarEditFixture(): SidebarEditFixture {
  if (editFixture) return editFixture;
  installGitSpawnCounter();

  const root = createPerfTempRoot("daintree-perf-sidebar-");
  const mainPath = join(root, "repo");
  mkdirSync(mainPath, { recursive: true });
  runGit(mainPath, ["init", "-b", "main"]);
  runGit(mainPath, ["config", "commit.gpgsign", "false"]);
  runGit(mainPath, ["config", "core.fsmonitor", "false"]);
  for (let dir = 0; dir < 3; dir++) {
    const dirPath = join(mainPath, `module-${dir}`);
    mkdirSync(dirPath, { recursive: true });
    for (let file = 0; file < 4; file++) {
      writeFileSync(join(dirPath, `file-${file}.txt`), `base ${dir}/${file}\n`.repeat(20));
    }
  }
  runGit(mainPath, ["add", "-A"]);
  runGit(mainPath, ["commit", "-m", "base tree"]);

  const addWorktree = (name: string): string => {
    const wtPath = join(root, name);
    runGit(mainPath, ["worktree", "add", wtPath, "-b", `${name}-branch`, "main"]);
    return wtPath;
  };

  const fanInPaths: string[] = [];
  for (let i = 0; i < FAN_IN_WORKTREE_COUNT; i++) {
    fanInPaths.push(addWorktree(`wt-fanin-${i}`));
  }

  editFixture = {
    root,
    mainPath,
    focusPath: addWorktree("wt-focus"),
    metaPath: addWorktree("wt-meta"),
    pollPath: addWorktree("wt-poll"),
    burstPath: addWorktree("wt-burst"),
    fanInPaths,
  };

  return editFixture;
}

/** Stage-and-commit helper for the git-metadata scenario (not spawn-counted). */
export function commitAllIn(worktreePath: string, message: string): void {
  runGit(worktreePath, ["add", "-A"]);
  runGit(worktreePath, ["commit", "-m", message]);
}

// --- Topology harness (Axis B: real WorkspaceService + TopologyWatcher) -----

interface WorkspaceServiceModule {
  WorkspaceService: typeof WorkspaceServiceType;
}

let workspaceModulePromise: Promise<WorkspaceServiceModule> | null = null;

function loadWorkspaceServiceModule(): Promise<WorkspaceServiceModule> {
  if (!workspaceModulePromise) {
    workspaceModulePromise = (async () => {
      // Sets DAINTREE_USER_DATA / DAINTREE_INSTANCE_ROLE before any product
      // module evaluates (the logger and WorkspaceService read them early).
      await loadPipelineModules();
      const mod = await import("../../../electron/workspace-host/WorkspaceService");
      return { WorkspaceService: mod.WorkspaceService };
    })();
  }
  return workspaceModulePromise;
}

// Monitors owned by the topology harness must stay inert between reconciles:
// hour-scale polling and no per-worktree git watchers, so the only pipeline
// under measurement is the TopologyWatcher → reconcile → syncMonitors chain.
const QUIET_MONITOR_CONFIG: MonitorConfig = {
  pollIntervalActive: 3_600_000,
  pollIntervalBackground: 3_600_000,
  pollIntervalMax: 3_600_000,
  adaptiveBackoff: false,
  gitWatchEnabled: false,
  fetchIntervalActiveMs: 3_600_000,
  fetchIntervalBackgroundMs: 3_600_000,
};

// The topology reconcile queue enforces a post-run cooldown
// (TOPOLOGY_RECONCILE_COOLDOWN_MS in TopologyWatcher, 500ms); an external
// mutation inside that window is deferred to cooldown expiry, so settled
// measurement windows must exceed cooldown + the drain epsilon.
export const TOPOLOGY_COOLDOWN_SETTLE_MS = 800;

export interface RecordedHostEvent {
  atMs: number;
  event: WorkspaceHostEvent;
}

export class TopologyHarness {
  readonly events: RecordedHostEvent[] = [];
  private disposed = false;

  private constructor(
    readonly svc: WorkspaceServiceType,
    readonly root: string,
    readonly repoPath: string
  ) {}

  static async create(existingWorktrees: number): Promise<TopologyHarness> {
    installGitSpawnCounter();
    const { WorkspaceService } = await loadWorkspaceServiceModule();

    // Long-lived harnesses (steady/scale topology projects) intentionally live
    // until the process ends, so `dispose()` is not guaranteed to reap this.
    const root = createPerfTempRoot("daintree-perf-topo-");
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    runGit(repoPath, ["init", "-b", "main"]);
    runGit(repoPath, ["config", "commit.gpgsign", "false"]);
    runGit(repoPath, ["config", "core.fsmonitor", "false"]);
    writeFileSync(join(repoPath, "README.txt"), "topology fixture\n");
    runGit(repoPath, ["add", "-A"]);
    runGit(repoPath, ["commit", "-m", "base"]);
    for (let i = 0; i < existingWorktrees; i++) {
      runGit(repoPath, ["worktree", "add", join(root, `wt-pre-${i}`), "-b", `pre-${i}`, "main"]);
    }

    let record: (event: WorkspaceHostEvent) => void = () => {};
    const svc = new WorkspaceService((event) => record(event));
    const harness = new TopologyHarness(svc, root, repoPath);
    record = (event) => harness.events.push({ atMs: performance.now(), event });

    const requestId = `perf-topo-${uid()}`;
    // projectId is required and is threaded into every worktree id the service
    // derives. Omitting it left `undefined` on that path, so the fixture was
    // measuring a load the product never performs.
    await svc.loadProject(requestId, repoPath, `perf-topo-project-${uid()}`);
    const loaded = await harness.waitForEvent(
      (e) => e.type === "load-project-result" && e.requestId === requestId,
      15_000
    );
    if (!loaded || !("success" in loaded.event) || !loaded.event.success) {
      throw new Error(`topology harness loadProject failed for ${repoPath}`);
    }

    // Quiet every monitor the load created (and set the service-level config
    // that future reconcile-created monitors inherit).
    const internals = svc as unknown as {
      listService: {
        list(options?: { forceRefresh?: boolean }): Promise<unknown[]>;
        mapToWorktrees(raw: unknown[]): Promise<Worktree[]>;
      };
    };
    const raw = await internals.listService.list({ forceRefresh: true });
    const worktrees = await internals.listService.mapToWorktrees(raw);
    await svc.syncMonitors(worktrees, null, "main", QUIET_MONITOR_CONFIG, true);

    await harness.settle();
    return harness;
  }

  cursor(): number {
    return this.events.length;
  }

  async waitForEvent(
    predicate: (event: WorkspaceHostEvent) => boolean,
    timeoutMs: number,
    from = 0
  ): Promise<RecordedHostEvent | null> {
    let index = from;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      while (index < this.events.length) {
        const recorded = this.events[index];
        index += 1;
        if (predicate(recorded.event)) return recorded;
      }
      await sleep(5);
    }
    return null;
  }

  /** First worktree-update carrying the given worktree directory basename. */
  waitForSurfaced(
    name: string,
    timeoutMs: number,
    from: number
  ): Promise<RecordedHostEvent | null> {
    return this.waitForEvent(
      (e) => e.type === "worktree-update" && basename(e.worktree.id) === name,
      timeoutMs,
      from
    );
  }

  waitForRemoved(name: string, timeoutMs: number, from: number): Promise<RecordedHostEvent | null> {
    return this.waitForEvent(
      (e) => e.type === "worktree-removed" && basename(e.worktreeId) === name,
      timeoutMs,
      from
    );
  }

  /**
   * Create a worktree the way an external actor would: raw git via
   * execFileSync, which neither routes through the app's create path (so the
   * TopologyWatcher's pending-set filtering can't suppress it) nor through
   * the async-spawn git counter (external work isn't pipeline cost).
   */
  addWorktreeExternal(name: string): string {
    const wtPath = join(this.root, name);
    runGit(this.repoPath, ["worktree", "add", wtPath, "-b", `${name}-branch`, "main"]);
    return wtPath;
  }

  removeWorktreeExternal(wtPath: string): void {
    runGit(this.repoPath, ["worktree", "remove", "--force", wtPath]);
  }

  /**
   * Unmeasured-cleanup removal: removes the worktree, then force-schedules a
   * reconcile so the drop can't strand behind the post-reconcile cooldown
   * (external events landing inside it are otherwise deferred indefinitely —
   * the exact latency hole PERF-139 exists to guard).
   */
  async cleanupWorktree(wtPath: string, name: string, from: number): Promise<void> {
    this.removeWorktreeExternal(wtPath);
    this.svc.scheduleTopologyReconcile(true);
    await this.waitForRemoved(name, 10_000, from);
  }

  /**
   * Wait out in-flight git activity AND the reconcile cooldown. A dirty
   * follow-up reconcile can fire mid-cooldown and restart the 2s window, so
   * settling requires observing a full cooldown-length span with zero git
   * spawns — quiesce-then-sleep alone can race a follow-up.
   */
  async settle(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      await quiesceGitSpawns();
      const mark = gitSpawnMark();
      await sleep(TOPOLOGY_COOLDOWN_SETTLE_MS);
      if (gitSpawnsSince(mark).count === 0) return;
    }
  }

  pause(): void {
    this.svc.setPollingEnabled(false);
  }

  /** Resume watching; includes the resume-triggered reconcile settling. */
  async resume(): Promise<void> {
    this.svc.setPollingEnabled(true);
    await this.settle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.svc.dispose();
    releasePerfTempRoot(this.root);
  }
}

let steadyHarnessPromise: Promise<TopologyHarness> | null = null;

/** Shared steady-state project (2 pre-existing worktrees) for PERF-135/137/139. */
export function getSteadyTopologyHarness(): Promise<TopologyHarness> {
  if (!steadyHarnessPromise) {
    steadyHarnessPromise = TopologyHarness.create(2);
  }
  return steadyHarnessPromise;
}

export const TOPOLOGY_SCALING_COUNTS = [1, 5, 20, 50] as const;

const scaleHarnessPromises = new Map<number, Promise<TopologyHarness>>();

/**
 * Scaling projects for PERF-138. Kept running between measurements: pausing
 * tears down and re-creates the parcel subscription each cycle, and that
 * churn (plus the fire-and-forget startWatcher in setPollingEnabled racing
 * ensureAlive's) intermittently loses the first post-resume event on macOS.
 * Live-but-quiet costs one safety-net reconcile per 90s per harness, which
 * the spawn budgets tolerate.
 */
export function getScaleTopologyHarness(existingWorktrees: number): Promise<TopologyHarness> {
  let promise = scaleHarnessPromises.get(existingWorktrees);
  if (!promise) {
    promise = TopologyHarness.create(existingWorktrees);
    scaleHarnessPromises.set(existingWorktrees, promise);
  }
  return promise;
}

// --- Store harness (Axis C: real createWorktreeStore, headless) -------------

type StoreLike = {
  getState: () => {
    worktrees: Map<string, WorktreeSnapshot>;
    applySnapshot: (
      states: WorktreeSnapshot[],
      version: WorktreeEventVersion,
      associations?: Record<string, unknown>
    ) => void;
    applyUpdate: (state: WorktreeSnapshot, version: WorktreeEventVersion) => void;
  };
  subscribe: (listener: () => void) => () => void;
};

export interface WorktreeStoreModule {
  createWorktreeStore: () => StoreLike;
}

const PANEL_STORE_STUB = `
export const usePanelStore = {
  getState: () => ({ panelIds: [], panelIdsByWorktreeId: {}, panelsById: {}, removePanel() {} }),
  setState() {},
  subscribe() { return () => {}; },
};
`;

const CLIENTS_STUB = `
const asyncNoop = new Proxy({}, { get: () => () => Promise.resolve(undefined) });
export const worktreeClient = asyncNoop;
export const systemClient = asyncNoop;
export const terminalClient = asyncNoop;
export const projectClient = asyncNoop;
export const watchdogClient = asyncNoop;
export default asyncNoop;
`;

const DELETE_HELPER_STUB = `
export function captureWorktreeTerminalSnapshot() { return []; }
export async function closeTerminalsForWorktree() {}
export async function restoreClosedTerminals() {}
`;

const NOTIFY_STUB = `export function notify() {} export default notify;`;

let storeModulePromise: Promise<WorktreeStoreModule> | null = null;

/**
 * Bundle the real createWorktreeStore for plain Node. The benchmarked entry
 * points (applySnapshot/applyUpdate, plus applyRemove) never call the
 * renderer-only imports — panelStore, the IPC clients, terminal-close helper,
 * and notify — so those four leaves are stubbed and everything else
 * (snapshotsEqual, mergeIssueState, the statusCheckedAt side-map) is the
 * production code.
 *
 * esbuild links every static import regardless of reachability, so each stub
 * must export the full set of names the store imports and return shapes the
 * caller can use (see the `.finally()` on restoreClosedTerminals). Unmeasured
 * exports do reach the stubs — cleanupOrphanedTerminals reads panelStore's
 * panelIds — so keep the stubbed state shape complete, not just non-throwing.
 */
export function loadWorktreeStoreModule(): Promise<WorktreeStoreModule> {
  if (!storeModulePromise) {
    storeModulePromise = buildStoreBundle();
  }
  return storeModulePromise;
}

async function buildStoreBundle(): Promise<WorktreeStoreModule> {
  const esbuild = await import("esbuild");
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = pathResolve(here, "../../..");
  const outDir = createPerfTempRoot("daintree-perf-store-");
  const outfile = join(outDir, "worktreeStore.mjs");

  const stubs: Array<{ filter: RegExp; contents: string }> = [
    { filter: /(^|[\\/])panelStore$/, contents: PANEL_STORE_STUB },
    { filter: /^@\/clients(\/.*)?$/, contents: CLIENTS_STUB },
    { filter: /worktreeDeleteHelper$/, contents: DELETE_HELPER_STUB },
    { filter: /^@\/lib\/notify$/, contents: NOTIFY_STUB },
  ];

  await esbuild.build({
    entryPoints: [join(repoRoot, "src/store/createWorktreeStore.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    alias: {
      "@": join(repoRoot, "src"),
      "@shared": join(repoRoot, "shared"),
    },
    define: { "import.meta.env": "{}" },
    plugins: [
      {
        name: "daintree-renderer-stubs",
        setup(build) {
          for (const stub of stubs) {
            build.onResolve({ filter: stub.filter }, (args) => ({
              path: args.path,
              namespace: "daintree-stub",
              pluginData: stub.contents,
            }));
          }
          build.onLoad({ filter: /.*/, namespace: "daintree-stub" }, (args) => ({
            contents: args.pluginData as string,
            loader: "js",
          }));
        },
      },
    ],
  });

  const mod = (await import(pathToFileURL(outfile).href)) as WorktreeStoreModule;
  if (typeof mod.createWorktreeStore !== "function") {
    throw new Error("store bundle did not export createWorktreeStore");
  }
  return mod;
}

export interface BenchSnapshotOptions {
  changedFileCount?: number;
  lastUpdated?: number;
  checkedAt?: number;
}

/**
 * Deterministic synthetic snapshot. Keep `lastUpdated` constant across
 * applies to exercise worktreeChangesEqual's fast path; bump it together
 * with `changedFileCount` to force a real row change.
 */
export function makeBenchSnapshot(
  index: number,
  options: BenchSnapshotOptions = {}
): WorktreeSnapshot {
  const id = `/bench/worktrees/wt-${index}`;
  const changed = options.changedFileCount ?? 0;
  return {
    id,
    worktreeId: id,
    path: id,
    name: `wt-${index}`,
    branch: `bench-${index}`,
    isCurrent: false,
    isMainWorktree: index === 0,
    mood: "stable",
    modifiedCount: changed,
    worktreeChanges: {
      worktreeId: id,
      rootPath: id,
      changes: [],
      changedFileCount: changed,
      lastUpdated: options.lastUpdated ?? 1_000_000,
    },
    lastGitStatusCheckedAt: options.checkedAt ?? 1_000_000,
    lastActivityTimestamp: null,
  } as WorktreeSnapshot;
}
