import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { performance, type EventLoopUtilization } from "node:perf_hooks";
import type { ProcessTreeCache as ProcessTreeCacheType } from "../../../electron/services/ProcessTreeCache";
import { windowsSystemTool } from "../../../electron/utils/windowsExecutable";
import {
  allSpawnMark,
  allSpawnsSince,
  gitSpawnMark,
  gitSpawnsSince,
  installGitSpawnCounter,
  sleep,
  spawnObserverMisses,
} from "./gitPipelineFixture";
import { createPerfTempRoot, releasePerfTempRoot } from "./tempRoots";

/**
 * Fixture for the idle-window scenarios (PERF-092..094).
 *
 * These scenarios idle REAL long-lived services and count what those services
 * actually do — the predecessor scenarios (PERF-090/091) hand-wrote a list of
 * timer groups and did arithmetic over it, so no product code ever ran and the
 * numbers were identical on every machine forever.
 *
 * The subprocess counters are reused wholesale from `gitPipelineFixture`
 * rather than re-patched here: `ChildProcess.prototype.spawn` must be wrapped
 * exactly once per process, and that module's hook already covers every async
 * `child_process` start (spawn/exec/execFile/fork). `execFileSync`/`execSync`
 * go through `spawnSync`, which does NOT route through `ChildProcess`, so
 * every setup and verification call in this file is invisible to the counters
 * by construction.
 *
 * Nothing here runs at import: the perf harness loads every scenario module up
 * front, so building fixtures or importing product code eagerly would charge
 * every run for scenarios it never selected.
 */

// --- Environment isolation ---------------------------------------------------
// ProcessTreeCache pulls in the logger, which resolves its file destination
// from DAINTREE_USER_DATA at module eval. Product modules are therefore only
// ever loaded through the lazy loader below.

let envReady = false;

function ensureIdlePerfEnv(): void {
  if (envReady) return;
  process.env.DAINTREE_USER_DATA ??= createPerfTempRoot("daintree-perf-userdata-");
  process.env.DAINTREE_INSTANCE_ROLE ??= "worker";
  envReady = true;
}

type ProcessTreeCacheModule = typeof import("../../../electron/services/ProcessTreeCache");

let cacheModulePromise: Promise<ProcessTreeCacheModule> | null = null;

export function loadProcessTreeCacheModule(): Promise<ProcessTreeCacheModule> {
  if (!cacheModulePromise) {
    ensureIdlePerfEnv();
    installGitSpawnCounter();
    cacheModulePromise = import("../../../electron/services/ProcessTreeCache");
  }
  return cacheModulePromise;
}

/**
 * The pty-host's own constructor value (`new ProcessTreeCache(1500)`), not a
 * benchmark-chosen number. It is also the fastest cadence the product ever
 * runs at, so it is the honest worst case for an idle reading — the resource
 * profiles only ever stretch it (2000/2500/5000).
 */
export const PROCESS_TREE_POLL_INTERVAL_MS = 1_500;

/**
 * ProcessTreeCache's adaptive backoff climbs 1.5x per unchanged poll to a
 * 15s ceiling, so a window shorter than the full ramp reads the expensive
 * early part of idle and calls it steady state. 1500ms compounding to the
 * ceiling takes ~46s; 15s covers the first five steps, which is where a
 * regression that pins the poller at base rate becomes unmistakable
 * (10 polls vs 5) without paying 46s per iteration.
 */
export const IDLE_WINDOW_MS = 15_000;

export interface ProcessTreeHarness {
  cache: ProcessTreeCacheType;
  /**
   * Refresh callbacks observed since construction. NOT a success count: the
   * service fires them from a `finally`, so a poll that threw increments this
   * exactly like one that parsed. Pair it with `isHealthy()` whenever the
   * question is "did a poll succeed" rather than "did a poll happen".
   */
  refreshCount: () => number;
  /** A poll has completed successfully and nothing has failed since. */
  isHealthy: () => boolean;
  /** The service's own record of a failing probe — the fault it can see. */
  hasObservedFailure: () => boolean;
  stop: () => void;
}

/**
 * A real ProcessTreeCache with a real subscriber.
 *
 * The subscriber is not decoration: `refresh()` returns early and polls a
 * no-op forever when `refreshCallbacks` is empty (#5813's zero-subscriber
 * skip). A harness without one measures a service that deliberately does
 * nothing and reports it as a perfect zero.
 */
export async function createProcessTreeHarness(
  pollIntervalMs = PROCESS_TREE_POLL_INTERVAL_MS
): Promise<ProcessTreeHarness> {
  const { ProcessTreeCache } = await loadProcessTreeCacheModule();
  const cache = new ProcessTreeCache(pollIntervalMs);
  let refreshes = 0;
  // start() before onRefresh(), in that order: start() refuses with an
  // "Already started" warning if a refresh is in flight, and subscribing first
  // puts one there. This is also the product's own order — pty-host.ts starts
  // the cache and ProcessDetectors attach afterwards.
  cache.start();
  const unsubscribe = cache.onRefresh(() => {
    refreshes += 1;
  });
  return {
    cache,
    refreshCount: () => refreshes,
    isHealthy: () => cache.getLastRefreshTime() > 0 && cache.getLastError() === null,
    hasObservedFailure: () => cache.getLastError() !== null,
    stop: () => {
      unsubscribe();
      cache.stop();
    },
  };
}

// --- Idle measurement window --------------------------------------------------

export interface OpenIdleWindow {
  observerMisses: number;
  gitMark: number;
  allMark: number;
  cpu: NodeJS.CpuUsage;
  elu: EventLoopUtilization;
  startedAt: number;
}

export interface IdleWindowReading {
  windowMs: number;
  /** In-process CPU time consumed across the window, user + system. */
  cpuMs: number;
  cpuMsPerIdleSec: number;
  /** Share of the window the event loop was executing rather than parked. */
  eluPct: number;
  gitSpawns: number;
  subprocessSpawns: number;
  byExecutable: Record<string, number>;
  /**
   * 0 when the spawn counter proved itself able to see a known start just
   * before this window opened. Non-zero means the counts below are not
   * authoritative — read them as absent, not as low.
   */
  spawnObserverMisses: number;
}

export function openIdleWindow(): OpenIdleWindow {
  installGitSpawnCounter();
  // Before the marks, never after: the probe starts a real child, and that
  // start must land outside the window whose observer it is validating.
  const observerMisses = spawnObserverMisses();
  return {
    observerMisses,
    gitMark: gitSpawnMark(),
    allMark: allSpawnMark(),
    cpu: process.cpuUsage(),
    elu: performance.eventLoopUtilization(),
    startedAt: performance.now(),
  };
}

/**
 * Close a window opened by {@link openIdleWindow}.
 *
 * `cpuMs` is RUSAGE_SELF: it covers the parse, the timer callbacks and the
 * bookkeeping this process does, and NOT the CPU burned by the `ps` /
 * `powershell` children it forks. That out-of-process cost is what
 * `subprocessSpawns` stands in for — the two metrics have to be read
 * together, and neither is a substitute for the other.
 */
export function closeIdleWindow(open: OpenIdleWindow): IdleWindowReading {
  const windowMs = performance.now() - open.startedAt;
  const cpu = process.cpuUsage(open.cpu);
  const elu = performance.eventLoopUtilization(open.elu);
  const allWindow = allSpawnsSince(open.allMark);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return {
    windowMs,
    cpuMs,
    // Guarded rather than assumed: run.ts throws on a non-finite metric, and a
    // zero-length window is one clock-resolution accident away.
    cpuMsPerIdleSec: windowMs > 0 ? (cpuMs * 1000) / windowMs : 0,
    eluPct: Number.isFinite(elu.utilization) ? elu.utilization * 100 : 0,
    gitSpawns: gitSpawnsSince(open.gitMark).count,
    subprocessSpawns: allWindow.count,
    byExecutable: allWindow.byExecutable,
    spawnObserverMisses: open.observerMisses,
  };
}

/**
 * Executables that ARE the process-tree probe, as Node starts them.
 *
 * Windows is the case that matters: `refreshWindows` launches PowerShell
 * directly with `execFile`, so the observer sees that executable rather than
 * an intermediary `cmd.exe`.
 */
const PROBE_EXECUTABLES: ReadonlySet<string> =
  process.platform === "win32"
    ? new Set(["powershell.exe", "powershell", "pwsh.exe", "pwsh"])
    : new Set(["ps"]);

/** Spawns in the window whose executable is the process-tree probe itself. */
export function processProbeSpawnCount(byExecutable: Record<string, number>): number {
  let total = 0;
  for (const [executable, count] of Object.entries(byExecutable)) {
    if (PROBE_EXECUTABLES.has(executable)) total += count;
  }
  return total;
}

// --- Transient probe fault ----------------------------------------------------

export interface ProbeFaultHandle {
  dir: string;
  previousPath: string | undefined;
  previousSystemRoot: string | undefined;
  probeChildEnv: NodeJS.ProcessEnv;
}

/**
 * Break the process-tree probe for real, then heal it.
 *
 * POSIX resolves `ps` through PATH; Windows resolves PowerShell under
 * SystemRoot. Redirect the resolver each product probe actually uses to an
 * isolated failing executable, leaving the real system files alone.
 *
 * A failing POSIX script or invalid Windows executable makes the OS probe
 * reject on the product's normal error path.
 *
 * SystemRoot is read at CreateProcess time, so on Windows the fault only bites a
 * census that starts a process. Since #12243 the census is served by one
 * persistent helper, resolved before the shim existed — so a caller that has
 * one passes its PID and it is killed here. That is the same fault the shim
 * is: the census loses its probe, and the replacement it starts is the one the
 * shim intercepts. Without it the Windows arm of a fault scenario measures a
 * perfectly healthy census under a misleading name.
 */
export function installProcessProbeFault(censusHelperPid?: number | null): ProbeFaultHandle {
  const dir = createPerfTempRoot("daintree-perf-probe-fault-");
  const probeChildEnv = { ...process.env };
  const previousSystemRoot = process.env.SystemRoot;
  if (process.platform === "win32") {
    const shim = windowsSystemTool("powershell.exe", { SystemRoot: dir });
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, "not a Windows executable\r\n");
    process.env.SystemRoot = dir;
  } else {
    const shim = join(dir, "ps");
    writeFileSync(shim, "#!/bin/sh\nexit 1\n");
    chmodSync(shim, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  if (process.platform === "win32" && censusHelperPid) {
    try {
      process.kill(censusHelperPid);
    } catch {
      // Already gone, which is the state this was trying to reach.
    }
  }
  return { dir, previousPath, previousSystemRoot, probeChildEnv };
}

export function removeProcessProbeFault(handle: ProbeFaultHandle): void {
  if (process.platform === "win32") {
    if (handle.previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = handle.previousSystemRoot;
  }
  if (handle.previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = handle.previousPath;
  }
  // Best-effort; restoring the resolver environment above is what matters. If it fails, the root
  // stays registered for the exit/signal sweep.
  releasePerfTempRoot(handle.dir);
}

/**
 * Whether the process-tree probe currently succeeds, resolved the same way
 * the product resolves it.
 *
 * Run through the sync APIs so the check never lands in a spawn count, and
 * called on BOTH sides of the fault: a fault scenario that cannot prove the
 * probe was broken has measured a healthy system under a misleading name.
 */
export function processProbeWorks(): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync(
        windowsSystemTool("powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        {
          stdio: "ignore",
          timeout: 20_000,
          windowsHide: true,
        }
      );
    } else {
      execFileSync("ps", ["-eo", "pid"], { stdio: "ignore", timeout: 10_000 });
    }
    return true;
  } catch {
    return false;
  }
}

// --- Discovery probe child ------------------------------------------------------

export interface ProbeChild {
  pid: number | null;
  kill: () => void;
}

/**
 * A real child process for the paired correctness reading.
 *
 * `process.execPath` is deliberate: it is absolute, so it still starts while
 * the probe fault has PATH pointed at a shim directory, and it exists on every
 * platform the harness runs on. During a Windows fault, pass the pre-fault
 * environment so the child itself doesn't inherit the broken SystemRoot.
 */
export function spawnProbeChild(
  lifetimeMs = 120_000,
  startupCpuMs = 0,
  env?: NodeJS.ProcessEnv
): ProbeChild {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const until = Date.now() + ${startupCpuMs}; while (Date.now() < until) Math.sqrt(12345); setTimeout(() => {}, ${lifetimeMs})`,
    ],
    {
      stdio: "ignore",
      env,
    }
  );
  child.unref();
  const pid = child.pid ?? null;
  return {
    pid,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
}

// --- Worktree change probe ------------------------------------------------------

function git(worktreePath: string, args: string[]): void {
  execFileSync("git", args, { cwd: worktreePath, stdio: "ignore", timeout: 30_000 });
}

/**
 * Stage a file so an UNWATCHED worktree monitor can actually see it.
 *
 * StatPrecheck's baseline is four `.git` metadata files, so a pure
 * working-tree write perturbs nothing and stays invisible to a polling
 * monitor until the 120s full-status budget expires — an edit-only probe on a
 * watcher-less fleet would report `detectionMisses: 1` on a perfectly healthy
 * system. Staging touches the worktree's own index, which is exactly what the
 * pre-check watches, so this drives the real
 * stat-miss → full-status-pass → snapshot-emit chain that a user staging a
 * file drives. Sync git, so none of it lands in a spawn count.
 */
export function stageProbeFile(worktreePath: string, fileName: string): void {
  git(worktreePath, ["add", "--", fileName]);
}

/** Restore the worktree to its pre-probe state. Best effort. */
export function unstageProbeFile(worktreePath: string, fileName: string): void {
  try {
    git(worktreePath, ["reset", "-q", "--", fileName]);
  } catch {
    // Nothing was staged, or the file never existed.
  }
}

/**
 * Wait for a live pid to appear in the cache, i.e. for the poller to still be
 * doing its job. Returns the observed latency, or null on timeout — the caller
 * turns null into a `*Misses` metric rather than into a silent zero.
 */
export async function waitForProcessDiscovery(
  cache: ProcessTreeCacheType,
  pid: number,
  timeoutMs: number
): Promise<number | null> {
  const start = performance.now();
  const deadline = start + timeoutMs;
  while (performance.now() < deadline) {
    if (cache.getProcess(pid) !== undefined) return performance.now() - start;
    await sleep(50);
  }
  return cache.getProcess(pid) !== undefined ? performance.now() - start : null;
}
