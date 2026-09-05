import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type PQueueType from "p-queue";
import type { WorktreeMonitor as WorktreeMonitorType } from "../../../electron/workspace-host/WorktreeMonitor";
import type { WorktreeMonitorConfig } from "../../../electron/workspace-host/WorktreeMonitor";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host";
import type { Worktree } from "../../../shared/types/worktree";
import { createPerfTempRoot } from "./tempRoots";

/**
 * Fixture + instrumentation for the git-pipeline scenarios (PERF-100..104).
 *
 * Everything here measures the REAL workspace-host poll pipeline
 * (WorktreeMonitor + shared PQueue, exactly what WorkspaceService.refreshAll
 * drives) against a synthetic repo with up to 50 linked worktrees. No product
 * code is modified or mocked — git subprocess counting happens by patching
 * ChildProcess.prototype.spawn in this process, which every async spawn
 * (simple-git, execFile in gitUtils) routes through. Fixture-setup git calls
 * use execFileSync → spawnSync, which does NOT route through ChildProcess,
 * so setup never pollutes the counters.
 */

// --- Environment isolation -------------------------------------------------
// Must run before any product module is imported: the logger resolves its file
// destination from DAINTREE_USER_DATA at module eval, and WorkspaceService
// reads DAINTREE_INSTANCE_ROLE at construction. Product modules are therefore
// loaded lazily via loadPipelineModules() below.

let envReady = false;

function ensurePerfEnv(): void {
  if (envReady) return;
  process.env.DAINTREE_USER_DATA ??= createPerfTempRoot("daintree-perf-userdata-");
  // Suppresses automatic PR polling if any scenario ever touches WorkspaceService.
  process.env.DAINTREE_INSTANCE_ROLE ??= "worker";
  envReady = true;
}

export interface PipelineModules {
  WorktreeMonitor: typeof WorktreeMonitorType;
  PQueue: typeof PQueueType;
}

let modulesPromise: Promise<PipelineModules> | null = null;

export function loadPipelineModules(): Promise<PipelineModules> {
  if (!modulesPromise) {
    ensurePerfEnv();
    modulesPromise = (async () => {
      const [monitorModule, pqueueModule] = await Promise.all([
        import("../../../electron/workspace-host/WorktreeMonitor"),
        import("p-queue"),
      ]);
      return {
        WorktreeMonitor: monitorModule.WorktreeMonitor,
        PQueue: pqueueModule.default,
      };
    })();
  }
  return modulesPromise;
}

type GitUtilsModule = typeof import("../../../electron/utils/gitUtils");

let gitUtilsPromise: Promise<GitUtilsModule> | null = null;

/**
 * Kept out of loadPipelineModules: only the fault-injection path needs the
 * git-dir resolver, and every scenario that merely imports this fixture would
 * otherwise pay for pulling the logger in.
 */
function loadGitUtils(): Promise<GitUtilsModule> {
  if (!gitUtilsPromise) {
    ensurePerfEnv();
    gitUtilsPromise = import("../../../electron/utils/gitUtils");
  }
  return gitUtilsPromise;
}

// --- Git subprocess counter --------------------------------------------------

export interface GitSpawnEvent {
  atMs: number;
  subcommand: string;
}

/**
 * Every async subprocess, not just git. #12042's Windows symptom was a git
 * storm, but the same report carried `cmd.exe` starts — `@parcel/watcher`
 * probes watchman through `_popen` before reaching the native backend — which
 * a git-only counter reports as zero cost. Recorded as a PARALLEL log rather
 * than by widening the git filter: `GitSpawnWindow.count` means "git spawns"
 * at every existing call site, several of them feeding referenced metrics.
 */
export interface ProcessSpawnEvent {
  atMs: number;
  /** Lowercased executable basename as spawned: "git", "git.exe", "cmd.exe". */
  executable: string;
}

const spawnEvents: GitSpawnEvent[] = [];
const processSpawnEvents: ProcessSpawnEvent[] = [];
let counterInstalled = false;
/** The wrapper this module installed, so a later re-patch is detectable. */
let installedHook: unknown = null;

function isGitExecutable(baseName: string): boolean {
  return baseName === "git" || baseName === "git.exe";
}

function extractSubcommand(args: readonly string[]): string {
  // args[0] is the binary itself; skip `-c key=val` pairs and other flags.
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (token === "-c" || token === "-C") {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return "(none)";
}

/**
 * Count every async git subprocess spawned in this process. Idempotent.
 * ChildProcess.prototype.spawn is the single funnel for child_process.spawn,
 * exec, execFile, and fork, so both simple-git (spawn) and gitUtils
 * (execFile) are captured. The counter is process-global: measurement
 * windows are only meaningful because the harness runs scenarios strictly
 * sequentially and the git-pipeline scenarios stop their monitors before
 * returning — a scenario that leaked background git activity would bleed
 * into later windows.
 */
export function installGitSpawnCounter(): void {
  if (counterInstalled) return;
  counterInstalled = true;
  const proto = ChildProcess.prototype as unknown as {
    spawn: (options: { file?: string; args?: string[] }) => unknown;
  };
  const original = proto.spawn;
  proto.spawn = function (this: ChildProcess, options: { file?: string; args?: string[] }) {
    const file = options?.file ?? "";
    const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
    const baseName = base.toLowerCase();
    const atMs = performance.now();
    processSpawnEvents.push({ atMs, executable: baseName });
    if (isGitExecutable(baseName)) {
      spawnEvents.push({
        atMs,
        subcommand: extractSubcommand(options?.args ?? [file]),
      });
    }
    return original.call(this, options);
  };
  installedHook = proto.spawn;
}

// --- Observer self-validation ------------------------------------------------

let observerProbePassed: boolean | null = null;

/**
 * Make a start the observer MUST see, and report whether it saw it.
 *
 * `process.execPath` is absolute, so this still starts while a fault scenario
 * has PATH pointed at a shim directory, and `-e ""` exits immediately
 * everywhere. The hook fires synchronously inside `spawn()`, so the window
 * below is closed before the child has done anything at all.
 */
function runObserverProbe(): boolean {
  const mark = allSpawnMark();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  } catch {
    return false;
  }
  const observed = allSpawnsSince(mark).count > 0;
  // Never let the probe outlive the call: unref first, then signal, and
  // swallow the async spawn error a failed exec would otherwise throw.
  child.unref();
  child.on("error", () => {});
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  return observed;
}

/**
 * Whether the spawn counter can still be trusted. 0 = proven live.
 *
 * A count of zero has two indistinguishable causes: the subsystem genuinely
 * stopped spawning, or the observer stopped observing. This settles the
 * second, and every counting scenario emits the result as
 * `spawnObserverMisses` so a blind observer never reads as a quiet system.
 * Call it BEFORE opening a measurement window — the probe's own child start
 * would otherwise land inside the count it is validating. The expensive half
 * runs once per process; the cheap half (has anything re-patched the
 * prototype since?) runs on every call.
 *
 * What stays invisible even at 0, because no in-process hook can see it:
 *  - starts made from C++ inside a native addon — `@parcel/watcher` probes
 *    watchman through `_popen`, and better-sqlite3 and node-pty fork their own
 *  - grandchildren: on Windows `exec` starts `cmd.exe`, and PowerShell is that
 *    shell's child, not this process's
 *  - anything a child process spawns after it is running
 *  - `spawnSync`/`execFileSync`, excluded by design so fixture setup can never
 *    land in a measurement
 * So a zero from this counter means "nothing started through Node in THIS
 * process", never "nothing started". The OS-level observer that would close
 * that gap is deliberately out of scope.
 */
export function spawnObserverMisses(): number {
  installGitSpawnCounter();
  const proto = ChildProcess.prototype as unknown as { spawn: unknown };
  if (proto.spawn !== installedHook) return 1;
  if (observerProbePassed === null) observerProbePassed = runObserverProbe();
  return observerProbePassed ? 0 : 1;
}

export interface GitSpawnWindow {
  /** Total git spawns inside the window. */
  count: number;
  /** Spawn counts keyed by git subcommand (status, rev-parse, diff, ...). */
  bySubcommand: Record<string, number>;
  /** performance.now() timestamp of the last spawn, or null when count is 0. */
  lastAtMs: number | null;
}

export function gitSpawnMark(): number {
  return spawnEvents.length;
}

export function gitSpawnsSince(mark: number): GitSpawnWindow {
  const slice = spawnEvents.slice(mark);
  const bySubcommand: Record<string, number> = {};
  for (const event of slice) {
    bySubcommand[event.subcommand] = (bySubcommand[event.subcommand] ?? 0) + 1;
  }
  return {
    count: slice.length,
    bySubcommand,
    lastAtMs: slice.length > 0 ? slice[slice.length - 1].atMs : null,
  };
}

export interface ProcessSpawnWindow {
  /** Total subprocess starts inside the window, git included. */
  count: number;
  /** Starts keyed by lowercased executable basename. */
  byExecutable: Record<string, number>;
  lastAtMs: number | null;
}

export function allSpawnMark(): number {
  return processSpawnEvents.length;
}

/**
 * Executable-bucketed companion to `gitSpawnsSince`. It counts Node
 * `child_process` starts, NOT every process the app creates: the hook patches
 * `ChildProcess.prototype.spawn`, and `@parcel/watcher`'s watchman probe
 * forks from C++ inside `watcher.node`, so a zero here means "nothing spawned
 * through Node", never "nothing spawned".
 */
export function allSpawnsSince(mark: number): ProcessSpawnWindow {
  const slice = processSpawnEvents.slice(mark);
  const byExecutable: Record<string, number> = {};
  for (const event of slice) {
    byExecutable[event.executable] = (byExecutable[event.executable] ?? 0) + 1;
  }
  return {
    count: slice.length,
    byExecutable,
    lastAtMs: slice.length > 0 ? slice[slice.length - 1].atMs : null,
  };
}

/** Starts in the window that were not git — cmd.exe, where.exe, powershell.exe. */
export function nonGitSpawnCount(window: ProcessSpawnWindow): number {
  let total = 0;
  for (const [executable, count] of Object.entries(window.byExecutable)) {
    if (!isGitExecutable(executable)) total += count;
  }
  return total;
}

// --- Fixture repo -----------------------------------------------------------

export const SCALING_WORKTREE_COUNTS = [1, 5, 20, 50] as const;
const MAX_SCALING_WORKTREES = 50;
const BASE_FILE_DIRS = 12;
const BASE_FILES_PER_DIR = 10;
const STORM_MODIFIED_FILES = 100;
const STORM_ADDED_FILES = 40;
const DIRTY_MODIFIED_FILES = 40;
const DIRTY_UNTRACKED_FILES = 12;

export interface GitPipelineFixture {
  root: string;
  /** Main worktree (the repo itself). */
  mainPath: string;
  /** Linked worktrees for the scaling scenarios, length MAX_SCALING_WORKTREES. */
  scalingPaths: string[];
  /** Dedicated clean worktree for the single-pass scenario. */
  soloPath: string;
  /** Worktree with a standing set of modified + untracked files. */
  dirtyPath: string;
  /** Worktree used for checkout storms; alternates between two branches. */
  stormPath: string;
  stormBranches: [string, string];
  /** PERF-105 idle-window worktree (healthy watcher). */
  idlePath: string;
  /** PERF-106 idle-window worktree, exposed to the transient git-dir probe
   *  fault. Kept separate from `idlePath` because the fault poisons a
   *  path-keyed cache for 600s — sharing one worktree would leak the fault
   *  state into the healthy reading. */
  faultPath: string;
  /** PERF-107 worktree whose own `.gitignore` excludes a directory that is
   *  deliberately absent from WORKTREE_IGNORE_GLOBS, so writes there reach the
   *  recursive watcher and have to be classified rather than filtered. */
  ignoredPath: string;
}

/** Directory PERF-107's fixture gitignores. Not a WORKTREE_IGNORE_GLOBS name. */
export const IGNORED_BURST_DIR = ".output";

let fixture: GitPipelineFixture | null = null;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    // Keep setup quiet on success, but preserve Git's diagnostic when a
    // fixture command fails. `stdio: "ignore"` reduced every failure to the
    // command name and made transient filesystem/configuration faults opaque.
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      // Setup isolation only — product-path spawns keep the app's own
      // (hardened) environment so measurements reflect production behavior.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "perf",
      GIT_AUTHOR_EMAIL: "perf@example.invalid",
      GIT_COMMITTER_NAME: "perf",
      GIT_COMMITTER_EMAIL: "perf@example.invalid",
    },
  });
}

function fileBody(seed: string): string {
  let body = "";
  for (let line = 0; line < 40; line++) {
    body += `${seed} line ${line} — deterministic fixture content\n`;
  }
  return body;
}

function writeBaseTree(repoPath: string, revision: string): void {
  // Path count and file size are the workload; unique blob contents are not.
  // Reuse one blob per revision so concurrent test workers do not make Git
  // create hundreds of object-store temp files while this fixture is setting
  // up. Every path is still materialised and every storm path still changes.
  const body = fileBody(revision);
  for (let dir = 0; dir < BASE_FILE_DIRS; dir++) {
    const dirPath = join(repoPath, `module-${dir}`);
    mkdirSync(dirPath, { recursive: true });
    for (let file = 0; file < BASE_FILES_PER_DIR; file++) {
      writeFileSync(join(dirPath, `file-${file}.txt`), body);
    }
  }
}

/**
 * Build the shared fixture once per process: a base repo with a deterministic
 * committed tree, 50 linked worktrees for the scaling curve, plus dedicated
 * solo / dirty / storm worktrees. Setup uses spawnSync so none of it counts
 * toward the git-spawn metrics. Cleaned up on process exit.
 */
export function getGitPipelineFixture(): GitPipelineFixture {
  if (fixture) return fixture;
  ensurePerfEnv();
  installGitSpawnCounter();

  const root = createPerfTempRoot("daintree-perf-git-");
  const mainPath = join(root, "repo");
  mkdirSync(mainPath, { recursive: true });

  git(mainPath, ["init", "-b", "main"]);
  // Pin behavior that a developer's global config could otherwise vary.
  git(mainPath, ["config", "commit.gpgsign", "false"]);
  git(mainPath, ["config", "core.fsmonitor", "false"]);
  writeBaseTree(mainPath, "base");
  git(mainPath, ["add", "-A"]);
  git(mainPath, ["commit", "-m", "base tree"]);

  // Storm target branch: a commit that rewrites a large slice of the tree so
  // `git checkout` between the two branches floods the file watcher.
  git(mainPath, ["checkout", "-b", "storm-alt"]);
  const stormBody = fileBody("storm-alt");
  for (let i = 0; i < STORM_MODIFIED_FILES; i++) {
    const dir = i % BASE_FILE_DIRS;
    const file = i % BASE_FILES_PER_DIR;
    writeFileSync(join(mainPath, `module-${dir}`, `file-${file}.txt`), stormBody);
  }
  const stormExtraDir = join(mainPath, "storm-extra");
  mkdirSync(stormExtraDir, { recursive: true });
  for (let i = 0; i < STORM_ADDED_FILES; i++) {
    writeFileSync(join(stormExtraDir, `extra-${i}.txt`), stormBody);
  }
  git(mainPath, ["add", "-A"]);
  git(mainPath, ["commit", "-m", "storm alternate tree"]);
  git(mainPath, ["checkout", "main"]);

  const scalingPaths: string[] = [];
  for (let i = 0; i < MAX_SCALING_WORKTREES; i++) {
    const wtPath = join(root, `wt-${i}`);
    git(mainPath, ["worktree", "add", wtPath, "-b", `wt-branch-${i}`, "main"]);
    scalingPaths.push(wtPath);
  }

  const soloPath = join(root, "wt-solo");
  git(mainPath, ["worktree", "add", soloPath, "-b", "wt-solo-branch", "main"]);

  const dirtyPath = join(root, "wt-dirty");
  git(mainPath, ["worktree", "add", dirtyPath, "-b", "wt-dirty-branch", "main"]);
  const dirtyBody = fileBody("dirty");
  for (let i = 0; i < DIRTY_MODIFIED_FILES; i++) {
    const dir = i % BASE_FILE_DIRS;
    const file = i % BASE_FILES_PER_DIR;
    writeFileSync(join(dirtyPath, `module-${dir}`, `file-${file}.txt`), dirtyBody);
  }
  for (let i = 0; i < DIRTY_UNTRACKED_FILES; i++) {
    writeFileSync(join(dirtyPath, `untracked-${i}.txt`), dirtyBody);
  }

  const stormPath = join(root, "wt-storm");
  git(mainPath, ["worktree", "add", stormPath, "-b", "storm-base", "main"]);

  const idlePath = join(root, "wt-idle");
  git(mainPath, ["worktree", "add", idlePath, "-b", "wt-idle-branch", "main"]);

  const faultPath = join(root, "wt-fault");
  git(mainPath, ["worktree", "add", faultPath, "-b", "wt-fault-branch", "main"]);

  // PERF-107: a repo that gitignores its own build directory. `.output/` is
  // chosen precisely because it is NOT in WORKTREE_IGNORE_GLOBS — the watcher
  // therefore delivers every write there, which is the whole cost this
  // scenario measures. The directory is created up front so the burst does not
  // also measure a mkdir, and `.gitignore` is committed so the worktree starts
  // clean.
  const ignoredPath = join(root, "wt-ignored");
  git(mainPath, ["worktree", "add", ignoredPath, "-b", "wt-ignored-branch", "main"]);
  writeFileSync(join(ignoredPath, ".gitignore"), `${IGNORED_BURST_DIR}/\n`);
  mkdirSync(join(ignoredPath, IGNORED_BURST_DIR), { recursive: true });
  git(ignoredPath, ["add", ".gitignore"]);
  git(ignoredPath, ["commit", "-m", "ignore build output"]);

  fixture = {
    root,
    mainPath,
    scalingPaths,
    soloPath,
    dirtyPath,
    stormPath,
    stormBranches: ["storm-alt", "storm-base"],
    idlePath,
    faultPath,
    ignoredPath,
  };

  return fixture;
}

/** Run a checkout in the storm worktree via spawnSync (not counted). */
export function checkoutStormBranch(target: string): void {
  const fx = getGitPipelineFixture();
  git(fx.stormPath, ["checkout", target]);
}

// --- Monitor factory ----------------------------------------------------------

export interface MonitorHarnessOptions {
  isCurrent?: boolean;
  gitWatchEnabled?: boolean;
  /** Base polling interval; defaults to 1h so self-scheduled polls stay out
   *  of manually driven measurements. An idle-window scenario MUST override
   *  this — at the default, a monitor that has fallen off the watcher path
   *  schedules its next poll an hour out and reports a perfect zero. */
  basePollingInterval?: number;
  /** Ceiling the adaptive strategy may back off to; defaults to 1h for the
   *  same reason. Pass a realistic value alongside `basePollingInterval`. */
  pollIntervalMax?: number;
  /** Snapshot sink. Defaults to a no-op; idle scenarios pass a recorder so
   *  the paired "was the edit still detected?" reading has something to
   *  observe. */
  onUpdate?: (snapshot: WorktreeSnapshot) => void;
}

/**
 * Mirror of WorkspaceService.addNewWorktreeMonitor's constructor wiring with
 * inert callbacks: no fetch scheduling (hasFetchCallback false → FetchScheduler
 * no-ops), no resource polling, snapshot updates collected in-memory.
 */
export async function createMonitorHarness(
  worktreePath: string,
  branch: string,
  options: MonitorHarnessOptions = {},
  pollQueue?: PQueueType
): Promise<WorktreeMonitorType> {
  const { WorktreeMonitor } = await loadPipelineModules();
  const worktree: Worktree = {
    id: worktreePath,
    path: worktreePath,
    name: branch,
    branch,
    isCurrent: options.isCurrent ?? false,
    isMainWorktree: false,
  };
  const config: WorktreeMonitorConfig = {
    basePollingInterval: options.basePollingInterval ?? 3_600_000,
    adaptiveBackoff: true,
    pollIntervalMax: options.pollIntervalMax ?? 3_600_000,
    circuitBreakerThreshold: 3,
    gitWatchEnabled: options.gitWatchEnabled ?? false,
    gitWatchDebounceMs: 150,
  };
  return new WorktreeMonitor(
    worktree,
    config,
    { onUpdate: options.onUpdate ?? (() => {}) },
    "main",
    pollQueue
  );
}

// --- Transient git-dir probe fault (#12042) ----------------------------------

export interface ProbeFaultOutcome<T> {
  result: T;
  /**
   * The git-dir probe genuinely returned null while the fault was live. False
   * means the apparatus failed, not that the product recovered — read it
   * before reading any spawn count from a fault scenario.
   */
  injected: boolean;
}

/**
 * Reproduce #12042's ONE transient probe failure and then heal the repo.
 *
 * Hiding the worktree's `.git` entry defeats both halves of the resolver:
 * `resolveGitDirFromFs` finds nothing to prove, and the `git rev-parse
 * --git-dir` fallback fails for real. `getGitDir` caches that null for the
 * error TTL (600s) — the wrong turn the recovery state machine never takes
 * back. `.git` is restored before this returns, so everything after it runs
 * against a perfectly healthy repo, which is the whole point: on Windows the
 * repo was fine and only the probe blipped.
 *
 * `fn` runs while the fault is live, and this helper deliberately does NOT
 * populate the cache itself: the PRODUCT's own probe has to be the one that
 * caches the null. Probing first would mask exactly the fixes worth
 * measuring — a caller switching to `cacheErrors: false`, say, would never
 * get the chance to act on a cache this harness had already poisoned. The
 * verification probe therefore runs AFTER `fn`, with `cache: false`, so it
 * proves the fault was live without touching what the product stored.
 *
 * A PATH shim (the obvious way to fail `rev-parse`) would NOT reproduce this:
 * the filesystem fast path resolves a healthy linked worktree without ever
 * forking git.
 */
export async function withGitDirProbeFault<T>(
  worktreePath: string,
  fn: () => Promise<T>
): Promise<ProbeFaultOutcome<T>> {
  const { getGitDir, clearGitDirCache } = await loadGitUtils();
  clearGitDirCache(worktreePath);
  const livePath = join(worktreePath, ".git");
  const hiddenPath = join(worktreePath, ".git.perf-probe-fault");
  renameSync(livePath, hiddenPath);
  try {
    const result = await fn();
    const injected = (await getGitDir(worktreePath, { cache: false })) === null;
    return { result, injected };
  } finally {
    renameSync(hiddenPath, livePath);
  }
}

/**
 * Drop the cached git-dir resolution for one worktree so the next iteration
 * injects its own fault rather than inheriting the previous one's. Best
 * effort by design: the cached null is what a fault scenario is measuring, so
 * a failure to clear it changes nothing except which iteration created it.
 */
export async function clearCachedGitDir(worktreePath: string): Promise<void> {
  const { clearGitDirCache } = await loadGitUtils();
  clearGitDirCache(worktreePath);
}

export function percentileOf(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
