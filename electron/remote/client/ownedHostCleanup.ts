import { lstat } from "node:fs/promises";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { events } from "../../services/events.js";
import { withTimeout } from "../../utils/withTimeout.js";

const WORKTREE_GONE_PROBE_TIMEOUT_MS = 5000;

export interface OwnedHostCleanupOptions {
  list(): HostDescriptor[];
  forget(hostId: HostId): Promise<void>;
  /** Resolves when the worktree's root still exists; rejects with ENOENT once it is gone. */
  probe?: (worktreePath: string) => Promise<unknown>;
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
  const pending = new Set<string>();
  /** Teardowns already acted on, by worktree and start: a settled status repeats on every update. */
  const handledTeardowns = new Set<string>();

  const forgetOwned = (worktreeId: string, confirm?: () => Promise<boolean>): void => {
    if (pending.has(worktreeId)) return;
    if (!options.list().some((host) => host.ownerWorktreeId === worktreeId)) return;
    pending.add(worktreeId);
    void (async () => {
      try {
        if (confirm && !(await confirm())) return;
        // Read again: the list may have changed while the folder was checked.
        const owned = options.list().filter((host) => host.ownerWorktreeId === worktreeId);
        for (const host of owned) {
          await options.forget(host.id).catch((error: unknown) => {
            console.warn("[RemoteHosts] Removing a worktree's resource host failed:", error);
          });
        }
      } finally {
        pending.delete(worktreeId);
      }
    })();
  };

  const stopRemove = events.on("sys:worktree:remove", ({ worktreeId }) => {
    forgetOwned(worktreeId, () => isWorktreeGone(probe(worktreeId)));
  });
  const stopUpdate = events.on("sys:worktree:update", (worktree) => {
    const status = worktree.lifecycleStatus;
    if (status?.phase !== "resource-teardown" || status.state !== "success") return;
    const key = `${worktree.id}:${status.startedAt}`;
    if (handledTeardowns.has(key)) return;
    handledTeardowns.add(key);
    forgetOwned(worktree.id);
  });
  return () => {
    stopRemove();
    stopUpdate();
  };
}
