import { projectClient } from "@/clients";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { computeRecordDelta, type IdArrayDelta } from "@shared/utils/layoutMerge";
import { logError } from "@/utils/logger";
import { getDriveLeaseSnapshot, subscribeDriveLeaseSnapshot } from "@/services/terminal/inputGate";
import { getHostOwnedStateEpoch, sendHostOwnedWrite } from "./hostOwnedWrites";

/** Quiet time after a driver's last draft edit before it goes to the host. */
export const LIVE_DRAFT_FLUSH_DELAY_MS = 300;
/** The longest an edit waits while typing continues, so watchers keep up within a second. */
export const LIVE_DRAFT_FLUSH_MAX_WAIT_MS = 700;

function projectRecord(drafts: Map<string, string>, projectId: string): Record<string, string> {
  const prefix = `${projectId}:`;
  const record: Record<string, string> = {};
  for (const [key, value] of drafts) {
    if (value && key.startsWith(prefix) && key.length > prefix.length) {
      record[key.slice(prefix.length)] = value;
    }
  }
  return record;
}

/**
 * The project this view drives while another screen may be watching it: a
 * lease is held, and this view holds it. Null for a view that only ever ran
 * locally (no lease), one nobody holds, and one that watches.
 */
function liveSyncedProject(): string | null {
  const lease = getDriveLeaseSnapshot();
  if (!lease || lease.holder === null || !lease.drivingHere) return null;
  return lease.projectId;
}

/**
 * Renderer-owned persistence for terminal draft inputs (#11352).
 *
 * Drafts (unsent compose text) live only in `terminalInputStore`. A project
 * switch relays them into outgoing state, but window/view teardown never
 * persisted them, so a half-written prompt was lost when the window closed.
 * This module flushes drafts on view teardown (via `resource.ts`'s
 * `visibilitychange` handler) using the same merge-safe delta contract the
 * layout persistence uses for terminals/tab groups: the writer sends what it
 * changed relative to its last-acknowledged baseline so Main merges concurrent
 * writes from sibling windows of the same project instead of clobbering them.
 *
 * The baseline (`persistedByProject`) is separate from the Zustand store on
 * purpose: a cleared/sent draft is dropped from the live map entirely, so a
 * removal tombstone can only be derived by diffing the current record against a
 * remembered prior key set. Keeping the baseline out of the store also means
 * `clearAllDraftInputs` can't accidentally erase the very key set that produces
 * those tombstones. Seed it from hydration via {@link primeProject}.
 */
class DraftInputPersistence {
  private readonly persistedByProject = new Map<string, Record<string, string>>();
  // Per-project write tail: each flush chains its delta computation and send
  // onto the previous write for the same project so the baseline advances in
  // send order and overlapping flushes never diff against a stale baseline
  // (mirrors PanelPersistence, #11350/#11352). Rejections are swallowed so a
  // failed write never blocks the next one.
  private readonly writeTailByProject = new Map<string, Promise<void>>();
  /** Bumped by each rebase, so a flush queued before one re-reads the drafts it would send. */
  private readonly rebaseEpochByProject = new Map<string, number>();
  /**
   * Drafts sent whose save may have landed without this view hearing so (its
   * answer was lost). A clear of one still has to go up as a removal, though
   * the acknowledged baseline never had it.
   */
  private readonly unackedByProject = new Map<string, { hostEpoch: number; ids: Set<string> }>();
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private liveMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Seed the last-persisted baseline from hydration, before drafts are restored
   * into the store. Primes even for an empty record so that clearing a
   * hydrated draft later produces a proper `removedIds` tombstone rather than
   * silently resurrecting on next load. Only primes if not already present so a
   * late hydration result can't overwrite an already-acknowledged live write.
   */
  primeProject(projectId: string, drafts: Record<string, string>): void {
    if (this.persistedByProject.has(projectId)) return;
    this.persistedByProject.set(projectId, { ...drafts });
  }

  /**
   * Replace an established baseline with what the store now holds, as read
   * back from it (a host snapshot this view just applied). Unlike
   * {@link primeProject} it always takes effect: a view that adopts a newer
   * saved record must diff against that record, or a draft it restored and
   * then cleared would never be tombstoned. A write still in flight lands on
   * top of this baseline when it is acknowledged.
   */
  rebaseProject(projectId: string, drafts: Record<string, string>): void {
    this.persistedByProject.set(projectId, { ...drafts });
    this.unackedByProject.delete(projectId);
    this.rebaseEpochByProject.set(projectId, (this.rebaseEpochByProject.get(projectId) ?? 0) + 1);
  }

  /** A copy of the project's last-acknowledged baseline; undefined before one is primed. */
  getBaseline(projectId: string): Record<string, string> | undefined {
    const baseline = this.persistedByProject.get(projectId);
    return baseline ? { ...baseline } : undefined;
  }

  /**
   * Delta a caller outside this module (the synchronous project-switch outgoing
   * capture) should send so Main merges drafts by key instead of full-replacing
   * and clobbering a sibling window's drafts (#11352).
   */
  computeDelta(projectId: string, current: Record<string, string>): IdArrayDelta {
    return computeRecordDelta(this.persistedByProject.get(projectId) ?? {}, current);
  }

  /**
   * Persist drafts for every project the store currently holds — plus any
   * project with a baseline or an unacknowledged save (so a project whose
   * drafts were all cleared still emits its tombstones). Called on view
   * teardown.
   */
  flushAll(): void {
    this.cancelLiveFlush();
    const state = useTerminalInputStore.getState();
    const projectIds = new Set<string>(state.getDraftProjectIds());
    for (const projectId of this.persistedByProject.keys()) {
      projectIds.add(projectId);
    }
    for (const projectId of this.unackedByProject.keys()) {
      projectIds.add(projectId);
    }
    for (const projectId of projectIds) {
      this.flushProject(projectId, state.getProjectDraftInputs(projectId));
    }
  }

  private flushProject(projectId: string, current: Record<string, string>): void {
    // Snapshot synchronously — the map may mutate before the queued send runs.
    let snapshot = { ...current };
    const epoch = this.rebaseEpochByProject.get(projectId) ?? 0;
    const hostEpoch = getHostOwnedStateEpoch();
    const prior = this.writeTailByProject.get(projectId) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(async () => {
        // A rebase landed while this waited: the snapshot predates what the
        // view restored, so diffing it against the new baseline would delete
        // those drafts. Send what the view holds now instead.
        if ((this.rebaseEpochByProject.get(projectId) ?? 0) !== epoch) {
          snapshot = { ...useTerminalInputStore.getState().getProjectDraftInputs(projectId) };
        }
        // Another screen drove the project since this was queued: the host's
        // drafts are its now, and this snapshot would write over them.
        if (getHostOwnedStateEpoch() !== hostEpoch) return;
        const { changedIds, removedIds } = computeRecordDelta(
          this.persistedByProject.get(projectId) ?? {},
          snapshot
        );
        for (const id of this.getUnacked(projectId) ?? []) {
          if (!(id in snapshot) && !removedIds.includes(id)) removedIds.push(id);
        }
        if (changedIds.length === 0 && removedIds.length === 0) {
          return;
        }
        try {
          const sent = snapshot;
          const outcome = await sendHostOwnedWrite(
            `project-drafts:${projectId}`,
            () => projectClient.setDraftInputs(projectId, sent, changedIds, removedIds),
            // Re-read at replay: whatever the view holds then is the latest.
            () =>
              this.flushProject(
                projectId,
                useTerminalInputStore.getState().getProjectDraftInputs(projectId)
              )
          );
          // Not acknowledged: the baseline stays for the replay to diff against.
          if (outcome === "deferred") this.markUnacked(projectId, hostEpoch, changedIds);
          if (outcome !== "sent") return;
          const unacked = this.getUnacked(projectId);
          for (const id of [...changedIds, ...removedIds]) unacked?.delete(id);
          if (unacked?.size === 0) this.unackedByProject.delete(projectId);
          // The store merged exactly this delta, so apply it to the baseline as
          // it stands now: a rebase made while the write was in flight keeps
          // the keys this write didn't touch.
          const acknowledged = { ...(this.persistedByProject.get(projectId) ?? {}) };
          for (const id of changedIds) acknowledged[id] = snapshot[id]!;
          for (const id of removedIds) delete acknowledged[id];
          this.persistedByProject.set(projectId, acknowledged);
        } catch (error) {
          // Leave the baseline untouched so the next flush resends the
          // unacknowledged delta.
          this.markUnacked(projectId, hostEpoch, changedIds);
          logError("Failed to persist draft inputs", error);
          throw error;
        }
      });
    this.writeTailByProject.set(
      projectId,
      run.catch(() => {})
    );
    // Prevent an unhandled rejection warning for the background send.
    run.catch(() => {});
  }

  /**
   * While this view drives a project others may watch, send its draft edits
   * as they're made (#13283): debounced while typing, at most
   * {@link LIVE_DRAFT_FLUSH_MAX_WAIT_MS} behind, and at once when a draft is
   * sent or cleared, so a watcher never keeps showing it. A view that only
   * ever ran locally or watches sends nothing more than before. Returns the
   * disposer.
   */
  startLiveSync(): () => void {
    const offStore = useTerminalInputStore.subscribe((next, prev) => {
      if (next.draftInputs === prev.draftInputs) return;
      const projectId = liveSyncedProject();
      if (projectId === null) return;
      const before = projectRecord(prev.draftInputs, projectId);
      const after = projectRecord(next.draftInputs, projectId);
      const { changedIds, removedIds } = computeRecordDelta(before, after);
      if (removedIds.length > 0) {
        this.flushLive(projectId);
      } else if (changedIds.length > 0) {
        this.scheduleLiveFlush(projectId);
      }
    });
    // A view that stops driving can't save; a pending edit would be skipped.
    const offLease = subscribeDriveLeaseSnapshot(() => {
      if (liveSyncedProject() === null) this.cancelLiveFlush();
    });
    return () => {
      offStore();
      offLease();
      this.cancelLiveFlush();
    };
  }

  private scheduleLiveFlush(projectId: string): void {
    if (this.liveTimer !== null) clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => this.flushLive(projectId), LIVE_DRAFT_FLUSH_DELAY_MS);
    this.liveMaxWaitTimer ??= setTimeout(
      () => this.flushLive(projectId),
      LIVE_DRAFT_FLUSH_MAX_WAIT_MS
    );
  }

  private flushLive(projectId: string): void {
    this.cancelLiveFlush();
    // Read when it goes: the lease may have moved, and the drafts be newer.
    if (liveSyncedProject() !== projectId) return;
    this.flushProject(projectId, useTerminalInputStore.getState().getProjectDraftInputs(projectId));
  }

  private cancelLiveFlush(): void {
    if (this.liveTimer !== null) clearTimeout(this.liveTimer);
    if (this.liveMaxWaitTimer !== null) clearTimeout(this.liveMaxWaitTimer);
    this.liveTimer = null;
    this.liveMaxWaitTimer = null;
  }

  /**
   * The project's possibly-saved drafts, while this view still holds what it
   * held when it saved them. Once another screen has driven the project, the
   * host's drafts are that screen's, and a removal sent for one would delete
   * its newer draft.
   */
  private getUnacked(projectId: string): Set<string> | undefined {
    const entry = this.unackedByProject.get(projectId);
    if (!entry) return undefined;
    if (entry.hostEpoch === getHostOwnedStateEpoch()) return entry.ids;
    this.unackedByProject.delete(projectId);
    return undefined;
  }

  private markUnacked(projectId: string, hostEpoch: number, ids: readonly string[]): void {
    if (ids.length === 0 || hostEpoch !== getHostOwnedStateEpoch()) return;
    const unacked = this.getUnacked(projectId) ?? new Set<string>();
    for (const id of ids) unacked.add(id);
    this.unackedByProject.set(projectId, { hostEpoch, ids: unacked });
  }

  /** Await all in-flight per-project writes. Primarily for tests. */
  async whenIdle(): Promise<void> {
    await Promise.all(this.writeTailByProject.values());
  }

  /**
   * Forget a project's persisted baseline and pending write tail. Recreation of
   * a project's deleted state file by a late teardown flush is prevented in Main
   * (the `setDraftInputs` handler skips a pure-removal write when no state
   * exists), so this is not required on the close/remove paths; it exists for
   * test cleanup and callers that need to reset a project's draft-flush state.
   */
  clearProject(projectId: string): void {
    this.persistedByProject.delete(projectId);
    this.writeTailByProject.delete(projectId);
    this.rebaseEpochByProject.delete(projectId);
    this.unackedByProject.delete(projectId);
  }
}

export const draftInputPersistence = new DraftInputPersistence();
