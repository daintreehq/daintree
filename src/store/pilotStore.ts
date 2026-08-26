import { create } from "zustand";

/**
 * Which population the overview is showing.
 *
 * `fleet` is every run in every workspace, grouped by project. `project` is one
 * project's runs, grouped by worktree — the same rows, the same bands, the same
 * query box, cut on the other axis.
 */
export type PilotScope = { kind: "fleet" } | { kind: "project"; workspaceId: string };

const FLEET_SCOPE: PilotScope = { kind: "fleet" };

interface PilotState {
  isOpen: boolean;
  scope: PilotScope;
  /**
   * The workspace a scoped opening asked for and could not give, or null.
   *
   * Set for exactly one opening, by the one caller that decided this project has
   * no worktree axis to cut on. `PilotView` turns it into a line saying so, which
   * is what stops the scoped chord from being indistinguishable from a dead key:
   * the fleet it lands on is byte for byte the surface the unscoped chord already
   * gives, so without this the user has no way to tell a fallback from a misfire
   * (#11957).
   */
  fellBackFrom: string | null;
  open: () => void;
  /** Open (or re-scope) the overview to one project's worktrees. */
  openProject: (workspaceId: string) => void;
  /** Open the fleet BECAUSE this workspace has no worktree axis, and say so. */
  openFleetFallback: (workspaceId: string) => void;
  /** Back out to the whole fleet without closing. */
  showFleet: () => void;
  close: () => void;
  toggle: () => void;
}

/**
 * Open state for the fleet overview.
 *
 * A store rather than local state threaded through `App`: Pilot is opened from
 * the action registry, the project switcher and a keybinding, and none of those
 * has a natural prop path to a `useState` in the app shell.
 *
 * Scope lives here for a harder reason than convenience. `PilotView` is
 * lazy-mounted only once `isOpen` turns true, so a shortcut that opens the
 * surface already scoped has nowhere else to say which project it meant — the
 * component it would tell does not exist yet. Everything else about one opening
 * (the query, the band filter, the park editor, the pointer's order hold) stays
 * component-local, because it is narrowing rather than destination.
 *
 * Nothing here persists. `isOpen` deliberately does not — a dialog that reopens
 * itself on next launch because it was open at quit is a surprise, not a
 * restored preference — and neither does `scope`, which resets to the fleet on
 * every close so a project removed in the meantime cannot come back as an empty
 * heading. The collapse set that used to ride the `persist` middleware went
 * with the disclosure it served (#11669): a project collapsed last week hiding
 * an agent that blocks today is the wrong default on a surface whose job is to
 * show every agent. The orphaned `daintree-pilot` localStorage key is inert.
 */
export const usePilotStore = create<PilotState>((set) => ({
  isOpen: false,
  scope: FLEET_SCOPE,
  fellBackFrom: null,
  // Opening from anywhere that did not name a project means the whole fleet.
  // Carrying the last scope forward would reopen the surface already hiding
  // most of it, with the reason two openings in the past.
  //
  // Every transition but the fallback itself clears `fellBackFrom` — an
  // explanation is about the opening that needed it, and one still on screen a
  // gesture later is describing something the user has already moved past.
  open: () => set({ isOpen: true, scope: FLEET_SCOPE, fellBackFrom: null }),
  openProject: (workspaceId) =>
    set({ isOpen: true, scope: { kind: "project", workspaceId }, fellBackFrom: null }),
  openFleetFallback: (workspaceId) =>
    set({ isOpen: true, scope: FLEET_SCOPE, fellBackFrom: workspaceId }),
  showFleet: () => set({ scope: FLEET_SCOPE, fellBackFrom: null }),
  close: () => set({ isOpen: false, scope: FLEET_SCOPE, fellBackFrom: null }),
  toggle: () =>
    set((state) => ({
      isOpen: !state.isOpen,
      scope: FLEET_SCOPE,
      fellBackFrom: null,
    })),
}));
