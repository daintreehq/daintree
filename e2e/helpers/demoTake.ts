import { execFileSync, spawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { removePathSync } from "./fixtures";
import { readProfileManifest, restoreProfile } from "./demoProfile";

/**
 * Start and stop a recording take.
 *
 * A take is deliberately not a Playwright session. The whole point of the
 * staging harness is that a human drives the mouse and records with their own
 * screen recorder, so the app has to outlive whatever started it: no automation
 * attached, no CDP client that dies and takes the window with it, nothing on
 * screen that would not be there in a real session.
 */
const APP_ROOT = path.resolve(import.meta.dirname, "../..");

export interface TakeArgsOptions {
  appRoot: string;
  workDir: string;
  extraArgs?: string[];
}

/**
 * Build the Electron argv for a take.
 *
 * No `--daintree-e2e-*` flags by default. They are the wrong default for a
 * recording: e2e mode suppresses the crash reporter and changes the shutdown
 * confirm, and a take should behave exactly like the build a viewer downloads.
 * Suppressing first-run dialogs is the baked profile's job, not a flag's — if a
 * dialog appears during a take, the profile is wrong and hiding it would only
 * move the problem.
 */
export function buildTakeArgs(options: TakeArgsOptions): string[] {
  if (!path.isAbsolute(options.workDir)) {
    throw new Error(`Take work directory must be absolute: ${options.workDir}`);
  }
  for (const arg of options.extraArgs ?? []) {
    // Electron takes the first non-switch argument as the app path, so a
    // positional extra would silently become the app and launch nothing.
    if (!arg.startsWith("-")) {
      throw new Error(`Take arguments must be switches; "${arg}" would displace the app path`);
    }
  }
  return [...(options.extraArgs ?? []), `--user-data-dir=${options.workDir}`, options.appRoot];
}

export interface StopOptions {
  /**
   * How long to allow a graceful quit before escalating. Daintree's own
   * shutdown deadline is 17s (`SHUTDOWN_DEADLINE_MS`) with a 20s safety belt,
   * so a shorter grace escalates a shutdown that was going to succeed.
   */
  graceMs?: number;
  pollMs?: number;
}

export interface TakeHandle {
  pid: number;
  workDir: string;
  /** Stop the app and wait for it to exit. Safe to call more than once. */
  stop: (options?: StopOptions) => Promise<void>;
}

export interface StartTakeOptions {
  snapshotDir: string;
  /** Live profile for this take. Reset from the snapshot on every start. */
  workDir: string;
  appRoot?: string;
  extraArgs?: string[];
  /** Electron binary. Resolved from the `electron` package when omitted. */
  electronPath?: string;
}

function resolveElectronPath(): string {
  // The `electron` package's main export is the binary path when required from
  // an ordinary Node process. It has no ESM export, hence createRequire.
  const resolved: unknown = createRequire(import.meta.url)("electron");
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new Error("Could not resolve the Electron binary from the `electron` package");
  }
  return resolved;
}

/**
 * The environment a take runs in.
 *
 * Omitting the e2e switches is not enough: every `--daintree-e2e-*` flag has an
 * environment-variable equivalent (`runtimeFlags.ts`), and the harness often
 * runs under Vitest, which sets `NODE_ENV=development`. A take that inherited
 * any of that would not behave like the build a viewer downloads.
 */
function takeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DAINTREE_E2E") || key.startsWith("DAINTREE_DEMO")) delete env[key];
  }
  // These would turn the Electron binary into a plain Node process.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ATOM_SHELL_INTERNAL_RUN_AS_NODE;
  env.NODE_ENV = "production";
  return env;
}

/** True while the process exists. Signal 0 probes without touching it. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone, or not a group leader.
  }
}

/**
 * Stop a take and wait for it to actually exit.
 *
 * The main process is signalled on its own first, deliberately. Daintree
 * handles SIGTERM by calling `app.quit()` (`appLifecycle.ts`), which runs the
 * full cleanup chain and removes `running.lock` — a clean exit, which matters
 * because the next bake refuses to snapshot a profile still carrying the
 * dirty-exit marker. Signalling the whole process group instead would SIGTERM
 * the GPU, renderer and utility children while the main process is mid-teardown:
 * unnecessary, since Electron reaps its own children, and a good way to turn a
 * clean quit into a crashy one.
 *
 * Escalation exists because that chain is bounded but slow. Only once the grace
 * period is spent do we SIGKILL the group.
 */
export async function stopTake(pid: number, options: StopOptions = {}): Promise<void> {
  // pid 0 signals the caller's OWN process group and pid 1 becomes kill(-1),
  // which on POSIX signals every process the user may signal. Neither is a take.
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`Refusing to signal pid ${pid}: not a take process id`);
  }

  const graceMs = options.graceMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;

  if (!isAlive(pid)) return;

  if (process.platform === "win32") {
    // Windows has no signallable process group. `taskkill /T` is what the rest
    // of the E2E harness uses to take an Electron tree down; it bypasses Node's
    // shutdown hooks, so CrashRecoveryService handles the marker on next start.
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
    return;
  }

  signal(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  // The graceful quit did not land. Escalate straight to SIGKILL rather than
  // repeating SIGTERM: Daintree treats a second signal inside two seconds as a
  // dirty process.exit(1), and ignores it after that — harmful or pointless.
  signal(-pid, "SIGKILL");
  signal(pid, "SIGKILL");
}

/**
 * Reset the profile from its snapshot and launch the app for recording.
 *
 * The child is detached and its stdio discarded so the harness process can exit
 * while the take keeps running — that is what lets a shot card be printed and
 * the terminal handed back while the app stays on screen.
 */
export function startTake(options: StartTakeOptions): TakeHandle {
  const manifest = readProfileManifest(options.snapshotDir);
  if (!manifest) {
    throw new Error(
      `Cannot start a take: ${options.snapshotDir} holds no complete snapshot. Bake one first.`
    );
  }

  // Build argv first: a relative workDir or a positional switch has to fail
  // before the profile is claimed and copied, not after.
  const args = buildTakeArgs({
    appRoot: options.appRoot ?? APP_ROOT,
    workDir: options.workDir,
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
  });

  restoreProfile(options.snapshotDir, options.workDir);

  const electronPath = options.electronPath ?? resolveElectronPath();
  const child = spawn(electronPath, args, {
    detached: true,
    stdio: "ignore",
    env: takeEnv(),
  });
  if (child.pid === undefined) {
    throw new Error("Failed to start the take: Electron did not report a pid");
  }
  // Release the child from the parent's event loop so this process can exit.
  child.unref();

  const pid = child.pid;
  let stopping: Promise<void> | null = null;
  return {
    pid,
    workDir: options.workDir,
    stop: (stopOptions) => {
      stopping ??= stopTake(pid, stopOptions ?? {});
      return stopping;
    },
  };
}

export interface TeardownOptions {
  /** Scene directories to remove — pass `BuiltScene.cleanup`. */
  sceneCleanup?: () => void;
  snapshotDir?: string;
  workDirs?: string[];
  /** Running takes to stop before anything is deleted. */
  takes?: TakeHandle[];
  stop?: StopOptions;
}

/**
 * Tear a demo down completely.
 *
 * Demos are temporary by design: a scene, a snapshot and a work profile exist
 * for one recording session and are then deleted.
 *
 * Takes are stopped *and awaited* before any directory is removed. Daintree's
 * shutdown chain can run for 17 seconds, and deleting a profile out from under
 * it leaves the app spending that whole window writing into a directory that no
 * longer exists.
 *
 * Best-effort otherwise: it reports what it could not remove rather than
 * throwing, because a teardown that aborts halfway leaves more mess than one
 * that carries on.
 */
export async function teardownDemo(
  options: TeardownOptions
): Promise<{ removed: string[]; failed: string[] }> {
  await Promise.all(
    (options.takes ?? []).map(async (take) => {
      try {
        await take.stop(options.stop);
      } catch {
        // A take that is already gone is the outcome we wanted.
      }
    })
  );

  const removed: string[] = [];
  const failed: string[] = [];

  const targets = [
    ...(options.workDirs ?? []),
    ...(options.snapshotDir ? [options.snapshotDir] : []),
  ];
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    // Teardown takes paths from a CLI and a scene file, so it must not be a
    // recursive-delete primitive: only directories this harness marked as its
    // own profiles are removable. Phases 1 and 2 enforce the same rule.
    if (!readProfileManifest(dir)) {
      failed.push(dir);
      continue;
    }
    // A take started from another process cannot be passed in as a handle, so
    // the marker is the only evidence an app still owns this profile. Deleting
    // it underneath a live app leaves it writing into a directory that is gone.
    if (existsSync(path.join(dir, "running.lock"))) {
      failed.push(dir);
      continue;
    }
    try {
      removePathSync(dir);
      removed.push(dir);
    } catch {
      failed.push(dir);
    }
  }

  if (options.sceneCleanup) {
    try {
      options.sceneCleanup();
    } catch {
      failed.push("scene");
    }
  }

  return { removed, failed };
}
