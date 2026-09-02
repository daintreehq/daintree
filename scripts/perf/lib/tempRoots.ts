import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The one owner of every temp directory a perf fixture creates.
 *
 * WHY THIS EXISTS. Fixtures used to clean up with a bare
 * `process.on("exit", () => rmSync(dir))`. That works under `scripts/perf/run.ts`,
 * which ends by calling `process.exit`. It does NOT work under vitest, whose
 * `forks` pool terminates each worker with SIGTERM — and a process with no
 * SIGTERM listener dies on the default disposition without ever emitting
 * `exit`, so the handler is never called. Every `npm test` therefore leaked one
 * directory per fixture that a test file touched; ~360 of them had piled up in
 * `$TMPDIR` before anyone counted.
 *
 * WHAT IT DOES. One process-wide registry, removed on `exit` and on each
 * termination signal. Registration happens at creation, before anything is
 * written into the directory, so a scenario that throws mid-build still cleans
 * up — a fixture that only removes its directory on the happy path is the other
 * half of how the leak grew.
 *
 * Cleanup is always best-effort: a directory that will not delete is noise, and
 * must never turn a completed measurement into a failed run.
 */

const roots = new Set<string>();
let hooksInstalled = false;

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];

/** Returns whether the directory is gone. Never throws; see the module comment. */
function remove(root: string): boolean {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

function removeAll(): void {
  // Keep a failed removal registered. Liveness children call cleanup before
  // process.exit and the exit hook calls it again, giving transient writers or
  // native watcher teardown a second bounded chance instead of forgetting the
  // root after the first ENOTEMPTY/EBUSY result.
  for (const root of [...roots]) {
    if (remove(root)) roots.delete(root);
  }
}

function onSignal(signal: TerminationSignal): void {
  removeAll();
  // Having a listener at all is what suppresses the signal's default
  // disposition, so without this the process would survive a kill it was meant
  // to die from. The listener was registered with `once` and has now been
  // removed, so re-raising with nobody else listening reaches the default
  // handler and terminates exactly as it would have without this module. If
  // something else is managing the signal, it is left to decide.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", removeAll);
  for (const signal of TERMINATION_SIGNALS) {
    process.once(signal, () => onSignal(signal));
  }
}

export interface PerfTempRootOptions {
  /**
   * Resolve the result through `realpath`.
   *
   * Matters on macOS, where `mkdtemp` hands back `/var/…` while git and
   * `fs.realpath` report `/private/var/…`. A fixture that compares a canonical
   * path against its root needs both spellings to agree.
   */
  canonical?: boolean;
  /** Create under this directory instead of `os.tmpdir()`. */
  parent?: string;
}

/**
 * Create a temp directory this module owns and will remove.
 *
 * `prefix` is the full `mkdtemp` prefix, e.g. `"daintree-perf-hydration-"`.
 */
export function createPerfTempRoot(prefix: string, options: PerfTempRootOptions = {}): string {
  installHooks();
  const created = mkdtempSync(join(options.parent ?? tmpdir(), prefix));
  const root = options.canonical === true ? realpathSync(created) : created;
  roots.add(root);
  return root;
}

/**
 * Adopt a directory this module did not create, for the few callers that are
 * handed one (an explicit `--user-data-dir`, a path inherited from the
 * environment). Returns the path so it can be used inline.
 */
export function registerPerfTempRoot(root: string): string {
  installHooks();
  roots.add(root);
  return root;
}

/**
 * Remove one owned root now, rather than at process exit.
 *
 * A removal that fails leaves the root registered, so the exit/signal sweep
 * gets a second attempt at it.
 */
export function releasePerfTempRoot(root: string): void {
  if (remove(root)) roots.delete(root);
}

/**
 * Remove every owned root now.
 *
 * Exported for callers that want their directories gone before the process
 * ends — a vitest `afterAll`, or a fixture's own `dispose`. The `exit` and
 * signal hooks stay installed, so anything created afterwards is still covered.
 */
export function cleanupPerfTempRoots(): void {
  removeAll();
}

/** How many temp roots this process currently owns. For hygiene assertions. */
export function ownedPerfTempRootCount(): number {
  return roots.size;
}
