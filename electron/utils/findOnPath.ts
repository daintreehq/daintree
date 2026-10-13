import { constants as fsConstants, promises as fsp } from "fs";
import path from "path";

/**
 * In-process POSIX `PATH` lookup: what `which` answers, without spawning
 * `which`. The external command is not part of a minimal Linux install —
 * Fedora containers ship without it and Arch keeps it out of `base` — so on
 * those systems every probe built on it read every tool as missing.
 *
 * POSIX only. Windows callers keep `where.exe`, which owns PATHEXT resolution.
 *
 * Semantics, matching `which` where it is well defined:
 * - A command containing `/` is checked as written (relative to the process
 *   cwd, as the child `which` would have) and is never searched for.
 * - Otherwise each `PATH` entry is joined with the command, in order; the first
 *   regular file the process may execute (`X_OK`) wins. Directories and files
 *   without an execute bit are skipped, not reported.
 * - Symlinks are followed: a link to an executable counts, a dangling one does
 *   not, and the path returned is the link as found on `PATH`.
 * - Empty and relative `PATH` entries are ignored. POSIX reads an empty entry
 *   as the current directory, but a GUI app's cwd is wherever it was launched
 *   from (often `/`), and a result relative to it would mean nothing to a
 *   caller that stores or displays the path.
 */

/**
 * Most libuv threadpool threads PATH probing may hold at once, across every
 * caller. An entry on a hung network mount blocks its `stat`/`access` for as
 * long as the mount stays hung, and the pool has four threads shared with all
 * other fs work in the process — so probes queue for one of two slots rather
 * than each taking a thread of their own.
 */
const MAX_CONCURRENT_PATH_PROBES = 2;
let activeProbes = 0;
const probeQueue: Array<() => void> = [];

/**
 * Runs `task` once a slot is free. Aborting `signal` while the task is still
 * queued drops it from the queue and rejects with the abort reason, so a lookup
 * that gave up behind two hung probes leaves nothing behind to run later.
 */
export function withPathProbeSlot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      const index = probeQueue.indexOf(run);
      if (index !== -1) probeQueue.splice(index, 1);
      reject(signal?.reason);
    };
    const run = () => {
      signal?.removeEventListener("abort", onAbort);
      activeProbes++;
      new Promise<T>((settle) => settle(task())).then(resolve, reject).finally(() => {
        activeProbes--;
        probeQueue.shift()?.();
      });
    };
    if (activeProbes < MAX_CONCURRENT_PATH_PROBES) {
      run();
      return;
    }
    probeQueue.push(run);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Test seam — lookups waiting for a probe slot. */
export function __pathProbeQueueDepthForTests(): number {
  return probeQueue.length;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export interface FindOnPathOptions {
  /** Environment whose `PATH` is searched. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Give up after this long. A lookup that confirmed nothing by then reports
   * nothing found — the outcome a timed-out `which` had — while
   * {@link findAllOnPath} keeps the matches it had already confirmed. Probes
   * still queued are dropped rather than run late.
   */
  timeoutMs?: number;
}

async function isExecutableFile(candidate: string, signal: AbortSignal): Promise<boolean> {
  try {
    // access first: it is the cheap miss for the common case (ENOENT), and the
    // stat only runs on a hit to rule out a directory, which passes X_OK.
    await fsp.access(candidate, fsConstants.X_OK);
    if (signal.aborted) return false;
    return (await fsp.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function searchCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (!command) return [];
  if (command.includes("/")) return [command];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || !path.posix.isAbsolute(dir)) continue;
    // Appended, not path.join()ed: joining would collapse `link/..` lexically,
    // while the kernel resolves `..` against wherever the link points.
    const candidate = dir.endsWith("/") ? dir + command : `${dir}/${command}`;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * What identifies an install: the file a match resolves to. Falls back to the
 * spelling when the link was removed between the probe and this call.
 */
async function fileIdentity(match: string): Promise<string> {
  try {
    return await fsp.realpath(match);
  } catch {
    return match;
  }
}

/** Appends each distinct match to `matches` as it is confirmed. */
async function walk(
  command: string,
  env: NodeJS.ProcessEnv,
  all: boolean,
  signal: AbortSignal,
  matches: string[]
): Promise<string[]> {
  const identities = new Set<string>();
  for (const candidate of searchCandidates(command, env)) {
    if (signal.aborted) break;
    let identity: string | null;
    try {
      identity = await withPathProbeSlot(async () => {
        if (signal.aborted || !(await isExecutableFile(candidate, signal))) return null;
        if (!all) return candidate;
        return signal.aborted ? null : fileIdentity(candidate);
      }, signal);
    } catch (err) {
      if (signal.aborted) break;
      throw err;
    }
    if (identity === null) continue;
    if (identities.has(identity)) continue;
    identities.add(identity);
    matches.push(candidate);
    if (!all) break;
  }
  return matches;
}

async function bounded(
  command: string,
  all: boolean,
  options: FindOnPathOptions | undefined
): Promise<string[]> {
  const env = options?.env ?? process.env;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const matches: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve([...matches]);
    }, timeoutMs);
  });
  try {
    return await Promise.race([walk(command, env, all, controller.signal, matches), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The first executable `command` on `PATH`, or `null` (`which <command>`). */
export async function findOnPath(
  command: string,
  options?: FindOnPathOptions
): Promise<string | null> {
  return (await bounded(command, false, options))[0] ?? null;
}

/**
 * Every distinct executable `command` on `PATH`, in `PATH` order
 * (`which -a <command>`). Entries that resolve to the same file are one
 * install, not two: on merged-/usr systems `/bin` links to `/usr/bin`, and a
 * PATH carrying both must not read as a duplicate install. The first spelling
 * found is the one kept.
 */
export function findAllOnPath(command: string, options?: FindOnPathOptions): Promise<string[]> {
  return bounded(command, true, options);
}
