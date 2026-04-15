import { events } from "./events.js";
import { createHardenedGit } from "../utils/hardenedGit.js";
import { logInfo, logWarn } from "../utils/logger.js";
import type { SnapshotInfo } from "../../shared/types/ipc/git.js";

const STASH_PREFIX = "daintree:pre-agent:";
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

class PreAgentSnapshotService {
  private snapshots = new Map<string, SnapshotInfo>();
  private unsubscribers: Array<() => void> = [];
  private pruneTimer: NodeJS.Timeout | null = null;

  initialize(): void {
    const unsub = events.on("agent:state-changed", (payload) => {
      this.handleStateChanged(payload);
    });
    this.unsubscribers.push(unsub);

    this.pruneAllWorktrees();
    this.pruneTimer = setInterval(() => this.pruneAllWorktrees(), PRUNE_INTERVAL_MS);
  }

  private handleStateChanged(payload: {
    state: string;
    previousState: string;
    worktreeId?: string;
  }): void {
    const { state, previousState, worktreeId } = payload;

    if (previousState !== "idle" || state !== "working" || !worktreeId) return;

    if (this.snapshots.has(worktreeId)) return;

    // Set sentinel to prevent duplicate concurrent snapshot creation
    this.snapshots.set(worktreeId, {
      worktreeId,
      stashRef: "",
      createdAt: Date.now(),
      hasChanges: false,
    });

    this.createSnapshot(worktreeId).catch((err) => {
      this.snapshots.delete(worktreeId);
      logWarn("[PreAgentSnapshot] Failed to create snapshot", {
        worktreeId,
        error: err instanceof Error ? err.message : String(err),
      });
      events.emit("ui:notify", {
        type: "warning",
        message:
          "Could not create pre-agent file snapshot. Agent will continue without rollback capability.",
      });
    });
  }

  private async createSnapshot(worktreeId: string): Promise<void> {
    const git = createHardenedGit(worktreeId);

    // Check for rebase/merge in progress
    const status = await git.status();
    if (status.conflicted.length > 0) {
      this.snapshots.delete(worktreeId);
      logInfo("[PreAgentSnapshot] Skipping snapshot — conflicts detected", { worktreeId });
      return;
    }

    const stashListBefore = await git.stashList();
    const countBefore = stashListBefore.total;

    const timestamp = Date.now();
    const message = `${STASH_PREFIX}${worktreeId}:${timestamp}`;

    await git.stash(["push", "--include-untracked", "-m", message]);

    const stashListAfter = await git.stashList();
    const countAfter = stashListAfter.total;

    if (countAfter <= countBefore) {
      // No stash was created (clean working tree)
      this.snapshots.set(worktreeId, {
        worktreeId,
        stashRef: "",
        createdAt: timestamp,
        hasChanges: false,
      });
      logInfo("[PreAgentSnapshot] Clean tree — no stash needed", { worktreeId });
      return;
    }

    // Stash was created — immediately apply it back so the agent has the files
    // The stash entry remains in the stash list for rollback
    await git.stash(["apply", "--index", "stash@{0}"]);

    this.snapshots.set(worktreeId, {
      worktreeId,
      stashRef: "stash@{0}",
      createdAt: timestamp,
      hasChanges: true,
    });

    logInfo("[PreAgentSnapshot] Snapshot created", { worktreeId, stashRef: "stash@{0}" });
  }

  async revertToSnapshot(worktreeId: string): Promise<{
    success: boolean;
    hasConflicts: boolean;
    message: string;
  }> {
    const snapshot = this.snapshots.get(worktreeId);
    if (!snapshot) {
      return {
        success: false,
        hasConflicts: false,
        message: "No snapshot found for this worktree",
      };
    }

    if (!snapshot.hasChanges) {
      this.snapshots.delete(worktreeId);
      return {
        success: true,
        hasConflicts: false,
        message: "No changes to revert (working tree was clean)",
      };
    }

    const git = createHardenedGit(worktreeId);

    // Find the stash entry by message prefix
    const stashIndex = await this.findStashIndex(worktreeId);
    if (stashIndex === null) {
      this.snapshots.delete(worktreeId);
      return {
        success: false,
        hasConflicts: false,
        message: "Snapshot stash entry not found — it may have been manually removed",
      };
    }

    const stashRef = `stash@{${stashIndex}}`;

    try {
      // Reset working tree to HEAD, then apply the stash
      await git.reset(["--hard", "HEAD"]);
      await git.clean(["-fd"]);

      try {
        await git.stash(["apply", "--index", stashRef]);
      } catch {
        // --index may fail if index state can't be restored; try without
        await git.stash(["apply", stashRef]);
      }

      // Drop the stash entry after successful apply
      await git.stash(["drop", stashRef]);
      this.snapshots.delete(worktreeId);

      return { success: true, hasConflicts: false, message: "Files reverted to pre-agent state" };
    } catch (err) {
      // Check for conflicts
      const status = await git.status();
      if (status.conflicted.length > 0) {
        this.snapshots.delete(worktreeId);
        return {
          success: true,
          hasConflicts: true,
          message: `Reverted with ${status.conflicted.length} conflict(s) — manual resolution required`,
        };
      }
      throw err;
    }
  }

  async deleteSnapshot(worktreeId: string): Promise<void> {
    const snapshot = this.snapshots.get(worktreeId);
    if (!snapshot) return;

    if (snapshot.hasChanges) {
      const stashIndex = await this.findStashIndex(worktreeId);
      if (stashIndex !== null) {
        const git = createHardenedGit(worktreeId);
        await git.stash(["drop", `stash@{${stashIndex}}`]);
      }
    }

    this.snapshots.delete(worktreeId);
  }

  getSnapshot(worktreeId: string): SnapshotInfo | null {
    return this.snapshots.get(worktreeId) ?? null;
  }

  listSnapshots(): SnapshotInfo[] {
    return Array.from(this.snapshots.values());
  }

  private async findStashIndex(worktreeId: string): Promise<number | null> {
    const git = createHardenedGit(worktreeId);
    const raw = await git.raw(["stash", "list", "--pretty=format:%gd %ct %s"]);
    if (!raw.trim()) return null;

    const worktreePrefix = `${STASH_PREFIX}${worktreeId}:`;
    const lines = raw.trim().split("\n");
    for (const line of lines) {
      if (line.includes(worktreePrefix)) {
        const match = line.match(/^stash@\{(\d+)\}/);
        if (match) return parseInt(match[1], 10);
      }
    }
    return null;
  }

  private async pruneAllWorktrees(): Promise<void> {
    const now = Date.now();

    // Prune in-memory entries past TTL
    for (const [worktreeId, snapshot] of this.snapshots) {
      if (now - snapshot.createdAt > DEFAULT_TTL_MS) {
        try {
          await this.deleteSnapshot(worktreeId);
        } catch (err) {
          logWarn("[PreAgentSnapshot] Failed to prune snapshot", {
            worktreeId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    this.snapshots.clear();
  }
}

export const preAgentSnapshotService = new PreAgentSnapshotService();
