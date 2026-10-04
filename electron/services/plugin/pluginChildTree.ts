import { spawn } from "node:child_process";

const TASKKILL_TIMEOUT_MS = 3000;

interface PendingTree {
  timer: ReturnType<typeof setTimeout>;
  shouldEscalate: () => boolean;
}

/** Trees SIGTERMed whose escalation has not yet run — what quit still owes a SIGKILL. */
const pendingTrees = new Map<TreeKillableChild, PendingTree>();

/** Tree-owning children whose direct child is still running. */
const liveTrees = new Set<TreeKillableChild>();
let exitHookInstalled = false;

/**
 * The slice of a spawned plugin child that tree teardown needs. `ownsProcessTree`
 * is set only by the real spawners, which start the child as its own process
 * group leader on POSIX (`detached: true`); a test fake leaves it unset and so
 * only ever sees its own `kill()` — a fake PID must never reach a real
 * `process.kill(-pid)` or `taskkill`.
 */
export interface TreeKillableChild {
  pid?: number | undefined;
  ownsProcessTree?: boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Spawn option for a plugin child whose whole tree teardown must reach (#13173). */
export const PLUGIN_CHILD_DETACHED = process.platform !== "win32";

function treePid(child: TreeKillableChild): number | null {
  if (child.ownsProcessTree !== true) return null;
  const pid = child.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1 ? pid : null;
}

function directKill(child: TreeKillableChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * Signal a plugin child together with everything it spawned (#13173). Killing
 * only the direct child strands `npm run dev`'s server, a watcher, or a language
 * server behind a wrapper.
 *
 * POSIX: the child leads its own process group, so the group signal reaches
 * every descendant that stayed in it, and keeps reaching them after the leader
 * exits — the kernel will not hand the group's ID to a new process while any
 * member is alive. SIGCONT follows SIGTERM so a stopped member actually
 * receives the queued signal. Descendants that `setsid` out of the group are
 * not reached; that needs the lineage ledger the pty-host has and Main does not.
 *
 * Windows: there are no signals, and `child.kill()` is TerminateProcess on the
 * direct child — which erases the parent link `taskkill /T` walks. So the tree
 * kill runs first, asynchronously so it never blocks Main, and the direct kill
 * follows as the fallback once it finishes or times out.
 */
export function signalChildTree(child: TreeKillableChild, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = treePid(child);
  if (pid === null) {
    directKill(child, signal);
    return;
  }

  if (process.platform === "win32") {
    taskkillTree(pid, () => directKill(child, signal));
    return;
  }

  if (!signalGroup(pid, signal)) {
    directKill(child, signal);
    return;
  }
  if (signal === "SIGTERM") signalGroup(pid, "SIGCONT");
}

/**
 * Whether anything in the child's process group is still alive. Only
 * meaningful on POSIX for a tree-owning child; everywhere else it reports
 * false, leaving the direct child's own `exit` as the only evidence.
 */
export function isChildTreeAlive(child: TreeKillableChild): boolean {
  const pid = treePid(child);
  if (pid === null || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * SIGKILL whatever of the child's process group outlived the grace window,
 * whether or not the direct child is still running. A direct child that exits
 * promptly on SIGTERM ends its owner's own escalation, and without this its
 * grandchildren that ignored the signal would run on forever. The timer is
 * unref'd: quit has its own referenced sweep.
 */
export function scheduleChildTreeEscalation(
  child: TreeKillableChild,
  delayMs: number,
  shouldEscalate: () => boolean = () => true
): void {
  if (treePid(child) === null || process.platform === "win32") return;
  const previous = pendingTrees.get(child);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    pendingTrees.delete(child);
    if (!shouldEscalate() || !isChildTreeAlive(child)) return;
    signalChildTree(child, "SIGKILL");
  }, delayMs);
  timer.unref?.();
  pendingTrees.set(child, { timer, shouldEscalate });
}

/**
 * Reap what a direct child left in its process group when it exited on its
 * own — a backgrounded `server &` behind a wrapper script. Terminals do the
 * same for a shell that exits (#12203). Must be called from the child's `exit`
 * event, while the group's ID is still known to be ours.
 */
export function reapChildTreeAfterExit(
  child: TreeKillableChild,
  graceMs: number,
  shouldEscalate?: () => boolean
): void {
  liveTrees.delete(child);
  if (!isChildTreeAlive(child)) return;
  signalChildTree(child, "SIGTERM");
  scheduleChildTreeEscalation(child, graceMs, shouldEscalate);
}

/**
 * Record a freshly spawned tree-owning child so a synchronous process exit can
 * still signal its group. Returns the untrack call for the child's own exit. Detaching takes the child out of this process's
 * group, so a terminal's Ctrl+C no longer reaches it, and execa skips its own
 * exit cleanup for detached children — this hook stands in for both.
 */
export function trackChildTree(child: TreeKillableChild): () => void {
  const untrack = (): void => {
    liveTrees.delete(child);
  };
  if (treePid(child) === null || process.platform === "win32") return untrack;
  liveTrees.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", signalTrackedTreesOnExit);
  }
  return untrack;
}

function signalTrackedTreesOnExit(): void {
  for (const child of liveTrees) signalChildTree(child, "SIGTERM");
  for (const [child, pending] of pendingTrees) {
    if (pending.shouldEscalate() && isChildTreeAlive(child)) signalChildTree(child, "SIGKILL");
  }
}

/**
 * SIGKILL every tree still inside its grace window, for app quit. Those
 * escalations ride unref'd timers that never fire once the app exits, so a
 * group torn down by an unload or restart moments before quit would otherwise
 * outlive the app.
 */
export function reapPendingChildTrees(): void {
  for (const [child, pending] of [...pendingTrees]) {
    clearTimeout(pending.timer);
    pendingTrees.delete(child);
    if (pending.shouldEscalate() && isChildTreeAlive(child)) signalChildTree(child, "SIGKILL");
  }
}

/**
 * Give every pending tree until `deadlineMs` to empty on its own, then reap
 * the rest. For a quit path that only SIGTERMed and must not leave the
 * SIGKILL to an unref'd timer that will never fire. Referenced on purpose.
 */
export async function drainPendingChildTrees(
  deadlineMs: number,
  pollMs: number = 50
): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    let anyAlive = false;
    for (const child of pendingTrees.keys()) {
      if (isChildTreeAlive(child)) {
        anyAlive = true;
        break;
      }
    }
    if (!anyAlive) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  reapPendingChildTrees();
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      console.warn(`[PluginChildTree] ${signal} group=${pid}: ${(err as Error).message}`);
    }
    return false;
  }
}

function taskkillTree(pid: number, then: () => void): void {
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    then();
  };
  try {
    const proc = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
    });
    proc.once("exit", finish);
    proc.once("error", finish);
  } catch {
    finish();
  }
}
