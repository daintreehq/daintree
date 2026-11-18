import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { events } from "../../services/events.js";
import { withTimeout } from "../../utils/withTimeout.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:ownedHostCleanup");

const WORKTREE_GONE_PROBE_TIMEOUT_MS = 5000;
/** A removal refused while the host is installing or being re-pointed is tried again this often. */
const RETRY_DELAY_MS = 15_000;
/** About fifteen minutes of retries: longer than an install takes, short of retrying forever. */
const MAX_RETRIES = 60;

export interface OwnedHostCleanupOptions {
  list(): HostDescriptor[];
  forget(hostId: HostId): Promise<void>;
  /** Drop the worktree waiting on a host's setup, leaving the host itself. */
  clearPlacement?(hostId: HostId): Promise<void>;
  /** Resolves when the worktree's root still exists; rejects with ENOENT once it is gone. */
  probe?: (worktreePath: string) => Promise<unknown>;
  retryDelayMs?: number;
}

/**
 * `sys:worktree:remove` means a monitor went away, not that the directory did:
 * a `git worktree list` that transiently omits a live worktree prunes its
 * monitor too. Only a confirmed ENOENT on the root (the id is its path) counts.
 */
async function isWorktreeGone(probe: Promise<unknown>): Promise<boolean> {
  try {
    await withTimeout(probe, WORKTREE_GONE_PROBE_TIMEOUT_MS, "Worktree existence probe timed out");
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

/**
 * Whether a worktree's root on this device is gone: true only when the root
 * is missing and the folder it sat in is a readable directory, false while it
 * is there, and null when that couldn't be told. A parent that doesn't read
 * proves nothing: an unmounted drive, a disconnected share, or a link into
 * one loses the whole path, and the worktree comes back with it. The parent
 * is followed through any link, so a link into a missing volume counts too.
 */
export async function worktreeRootGone(
  worktreePath: string,
  probes: {
    root?: (target: string) => Promise<unknown>;
    parent?: (target: string) => Promise<{ isDirectory(): boolean }>;
  } = {}
): Promise<boolean | null> {
  const bounded = <T>(work: Promise<T>) =>
    withTimeout(work, WORKTREE_GONE_PROBE_TIMEOUT_MS, "Worktree existence probe timed out");
  try {
    await bounded((probes.root ?? lstat)(worktreePath));
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
  }
  const parent = path.dirname(worktreePath);
  if (parent === worktreePath) return null;
  try {
    const found = await bounded((probes.parent ?? stat)(parent));
    if (!found.isDirectory()) return null;
  } catch {
    return null;
  }
  // Read again: a volume that came back between the two reads brings the worktree with it.
  try {
    await bounded((probes.root ?? lstat)(worktreePath));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? true : null;
  }
}

/** Each worktree whose monitor went away: a hint that it may be gone, never proof. */
export function onWorktreeMonitorRemoved(listener: (worktreeId: string) => void): () => void {
  return events.on("sys:worktree:remove", ({ worktreeId }) => listener(worktreeId));
}

/**
 * A host added for a worktree's resource environment goes when its box does:
 * once that resource's teardown succeeds, or the worktree itself is deleted.
 * Removal is the same as Settings → Hosts': windows on it go home, the record
 * is dropped, and its ssh master and cache are cleared. A host the user added
 * themselves carries no owner and is never removed, but a worktree waiting on
 * its setup stops waiting when that worktree or its box goes.
 */
export function watchOwnedHostCleanup(options: OwnedHostCleanupOptions): () => void {
  const probe = options.probe ?? lstat;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const pending = new Set<string>();
  /** Removals heard while that worktree's cleanup ran: checked once it's done. */
  const removalsWaiting = new Set<string>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const ownedBy = (worktreeId: string) =>
    options.list().filter((host) => host.ownerWorktreeId === worktreeId);
  // An owned host goes whole; only another host's record needs its placement dropped.
  // A worktree waiting on a machine made for it waits on that machine, not on its
  // resource environment: only the worktree's own removal ends that wait.
  const waitingFor = (worktreeId: string, worktreeGone: boolean) =>
    options.clearPlacement
      ? options
          .list()
          .filter(
            (host) =>
              host.pendingPlacement?.worktreeId === worktreeId &&
              host.ownerWorktreeId !== worktreeId &&
              (worktreeGone || host.pendingPlacement.createdMachine !== true)
          )
      : [];

  /**
   * `only` narrows a retry to the hosts the original cleanup was for: a host
   * added afterwards, for the box a reprovision brought up, isn't this one's.
   */
  const forgetOwned = (
    worktreeId: string,
    confirm?: () => Promise<boolean>,
    attempt = 0,
    only?: ReadonlySet<HostId>
  ): void => {
    const targets = () =>
      ownedBy(worktreeId).filter((host) => only === undefined || only.has(host.id));
    // Confirmed gone only when the folder check ran: a resource teardown leaves the worktree.
    const worktreeGone = confirm !== undefined;
    if (disposed || pending.has(worktreeId)) return;
    const placements = only === undefined;
    if (
      targets().length === 0 &&
      (!placements || waitingFor(worktreeId, worktreeGone).length === 0)
    ) {
      return;
    }
    pending.add(worktreeId);
    void (async () => {
      const refused = new Set<HostId>();
      try {
        if (confirm && !(await confirm())) return;
        if (disposed) return;
        if (placements) {
          for (const host of waitingFor(worktreeId, worktreeGone)) {
            if (disposed) return;
            await options.clearPlacement?.(host.id).catch((error: unknown) => {
              logger.warn("Dropping a removed worktree's pending placement failed", { error });
            });
          }
        }
        // Read again: the list may have changed while the folder was checked.
        for (const host of targets()) {
          if (disposed) return;
          await options.forget(host.id).catch((error: unknown) => {
            refused.add(host.id);
            logger.warn("Removing a worktree's resource host failed", { error });
          });
        }
      } finally {
        pending.delete(worktreeId);
        // Checked whichever way this pass ended, the early returns included.
        if (removalsWaiting.delete(worktreeId) && !disposed) {
          forgetOwned(worktreeId, () => isWorktreeGone(probe(worktreeId)));
        }
      }
      // Refused while installing or being re-pointed: the box is still gone, so
      // try again once that settles rather than leave a host nothing removes.
      if (refused.size > 0 && !disposed && attempt < MAX_RETRIES && !retryTimers.has(worktreeId)) {
        const timer = setTimeout(() => {
          retryTimers.delete(worktreeId);
          forgetOwned(worktreeId, undefined, attempt + 1, refused);
        }, retryDelayMs);
        timer.unref?.();
        retryTimers.set(worktreeId, timer);
      }
    })();
  };

  const stopRemove = events.on("sys:worktree:remove", ({ worktreeId }) => {
    if (pending.has(worktreeId)) {
      removalsWaiting.add(worktreeId);
      return;
    }
    forgetOwned(worktreeId, () => isWorktreeGone(probe(worktreeId)));
  });
  const stopTeardown = events.on("sys:worktree:resource-teardown", ({ worktreeId }) => {
    forgetOwned(worktreeId);
  });
  return () => {
    disposed = true;
    stopRemove();
    stopTeardown();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
  };
}
