/**
 * Subprocess spawn census for the idle harness (#12521). Counts every Node
 * child-process launch in this process by command, in one-second buckets, and
 * periodically writes the counts to a per-process JSON file the harness reads
 * after its window closes.
 *
 * Off unless `DAINTREE_IDLE_SPAWN_CENSUS_DIR` is set, which only the idle
 * harness runner does. Main installs it before anything else loads and clears
 * the variable in packaged builds, so the pty-host and workspace-host — which
 * inherit main's environment — never see it there either. Terminal shells do
 * not inherit it: the PTY environment filter strips every `DAINTREE_*` key.
 *
 * In-process interception, not OS exec tracing: macOS has no unprivileged way
 * to observe `exec`, and the costs the harness looks for (the pty-host's `ps`
 * polling, git status passes) are Node launches. Anything a terminal's shell
 * runs, and PTYs spawned natively by node-pty, are out of scope by design.
 *
 * Async launches all funnel through `ChildProcess.prototype.spawn`. The sync
 * family does not, so `spawnSync`/`execSync`/`execFileSync` are wrapped on the
 * module and republished to ESM importers with `syncBuiltinESMExports`.
 *
 * Counts attempts, recorded before Node launches anything: a launch that fails
 * with ENOENT has still paid for the fork, which is the cost being measured.
 */

import childProcess, { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

export const SPAWN_CENSUS_DIR_ENV = "DAINTREE_IDLE_SPAWN_CENSUS_DIR";
export const SPAWN_CENSUS_VERSION = 1;

const FLUSH_INTERVAL_MS = 5_000;
/** Twice the runner's longest window, so a whole window survives to be read. */
const BUCKET_RETENTION_S = 7_200;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "cmd.exe", "powershell.exe"]);

export interface SpawnCensusFile {
  version: number;
  role: string;
  pid: number;
  startedAtMs: number;
  flushedAtMs: number;
  exited: boolean;
  /** Epoch second -> command -> launches that second. */
  buckets: Record<string, Record<string, number>>;
}

interface CensusState {
  role: string;
  dir: string;
  startedAtMs: number;
  buckets: Map<number, Map<string, number>>;
  suppressDepth: number;
  restore: () => void;
}

let state: CensusState | null = null;

/**
 * A stable, argument-free key for a launch. Full arguments are never kept:
 * they can carry paths and user data, and the harness only needs "what ran".
 * A shell running `-c` is keyed by the first word of its command string, so
 * `exec("ps -o ...")` counts as `sh -c ps` rather than an opaque `sh`.
 */
export function commandKey(file: unknown, args: readonly unknown[] = []): string {
  if (typeof file !== "string" || file.length === 0) return "(unknown)";
  const base = path.basename(file);
  if (SHELLS.has(base.toLowerCase())) {
    const flagIndex = args.findIndex((arg) => arg === "-c" || arg === "/c" || arg === "/C");
    const command = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
    if (typeof command === "string") {
      const first = command.trim().split(/\s+/)[0];
      if (first) return `${base} -c ${path.basename(first.replace(/^["']|["']$/g, ""))}`;
    }
  }
  return base;
}

function record(key: string): void {
  if (!state || state.suppressDepth > 0) return;
  const second = Math.floor(Date.now() / 1000);
  let bucket = state.buckets.get(second);
  if (!bucket) {
    bucket = new Map();
    state.buckets.set(second, bucket);
  }
  bucket.set(key, (bucket.get(key) ?? 0) + 1);
}

/**
 * The key for a sync launch. The sync APIs overload on position — options may
 * sit where the argument list goes — and `shell` may name the shell to use.
 */
function syncCommandKey(file: unknown, args: unknown, options: unknown): string {
  const argv = Array.isArray(args) ? args : [];
  const opts = (Array.isArray(args) || args == null ? options : args) as
    { shell?: unknown } | undefined;
  if (!opts?.shell) return commandKey(file, argv);
  const shell = typeof opts.shell === "string" ? opts.shell : "sh";
  return commandKey(shell, ["-c", [file, ...argv].join(" ")]);
}

/** Snapshot of this process's census, in the on-disk shape. */
export function readSpawnCensus(exited = false): SpawnCensusFile | null {
  if (!state) return null;
  const buckets: Record<string, Record<string, number>> = {};
  for (const [second, counts] of state.buckets) {
    buckets[String(second)] = Object.fromEntries(counts);
  }
  return {
    version: SPAWN_CENSUS_VERSION,
    role: state.role,
    pid: process.pid,
    startedAtMs: state.startedAtMs,
    flushedAtMs: Date.now(),
    exited,
    buckets,
  };
}

/**
 * Write the census atomically (temp file + rename) so a reader never sees a
 * torn file. Synchronous because the exit path cannot await, and at one small
 * file every few seconds the cost is below what the harness can resolve.
 */
export function flushSpawnCensus(exited = false): void {
  if (!state) return;
  const cutoff = Math.floor(Date.now() / 1000) - BUCKET_RETENTION_S;
  for (const second of state.buckets.keys()) {
    if (second < cutoff) state.buckets.delete(second);
  }
  const snapshot = readSpawnCensus(exited);
  if (!snapshot) return;
  // Start time in the name: a later process that reuses this pid gets its own file.
  const target = path.join(state.dir, `${state.role}-${process.pid}-${state.startedAtMs}.json`);
  const temp = `${target}.tmp`;
  try {
    fs.mkdirSync(state.dir, { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(snapshot));
    fs.renameSync(temp, target);
  } catch {
    // A lost flush shows up as stale coverage in the harness report.
  }
}

/**
 * Run `fn` without counting the launches it makes. For the harness's own
 * samplers, so the measurement does not count itself. Only covers launches
 * made synchronously inside `fn` — which is every launch, since the spawn
 * syscall happens inside the `spawn`/`execFile` call itself.
 */
export function runUncounted<T>(fn: () => T): T {
  if (!state) return fn();
  state.suppressDepth++;
  try {
    return fn();
  } finally {
    state.suppressDepth--;
  }
}

export function isSpawnCensusInstalled(): boolean {
  return state !== null;
}

/**
 * Install the census when the runner asked for one. `allowed` is false in
 * packaged builds: the variable is then deleted so no child inherits it.
 */
export function installSpawnCensusFromEnv(role: string, { allowed = true } = {}): boolean {
  const dir = process.env[SPAWN_CENSUS_DIR_ENV];
  if (!dir) return false;
  if (!allowed) {
    delete process.env[SPAWN_CENSUS_DIR_ENV];
    return false;
  }
  return installSpawnCensus(role, dir);
}

export function installSpawnCensus(role: string, dir: string): boolean {
  if (state) return false;

  const proto = ChildProcess.prototype as unknown as {
    spawn: (options: { file?: unknown; args?: unknown[] }) => unknown;
  };
  const originalSpawn = proto.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalExecSync = childProcess.execSync;
  const originalExecFileSync = childProcess.execFileSync;

  proto.spawn = function (this: ChildProcess, options) {
    record(commandKey(options?.file, options?.args ?? []));
    return originalSpawn.call(this, options);
  };

  // Rest parameters so each call reaches Node with exactly the arguments the
  // caller passed — the sync APIs overload on argument position.
  type Variadic = (...args: unknown[]) => unknown;
  const patched = childProcess as unknown as Record<string, unknown>;
  patched.spawnSync = function (...callArgs: unknown[]) {
    record(syncCommandKey(callArgs[0], callArgs[1], callArgs[2]));
    return (originalSpawnSync as Variadic).apply(childProcess, callArgs);
  };
  patched.execSync = function (...callArgs: unknown[]) {
    // Always a shell; `options.shell` only chooses which.
    const shell = (callArgs[1] as { shell?: unknown } | undefined)?.shell;
    record(syncCommandKey(callArgs[0], undefined, { shell: shell || true }));
    return (originalExecSync as Variadic).apply(childProcess, callArgs);
  };
  patched.execFileSync = function (...callArgs: unknown[]) {
    record(syncCommandKey(callArgs[0], callArgs[1], callArgs[2]));
    return (originalExecFileSync as Variadic).apply(childProcess, callArgs);
  };
  syncBuiltinESMExports();

  const onExit = () => flushSpawnCensus(true);
  process.on("exit", onExit);

  const flushTimer = setInterval(() => flushSpawnCensus(false), FLUSH_INTERVAL_MS);
  flushTimer.unref();

  state = {
    role,
    dir,
    startedAtMs: Date.now(),
    buckets: new Map(),
    suppressDepth: 0,
    restore: () => {
      proto.spawn = originalSpawn;
      patched.spawnSync = originalSpawnSync;
      patched.execSync = originalExecSync;
      patched.execFileSync = originalExecFileSync;
      syncBuiltinESMExports();
      process.off("exit", onExit);
      clearInterval(flushTimer);
    },
  };
  flushSpawnCensus(false);
  return true;
}

/** Test seam: undo the patches and forget all counts. */
export function uninstallSpawnCensus(): void {
  state?.restore();
  state = null;
}
