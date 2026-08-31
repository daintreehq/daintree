import { create } from "zustand";

/**
 * Force-push recovery state, plus the deferred-Promise confirm gate for the
 * `git.forcePushWithLease` action.
 *
 * The two live together because they are the same fact seen twice: a lease SHA
 * is only ever valid for the rejection that produced it, so the thing the
 * dialog confirms and the thing the menu row keys its visibility off must be
 * one record, not two derivations of it.
 *
 * WHY A STORE AT ALL — `--force-with-lease` is only safe when the lease pins
 * the remote-tracking SHA as it stood at the moment a push was actually
 * rejected (#7822). This app fetches in the background (`FetchScheduler` →
 * `RepoFetchCoordinator`), so `refs/remotes/<remote>/<branch>` advances on its
 * own; re-reading it at click time would silently degrade the lease to a plain
 * `--force`. `handlePush` captures the SHA inside its rejection catch and ships
 * it on the error, and this store is where that captured value waits for the
 * user to act on it. Nothing else may write a lease here.
 *
 * Session-only and deliberately not persisted: a lease that outlives the
 * renderer is a lease that has had unbounded time to go stale.
 *
 * Keys are compared by identity, not canonicalised, because every writer and
 * reader passes the same string: `WorktreeState.path`. `resolveWorktreeLocation`
 * returns a supplied path verbatim, so the path an action resolves is the one
 * the card dispatched — normalising here would only invent a second spelling.
 */

/** A lease captured from one real push rejection, for one worktree. */
export interface ForcePushRecovery {
  /** Canonical worktree path the rejected push ran in. */
  cwd: string;
  /** The branch `handlePush` reported, not one re-derived from the snapshot. */
  branchName: string;
  /** Remote-tracking SHA as it stood when the push was rejected. */
  leaseSha: string;
  /**
   * Bumped on every capture. An async continuation holding an old generation
   * can tell that a newer push replaced the record under it, which is what
   * stops a confirm granted against one rejection from force-pushing a lease
   * belonging to another.
   */
  generation: number;
}

/**
 * Same shape `git-write.ts` validates before interpolating the lease into
 * `--force-with-lease=<branch>:<sha>`. Checked on the way in as well so a
 * malformed value never becomes a visible menu row in the first place.
 */
const LEASE_SHA_PATTERN = /^[0-9a-f]{4,64}$/i;

interface PendingForcePushConfirmation {
  resolve: (ok: boolean) => void;
  record: ForcePushRecovery;
}

interface GitForcePushState {
  /** Keyed by canonical worktree path; at most one live lease per worktree. */
  recovery: Record<string, ForcePushRecovery>;
  pendingConfirm: PendingForcePushConfirmation | null;
  /**
   * Monotonic request counter, used as the globally-mounted host's
   * ErrorBoundary `resetKeys` signal so a crashed dialog recovers when a new
   * request arrives — including back-to-back requests where `pendingConfirm`
   * never returns to null. Mirrors `gitPushConfirmStore`.
   */
  requestSeq: number;
  /** Internal counter behind {@link ForcePushRecovery.generation}. */
  generationSeq: number;

  /**
   * Record a lease captured from a real push rejection. Returns the stored
   * record, or null when the rejection carried nothing usable — a rejection
   * without both a branch and a well-formed SHA leaves NO record, so the
   * force-push row stays hidden rather than offering a lease-less force.
   */
  recordRejection: (input: {
    cwd: string;
    branchName?: string;
    leaseSha?: string;
  }) => ForcePushRecovery | null;

  getRecovery: (cwd: string) => ForcePushRecovery | null;

  /**
   * Drop a worktree's lease. `generation` makes it conditional: a late
   * continuation clearing the record it *thinks* is current can't delete a
   * newer capture that landed while it was awaiting.
   */
  clearRecovery: (cwd: string, generation?: number) => void;

  requestConfirmation: (record: ForcePushRecovery) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

export const useGitForcePushStore = create<GitForcePushState>()((set, get) => ({
  recovery: {},
  pendingConfirm: null,
  requestSeq: 0,
  generationSeq: 0,

  recordRejection: ({ cwd, branchName, leaseSha }) => {
    if (!cwd) return null;
    if (!branchName) return null;
    if (!leaseSha || !LEASE_SHA_PATTERN.test(leaseSha)) return null;

    const generation = get().generationSeq + 1;
    const record: ForcePushRecovery = { cwd, branchName, leaseSha, generation };
    set((state) => ({
      generationSeq: generation,
      recovery: { ...state.recovery, [cwd]: record },
    }));
    return record;
  },

  getRecovery: (cwd: string) => get().recovery[cwd] ?? null,

  clearRecovery: (cwd: string, generation?: number) => {
    const existing = get().recovery[cwd];
    if (!existing) return;
    if (generation !== undefined && existing.generation !== generation) return;
    set((state) => {
      const next = { ...state.recovery };
      delete next[cwd];
      return { recovery: next };
    });
  },

  requestConfirmation: (record: ForcePushRecovery): Promise<boolean> => {
    const existing = get().pendingConfirm;
    if (existing) {
      existing.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      set((state) => ({
        pendingConfirm: { resolve, record },
        requestSeq: state.requestSeq + 1,
      }));
    });
  },

  resolveConfirmation: (ok: boolean) => {
    const pending = get().pendingConfirm;
    if (pending) {
      pending.resolve(ok);
      set({ pendingConfirm: null });
    }
  },
}));
