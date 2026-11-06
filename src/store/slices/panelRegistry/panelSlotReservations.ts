/**
 * Panel-limit capacity that has been granted but is not yet visible in the
 * registry (#15607).
 *
 * A batch gate (recipe run, worktree spin-up) sizes its burst once and then
 * spawns with `bypassLimits`, and a single add checks the limit before it
 * awaits its way to the commit. Between that check and the panel landing,
 * nothing else could see the slot was taken, so two overlapping gates could
 * both be granted the same remaining capacity. A grant holds its slots here
 * until the caller releases it.
 *
 * A slot starts anonymous. Right before `addPanel`, the caller claims it with
 * the id it passes as `requestedId`; from then on the slot counts only while
 * that id has no panel in the registry, so a panel is never counted twice
 * between its commit and the grant's release, however long its spawn takes.
 */

interface GrantState {
  unclaimed: number;
  claimedIds: Set<string>;
}

export interface PanelSlotGrant {
  /** How many slots this grant holds. */
  readonly allowed: number;
  /** Tie one of the grant's slots to the id about to be passed to `addPanel`. */
  claim(id: string): void;
  /**
   * Give back every slot still held. Call once the claimed panels are visible
   * to the count: after the spawn batch flushes, or after the add returns.
   * Idempotent.
   */
  release(): void;
}

const activeGrants = new Set<GrantState>();

export function reservePanelSlots(count: number): PanelSlotGrant {
  const state: GrantState = { unclaimed: Math.max(0, count), claimedIds: new Set() };
  activeGrants.add(state);
  return {
    allowed: state.unclaimed,
    claim(id) {
      // A released grant (or one dropped by a store reset) holds nothing.
      if (!activeGrants.has(state) || state.unclaimed === 0) return;
      if (state.claimedIds.has(id)) return;
      state.unclaimed--;
      state.claimedIds.add(id);
    },
    release() {
      activeGrants.delete(state);
    },
  };
}

/** The slots every live grant still holds: anonymous ones, and the ids claimed. */
export function getPanelSlotReservations(): { unclaimed: number; claimedIds: Set<string> } {
  let unclaimed = 0;
  const claimedIds = new Set<string>();
  for (const grant of activeGrants) {
    unclaimed += grant.unclaimed;
    for (const id of grant.claimedIds) claimedIds.add(id);
  }
  return { unclaimed, claimedIds };
}

/**
 * Drop every grant. Called with the batch reset, so a run that never reached
 * its release (a store reset, a project switch) can't hold capacity forever.
 */
export function resetPanelSlotReservations(): void {
  activeGrants.clear();
}
