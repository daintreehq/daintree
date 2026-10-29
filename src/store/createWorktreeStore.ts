import { createStore, type StoreApi } from "zustand/vanilla";
import type { WorktreeSnapshot, WorktreeEventVersion, AttachIssuePayload } from "@shared/types";
import { usePanelStore } from "./panelStore";
import { getWorktreeSelectionSnapshot } from "./storeAccessors";
import { logDebug } from "@/utils/logger";
import {
  FENCE_TTL_MS,
  TOMBSTONE_TTL_MS,
  compareVersion,
  mergeChangedDirs,
  mergeIssueState,
  retainTombstoneFences,
  runKeyFor,
  snapshotsEqual,
  type ManualIssueAssociation,
  type WorktreeChangedDirs,
  type WorktreeTombstone,
} from "./worktreeSnapshotReconciliation";
import {
  abandonDelete,
  discardDeleteRestores,
  findDeleteOutboxEntryForWorktree,
  findIssueOutboxEntryForWorktree,
  findOutboxEntriesForWorktree,
  isIssueMutation,
  mintMutationId,
  runDeleteAsync,
  runIssueMutationAsync,
  type AttachIssueOutboxEntry,
  type DetachIssueOutboxEntry,
  type IssueMutationError,
  type MutationOutboxEntry,
  type WorktreeDeleteOptions,
} from "./worktreeMutationOutbox";

export { compareVersion };
export type { ManualIssueAssociation, WorktreeChangedDirs };
export { OUTBOX_RETRY_CAP } from "./worktreeMutationOutbox";
export type {
  AttachIssueOutboxEntry,
  DeleteWorktreeOutboxEntry,
  DetachIssueOutboxEntry,
  IssueMutationError,
  MutationOutboxEntry,
  WorktreeDeleteOptions,
} from "./worktreeMutationOutbox";

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

export type ReconnectRecoveryPhase = "idle" | "recovering" | "exhausted";

export interface WorktreeViewState {
  worktrees: Map<string, WorktreeSnapshot>;
  /**
   * `worktreeId → lastGitStatusCheckedAt` (epoch ms), tracked outside the
   * snapshot map on purpose: the host advances this stamp on every completed
   * poll — including polls where nothing user-visible changed — so comparing
   * it in `snapshotsEqual` forced a new `worktrees` Map identity per poll and
   * fanned every quiet tick out to every whole-map subscriber. Freshness
   * consumers (WorktreeCard's hover-revalidate gate) read this map per-id
   * instead. The `lastGitStatusCheckedAt` field still present
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
  /**
   * `worktreeId → ` the directories behind the latest `workingTreeChangedAt`,
   * so the file browser can re-list only what changed (#12244). A side map for
   * the same reason as {@link workingTreeChangedAtById}, and updated in lockstep
   * with it on both merge paths.
   */
  workingTreeChangedDirsById: Map<string, WorktreeChangedDirs>;
  manualAssociations: Map<string, ManualIssueAssociation>;
  /**
   * Host-minted `(epoch, seq)` stamp of the most recently applied event.
   * Initial value uses an empty epoch so the first real host stamp (any
   * non-empty epoch) is treated as an epoch transition and accepted (#8403).
   */
  version: WorktreeEventVersion;
  /**
   * `worktreeId → tombstone` for recently removed worktrees, so a late
   * same-epoch `worktree-update` can't resurrect a deleted row. Cleared on
   * epoch transition; entries expire after {@link TOMBSTONE_TTL_MS} or when a
   * newer monitor incarnation claims the id.
   */
  tombstones: Map<string, WorktreeTombstone>;
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
   * Where the automatic Retry of a stalled reconnect stands (#14313). Owned by
   * `startWorktreeReconnectRecovery`; the stalled banner waits for `exhausted`.
   */
  reconnectRecovery: ReconnectRecoveryPhase;
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
  /**
   * Merge one host `worktree-update` into the map. Returns whether the event
   * was accepted — a stale version, a superseded monitor incarnation or an
   * active tombstone all reject it. Callers must gate any side effect that
   * assumes the worktree is now present (clearing the "Creating…" placeholder,
   * applying a pending selection) on a `true` return (#11994).
   */
  applyUpdate(state: WorktreeSnapshot, version: WorktreeEventVersion): boolean;
  /**
   * Clear forge-issue overlay without going through `mergeIssueState`, which
   * would restore the previous `issueTitle` whenever `issueNumber` is
   * unchanged (the manual-association preservation path). Used by the
   * `issue-not-found` event handler so a 404 actually clears the title while
   * keeping the branch-parsed `issueNumber` and the `branchDerivedTitle`
   * fallback intact (#8851).
   */
  applyIssueNotFound(worktreeId: string, issueNumber: number): void;
  /**
   * `generation` is the removed monitor's incarnation stamp, recorded on the
   * tombstone so a later update can be told apart from a re-creation at the
   * same path (#11994).
   */
  applyRemove(worktreeId: string, version: WorktreeEventVersion, generation?: number): void;
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
  setReconnectRecovery(phase: ReconnectRecoveryPhase): void;
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
    workingTreeChangedDirsById: new Map(),
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
    reconnectRecovery: "idle",
    watcherDegraded: false,
    topologyWatcherDark: false,

    applySnapshot(
      states: WorktreeSnapshot[],
      version: WorktreeEventVersion,
      associations?: Record<string, ManualIssueAssociation>
    ) {
      const prev = get();
      if (compareVersion(version, prev.version) < 0) return;
      // A snapshot is the host's authoritative state. An epoch transition means
      // the host rebuilt from scratch, so nothing from the prior run survives;
      // within the same epoch the snapshot settles every id it reports, but a
      // stamped fence for an id it does NOT report still stands (see
      // `retainTombstoneFences`).
      const epochChanged = version.epoch !== prev.version.epoch;
      const nextTombstones = epochChanged
        ? new Map<string, WorktreeTombstone>()
        : retainTombstoneFences(prev.tombstones, new Set(states.map((s) => s.id)));
      const tombstonesChanged = nextTombstones.size !== prev.tombstones.size;
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

      // Same rebuild for the affected-directory side map. Continuity is
      // deliberately not claimed here: a snapshot is the host's authoritative
      // state and can jump across flushes the store never saw one by one, so
      // every advanced stamp lands with `previousAt: null` and the file browser
      // takes one full re-read before scoping resumes.
      let nextWorkingTreeChangedDirs = prev.workingTreeChangedDirsById;
      {
        let rebuilt = new Map<string, WorktreeChangedDirs>();
        for (const s of merged) {
          const carried = prev.workingTreeChangedDirsById.get(s.id);
          // Carried by identity only within one host run: across an epoch or a
          // re-created worktree the record's `previousAt` describes a chain the
          // new run knows nothing about, and repeating the stamp would preserve
          // it.
          if (
            carried !== undefined &&
            carried.at === s.workingTreeChangedAt &&
            carried.run === runKeyFor(s, version.epoch)
          ) {
            rebuilt.set(s.id, carried);
            continue;
          }
          rebuilt = mergeChangedDirs(rebuilt, s, version.epoch, false);
        }
        const unchanged =
          rebuilt.size === prev.workingTreeChangedDirsById.size &&
          [...rebuilt].every(([id, record]) => prev.workingTreeChangedDirsById.get(id) === record);
        if (!unchanged) nextWorkingTreeChangedDirs = rebuilt;
      }
      const workingTreeChangedDirsChanged =
        nextWorkingTreeChangedDirs !== prev.workingTreeChangedDirsById;

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
          ...(workingTreeChangedDirsChanged
            ? { workingTreeChangedDirsById: nextWorkingTreeChangedDirs }
            : {}),
          ...(tombstonesChanged ? { tombstones: nextTombstones } : {}),
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
        ...(workingTreeChangedDirsChanged
          ? { workingTreeChangedDirsById: nextWorkingTreeChangedDirs }
          : {}),
        ...(tombstonesChanged ? { tombstones: nextTombstones } : {}),
        ...(associationsChanged ? { manualAssociations: manual } : {}),
      });
    },

    applyUpdate(state: WorktreeSnapshot, version: WorktreeEventVersion) {
      const prevState = get();
      if (compareVersion(version, prevState.version) < 0) return false;
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
      } else if (existing) {
        // Incarnation fence for a row that is already live: once a re-created
        // worktree has landed, a continuation still running against the
        // torn-down monitor for the same path would otherwise clobber the new
        // row with pre-delete data. Only a strictly older stamp is rejected, so
        // the renderer's own overlay updates (which reuse the row's stamp) and
        // unstamped events are unaffected. The version is deliberately NOT
        // advanced: the fence lives on the row itself, so it keeps rejecting
        // later stale events without borrowing the event counter to do it —
        // and advancing here would make an in-flight snapshot look stale and
        // strand the row (the snapshot is version-gated too).
        if (
          state.generation !== undefined &&
          existing.generation !== undefined &&
          state.generation < existing.generation
        ) {
          return false;
        }
      } else {
        const tombstone = tombstones.get(state.id);
        if (tombstone !== undefined) {
          if (state.generation !== undefined && tombstone.generation !== undefined) {
            // Both stamped, so the decision is algebraic and the wall clock
            // plays no part: only a newer monitor incarnation may claim the id
            // back. A strictly higher stamp is the host having built a new
            // monitor for this path — a genuine re-creation (#11994) — while
            // anything at or below it is the buffered update the tombstone
            // exists to suppress, however long it took to arrive.
            if (state.generation <= tombstone.generation) return false;
          } else if (Date.now() - tombstone.removedAt < TOMBSTONE_TTL_MS) {
            // One side is unstamped, so fall back to the suppression window:
            // drop the late update but advance the version so a subsequent
            // stale event stays rejected (#8403).
            set({ version });
            return false;
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

      // Per-event, so continuity holds: the store sees every host update in
      // order and each record can name the stamp it superseded (#12244) — but
      // only within one host run. An epoch transition means the host restarted,
      // and whatever changed on disk while it was down reached nobody, so the
      // first event of the new epoch must not chain off the old one's stamp.
      const workingTreeChangedDirsById = mergeChangedDirs(
        prevState.workingTreeChangedDirsById,
        merged,
        version.epoch,
        true
      );
      const workingTreeChangedDirsChanged =
        workingTreeChangedDirsById !== prevState.workingTreeChangedDirsById;

      // Replace with the complete state so Zustand does not merge into a second object.
      if (existing && snapshotsEqual(existing, merged)) {
        set(
          {
            ...prevState,
            version,
            ...(statusCheckedAtChanged ? { statusCheckedAt } : {}),
            ...(workingTreeChangedAtChanged ? { workingTreeChangedAtById } : {}),
            ...(workingTreeChangedDirsChanged ? { workingTreeChangedDirsById } : {}),
            ...(tombstonesChanged ? { tombstones } : {}),
          },
          true
        );
        return true;
      }
      const next = new Map(prev);
      next.set(state.id, merged);
      set(
        {
          ...prevState,
          worktrees: next,
          version,
          ...(statusCheckedAtChanged ? { statusCheckedAt } : {}),
          ...(workingTreeChangedAtChanged ? { workingTreeChangedAtById } : {}),
          ...(workingTreeChangedDirsChanged ? { workingTreeChangedDirsById } : {}),
          ...(tombstonesChanged ? { tombstones } : {}),
        },
        true
      );
      return true;
    },

    applyIssueNotFound(worktreeId: string, issueNumber: number) {
      const prev = get();
      const existing = prev.worktrees.get(worktreeId);
      if (!existing) return;
      if (existing.issueNumber !== issueNumber) return;
      // The lookup was for the branch's own number; a link the user attached
      // is a different issue even when its number matches (#13744).
      if (prev.manualAssociations.has(worktreeId)) return;
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

    applyRemove(worktreeId: string, version: WorktreeEventVersion, generation?: number) {
      const prevState = get();
      if (compareVersion(version, prevState.version) < 0) return;

      // Record a tombstone so a buffered same-epoch `worktree-update` can't
      // resurrect this row (#8403). An epoch transition starts the tombstone
      // set fresh — the prior run's removals don't apply to the new host.
      const now = Date.now();
      const epochChanged = version.epoch !== prevState.version.epoch;
      const tombstones = epochChanged
        ? new Map<string, WorktreeTombstone>()
        : new Map(prevState.tombstones);
      // Reap on write so ids that never receive a follow-up update can't
      // accumulate over a long high-churn session. A stamped fence is durable —
      // retired by a newer incarnation, an epoch change, or a snapshot that
      // reports the id alive — so it expires on the far longer FENCE_TTL_MS
      // rather than the suppression window.
      for (const [id, tombstone] of tombstones) {
        const ttl = tombstone.generation === undefined ? TOMBSTONE_TTL_MS : FENCE_TTL_MS;
        if (now - tombstone.removedAt >= ttl) tombstones.delete(id);
      }
      // Fall back to the outgoing row's stamp when the event didn't carry one,
      // so the incarnation comparison still works for any path that removes a
      // worktree the store had already hydrated from a snapshot.
      tombstones.set(worktreeId, {
        removedAt: now,
        generation: generation ?? prevState.worktrees.get(worktreeId)?.generation,
      });

      const hadWorktree = prevState.worktrees.has(worktreeId);
      const hadStatusCheckedAt = prevState.statusCheckedAt.has(worktreeId);
      const hadWorkingTreeChangedAt = prevState.workingTreeChangedAtById.has(worktreeId);
      const hadWorkingTreeChangedDirs = prevState.workingTreeChangedDirsById.has(worktreeId);
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
      const nextWorkingTreeChangedDirs = hadWorkingTreeChangedDirs
        ? new Map(prevState.workingTreeChangedDirsById)
        : prevState.workingTreeChangedDirsById;
      if (hadWorkingTreeChangedDirs) nextWorkingTreeChangedDirs.delete(worktreeId);
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
        workingTreeChangedDirsById: nextWorkingTreeChangedDirs,
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
        discardDeleteRestores(
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
      // Dismiss on the delete banner. Abandons the whole delete, not just its
      // presentation — see `abandonDelete` for why the outbox entry and the
      // closed terminals have to go with the banner (#12087).
      abandonDelete(get, set, worktreeId);
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

        // ...unless the mutation is still running. `replayOutboxAfterReconnect`
        // flips entries to `in-flight` without clearing `issueErrors`, so a
        // Dismiss can land on a live attach/detach. Pruning it would make
        // `applyIssueMutationSuccess` discard a write the host had already
        // committed, leaving the renderer's association permanently stale.
        // Hide the banner; leave the entry and its guard to settle (#12087).
        if (entry.status === "in-flight") {
          set({ issueErrors: nextIssueErrors });
          return;
        }

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

      // Same abandon as the banner's Dismiss — routed through one helper so the
      // two paths can't drift apart (#12087).
      abandonDelete(get, set, entry.worktreeId, mutationId);
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

    setReconnectRecovery(phase: ReconnectRecoveryPhase) {
      set({ reconnectRecovery: phase });
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

  // A deleted worktree whose terminals outlived it is not orphaned — it has a
  // sidebar row holding exactly these panels, and removing them here would
  // empty the row and destroy the survivors #11232 exists to keep (#11911).
  // Read live rather than passed in: this runs after hydration has rebuilt the
  // rows, and the live path can be holding rows at any time.
  //
  // Through the accessor rather than importing the selection store directly:
  // that store pulls in TerminalInstanceService, and esbuild links every static
  // import whether or not it is reachable, so a direct import drags the whole
  // terminal subgraph into the perf bundle that exists to isolate this store.
  const ghostedWorktreeIds = getWorktreeSelectionSnapshot()?.deletedWorktreeIds;

  const terminalStore = usePanelStore.getState();
  const orphanedTerminals = terminalStore.panelIds
    .map((id) => terminalStore.panelsById[id])
    .filter((t): t is NonNullable<typeof t> => {
      if (!t) return false;
      const worktreeId = typeof t.worktreeId === "string" ? t.worktreeId.trim() : "";
      if (!worktreeId || worktreeIds.has(worktreeId)) return false;
      return ghostedWorktreeIds?.has(worktreeId) !== true;
    });

  if (orphanedTerminals.length > 0) {
    logDebug("[WorktreeStore] Removing orphaned terminals from deleted worktrees", {
      count: orphanedTerminals.length,
    });
    orphanedTerminals.forEach((terminal) => terminalStore.removePanel(terminal.id));
  }
}
