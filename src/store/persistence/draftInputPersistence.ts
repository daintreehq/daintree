import { projectClient } from "@/clients";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { computeRecordDelta, type IdArrayDelta } from "@shared/utils/layoutMerge";
import { logError } from "@/utils/logger";

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
   * project with a baseline (so a project whose drafts were all cleared still
   * emits its tombstones). Called on view teardown.
   */
  flushAll(): void {
    const state = useTerminalInputStore.getState();
    const projectIds = new Set<string>(state.getDraftProjectIds());
    for (const projectId of this.persistedByProject.keys()) {
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
        const { changedIds, removedIds } = computeRecordDelta(
          this.persistedByProject.get(projectId) ?? {},
          snapshot
        );
        if (changedIds.length === 0 && removedIds.length === 0) {
          return;
        }
        try {
          await projectClient.setDraftInputs(projectId, snapshot, changedIds, removedIds);
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
  }
}

export const draftInputPersistence = new DraftInputPersistence();
