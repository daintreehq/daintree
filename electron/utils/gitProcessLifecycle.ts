import type { ChildProcess } from "node:child_process";
import type { SimpleGit } from "simple-git";

/** How long a git child has to exit after Daintree signals it, before SIGKILL. */
export const GIT_KILL_GRACE_MS = 2_000;

/** Minimal shape of simple-git's internal PluginStore (`_plugins`, 4.0.2). */
interface PluginStoreLike {
  append?(
    type: "spawn.after",
    action: (data: unknown, context: { spawned?: ChildProcess }) => unknown
  ): () => void;
}

// Children Daintree has signalled and that have not exited yet, by the
// directory git runs in. Only exit evidence removes one: a child that ignores
// SIGKILL too (an uninterruptible wait) stays here until the kernel lets it go.
const stoppedChildren = new Map<string, Set<ChildProcess>>();
let seamMissingReported = false;
let exitHookInstalled = false;

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * simple-git stops waiting for a child (block timeout, abort) by sending
 * SIGINT once and then waits for `close` with no deadline, so a git blocked on
 * a File Provider download held its task pending forever while the next poll
 * spawned another. Every signal simple-git sends is followed by SIGKILL when
 * the child has not exited within {@link GIT_KILL_GRACE_MS}.
 *
 * simple-git 4 has no public plugin API; this uses the same internal
 * `spawn.after` seam as the clone path (`gitClone.ts`). Wrapping the child's
 * own `kill` catches the timeout and abort plugins alike without copying
 * their timers, and leaves their rejection shapes untouched.
 */
export function superviseGitChildren(git: SimpleGit, dir: string): void {
  const store = (git as unknown as { _plugins?: PluginStoreLike })._plugins;
  if (typeof store?.append !== "function") {
    if (!seamMissingReported) {
      seamMissingReported = true;
      // console.error, not warn: esbuild strips console.warn from production.
      console.error(
        "[gitProcessLifecycle] simple-git's plugin store is unavailable; git children will not be killed past SIGINT"
      );
    }
    return;
  }
  store.append("spawn.after", (data, context) => {
    const child = context?.spawned;
    if (child) superviseChild(child, dir);
    return data;
  });
}

function superviseChild(child: ChildProcess, dir: string): void {
  const signal = child.kill.bind(child);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const settle = (): void => {
    clearTimeout(graceTimer);
    graceTimer = undefined;
    const stopped = stoppedChildren.get(dir);
    if (stopped?.delete(child) && stopped.size === 0) stoppedChildren.delete(dir);
  };
  child.once("exit", settle);
  // `close` follows `exit`, and is the only exit evidence on some spawn
  // failures; settling twice is harmless.
  child.once("close", settle);

  child.kill = (sig?: NodeJS.Signals | number): boolean => {
    const sent = signal(sig);
    if (!sent || hasExited(child)) return sent;
    let stopped = stoppedChildren.get(dir);
    if (!stopped) {
      stopped = new Set();
      stoppedChildren.set(dir, stopped);
    }
    stopped.add(child);
    installExitHook();
    if (graceTimer === undefined && sig !== "SIGKILL" && sig !== 9) {
      graceTimer = setTimeout(() => {
        if (!hasExited(child)) signal("SIGKILL");
      }, GIT_KILL_GRACE_MS);
      graceTimer.unref?.();
    }
    return sent;
  };
}

/**
 * A host shutting down exits on its own deadline (about a second, see
 * `hostShutdown.ts`), before a grace timer could fire, and a child outlives
 * its parent. Whatever was stopped and is still running goes on the way out.
 */
function killStoppedChildrenOnExit(): void {
  for (const stopped of stoppedChildren.values()) {
    for (const child of stopped) {
      if (!hasExited(child)) child.kill("SIGKILL");
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", killStoppedChildrenOnExit);
}

/**
 * Whether a git child running in `dir` was told to stop and has not exited.
 * Starting another git against the same files would only queue behind it.
 */
export function hasStoppedGitChild(dir: string): boolean {
  return (stoppedChildren.get(dir)?.size ?? 0) > 0;
}

export function _resetGitProcessLifecycleForTesting(): void {
  stoppedChildren.clear();
  seamMissingReported = false;
  process.removeListener("exit", killStoppedChildrenOnExit);
  exitHookInstalled = false;
}
