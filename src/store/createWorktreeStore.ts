import { createStore, type StoreApi } from "zustand/vanilla";
import type { WorktreeSnapshot, WorktreeEventVersion, AttachIssuePayload } from "@shared/types";
import { usePanelStore } from "./panelStore";
import { worktreeClient } from "@/clients";
import {
  captureWorktreeTerminalSnapshot,
  closeTerminalsForWorktree,
  restoreClosedTerminals,
  type WorktreeTerminalRestoreSnapshot,
} from "@/components/Worktree/worktreeDeleteHelper";
import { logDebug } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * How long a `worktree-removed` tombstone suppresses a late `worktree-update`
 * for the same id within the same epoch. A removal followed by a buffered
 * update from the same host run could otherwise resurrect a deleted row. The
 * host reconnect/restart budget is ~14s; 30s gives 2x headroom and tombstones
 * are cleared outright on epoch transition (a host rebuild starts clean).
 */
const TOMBSTONE_TTL_MS = 30_000;

/**
 * Order two host-minted version stamps. A differing epoch means the events
 * came from different host runs — UUIDv4 epochs carry no ordering, so a new
 * epoch always wins (the renderer re-hydrates from the fresh host). Within an
 * epoch, the higher `seq` wins.
 *
 * Returns <0 only when `incoming` is strictly older than `current`. Callers
 * gate on `compareVersion(...) < 0` (reject), so an EQUAL same-epoch stamp is
 * accepted: `get-all-states` reports the host's current high-water `seq`
 * without advancing it, so a snapshot that races the event sitting at that
 * same `seq` is the host's authoritative state at that boundary — applying it
 * is idempotent, never a revert (#8403 review).
 */
export function compareVersion(
  incoming: WorktreeEventVersion,
  current: WorktreeEventVersion
): number {
  if (incoming.epoch !== current.epoch) return 1;
  return incoming.seq - current.seq;
}

let _currentViewStore: WorktreeViewStoreApi | null = null;

export function setCurrentViewStore(store: WorktreeViewStoreApi): void {
  _currentViewStore = store;
}

export function getCurrentViewStore(): WorktreeViewStoreApi {
  if (!_currentViewStore) {
    throw new Error(
      "WorktreeViewStore not initialized — called before WorktreeStoreProvider mount"
    );
  }
  return _currentViewStore;
}

// Non-throwing variant for callers that can legitimately run before the
// provider mounts (e.g. action-manifest listing during initial render).
export function getCurrentViewStoreOrNull(): WorktreeViewStoreApi | null {
  return _currentViewStore;
}

/**
 * A user-attached worktree→issue association held in the renderer alongside
 * the snapshot map. The authoritative copy lives in the Electron store
 * (`worktreeIssueMap`); this slice mirrors it so that `worktree-update` events
 * — which carry only auto-detected (branch-name) issue state — don't clobber
 * manual associations between cold hydrations.
 */
export interface ManualIssueAssociation {
  issueNumber: number;
  issueTitle?: string;
}

/**
 * Options carried alongside a delete-in-flight so the card's "Retry" button
 * can re-fire the original request without re-opening the dialog. The dialog
 * confirms once; the card retries with the same intent.
 */
export interface WorktreeDeleteOptions {
  force?: boolean;
  deleteBranch?: boolean;
  closeTerminals?: boolean;
}

/**
 * Maximum number of generic (unclassified) error retries for a single outbox
 * entry before it's marked `failed` and surfaced to the user. Connectivity
 * failures (port not ready, host exited) don't count — they're driven by the
 * port reconnect lifecycle, not by the entry itself. Permanent errors (e.g.
 * "uncommitted changes", "Cannot delete the main worktree") flip to `failed`
 * after a single attempt without burning the cap. The 3-attempt budget is the
 * standard transient-retry ceiling; past that the failure is almost certainly
 * deterministic and the user should be asked.
 */
export const OUTBOX_RETRY_CAP = 3;

/**
 * Fields shared by every mutation-outbox entry (#8405). One entry per
 * user-intent worktree mutation, keyed by `mutationId`. The outbox survives
 * `setFatalError` so a mutation that was in flight when the host crashed can be
 * replayed once the host comes back. For `delete-worktree` the stable
 * `mutationId` also lets the host dedupe a replay against its ack map; the
 * issue-association mutations route through the main-process IPC bridge (the
 * `worktreeIssueMap` Electron-store write is main-owned, not host-owned), so
 * for them `mutationId` is purely the renderer's outbox key.
 */
interface MutationOutboxEntryBase {
  mutationId: string;
  worktreeId: string;
  /** Number of generic (unclassified) attempts so far; counted toward {@link OUTBOX_RETRY_CAP}. */
  retryCount: number;
  /**
   * `pending` — eligible for the next replay sweep (initial or post-failure).
   * `in-flight` — IPC request currently outstanding; no replay until it settles.
   * `failed` — terminal state for this entry; will not replay automatically.
   *   The user can dismiss the entry or hit Retry, which resets to `pending`.
   */
  status: "pending" | "in-flight" | "failed";
  lastError?: string;
}

/** Delete-worktree outbox entry — acked by the `worktree-removed` host event. */
export interface DeleteWorktreeOutboxEntry extends MutationOutboxEntryBase {
  type: "delete-worktree";
  options: WorktreeDeleteOptions;
}

/**
 * Attach-issue outbox entry (#9163). Unlike delete there is no host-emitted ack
 * event — the main-process `worktreeIssueMap` write is synchronous, so the
 * resolved IPC promise IS the ack and the entry is pruned on resolve. The local
 * association is applied only on success (pessimistic), so a failed/abandoned
 * attach needs no rollback — the renderer never gets ahead of the store.
 */
export interface AttachIssueOutboxEntry extends MutationOutboxEntryBase {
  type: "attach-issue";
  payload: AttachIssuePayload;
}

/** Detach-issue outbox entry (#9163). Same ack/no-rollback semantics as attach. */
export interface DetachIssueOutboxEntry extends MutationOutboxEntryBase {
  type: "detach-issue";
}

export type MutationOutboxEntry =
  DeleteWorktreeOutboxEntry | AttachIssueOutboxEntry | DetachIssueOutboxEntry;

/** True for the issue-association mutation arms (#9163). */
function isIssueMutation(
  entry: MutationOutboxEntry
): entry is AttachIssueOutboxEntry | DetachIssueOutboxEntry {
  return entry.type === "attach-issue" || entry.type === "detach-issue";
}

/** Per-worktree issue-mutation failure surfaced on the card banner (#9163). */
export interface IssueMutationError {
  message: string;
  type: "attach-issue" | "detach-issue";
  /** Outbox entry id so the banner's Retry/Dismiss can target it directly. */
  mutationId: string;
}

/**
 * Error patterns that cannot be remedied by retrying — e.g. uncommitted
 * changes block the delete until the user resolves them. These flip the
 * outbox entry to `failed` after a single attempt rather than burning the
 * generic-retry budget on a deterministic failure. The strings are checked
 * via `includes` against the error message so wrapped/prefixed variants
 * still match. All patterns come from {@link WorkspaceService.deleteWorktree}
 * — they're our own error messages, not git's, so they're stable.
 */
const PERMANENT_ERROR_PATTERNS = [
  "uncommitted changes",
  "untracked files",
  "Cannot delete the main worktree",
  "Cannot delete active worktree",
  "Cannot delete branch:",
  "has unmerged changes",
  "(detached HEAD)",
];

function isPermanentDeleteError(message: string): boolean {
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (message.includes(pattern)) return true;
  }
  return false;
}

/**
 * Connectivity-class errors thrown by `WorktreePortClient` when the host has
 * gone away. The port client encodes these as `BrokerError("HOST_EXITED", ...)`
 * which surfaces in the renderer as a string prefix; the renderer also throws
 * its own "Worktree port not ready" when the port is null. These shouldn't
 * count toward the retry cap — the failure is the port being down, and the
 * port reconnect path drives the next attempt.
 */
function isConnectivityError(message: string): boolean {
  return (
    message.includes("HOST_EXITED") ||
    message.includes("port not ready") ||
    message.includes("port disconnected") ||
    message.includes("port replaced") ||
    message.includes("APP_SHUTDOWN")
  );
}

export interface WorktreeViewState {
  worktrees: Map<string, WorktreeSnapshot>;
  /**
   * `worktreeId → lastGitStatusCheckedAt` (epoch ms), tracked outside the
   * snapshot map on purpose: the host advances this stamp on every completed
   * poll — including polls where nothing user-visible changed — so comparing
   * it in `snapshotsEqual` forced a new `worktrees` Map identity per poll and
   * fanned every quiet tick out to every whole-map subscriber. Freshness
   * consumers (the WorktreeHeader pill, WorktreeCard's revalidate gate) read
   * this map per-id instead. The `lastGitStatusCheckedAt` field still present
   * on stored snapshots reflects the last content change, not the last poll —
   * always read freshness from here.
   */
  statusCheckedAt: Map<string, number>;
  /**
   * `worktreeId → workingTreeChangedAt` (monotonic epoch ms) — the last raw
   * filesystem write the recursive watcher observed, independent of git status.
   * Kept in a side map for the same reason as {@link statusCheckedAt}: it
   * advances on writes that don't change the snapshot's compared fields, so
   * folding it into `snapshotsEqual` would churn the `worktrees` Map identity.
   * The file browser reads it per-id to refresh on writes into gitignored paths
   * that leave `git status` unmoved (#11330).
   */
  workingTreeChangedAtById: Map<string, number>;
  manualAssociations: Map<string, ManualIssueAssociation>;
  /**
   * Host-minted `(epoch, seq)` stamp of the most recently applied event.
   * Initial value uses an empty epoch so the first real host stamp (any
   * non-empty epoch) is treated as an epoch transition and accepted (#8403).
   */
  version: WorktreeEventVersion;
  /**
   * `worktreeId → removedAt` (epoch ms) for recently removed worktrees, so a
   * late same-epoch `worktree-update` can't resurrect a deleted row. Cleared
   * on epoch transition; entries expire after {@link TOMBSTONE_TTL_MS}.
   */
  tombstones: Map<string, number>;
  /**
   * Worktrees with a delete currently in flight (renderer-local — no backend
   * lifecycle phase exists for delete). Drives the card's reduced-opacity
   * "Deleting…" state. Cleared on `worktree-removed` (via `applyRemove`) or
   * on rejection (handled inside `runDeleteAsync`).
   */
  deletingIds: Set<string>;
  deleteErrors: Map<string, string>;
  deleteErrorArgs: Map<string, WorktreeDeleteOptions>;
  /**
   * Worktrees with an attach/detach-issue mutation currently in flight (#9163).
   * Shared single-flight key for both attach and detach so a rapid
   * attach→detach on the same row can't interleave and leave the Electron
   * store in a last-write-wins race. Internal guard only — there's no card
   * "in progress" treatment for issue mutations (the badge updates on success).
   */
  issueMutatingIds: Set<string>;
  /**
   * Per-worktree issue-mutation failures (#9163). Drives the inline
   * `WorktreeIssueErrorBanner`. Connectivity failures don't populate this — the
   * global reconnect indicator covers them and the outbox entry stays pending
   * for the reconnect replay.
   */
  issueErrors: Map<string, IssueMutationError>;
  /**
   * Mutation outbox keyed by `mutationId` (#8405). Survives `setFatalError`
   * so a delete that was in flight when the workspace host crashed can be
   * replayed once the host returns. Entries are pruned on a successful ack
   * (via `applyRemove` for the success path and `pruneAcknowledgedMutations`
   * for the post-crash replay path) or marked `failed` on a permanent error
   * / cap-exceeded retry.
   */
  mutationOutbox: Map<string, MutationOutboxEntry>;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
  isReconnecting: boolean;
  reconnectingAt: number | null;
  /**
   * True while this project's recursive file watcher is degraded to the
   * polling/git-only fallback (ENOSPC/EMFILE). Drives the persistent
   * Tier-1 indicator. Hydrated from the `get-all-states` handshake and
   * updated by watcher degradation/recovery port events.
   */
  watcherDegraded: boolean;
  /**
   * True while this project's topology watcher is "dark" — its subscribe()
   * failed at cold start or a safety valve expired without the matching event,
   * so the worktree list may silently drift until a reconcile verifies it.
   * Drives the same Tier-1 indicator as `watcherDegraded` (logical OR).
   * Hydrated from the `get-all-states` handshake and updated by the
   * `topology-watcher-dark` / `topology-watcher-recovered` port events (#9908).
   */
  topologyWatcherDark: boolean;
}

export interface WorktreeViewActions {
  applySnapshot(
    states: WorktreeSnapshot[],
    version: WorktreeEventVersion,
    associations?: Record<string, ManualIssueAssociation>
  ): void;
  applyUpdate(state: WorktreeSnapshot, version: WorktreeEventVersion): void;
  /**
   * Clear forge-issue overlay without going through `mergeIssueState`, which
   * would restore the previous `issueTitle` whenever `issueNumber` is
   * unchanged (the manual-association preservation path). Used by the
   * `issue-not-found` event handler so a 404 actually clears the title while
   * keeping the branch-parsed `issueNumber` and the `branchDerivedTitle`
   * fallback intact (#8851).
   */
  applyIssueNotFound(worktreeId: string, issueNumber: number): void;
  applyRemove(worktreeId: string, version: WorktreeEventVersion): void;
  setManualAssociation(worktreeId: string, assoc: ManualIssueAssociation): void;
  clearManualAssociation(worktreeId: string): void;
  startDelete(worktreeId: string, options: WorktreeDeleteOptions): void;
  retryDelete(worktreeId: string): void;
  clearDeleteError(worktreeId: string): void;
  /**
   * Attach an issue to a worktree through the resilient outbox (#9163). Creates
   * an `attach-issue` outbox entry and fires the IPC; the local association is
   * applied only once the IPC resolves (the renderer never gets ahead of the
   * Electron store). A host crash mid-call leaves the entry `pending` for the
   * reconnect replay; a non-connectivity failure surfaces the inline banner.
   */
  startAttachIssue(payload: AttachIssuePayload): void;
  /** Detach a worktree's issue through the resilient outbox (#9163). */
  startDetachIssue(worktreeId: string): void;
  /**
   * Prune outbox entries whose `mutationId` is in the supplied set. Called
   * after every `get-all-states` reply so acks the renderer missed (host
   * crash mid-call) are converged on without firing a duplicate replay.
   */
  pruneAcknowledgedMutations(mutationIds: readonly string[]): void;
  /**
   * Reset a `failed` outbox entry to `pending` and re-fire its IPC. The user
   * triggers this from the card's Retry button after a permanent error or
   * cap-exceeded auto-retry. Reuses the original `mutationId` so the host
   * still recognizes the replay.
   */
  retryOutboxEntry(mutationId: string): void;
  /**
   * Remove an outbox entry without retrying — the user clicked Dismiss on a
   * failed entry. Also clears the matching `deleteErrors`/`deleteErrorArgs`
   * entries so the card returns to its idle state.
   */
  dismissOutboxEntry(mutationId: string): void;
  /**
   * Replay every `pending` outbox entry whose target worktree still appears
   * in the current snapshot — entries whose target is already gone are pruned
   * (the original delete succeeded but the ack was lost in the crash window
   * between `git worktree remove` and the result ack — the worktree's
   * absence from the post-restart snapshot is the renderer's source of truth
   * for "this delete already happened"). Called by the context after
   * `applySnapshot` on a reconnect (`isWake` path), not on cold start.
   */
  replayOutboxAfterReconnect(): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  setFatalError(message: string): void;
  setReconnecting(reconnecting: boolean): void;
  setWatcherDegraded(degraded: boolean): void;
  setTopologyWatcherDark(dark: boolean): void;
}

export type WorktreeViewStore = WorktreeViewState & WorktreeViewActions;
export type WorktreeViewStoreApi = StoreApi<WorktreeViewStore>;

export function createWorktreeStore(): WorktreeViewStoreApi {
  return createStore<WorktreeViewStore>((set, get) => ({
    worktrees: new Map(),
    statusCheckedAt: new Map(),
    workingTreeChangedAtById: new Map(),
    manualAssociations: new Map(),
    version: { epoch: "", seq: 0 },
    tombstones: new Map(),
    deletingIds: new Set(),
    deleteErrors: new Map(),
    deleteErrorArgs: new Map(),
    issueMutatingIds: new Set(),
    issueErrors: new Map(),
    mutationOutbox: new Map(),
    isLoading: true,
    error: null,
    isInitialized: false,
    isReconnecting: false,
    reconnectingAt: null,
    watcherDegraded: false,
    topologyWatcherDark: false,

    applySnapshot(
      states: WorktreeSnapshot[],
      version: WorktreeEventVersion,
      associations?: Record<string, ManualIssueAssociation>
    ) {
      const prev = get();
      if (compareVersion(version, prev.version) < 0) return;
      // A snapshot is the host's authoritative state. Drop every tombstone:
      // an epoch transition means the host rebuilt from scratch, and within
      // the same epoch any id the host still reports is alive by definition.
      const tombstonesChanged = prev.tombstones.size > 0;
      // Atomically adopt the freshly-hydrated manual associations alongside
      // the snapshot (lesson #4958 — no separate slice update that could
      // render a half-merged state). When the caller doesn't pass them
      // (e.g. unit tests), keep whatever's already cached.
      const manual = associations
        ? new Map<string, ManualIssueAssociation>(Object.entries(associations))
        : prev.manualAssociations;
      const associationsChanged = associations !== undefined;

      const merged = states.map((s) =>
        mergeIssueState(s, prev.worktrees.get(s.id), manual.get(s.id))
      );

      // Rebuild the freshness map from the authoritative snapshot (also prunes
      // removed ids), keeping the previous identity when every stamp matches
      // so freshness-only subscribers see no spurious notify.
      let nextStatusCheckedAt = prev.statusCheckedAt;
      {
        const rebuilt = new Map<string, number>();
        for (const s of merged) {
          if (s.lastGitStatusCheckedAt !== undefined) {
            rebuilt.set(s.id, s.lastGitStatusCheckedAt);
          }
        }
        const unchanged =
          rebuilt.size === prev.statusCheckedAt.size &&
          [...rebuilt].every(([id, t]) => prev.statusCheckedAt.get(id) === t);
        if (!unchanged) nextStatusCheckedAt = rebuilt;
      }
      const statusCheckedAtChanged = nextStatusCheckedAt !== prev.statusCheckedAt;

      // Same rebuild for the working-tree-changed side map (also prunes removed
      // ids), keeping identity when every stamp matches so browser subscribers
      // see no spurious tick.
      let nextWorkingTreeChangedAt = prev.workingTreeChangedAtById;
      {
        const rebuilt = new Map<string, number>();
        for (const s of merged) {
          if (s.workingTreeChangedAt !== undefined) {
            rebuilt.set(s.id, s.workingTreeChangedAt);
          }
        }
        const unchanged =
          rebuilt.size === prev.workingTreeChangedAtById.size &&
          [...rebuilt].every(([id, t]) => prev.workingTreeChangedAtById.get(id) === t);
        if (!unchanged) nextWorkingTreeChangedAt = rebuilt;
      }
      const workingTreeChangedAtChanged =
        nextWorkingTreeChangedAt !== prev.workingTreeChangedAtById;

      // Once hydrated, suppress redundant Map identity churn when every
      // incoming snapshot is value-equal to its existing counterpart. Cold
      // starts always rebuild so `isInitialized` flips correctly even when
      // the first snapshot is empty.
      if (
        prev.isInitialized &&
        merged.length === prev.worktrees.size &&
        merged.every((s) => {
          const existing = prev.worktrees.get(s.id);
          return existing !== undefined && snapshotsEqual(existing, s);
        })
      ) {
        set({
          version,
          isLoading: false,
          isInitialized: true,
          error: null,
          isReconnecting: false,
          reconnectingAt: null,
          ...(statusCheckedAtChanged ? { statusCheckedAt: nextStatusCheckedAt } : {}),
          ...(workingTreeChangedAtChanged
            ? { workingTreeChangedAtById: nextWorkingTreeChangedAt }
            : {}),
          ...(tombstonesChanged ? { tombstones: new Map() } : {}),
          ...(associationsChanged ? { manualAssociations: manual } : {}),
        });
        return;
      }
      const map = new Map(merged.map((s) => [s.id, s]));
      set({
        worktrees: map,
        version,
        isLoading: false,
        isInitialized: true,
        error: null,
        isReconnecting: false,
        reconnectingAt: null,
        ...(statusCheckedAtChanged ? { statusCheckedAt: nextStatusCheckedAt } : {}),
        ...(workingTreeChangedAtChanged
          ? { workingTreeChangedAtById: nextWorkingTreeChangedAt }
          : {}),
        ...(tombstonesChanged ? { tombstones: new Map() } : {}),
        ...(associationsChanged ? { manualAssociations: manual } : {}),
      });
    },

    applyUpdate(state: WorktreeSnapshot, version: WorktreeEventVersion) {
      const prevState = get();
      if (compareVersion(version, prevState.version) < 0) return;
      const prev = prevState.worktrees;
      const existing = prev.get(state.id);

      // Resurrection guard: a buffered same-epoch `worktree-update` arriving
      // after the `worktree-removed` for the same id must not re-add the row.
      // An epoch transition clears all tombstones (handled below) since they
      // belonged to a prior host run. Expired tombstones are reaped lazily.
      let tombstones = prevState.tombstones;
      const epochChanged = version.epoch !== prevState.version.epoch;
      if (epochChanged) {
        if (tombstones.size > 0) tombstones = new Map();
      } else if (!existing) {
        const removedAt = tombstones.get(state.id);
        if (removedAt !== undefined) {
          if (Date.now() - removedAt < TOMBSTONE_TTL_MS) {
            // Still within the suppression window — drop the late update but
            // advance the version so a subsequent stale event stays rejected.
            set({ version });
            return;
          }
          tombstones = new Map(tombstones);
          tombstones.delete(state.id);
        }
      }
      const tombstonesChanged = tombstones !== prevState.tombstones;

      const merged = mergeIssueState(state, existing, prevState.manualAssociations.get(state.id));

      // Freshness stamp advances on every completed poll; track it in the
      // side map so a poll that changed nothing else doesn't churn the
      // snapshot Map identity below.
      let statusCheckedAt = prevState.statusCheckedAt;
      if (
        merged.lastGitStatusCheckedAt !== undefined &&
        statusCheckedAt.get(state.id) !== merged.lastGitStatusCheckedAt
      ) {
        statusCheckedAt = new Map(statusCheckedAt);
        statusCheckedAt.set(state.id, merged.lastGitStatusCheckedAt);
      }
      const statusCheckedAtChanged = statusCheckedAt !== prevState.statusCheckedAt;

      // The raw fs-write stamp advances independently of git status (it's the
      // whole point of the signal), so a snapshot that's otherwise value-equal
      // still needs to land in the side map — which is why it's applied even on
      // the snapshotsEqual fast path below.
      let workingTreeChangedAtById = prevState.workingTreeChangedAtById;
      if (
        merged.workingTreeChangedAt !== undefined &&
        workingTreeChangedAtById.get(state.id) !== merged.workingTreeChangedAt
      ) {
        workingTreeChangedAtById = new Map(workingTreeChangedAtById);
        workingTreeChangedAtById.set(state.id, merged.workingTreeChangedAt);
      }
      const workingTreeChangedAtChanged =
        workingTreeChangedAtById !== prevState.workingTreeChangedAtById;

      if (existing && snapshotsEqual(existing, merged)) {
        set({
          version,
          ...(statusCheckedAtChanged ? { statusCheckedAt } : {}),
          ...(workingTreeChangedAtChanged ? { workingTreeChangedAtById } : {}),
          ...(tombstonesChanged ? { tombstones } : {}),
        });
        return;
      }
      const next = new Map(prev);
      next.set(state.id, merged);
      set({
        worktrees: next,
        version,
        ...(statusCheckedAtChanged ? { statusCheckedAt } : {}),
        ...(workingTreeChangedAtChanged ? { workingTreeChangedAtById } : {}),
        ...(tombstonesChanged ? { tombstones } : {}),
      });
    },

    applyIssueNotFound(worktreeId: string, issueNumber: number) {
      const prev = get();
      const existing = prev.worktrees.get(worktreeId);
      if (!existing) return;
      if (existing.issueNumber !== issueNumber) return;
      // Direct mutation: bypasses mergeIssueState's title-restoration rule so
      // the not-found response actually clears the title. issueNumber is the
      // branch-parsed local fact and stays put.
      const next = new Map(prev.worktrees);
      next.set(worktreeId, {
        ...existing,
        issueTitle: undefined,
        issueLastUpdatedAt: undefined,
        linked: existing.linked?.pr
          ? { providerId: existing.linked.providerId, pr: existing.linked.pr }
          : null,
      });
      set({ worktrees: next });
    },

    setManualAssociation(worktreeId: string, assoc: ManualIssueAssociation) {
      const prev = get();
      const nextAssoc = new Map(prev.manualAssociations);
      nextAssoc.set(worktreeId, assoc);
      const existing = prev.worktrees.get(worktreeId);
      if (!existing) {
        set({ manualAssociations: nextAssoc });
        return;
      }
      // Re-merge the affected snapshot so the manual association survives the
      // next `worktree-update` (which carries only auto-detected issue state).
      const merged = mergeIssueState(existing, existing, assoc);
      const nextWorktrees = new Map(prev.worktrees);
      nextWorktrees.set(worktreeId, merged);
      set({ manualAssociations: nextAssoc, worktrees: nextWorktrees });
    },

    clearManualAssociation(worktreeId: string) {
      const prev = get();
      if (!prev.manualAssociations.has(worktreeId)) return;
      const nextAssoc = new Map(prev.manualAssociations);
      nextAssoc.delete(worktreeId);
      set({ manualAssociations: nextAssoc });
    },

    applyRemove(worktreeId: string, version: WorktreeEventVersion) {
      const prevState = get();
      if (compareVersion(version, prevState.version) < 0) return;

      // Record a tombstone so a buffered same-epoch `worktree-update` can't
      // resurrect this row (#8403). An epoch transition starts the tombstone
      // set fresh — the prior run's removals don't apply to the new host.
      const now = Date.now();
      const epochChanged = version.epoch !== prevState.version.epoch;
      const tombstones = epochChanged ? new Map<string, number>() : new Map(prevState.tombstones);
      // Reap expired tombstones on write so ids that never receive a follow-up
      // update can't accumulate unbounded over a long high-churn session.
      for (const [id, removedAt] of tombstones) {
        if (now - removedAt >= TOMBSTONE_TTL_MS) tombstones.delete(id);
      }
      tombstones.set(worktreeId, now);

      const hadWorktree = prevState.worktrees.has(worktreeId);
      const hadStatusCheckedAt = prevState.statusCheckedAt.has(worktreeId);
      const hadWorkingTreeChangedAt = prevState.workingTreeChangedAtById.has(worktreeId);
      const hadDeletingId = prevState.deletingIds.has(worktreeId);
      const hadDeleteError = prevState.deleteErrors.has(worktreeId);
      const hadDeleteErrorArgs = prevState.deleteErrorArgs.has(worktreeId);
      const hadIssueMutating = prevState.issueMutatingIds.has(worktreeId);
      const hadIssueError = prevState.issueErrors.has(worktreeId);
      const outboxEntries = findOutboxEntriesForWorktree(prevState.mutationOutbox, worktreeId);

      const nextWorktrees = hadWorktree ? new Map(prevState.worktrees) : prevState.worktrees;
      if (hadWorktree) nextWorktrees.delete(worktreeId);
      const nextStatusCheckedAt = hadStatusCheckedAt
        ? new Map(prevState.statusCheckedAt)
        : prevState.statusCheckedAt;
      if (hadStatusCheckedAt) nextStatusCheckedAt.delete(worktreeId);
      const nextWorkingTreeChangedAt = hadWorkingTreeChangedAt
        ? new Map(prevState.workingTreeChangedAtById)
        : prevState.workingTreeChangedAtById;
      if (hadWorkingTreeChangedAt) nextWorkingTreeChangedAt.delete(worktreeId);
      const nextDeletingIds = hadDeletingId
        ? new Set(prevState.deletingIds)
        : prevState.deletingIds;
      if (hadDeletingId) nextDeletingIds.delete(worktreeId);
      const nextDeleteErrors = hadDeleteError
        ? new Map(prevState.deleteErrors)
        : prevState.deleteErrors;
      if (hadDeleteError) nextDeleteErrors.delete(worktreeId);
      const nextDeleteErrorArgs = hadDeleteErrorArgs
        ? new Map(prevState.deleteErrorArgs)
        : prevState.deleteErrorArgs;
      if (hadDeleteErrorArgs) nextDeleteErrorArgs.delete(worktreeId);
      const nextIssueMutatingIds = hadIssueMutating
        ? new Set(prevState.issueMutatingIds)
        : prevState.issueMutatingIds;
      if (hadIssueMutating) nextIssueMutatingIds.delete(worktreeId);
      const nextIssueErrors = hadIssueError
        ? new Map(prevState.issueErrors)
        : prevState.issueErrors;
      if (hadIssueError) nextIssueErrors.delete(worktreeId);
      // Mutation outbox: a removed worktree moots every outbox entry targeting
      // it. For `delete-worktree`, `worktree-removed` is the authoritative
      // "this delete succeeded" signal (#8405) so a late reply replay can't
      // re-fire a delete that already landed. Issue-association entries are
      // equally moot — the worktree they'd attach/detach an issue on is gone.
      // `runDeleteAsync` also prunes on its own success branch; this is the
      // belt-and-braces convergence for the case where `worktree-removed`
      // arrives before the IPC promise resolves (a common ordering).
      const nextOutbox =
        outboxEntries.length > 0 ? new Map(prevState.mutationOutbox) : prevState.mutationOutbox;
      for (const entry of outboxEntries) nextOutbox.delete(entry.mutationId);

      set({
        worktrees: nextWorktrees,
        statusCheckedAt: nextStatusCheckedAt,
        workingTreeChangedAtById: nextWorkingTreeChangedAt,
        deletingIds: nextDeletingIds,
        deleteErrors: nextDeleteErrors,
        deleteErrorArgs: nextDeleteErrorArgs,
        issueMutatingIds: nextIssueMutatingIds,
        issueErrors: nextIssueErrors,
        mutationOutbox: nextOutbox,
        version,
        tombstones,
      });

      if (hadWorktree) {
        // The worktree is authoritatively gone (#11344): drop its restore
        // bookkeeping so a snapshot from a since-superseded delete can't leak or
        // replay. Do NOT touch the worktree's panels here — the deleted-worktree
        // ghost row (#11232) deliberately leaves surviving panels alive (their
        // agent processes keep running) until the user acts or the auto-cleanup
        // TTL trashes them.
        discardTerminalRestores(
          worktreeId,
          outboxEntries.map((entry) => entry.mutationId)
        );
      }
    },

    startDelete(worktreeId: string, options: WorktreeDeleteOptions) {
      const prev = get();
      if (prev.deletingIds.has(worktreeId)) return;

      const nextDeletingIds = new Set(prev.deletingIds);
      nextDeletingIds.add(worktreeId);
      const nextDeleteErrors = prev.deleteErrors.has(worktreeId)
        ? new Map(prev.deleteErrors)
        : prev.deleteErrors;
      if (prev.deleteErrors.has(worktreeId)) nextDeleteErrors.delete(worktreeId);
      const nextDeleteErrorArgs = new Map(prev.deleteErrorArgs);
      nextDeleteErrorArgs.set(worktreeId, options);

      // Mint a stable mutationId per user-intent delete (#8405). The same id
      // is reused across automatic retries (replay after host crash) AND user-
      // initiated retries — only a fresh `startDelete` for a worktree that has
      // no live outbox entry mints a new id. This is what lets the host's ack
      // map dedupe replays.
      const existingEntry = findDeleteOutboxEntryForWorktree(prev.mutationOutbox, worktreeId);
      const mutationId = existingEntry?.mutationId ?? mintMutationId();
      const nextOutbox = new Map(prev.mutationOutbox);
      nextOutbox.set(mutationId, {
        mutationId,
        worktreeId,
        type: "delete-worktree",
        options,
        retryCount: existingEntry?.retryCount ?? 0,
        status: "in-flight",
        lastError: undefined,
      });

      set({
        deletingIds: nextDeletingIds,
        deleteErrors: nextDeleteErrors,
        deleteErrorArgs: nextDeleteErrorArgs,
        mutationOutbox: nextOutbox,
      });

      void runDeleteAsync(get, set, worktreeId, options, mutationId);
    },

    retryDelete(worktreeId: string) {
      const prev = get();
      const args = prev.deleteErrorArgs.get(worktreeId);
      if (!args) return;
      // Re-fire with the original confirm-dialog options. `startDelete`
      // clears the previous error and re-marks `deletingIds` atomically, and
      // reuses the existing outbox `mutationId` if one is still in flight so
      // the host's ack map dedupes correctly.
      get().startDelete(worktreeId, args);
    },

    clearDeleteError(worktreeId: string) {
      const prev = get();
      const hadError = prev.deleteErrors.has(worktreeId);
      const hadArgs = prev.deleteErrorArgs.has(worktreeId);
      if (!hadError && !hadArgs) return;
      const nextDeleteErrors = hadError ? new Map(prev.deleteErrors) : prev.deleteErrors;
      if (hadError) nextDeleteErrors.delete(worktreeId);
      const nextDeleteErrorArgs = hadArgs ? new Map(prev.deleteErrorArgs) : prev.deleteErrorArgs;
      if (hadArgs) nextDeleteErrorArgs.delete(worktreeId);
      set({
        deleteErrors: nextDeleteErrors,
        deleteErrorArgs: nextDeleteErrorArgs,
      });
    },

    startAttachIssue(payload: AttachIssuePayload) {
      const { worktreeId } = payload;
      const prev = get();
      // Shared single-flight key: an attach or detach already in flight for this
      // worktree blocks a new one so the last-write-wins Electron store isn't
      // raced. The user can act again once the in-flight mutation settles.
      if (prev.issueMutatingIds.has(worktreeId)) return;

      const nextIssueMutatingIds = new Set(prev.issueMutatingIds);
      nextIssueMutatingIds.add(worktreeId);
      const nextIssueErrors = prev.issueErrors.has(worktreeId)
        ? new Map(prev.issueErrors)
        : prev.issueErrors;
      if (prev.issueErrors.has(worktreeId)) nextIssueErrors.delete(worktreeId);

      // Replace any prior (failed) issue entry for this worktree — a fresh user
      // action supersedes it. `mutationId` is just the outbox key here (the
      // issue IPC is main-owned, not host-deduped), so minting a new one is fine.
      const existing = findIssueOutboxEntryForWorktree(prev.mutationOutbox, worktreeId);
      const nextOutbox = new Map(prev.mutationOutbox);
      if (existing) nextOutbox.delete(existing.mutationId);
      const mutationId = mintMutationId();
      const entry: AttachIssueOutboxEntry = {
        type: "attach-issue",
        mutationId,
        worktreeId,
        payload,
        retryCount: 0,
        status: "in-flight",
        lastError: undefined,
      };
      nextOutbox.set(mutationId, entry);

      set({
        issueMutatingIds: nextIssueMutatingIds,
        issueErrors: nextIssueErrors,
        mutationOutbox: nextOutbox,
      });
      void runIssueMutationAsync(get, set, entry);
    },

    startDetachIssue(worktreeId: string) {
      const prev = get();
      if (prev.issueMutatingIds.has(worktreeId)) return;

      const nextIssueMutatingIds = new Set(prev.issueMutatingIds);
      nextIssueMutatingIds.add(worktreeId);
      const nextIssueErrors = prev.issueErrors.has(worktreeId)
        ? new Map(prev.issueErrors)
        : prev.issueErrors;
      if (prev.issueErrors.has(worktreeId)) nextIssueErrors.delete(worktreeId);

      const existing = findIssueOutboxEntryForWorktree(prev.mutationOutbox, worktreeId);
      const nextOutbox = new Map(prev.mutationOutbox);
      if (existing) nextOutbox.delete(existing.mutationId);
      const mutationId = mintMutationId();
      const entry: DetachIssueOutboxEntry = {
        type: "detach-issue",
        mutationId,
        worktreeId,
        retryCount: 0,
        status: "in-flight",
        lastError: undefined,
      };
      nextOutbox.set(mutationId, entry);

      set({
        issueMutatingIds: nextIssueMutatingIds,
        issueErrors: nextIssueErrors,
        mutationOutbox: nextOutbox,
      });
      void runIssueMutationAsync(get, set, entry);
    },

    pruneAcknowledgedMutations(mutationIds: readonly string[]) {
      if (mutationIds.length === 0) return;
      const prev = get();
      if (prev.mutationOutbox.size === 0) return;
      const removedWorktreeIds = new Set<string>();
      const acked = new Set(mutationIds);
      const next = new Map(prev.mutationOutbox);
      let changed = false;
      for (const entry of prev.mutationOutbox.values()) {
        if (acked.has(entry.mutationId)) {
          next.delete(entry.mutationId);
          changed = true;
          // The success path normally clears `deletingIds` via `applyRemove`
          // (driven by the `worktree-removed` event). But if the host crashed
          // between sending `worktree-removed` and the result ack, the
          // renderer may still have `deletingIds.has(worktreeId)` true.
          // Sweep every affected id here as a safety net — without this, a
          // batch ack that covers multiple concurrent deletes would only
          // clear the last entry's card (#8405 review finding #3).
          removedWorktreeIds.add(entry.worktreeId);
        }
      }
      if (!changed) return;
      // We only need to touch `deletingIds`/error maps if a swept entry's
      // worktreeId still appears in them — the snapshot from the new host
      // run should have already filtered them out via `applyRemove`-equivalent
      // semantics, but defensive cleanup keeps the card in sync.
      let nextDeletingIds = prev.deletingIds;
      let nextDeleteErrors = prev.deleteErrors;
      let nextDeleteErrorArgs = prev.deleteErrorArgs;
      // The host ack list only carries `delete-worktree` ids in practice (issue
      // mutations route through main, never the host ack map), but sweep the
      // issue guards/errors too so an unexpected ack can never permanently wedge
      // a worktree in `issueMutatingIds` (which would block re-attach).
      let nextIssueMutatingIds = prev.issueMutatingIds;
      let nextIssueErrors = prev.issueErrors;
      for (const removedWorktreeId of removedWorktreeIds) {
        if (prev.deletingIds.has(removedWorktreeId)) {
          if (nextDeletingIds === prev.deletingIds) nextDeletingIds = new Set(prev.deletingIds);
          nextDeletingIds.delete(removedWorktreeId);
        }
        if (prev.deleteErrors.has(removedWorktreeId)) {
          if (nextDeleteErrors === prev.deleteErrors) nextDeleteErrors = new Map(prev.deleteErrors);
          nextDeleteErrors.delete(removedWorktreeId);
        }
        if (prev.deleteErrorArgs.has(removedWorktreeId)) {
          if (nextDeleteErrorArgs === prev.deleteErrorArgs)
            nextDeleteErrorArgs = new Map(prev.deleteErrorArgs);
          nextDeleteErrorArgs.delete(removedWorktreeId);
        }
        if (prev.issueMutatingIds.has(removedWorktreeId)) {
          if (nextIssueMutatingIds === prev.issueMutatingIds)
            nextIssueMutatingIds = new Set(prev.issueMutatingIds);
          nextIssueMutatingIds.delete(removedWorktreeId);
        }
        if (prev.issueErrors.has(removedWorktreeId)) {
          if (nextIssueErrors === prev.issueErrors) nextIssueErrors = new Map(prev.issueErrors);
          nextIssueErrors.delete(removedWorktreeId);
        }
      }
      set({
        mutationOutbox: next,
        deletingIds: nextDeletingIds,
        deleteErrors: nextDeleteErrors,
        deleteErrorArgs: nextDeleteErrorArgs,
        issueMutatingIds: nextIssueMutatingIds,
        issueErrors: nextIssueErrors,
      });
    },

    retryOutboxEntry(mutationId: string) {
      const prev = get();
      const entry = prev.mutationOutbox.get(mutationId);
      if (!entry) return;
      if (entry.status === "in-flight") return;
      // Reset retry budget on a user-initiated retry — the user is making a
      // fresh judgment that the failure is worth another attempt, and an
      // exhausted auto-retry budget should not stick. Reuses the original
      // `mutationId` so the delete host's ack map still recognizes the replay.
      const next = new Map(prev.mutationOutbox);
      const reset: MutationOutboxEntry = {
        ...entry,
        status: "in-flight",
        retryCount: 0,
        lastError: undefined,
      };
      next.set(mutationId, reset);

      if (isIssueMutation(reset)) {
        const nextIssueMutatingIds = prev.issueMutatingIds.has(reset.worktreeId)
          ? prev.issueMutatingIds
          : new Set(prev.issueMutatingIds).add(reset.worktreeId);
        const nextIssueErrors = prev.issueErrors.has(reset.worktreeId)
          ? new Map(prev.issueErrors)
          : prev.issueErrors;
        if (prev.issueErrors.has(reset.worktreeId)) nextIssueErrors.delete(reset.worktreeId);
        set({
          mutationOutbox: next,
          issueMutatingIds: nextIssueMutatingIds,
          issueErrors: nextIssueErrors,
        });
        void runIssueMutationAsync(get, set, reset);
        return;
      }

      const nextDeletingIds = prev.deletingIds.has(reset.worktreeId)
        ? prev.deletingIds
        : new Set(prev.deletingIds).add(reset.worktreeId);
      const nextDeleteErrors = prev.deleteErrors.has(reset.worktreeId)
        ? new Map(prev.deleteErrors)
        : prev.deleteErrors;
      if (prev.deleteErrors.has(reset.worktreeId)) nextDeleteErrors.delete(reset.worktreeId);
      set({
        mutationOutbox: next,
        deletingIds: nextDeletingIds,
        deleteErrors: nextDeleteErrors,
      });
      void runDeleteAsync(get, set, reset.worktreeId, reset.options, mutationId);
    },

    dismissOutboxEntry(mutationId: string) {
      const prev = get();
      const entry = prev.mutationOutbox.get(mutationId);
      if (!entry) return;
      const next = new Map(prev.mutationOutbox);
      next.delete(mutationId);

      if (isIssueMutation(entry)) {
        // No optimistic state to unwind — issue mutations apply the local
        // association only on success, so dismissing a failed entry just clears
        // the error and the in-flight guard.
        const nextIssueErrors = prev.issueErrors.has(entry.worktreeId)
          ? new Map(prev.issueErrors)
          : prev.issueErrors;
        if (prev.issueErrors.has(entry.worktreeId)) nextIssueErrors.delete(entry.worktreeId);
        const nextIssueMutatingIds = prev.issueMutatingIds.has(entry.worktreeId)
          ? new Set(prev.issueMutatingIds)
          : prev.issueMutatingIds;
        if (prev.issueMutatingIds.has(entry.worktreeId))
          nextIssueMutatingIds.delete(entry.worktreeId);
        set({
          mutationOutbox: next,
          issueErrors: nextIssueErrors,
          issueMutatingIds: nextIssueMutatingIds,
        });
        return;
      }

      const nextDeleteErrors = prev.deleteErrors.has(entry.worktreeId)
        ? new Map(prev.deleteErrors)
        : prev.deleteErrors;
      if (prev.deleteErrors.has(entry.worktreeId)) nextDeleteErrors.delete(entry.worktreeId);
      const nextDeleteErrorArgs = prev.deleteErrorArgs.has(entry.worktreeId)
        ? new Map(prev.deleteErrorArgs)
        : prev.deleteErrorArgs;
      if (prev.deleteErrorArgs.has(entry.worktreeId)) nextDeleteErrorArgs.delete(entry.worktreeId);
      set({
        mutationOutbox: next,
        deleteErrors: nextDeleteErrors,
        deleteErrorArgs: nextDeleteErrorArgs,
      });
    },

    replayOutboxAfterReconnect() {
      const prev = get();
      if (prev.mutationOutbox.size === 0) return;
      // Two passes: first reconcile any entries whose target is already gone
      // from the post-crash snapshot (the original delete succeeded but the
      // ack never reached the renderer), then fire replays for entries whose
      // target still exists. The reconcile pass is critical for correctness —
      // without it, a delete that the host completed pre-crash would re-fire
      // and hit "Worktree not found", showing a spurious permanent error.
      let outboxChanged = false;
      let deletingChanged = false;
      let issueMutatingChanged = false;
      const nextOutbox = new Map(prev.mutationOutbox);
      const nextDeletingIds = new Set(prev.deletingIds);
      const nextIssueMutatingIds = new Set(prev.issueMutatingIds);
      const toReplay: MutationOutboxEntry[] = [];
      for (const entry of prev.mutationOutbox.values()) {
        if (entry.status === "failed") continue;
        // Skip `in-flight` so a second `replayOutboxAfterReconnect` call
        // (two rapid `onReady` events before the first replay's IPC settles)
        // doesn't double-fire the same mutation (#8405 review finding #4). The
        // first call's IPC promise will still resolve/reject and update the
        // entry; only then is another replay eligible.
        if (entry.status === "in-flight") continue;
        if (!prev.worktrees.has(entry.worktreeId)) {
          // Reconciled — target already absent from the post-crash snapshot. For
          // a delete this means it completed pre-crash but the ack was lost; for
          // an issue mutation the worktree is simply gone, so the attach/detach
          // is moot. Either way: prune, don't replay (a replay would hit
          // "Worktree not found" and surface a spurious error).
          nextOutbox.delete(entry.mutationId);
          outboxChanged = true;
          if (nextDeletingIds.delete(entry.worktreeId)) deletingChanged = true;
          if (nextIssueMutatingIds.delete(entry.worktreeId)) issueMutatingChanged = true;
          continue;
        }
        // Replay candidate — flip to in-flight so a duplicate replay during
        // the same reconnect window is suppressed.
        nextOutbox.set(entry.mutationId, { ...entry, status: "in-flight" });
        outboxChanged = true;
        if (isIssueMutation(entry)) {
          if (!nextIssueMutatingIds.has(entry.worktreeId)) {
            nextIssueMutatingIds.add(entry.worktreeId);
            issueMutatingChanged = true;
          }
        } else if (!nextDeletingIds.has(entry.worktreeId)) {
          nextDeletingIds.add(entry.worktreeId);
          deletingChanged = true;
        }
        toReplay.push(entry);
      }
      if (outboxChanged || deletingChanged || issueMutatingChanged) {
        set({
          mutationOutbox: outboxChanged ? nextOutbox : prev.mutationOutbox,
          deletingIds: deletingChanged ? nextDeletingIds : prev.deletingIds,
          issueMutatingIds: issueMutatingChanged ? nextIssueMutatingIds : prev.issueMutatingIds,
        });
      }
      for (const entry of toReplay) {
        // Each replay re-reads the freshest entry shape it needs; the flipped
        // `in-flight` copy in `nextOutbox` is what the async helpers mutate.
        const flipped = nextOutbox.get(entry.mutationId)!;
        if (isIssueMutation(flipped)) {
          void runIssueMutationAsync(get, set, flipped);
        } else {
          void runDeleteAsync(get, set, flipped.worktreeId, flipped.options, flipped.mutationId);
        }
      }
    },

    setLoading(loading: boolean) {
      set({ isLoading: loading });
    },

    setError(error: string | null) {
      set({ error });
    },

    setFatalError(message: string) {
      // Also clear `isLoading` so the sidebar renders the error branch (and
      // its Restart Service button) even when the host crashes before the
      // first snapshot hydrates — otherwise `SidebarContent` keeps showing
      // "Loading worktrees…" and the restart action is never surfaced.
      // `isInitialized` is reset so the next `fetchInitialState` treats the
      // post-restart fetch as a cold start rather than a silent wake refresh
      // (which swallows fetch errors).
      // Drop cached manual associations too — the post-restart
      // `fetchInitialState` re-hydrates them from the Electron store, so a
      // stale renderer copy must not leak across the crash boundary.
      // `mutationOutbox` is DELIBERATELY preserved (#8405) — it has no
      // server-side fallback to re-hydrate from, and the whole point of the
      // outbox is that a delete in flight when the host crashed gets to
      // replay on the next port reconnect. Clearing it here would silently
      // drop the user's request mid-flight.
      set({
        error: message,
        manualAssociations: new Map(),
        isInitialized: false,
        isReconnecting: false,
        reconnectingAt: null,
        isLoading: false,
      });
    },

    setReconnecting(reconnecting: boolean) {
      // Preserve the original disconnect timestamp across repeated
      // setReconnecting(true) calls. During a workspace-host crash-retry
      // loop, `onDisconnected` can fire on every restart attempt; resetting
      // the baseline on each fire would keep the elapsed clock under the
      // escalation threshold for the entire ~14s restart budget, so the
      // escalated copy would never appear before `setFatalError` fires.
      const prev = get();
      set({
        isReconnecting: reconnecting,
        reconnectingAt: reconnecting
          ? prev.isReconnecting && prev.reconnectingAt !== null
            ? prev.reconnectingAt
            : Date.now()
          : null,
      });
    },

    setWatcherDegraded(degraded: boolean) {
      // Functional updater: degradation/recovery events can race the
      // get-all-states hydration; merge against the latest state so a
      // concurrent update isn't dropped by a stale closure.
      set((prev) => (prev.watcherDegraded === degraded ? prev : { watcherDegraded: degraded }));
    },

    setTopologyWatcherDark(dark: boolean) {
      // Functional updater for the same reason as setWatcherDegraded: the
      // dark/recovered events can race the get-all-states hydration.
      set((prev) => (prev.topologyWatcherDark === dark ? prev : { topologyWatcherDark: dark }));
    },
  }));
}

/** Every live outbox entry for a worktreeId — a worktree can now hold both a
 *  delete and an issue-mutation entry concurrently (#9163). Used by
 *  `applyRemove` to prune them all when the worktree is gone. */
function findOutboxEntriesForWorktree(
  outbox: Map<string, MutationOutboxEntry>,
  worktreeId: string
): MutationOutboxEntry[] {
  const entries: MutationOutboxEntry[] = [];
  for (const entry of outbox.values()) {
    if (entry.worktreeId === worktreeId) entries.push(entry);
  }
  return entries;
}

/** Locate the live delete entry (if any) for a worktreeId. Used to reuse
 *  `mutationId` across user-initiated retries so the host's ack map dedupes. */
function findDeleteOutboxEntryForWorktree(
  outbox: Map<string, MutationOutboxEntry>,
  worktreeId: string
): DeleteWorktreeOutboxEntry | undefined {
  for (const entry of outbox.values()) {
    if (entry.worktreeId === worktreeId && entry.type === "delete-worktree") return entry;
  }
  return undefined;
}

/** Locate the live issue-association entry (if any) for a worktreeId (#9163).
 *  Attach and detach share the slot — only one issue mutation per worktree. */
function findIssueOutboxEntryForWorktree(
  outbox: Map<string, MutationOutboxEntry>,
  worktreeId: string
): AttachIssueOutboxEntry | DetachIssueOutboxEntry | undefined {
  for (const entry of outbox.values()) {
    if (entry.worktreeId === worktreeId && isIssueMutation(entry)) return entry;
  }
  return undefined;
}

/** Renderer-minted opaque id for a single user-intent mutation. UUIDv4 via
 *  `crypto.randomUUID` for cryptographic uniqueness across renderer sessions
 *  (the host ack map is global per-epoch and the renderer must not collide
 *  even across project switches that share a host process). */
function mintMutationId(): string {
  return crypto.randomUUID();
}

/**
 * Terminals closed ahead of a `git worktree remove`, held by `mutationId` so
 * they can be relaunched if the delete is ultimately abandoned (#11344). Keyed
 * by mutationId — not worktreeId — so the snapshot survives the outbox retry
 * loop: a connectivity or generic failure leaves the delete `pending` and
 * replays `runDeleteAsync`, but the replay finds no live terminals to snapshot
 * (they're already dead), so the ORIGINAL capture must persist here until the
 * delete either succeeds (entry discarded) or is definitively abandoned (entry
 * consumed to restore). In-memory only: a host crash mid-delete loses the
 * snapshot, which is acceptable — the PTYs died with the host regardless.
 */
const pendingTerminalRestores = new Map<string, WorktreeTerminalRestoreSnapshot[]>();

/**
 * In-flight relaunch per worktree. A relaunch is a sequence of async `addPanel`
 * spawns; a fresh `runDeleteAsync` for the same worktree awaits this before
 * closing terminals, so a rapid retry can't interleave its close with spawns
 * still in flight (which would strand panels against the git remove or leak them
 * onto a deleted worktree).
 */
const restoreInFlight = new Map<string, Promise<void>>();

/** Relaunch the terminals closed for a delete that has been definitively
 *  abandoned (won't be auto-retried), then drop the snapshot. No-op when the
 *  delete closed no terminals or a prior branch already consumed it. Tracks the
 *  relaunch promise per worktree so a concurrent delete can await it. */
function consumeTerminalRestore(worktreeId: string, mutationId: string): void {
  const snapshot = pendingTerminalRestores.get(mutationId);
  if (!snapshot) return;
  pendingTerminalRestores.delete(mutationId);
  const done = restoreClosedTerminals(snapshot).finally(() => {
    if (restoreInFlight.get(worktreeId) === done) restoreInFlight.delete(worktreeId);
  });
  restoreInFlight.set(worktreeId, done);
}

/** Drop any pending/in-flight restore bookkeeping for a worktree. Called when
 *  the worktree is authoritatively gone (`applyRemove`) so the module maps don't
 *  leak a snapshot that will never be replayed. */
function discardTerminalRestores(worktreeId: string, mutationIds: readonly string[]): void {
  for (const mutationId of mutationIds) pendingTerminalRestores.delete(mutationId);
  restoreInFlight.delete(worktreeId);
}

/**
 * Fire-and-forget delete async chain. The dialog dismisses immediately after
 * calling `startDelete`; this runs in the background driven by the store, so
 * `get()` / `set()` must never close over component state. The success cleanup
 * is handled by `applyRemove` (triggered by the `worktree-removed` IPC event),
 * not here — the only thing we own is the failure path.
 *
 * `mutationId` (#8405) is the renderer's stable identifier for this delete
 * intent and is threaded through to the host so a replay after a crash is
 * deduplicated against the host's ack map. On a connectivity failure (host
 * crashed mid-call) the entry is left as `pending` and the renderer's
 * `replayOutboxAfterReconnect` re-fires it once the port returns. On a
 * permanent error (uncommitted changes, etc.) the entry flips to `failed`
 * immediately. Generic errors increment the retry counter and flip to
 * `failed` once {@link OUTBOX_RETRY_CAP} is reached.
 */
async function runDeleteAsync(
  get: () => WorktreeViewStore,
  set: (
    partial: Partial<WorktreeViewStore> | ((state: WorktreeViewStore) => Partial<WorktreeViewStore>)
  ) => void,
  worktreeId: string,
  options: WorktreeDeleteOptions,
  mutationId: string
): Promise<void> {
  try {
    // A rapid retry after a prior attempt's restore must not start closing
    // terminals while that restore is still spawning panels (#11344) — wait it
    // out so this attempt sees the fully-restored set.
    const inFlightRestore = restoreInFlight.get(worktreeId);
    if (inFlightRestore) await inFlightRestore;

    if (options.closeTerminals) {
      // Capture BEFORE the destructive close so a close-wait timeout can't lose
      // the snapshot. Set only on the FIRST attempt that finds live terminals —
      // a retry replay finds none (already dead) and must not clobber it; a
      // later non-empty capture (e.g. the user opened new terminals mid-retry)
      // must not either.
      const snapshot = captureWorktreeTerminalSnapshot(worktreeId);
      if (snapshot.length > 0 && !pendingTerminalRestores.has(mutationId)) {
        pendingTerminalRestores.set(mutationId, snapshot);
      }
      await closeTerminalsForWorktree(worktreeId);
    }
    // Stop any running dev preview BEFORE `git worktree remove` (#9084). On
    // Windows the dev server holds a directory lock and the removal would
    // fail outright. Snapshot the worktree name first so a transient toast
    // can name it after `applyRemove` has already cleared the row.
    //
    // `getByWorktree` reflects only the worktreeId→session mapping's current
    // head, so when multiple panels share a worktreeId it may show one
    // session while another runs. `stopByWorktree` filters every session
    // itself and no-ops cleanly when nothing matches — call it
    // unconditionally and use `getByWorktree` only to decide whether to
    // surface a toast.
    const worktreeBefore = get().worktrees.get(worktreeId);
    const worktreeName = worktreeBefore?.name ?? worktreeBefore?.branch ?? worktreeId;
    const existingDevPreview = await window.electron.devPreview.getByWorktree({ worktreeId });
    const hadDevPreview = existingDevPreview !== null;
    await window.electron.devPreview.stopByWorktree({ worktreeId });
    await worktreeClient.delete(worktreeId, options.force, options.deleteBranch, mutationId);
    if (hadDevPreview) {
      notify({
        type: "success",
        title: "Dev server stopped",
        message: `${worktreeName} stopped before removing the worktree.`,
        transient: true,
      });
    }
    // Success: the worktree is gone, so the closed terminals stay closed —
    // discard their restore snapshot. `worktree-removed` will fire
    // `applyRemove`, which clears `deletingIds` + delete-error maps. The outbox
    // entry is pruned either by `applyRemove` (success path) or by the next
    // `get-all-states` reply via `pruneAcknowledgedMutations` (post-crash replay
    // path). Either way, no post-success bookkeeping is owned here.
    pendingTerminalRestores.delete(mutationId);
    pruneOutboxEntry(get, set, mutationId);
  } catch (err) {
    const message = formatErrorMessage(err, "Failed to delete worktree");
    const prev = get();
    // Partial-success path: the backend emits `worktree-removed` BEFORE the
    // branch-delete step (WorkspaceService.deleteWorktree:1587 vs :1592), so a
    // branch-delete failure arrives after `applyRemove` has already cleared
    // the card. The card surface is gone — fall back to a toast so the user
    // learns the branch was not cleaned up. Without this, the failure is
    // silently swallowed (the original race guard's bug).
    if (!prev.deletingIds.has(worktreeId) && !prev.worktrees.has(worktreeId)) {
      // The worktree directory is already gone (only the branch delete failed),
      // so the closed terminals have no home to come back to — drop the snapshot
      // rather than relaunch them against a deleted worktree.
      pendingTerminalRestores.delete(mutationId);
      pruneOutboxEntry(get, set, mutationId);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't delete branch",
        message,
        priority: "high",
        context: { worktreeId },
      });
      return;
    }
    handleDeleteFailure(get, set, worktreeId, options, mutationId, message);
  }
}

/** Remove an outbox entry by mutationId. Used on success and on partial
 *  success. No-op when the entry is already gone (a concurrent
 *  `pruneAcknowledgedMutations` may have removed it). */
function pruneOutboxEntry(
  get: () => WorktreeViewStore,
  set: (
    partial: Partial<WorktreeViewStore> | ((state: WorktreeViewStore) => Partial<WorktreeViewStore>)
  ) => void,
  mutationId: string
): void {
  const prev = get();
  if (!prev.mutationOutbox.has(mutationId)) return;
  const next = new Map(prev.mutationOutbox);
  next.delete(mutationId);
  set({ mutationOutbox: next });
}

/** Classify a delete failure and update the outbox entry accordingly.
 *
 *  Three branches:
 *   1. **Connectivity** — port not ready / host exited. Leave the entry as
 *      `pending` (no retry-cap charge) so the reconnect-driven replay fires.
 *      The card surface flips back to idle so the user isn't stuck looking at
 *      a spinner during the reconnect window; the persistent error indicator
 *      is the workspace-host reconnecting state itself, not the card.
 *   2. **Permanent** — uncommitted changes, main worktree, etc. Flip the
 *      entry to `failed` (no retry) and surface the error on the card.
 *   3. **Generic** — anything else. Increment the retry counter. If still
 *      under the cap, leave as `pending`; otherwise flip to `failed`. */
function handleDeleteFailure(
  get: () => WorktreeViewStore,
  set: (
    partial: Partial<WorktreeViewStore> | ((state: WorktreeViewStore) => Partial<WorktreeViewStore>)
  ) => void,
  worktreeId: string,
  options: WorktreeDeleteOptions,
  mutationId: string,
  message: string
): void {
  const prev = get();
  const entry = prev.mutationOutbox.get(mutationId);
  const isConnectivity = isConnectivityError(message);
  const isPermanent = !isConnectivity && isPermanentDeleteError(message);

  const nextDeletingIds = new Set(prev.deletingIds);
  nextDeletingIds.delete(worktreeId);

  if (isConnectivity) {
    // Card returns to idle; outbox entry stays `pending` for the reconnect
    // replay to pick up. Surface no per-card error — the global
    // workspace-host reconnect indicator covers it.
    const nextOutbox = entry ? new Map(prev.mutationOutbox) : prev.mutationOutbox;
    if (entry) {
      nextOutbox.set(mutationId, {
        ...entry,
        status: "pending",
        lastError: message,
      });
    }
    set({
      deletingIds: nextDeletingIds,
      mutationOutbox: nextOutbox,
    });
    return;
  }

  const nextDeleteErrors = new Map(prev.deleteErrors);
  nextDeleteErrors.set(worktreeId, message);
  const nextDeleteErrorArgs = new Map(prev.deleteErrorArgs);
  nextDeleteErrorArgs.set(worktreeId, options);

  if (!entry) {
    // No outbox entry — shouldn't happen since `startDelete` always creates
    // one, but defensive: still surface the error on the card. Nothing will
    // auto-retry this delete, so bring the closed terminals back (#11344).
    consumeTerminalRestore(worktreeId, mutationId);
    set({
      deletingIds: nextDeletingIds,
      deleteErrors: nextDeleteErrors,
      deleteErrorArgs: nextDeleteErrorArgs,
    });
    return;
  }

  const nextOutbox = new Map(prev.mutationOutbox);
  const nextRetryCount = isPermanent ? entry.retryCount : entry.retryCount + 1;
  const exceededCap = nextRetryCount >= OUTBOX_RETRY_CAP;
  const nextStatus: MutationOutboxEntry["status"] =
    isPermanent || exceededCap ? "failed" : "pending";
  nextOutbox.set(mutationId, {
    ...entry,
    status: nextStatus,
    retryCount: nextRetryCount,
    lastError: message,
  });

  // Only a `failed` delete is definitively abandoned; a `pending` one will be
  // replayed (reconnect or generic retry), so relaunching now would flicker the
  // terminals and re-close them on the next attempt. Restore solely on the
  // terminal transition (#11344).
  if (nextStatus === "failed") consumeTerminalRestore(worktreeId, mutationId);

  set({
    deletingIds: nextDeletingIds,
    deleteErrors: nextDeleteErrors,
    deleteErrorArgs: nextDeleteErrorArgs,
    mutationOutbox: nextOutbox,
  });
}

type WorktreeSet = (
  partial: Partial<WorktreeViewStore> | ((state: WorktreeViewStore) => Partial<WorktreeViewStore>)
) => void;

/**
 * Fire-and-forget attach/detach-issue async chain (#9163). Mirrors
 * `runDeleteAsync`'s store-driven shape so it survives a host crash via the
 * outbox, but differs in two ways grounded in where the data lives:
 *
 *  1. **No host ack event.** `worktreeIssueMap` is a main-process Electron-store
 *     write (not host-owned like `git worktree remove`), so there is no
 *     `worktree-removed`-style push to wait on. The resolved IPC promise IS the
 *     ack, so success applies the local association and prunes the entry here.
 *  2. **No rollback / partial-success path.** The local association is applied
 *     only on success (the renderer never gets ahead of the store), so a
 *     failed or abandoned mutation needs nothing unwound — eliminating the
 *     silent desync this fixes at the root.
 *
 * Uses `get()` at the point of use (never a captured closure) so a replay after
 * reconnect reads the freshest state (lesson #5087).
 */
async function runIssueMutationAsync(
  get: () => WorktreeViewStore,
  set: WorktreeSet,
  entry: AttachIssueOutboxEntry | DetachIssueOutboxEntry
): Promise<void> {
  const { worktreeId, type } = entry;
  try {
    if (type === "attach-issue") {
      await worktreeClient.attachIssue(entry.payload);
    } else {
      await worktreeClient.detachIssue(worktreeId);
    }
    applyIssueMutationSuccess(get, set, entry);
  } catch (err) {
    const message = formatErrorMessage(
      err,
      type === "attach-issue" ? "Failed to attach issue" : "Failed to detach issue"
    );
    handleIssueFailure(get, set, entry, message);
  }
}

/** Apply the authoritative local association now that the store write landed,
 *  then prune the outbox entry and clear the in-flight guard / any error. */
function applyIssueMutationSuccess(
  get: () => WorktreeViewStore,
  set: WorktreeSet,
  entry: AttachIssueOutboxEntry | DetachIssueOutboxEntry
): void {
  const prev = get();
  const { worktreeId, mutationId } = entry;
  // Superseded mid-flight: the entry was pruned (worktree removed, or the user
  // dismissed it) while the IPC was outstanding, so this result is moot. Don't
  // write a stale `manualAssociations` entry for a worktree that may be gone —
  // the pruning path already cleared the in-flight guard and any error.
  if (!prev.mutationOutbox.has(mutationId)) return;
  const existing = prev.worktrees.get(worktreeId);

  let nextManual = prev.manualAssociations;
  let nextWorktrees = prev.worktrees;
  if (entry.type === "attach-issue") {
    // Record the manual association + re-merge the snapshot so it survives the
    // next `worktree-update` (which carries only auto-detected issue state).
    const assoc: ManualIssueAssociation = {
      issueNumber: entry.payload.issueNumber,
      issueTitle: entry.payload.issueTitle,
    };
    nextManual = new Map(prev.manualAssociations);
    nextManual.set(worktreeId, assoc);
    if (existing) {
      nextWorktrees = new Map(prev.worktrees);
      nextWorktrees.set(worktreeId, mergeIssueState(existing, existing, assoc));
    }
  } else {
    if (prev.manualAssociations.has(worktreeId)) {
      nextManual = new Map(prev.manualAssociations);
      nextManual.delete(worktreeId);
    }
    if (existing && (existing.issueNumber !== undefined || existing.issueTitle !== undefined)) {
      nextWorktrees = new Map(prev.worktrees);
      nextWorktrees.set(worktreeId, { ...existing, issueNumber: undefined, issueTitle: undefined });
    }
  }

  const nextOutbox = prev.mutationOutbox.has(mutationId)
    ? new Map(prev.mutationOutbox)
    : prev.mutationOutbox;
  if (prev.mutationOutbox.has(mutationId)) nextOutbox.delete(mutationId);
  const nextIssueMutatingIds = prev.issueMutatingIds.has(worktreeId)
    ? new Set(prev.issueMutatingIds)
    : prev.issueMutatingIds;
  if (prev.issueMutatingIds.has(worktreeId)) nextIssueMutatingIds.delete(worktreeId);
  const nextIssueErrors = prev.issueErrors.has(worktreeId)
    ? new Map(prev.issueErrors)
    : prev.issueErrors;
  if (prev.issueErrors.has(worktreeId)) nextIssueErrors.delete(worktreeId);

  set({
    manualAssociations: nextManual,
    worktrees: nextWorktrees,
    mutationOutbox: nextOutbox,
    issueMutatingIds: nextIssueMutatingIds,
    issueErrors: nextIssueErrors,
  });
}

/** Classify an attach/detach-issue failure (#9163).
 *
 *  - **Connectivity** — host exited / port down. Leave the entry `pending` for
 *    the reconnect replay; no banner (the global reconnect indicator covers it).
 *  - **Generic** — anything else. The issue-map write is a key-value store
 *    write with no deterministic "permanent" failure class (unlike delete's
 *    "uncommitted changes"), so every non-connectivity error retries up to the
 *    cap, then flips to `failed`. The banner is surfaced immediately so the
 *    user sees the failure even while the entry is still retry-eligible. */
function handleIssueFailure(
  get: () => WorktreeViewStore,
  set: WorktreeSet,
  entry: AttachIssueOutboxEntry | DetachIssueOutboxEntry,
  message: string
): void {
  const { worktreeId, mutationId, type } = entry;
  const prev = get();
  const current = prev.mutationOutbox.get(mutationId);
  // Superseded mid-flight (worktree removed, or the entry dismissed): the
  // failure is moot and the pruning path already cleared the in-flight guard
  // and any error. Don't resurrect a banner for a worktree that may be gone.
  if (!current) return;
  const isConnectivity = isConnectivityError(message);

  const nextIssueMutatingIds = new Set(prev.issueMutatingIds);
  nextIssueMutatingIds.delete(worktreeId);

  if (isConnectivity) {
    const nextOutbox = new Map(prev.mutationOutbox);
    nextOutbox.set(mutationId, { ...current, status: "pending", lastError: message });
    set({ issueMutatingIds: nextIssueMutatingIds, mutationOutbox: nextOutbox });
    return;
  }

  const nextIssueErrors = new Map(prev.issueErrors);
  nextIssueErrors.set(worktreeId, { message, type, mutationId });

  const nextRetryCount = current.retryCount + 1;
  const exceededCap = nextRetryCount >= OUTBOX_RETRY_CAP;
  const nextOutbox = new Map(prev.mutationOutbox);
  nextOutbox.set(mutationId, {
    ...current,
    status: exceededCap ? "failed" : "pending",
    retryCount: nextRetryCount,
    lastError: message,
  });
  set({
    issueMutatingIds: nextIssueMutatingIds,
    issueErrors: nextIssueErrors,
    mutationOutbox: nextOutbox,
  });
}

export function cleanupOrphanedTerminals(): void {
  if (!_currentViewStore) return;

  const state = _currentViewStore.getState();
  if (!state.isInitialized || state.worktrees.size === 0) return;

  const worktreeMap = state.worktrees;
  const worktreeIds = new Set<string>();
  for (const [id, wt] of worktreeMap) {
    worktreeIds.add(id);
    if (wt.worktreeId) {
      worktreeIds.add(wt.worktreeId);
    }
  }

  const terminalStore = usePanelStore.getState();
  const orphanedTerminals = terminalStore.panelIds
    .map((id) => terminalStore.panelsById[id])
    .filter((t): t is NonNullable<typeof t> => {
      if (!t) return false;
      const worktreeId = typeof t.worktreeId === "string" ? t.worktreeId.trim() : "";
      return Boolean(worktreeId && !worktreeIds.has(worktreeId));
    });

  if (orphanedTerminals.length > 0) {
    logDebug("[WorktreeStore] Removing orphaned terminals from deleted worktrees", {
      count: orphanedTerminals.length,
    });
    orphanedTerminals.forEach((terminal) => terminalStore.removePanel(terminal.id));
  }
}

/**
 * Reconcile the issue fields of an incoming snapshot with what the renderer
 * already knows. Two concerns, both from #8079:
 *
 *  1. **Title flicker** — when the issue number is unchanged but the incoming
 *     snapshot dropped the title (the main process resets it to `undefined`
 *     while it re-fetches the GitHub title after a poll), keep the previous
 *     title so `IssueBadge` doesn't flash the raw `#NNN` for ~100–500ms.
 *     A genuine issue-number change clears the title immediately — the old
 *     title belongs to the old issue.
 *
 *  2. **MANUAL_OVER_AUTO** — an explicit user-attached issue association
 *     always overrides the auto-detected (branch-name) issue. Explicit user
 *     intent beats the heuristic, matching mainstream issue-tracker UX. This
 *     is a deliberate inversion of the old `if (assoc && !issueNumber)`
 *     fallback behaviour (manual was previously only a last resort).
 */
function mergeIssueState(
  incoming: WorktreeSnapshot,
  existing: WorktreeSnapshot | undefined,
  manual: { issueNumber: number; issueTitle?: string } | undefined
): WorktreeSnapshot {
  let issueNumber = incoming.issueNumber;
  let issueTitle = incoming.issueTitle;

  if (
    existing &&
    issueNumber !== undefined &&
    issueNumber === existing.issueNumber &&
    issueTitle === undefined &&
    existing.issueTitle !== undefined
  ) {
    issueTitle = existing.issueTitle;
  }

  // MANUAL_OVER_AUTO: explicit user association wins over auto-detection.
  if (manual) {
    issueNumber = manual.issueNumber;
    issueTitle = manual.issueTitle;
  }

  // `linked: undefined` from the host means "PR service hasn't run yet" —
  // preserve whatever the renderer already has (e.g. `linked.pr` from a
  // prior session's `pr-detected` event). `linked: null` is an explicit
  // clear (branch switch) and must propagate. (#8870 regression from #8452.)
  const linked =
    incoming.linked === undefined && existing?.linked !== undefined
      ? existing.linked
      : incoming.linked;

  if (
    issueNumber === incoming.issueNumber &&
    issueTitle === incoming.issueTitle &&
    linked === incoming.linked
  ) {
    return incoming;
  }
  return { ...incoming, issueNumber, issueTitle, linked };
}

function snapshotsEqual(a: WorktreeSnapshot, b: WorktreeSnapshot): boolean {
  return (
    a.branch === b.branch &&
    a.path === b.path &&
    a.name === b.name &&
    a.isCurrent === b.isCurrent &&
    a.isMainWorktree === b.isMainWorktree &&
    a.modifiedCount === b.modifiedCount &&
    a.summary === b.summary &&
    a.mood === b.mood &&
    a.aiNote === b.aiNote &&
    a.aiNoteTimestamp === b.aiNoteTimestamp &&
    a.lastActivityTimestamp === b.lastActivityTimestamp &&
    a.prNumber === b.prNumber &&
    a.prUrl === b.prUrl &&
    a.prState === b.prState &&
    a.prCiStatus === b.prCiStatus &&
    a.prTitle === b.prTitle &&
    a.issueNumber === b.issueNumber &&
    a.issueTitle === b.issueTitle &&
    a.branchDerivedTitle === b.branchDerivedTitle &&
    a.sourcePrNumber === b.sourcePrNumber &&
    a.prLastUpdatedAt === b.prLastUpdatedAt &&
    a.issueLastUpdatedAt === b.issueLastUpdatedAt &&
    a.hasPlanFile === b.hasPlanFile &&
    a.planFilePath === b.planFilePath &&
    a.aheadCount === b.aheadCount &&
    a.behindCount === b.behindCount &&
    a.baseBranchName === b.baseBranchName &&
    a.baseAheadCount === b.baseAheadCount &&
    a.baseBehindCount === b.baseBehindCount &&
    a.baseMatchesUpstream === b.baseMatchesUpstream &&
    a.baseCompareRef === b.baseCompareRef &&
    // lastGitStatusCheckedAt and workingTreeChangedAt are deliberately NOT
    // compared (like `timestamp`): both advance on events that change nothing
    // else in the snapshot, so comparing either here would force a new
    // worktrees Map identity per quiet tick. They live in the store's
    // `statusCheckedAt` / `workingTreeChangedAtById` side maps instead.
    a.lastFetchedAt === b.lastFetchedAt &&
    a.fetchAuthFailed === b.fetchAuthFailed &&
    a.fetchNetworkFailed === b.fetchNetworkFailed &&
    a.isFetchInFlight === b.isFetchInFlight &&
    a.matchedForgeProviderId === b.matchedForgeProviderId &&
    a.worktreeMode === b.worktreeMode &&
    a.worktreeEnvironmentLabel === b.worktreeEnvironmentLabel &&
    a.hasResourceConfig === b.hasResourceConfig &&
    a.hasStatusCommand === b.hasStatusCommand &&
    a.hasProvisionCommand === b.hasProvisionCommand &&
    a.hasPauseCommand === b.hasPauseCommand &&
    a.hasResumeCommand === b.hasResumeCommand &&
    a.hasTeardownCommand === b.hasTeardownCommand &&
    a.resourceConnectCommand === b.resourceConnectCommand &&
    a.isExternal === b.isExternal &&
    a.isWslPath === b.isWslPath &&
    a.wslDistro === b.wslDistro &&
    a.wslPosixPath === b.wslPosixPath &&
    a.wslGitEligible === b.wslGitEligible &&
    a.wslGitOptIn === b.wslGitOptIn &&
    a.wslGitDismissed === b.wslGitDismissed &&
    a.repoState === b.repoState &&
    a.isDetached === b.isDetached &&
    a.head === b.head &&
    resourceStatusEqual(a.resourceStatus, b.resourceStatus) &&
    worktreeChangesEqual(a.worktreeChanges, b.worktreeChanges) &&
    lifecycleStatusEqual(a.lifecycleStatus, b.lifecycleStatus) &&
    lifecyclePhaseResultsEqual(a.lifecyclePhaseResults, b.lifecyclePhaseResults) &&
    linkedEqual(a.linked ?? null, b.linked ?? null)
  );
}

function resourceStatusEqual(
  a: WorktreeSnapshot["resourceStatus"],
  b: WorktreeSnapshot["resourceStatus"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.lastStatus === b.lastStatus &&
    a.provider === b.provider &&
    a.endpoint === b.endpoint &&
    a.lastCheckedAt === b.lastCheckedAt &&
    a.lastOutput === b.lastOutput &&
    a.error === b.error &&
    a.resumedAt === b.resumedAt &&
    a.pausedAt === b.pausedAt
  );
}

function worktreeChangesEqual(
  a: WorktreeSnapshot["worktreeChanges"],
  b: WorktreeSnapshot["worktreeChanges"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.lastUpdated !== undefined && a.lastUpdated === b.lastUpdated) return true;
  return (
    a.changedFileCount === b.changedFileCount &&
    a.changes.length === b.changes.length &&
    a.totalInsertions === b.totalInsertions &&
    a.totalDeletions === b.totalDeletions &&
    a.latestFileMtime === b.latestFileMtime &&
    a.lastCommitMessage === b.lastCommitMessage &&
    a.lastCommitTimestampMs === b.lastCommitTimestampMs &&
    a.lastCommitAuthor?.name === b.lastCommitAuthor?.name &&
    a.lastCommitAuthor?.email === b.lastCommitAuthor?.email
  );
}

function lifecycleStatusEqual(
  a: WorktreeSnapshot["lifecycleStatus"],
  b: WorktreeSnapshot["lifecycleStatus"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.phase === b.phase &&
    a.state === b.state &&
    a.currentCommand === b.currentCommand &&
    a.commandIndex === b.commandIndex &&
    a.totalCommands === b.totalCommands &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.error === b.error
  );
}

function lifecyclePhaseResultsEqual(
  a: WorktreeSnapshot["lifecyclePhaseResults"],
  b: WorktreeSnapshot["lifecyclePhaseResults"]
): boolean {
  if (a === b) return true;
  // getSnapshot omits the field when empty, so treat undefined and [] alike.
  const al = a?.length ?? 0;
  const bl = b?.length ?? 0;
  if (al !== bl) return false;
  if (al === 0) return true;
  for (let i = 0; i < al; i++) {
    const x = a![i]!;
    const y = b![i]!;
    if (
      x.phase !== y.phase ||
      x.state !== y.state ||
      x.category !== y.category ||
      x.exitCode !== y.exitCode ||
      x.signalName !== y.signalName ||
      x.error !== y.error ||
      x.startedAt !== y.startedAt ||
      x.completedAt !== y.completedAt ||
      x.timedOut !== y.timedOut ||
      x.aborted !== y.aborted
    ) {
      return false;
    }
  }
  return true;
}

function linkedEqual(
  a: import("../../shared/types/plugin.js").PluginWorktreeLinked | null,
  b: import("../../shared/types/plugin.js").PluginWorktreeLinked | null
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.providerId === b.providerId &&
    a.pr?.ref.number === b.pr?.ref.number &&
    a.pr?.state === b.pr?.state &&
    a.pr?.url === b.pr?.url &&
    a.pr?.title === b.pr?.title &&
    a.pr?.ciStatus?.state === b.pr?.ciStatus?.state &&
    a.issue?.ref.number === b.issue?.ref.number &&
    a.issue?.title === b.issue?.title
  );
}
