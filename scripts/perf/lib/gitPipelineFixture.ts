import { ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type PQueueType from "p-queue";
import type { WorktreeMonitor as WorktreeMonitorType } from "../../../electron/workspace-host/WorktreeMonitor";
import type { WorktreeMonitorConfig } from "../../../electron/workspace-host/WorktreeMonitor";
import type { Worktree } from "../../../shared/types/worktree";

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
  process.env.DAINTREE_USER_DATA ??= mkdtempSync(join(tmpdir(), "daintree-perf-userdata-"));
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

// --- Git subprocess counter --------------------------------------------------

export interface GitSpawnEvent {
  atMs: number;
  subcommand: string;
}

const spawnEvents: GitSpawnEvent[] = [];
let counterInstalled = false;

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
    if (baseName === "git" || baseName === "git.exe") {
      spawnEvents.push({
        atMs: performance.now(),
        subcommand: extractSubcommand(options?.args ?? [file]),
      });
    }
    return original.call(this, options);
  };
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
}

let fixture: GitPipelineFixture | null = null;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
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
  for (let dir = 0; dir < BASE_FILE_DIRS; dir++) {
    const dirPath = join(repoPath, `module-${dir}`);
    mkdirSync(dirPath, { recursive: true });
    for (let file = 0; file < BASE_FILES_PER_DIR; file++) {
      writeFileSync(join(dirPath, `file-${file}.txt`), fileBody(`${revision} ${dir}/${file}`));
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

  const root = mkdtempSync(join(tmpdir(), "daintree-perf-git-"));
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
  for (let i = 0; i < STORM_MODIFIED_FILES; i++) {
    const dir = i % BASE_FILE_DIRS;
    const file = i % BASE_FILES_PER_DIR;
    writeFileSync(
      join(mainPath, `module-${dir}`, `file-${file}.txt`),
      fileBody(`storm-alt ${dir}/${file}`)
    );
  }
  const stormExtraDir = join(mainPath, "storm-extra");
  mkdirSync(stormExtraDir, { recursive: true });
  for (let i = 0; i < STORM_ADDED_FILES; i++) {
    writeFileSync(join(stormExtraDir, `extra-${i}.txt`), fileBody(`storm-extra ${i}`));
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
  for (let i = 0; i < DIRTY_MODIFIED_FILES; i++) {
    const dir = i % BASE_FILE_DIRS;
    const file = i % BASE_FILES_PER_DIR;
    writeFileSync(
      join(dirtyPath, `module-${dir}`, `file-${file}.txt`),
      fileBody(`dirty ${dir}/${file}`)
    );
  }
  for (let i = 0; i < DIRTY_UNTRACKED_FILES; i++) {
    writeFileSync(join(dirtyPath, `untracked-${i}.txt`), fileBody(`untracked ${i}`));
  }

  const stormPath = join(root, "wt-storm");
  git(mainPath, ["worktree", "add", stormPath, "-b", "storm-base", "main"]);

  fixture = {
    root,
    mainPath,
    scalingPaths,
    soloPath,
    dirtyPath,
    stormPath,
    stormBranches: ["storm-alt", "storm-base"],
  };

  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  });

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
   *  of manually driven measurements. */
  basePollingInterval?: number;
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
    pollIntervalMax: 3_600_000,
    circuitBreakerThreshold: 3,
    gitWatchEnabled: options.gitWatchEnabled ?? false,
    gitWatchDebounceMs: 150,
  };
  return new WorktreeMonitor(worktree, config, { onUpdate: () => {} }, "main", pollQueue);
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
