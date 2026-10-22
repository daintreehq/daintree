import { lstat } from "node:fs/promises";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { events } from "../../services/events.js";
import { withTimeout } from "../../utils/withTimeout.js";

const WORKTREE_GONE_PROBE_TIMEOUT_MS = 5000;
/** A removal refused while the host is installing or being re-pointed is tried again this often. */
const RETRY_DELAY_MS = 15_000;
/** About fifteen minutes of retries: longer than an install takes, short of retrying forever. */
const MAX_RETRIES = 60;

export interface OwnedHostCleanupOptions {
  list(): HostDescriptor[];
  forget(hostId: HostId): Promise<void>;
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
 * A host added for a worktree's resource environment goes when its box does:
 * once that resource's teardown succeeds, or the worktree itself is deleted.
 * Removal is the same as Settings → Hosts': windows on it go home, the record
 * is dropped, and its ssh master and cache are cleared. A host the user added
 * themselves carries no owner and is never touched.
 */
export function watchOwnedHostCleanup(options: OwnedHostCleanupOptions): () => void {
  const probe = options.probe ?? lstat;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const pending = new Set<string>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const ownedBy = (worktreeId: string) =>
    options.list().filter((host) => host.ownerWorktreeId === worktreeId);

  const forgetOwned = (worktreeId: string, confirm?: () => Promise<boolean>, attempt = 0): void => {
    if (disposed || pending.has(worktreeId)) return;
    if (ownedBy(worktreeId).length === 0) return;
    pending.add(worktreeId);
    void (async () => {
      let refused = false;
      try {
        if (confirm && !(await confirm())) return;
        // Read again: the list may have changed while the folder was checked.
        for (const host of ownedBy(worktreeId)) {
          await options.forget(host.id).catch((error: unknown) => {
            refused = true;
            console.warn("[RemoteHosts] Removing a worktree's resource host failed:", error);
          });
        }
      } finally {
        pending.delete(worktreeId);
      }
      // Refused while installing or being re-pointed: the box is still gone, so
      // try again once that settles rather than leave a host nothing removes.
      if (refused && !disposed && attempt < MAX_RETRIES && !retryTimers.has(worktreeId)) {
        const timer = setTimeout(() => {
          retryTimers.delete(worktreeId);
          forgetOwned(worktreeId, undefined, attempt + 1);
        }, retryDelayMs);
        timer.unref?.();
        retryTimers.set(worktreeId, timer);
      }
    })();
  };

  const stopRemove = events.on("sys:worktree:remove", ({ worktreeId }) => {
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
