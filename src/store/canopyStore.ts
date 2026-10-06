import { create } from "zustand";
import {
  CANOPY_URGENT_PRIORITY,
  type CanopyCard,
  type CanopySnapshot,
} from "@shared/types/ipc/canopy";

/** When the user last opened a run in the panel, for its incarnation. */
export interface CanopyRead {
  spawnedAt: number;
  at: number;
}

interface CanopyState {
  isOpen: boolean;
  /** Null until main has answered once — distinct from "no cards yet". */
  snapshot: CanopySnapshot | null;
  /**
   * Runs the user has opened, like read mail: unread until opened, and unread
   * again once the screen is read anew after that.
   */
  reads: Record<string, CanopyRead>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  applySnapshot: (snapshot: CanopySnapshot) => void;
  /**
   * The urgent prompt each run last showed while the panel was open, as
   * `spawnedAt:revision`. The toolbar badge counts only the urgent prompts not
   * in here, so opening the panel clears it until a new one arrives.
   */
  acknowledged: Record<string, string>;
  markRead: (runId: string, spawnedAt: number, at?: number) => void;
  /** Forget reads for runs no longer running. */
  pruneReads: (live: ReadonlySet<string>) => void;
  /**
   * The inbox's order as last shown, run ids first to last, and the scan it was
   * ranked after: kept across opens, so the list opens as it was left.
   */
  orders: Partial<Record<CanopyScope, CanopyOrder>>;
  setOrder: (scope: CanopyScope, order: CanopyOrder) => void;
  /** The inbox's "Archived" group is unfolded; kept across opens. */
  archivedExpanded: boolean;
  setArchivedExpanded: (expanded: boolean) => void;
  /** Every project's agents, or only the project this view shows; remembered across launches. */
  scope: CanopyScope;
  setScope: (scope: CanopyScope) => void;
}

export type CanopyScope = "all" | "project";

/** One scope's order: each scope ranks its own runs, so switching never buries another's. */
export interface CanopyOrder {
  ids: readonly string[];
  /** The snapshot's `refreshedAt` this order was ranked for. */
  rankedFor: number | null;
  /** The runs that were urgent when it was ranked: a run urgent since is placed at once. */
  urgent: readonly string[];
}

const SCOPE_STORAGE_KEY = "daintree-canopy-scope";
export const CANOPY_ACKNOWLEDGED_STORAGE_KEY = "daintree-canopy-acknowledged";

function promptKey(card: Pick<CanopyCard, "spawnedAt" | "revision">): string {
  return `${card.spawnedAt}:${card.revision}`;
}

function readAcknowledged(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(CANOPY_ACKNOWLEDGED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const clean: Record<string, string> = {};
    for (const [runId, key] of Object.entries(parsed)) {
      if (typeof key === "string") clean[runId] = key;
    }
    return clean;
  } catch {
    return {};
  }
}

function saveAcknowledged(acknowledged: Record<string, string>): void {
  try {
    window.localStorage.setItem(CANOPY_ACKNOWLEDGED_STORAGE_KEY, JSON.stringify(acknowledged));
  } catch {
    // Best effort: this view still stays quiet for this session.
  }
}

/**
 * Marks every urgent prompt in the snapshot as shown. Merged over what is
 * stored rather than this view's copy, since every project view writes the
 * key, and pruned to the runs Canopy still has cards for.
 */
function acknowledgeUrgent(
  current: Record<string, string>,
  snapshot: CanopySnapshot | null
): Record<string, string> | null {
  if (!snapshot) return null;
  const urgent = snapshot.cards.filter(
    (card) => card.priority >= CANOPY_URGENT_PRIORITY && current[card.runId] !== promptKey(card)
  );
  if (urgent.length === 0) return null;
  const known = new Set(snapshot.cards.map((card) => card.runId));
  const next: Record<string, string> = {};
  for (const [runId, key] of Object.entries({ ...current, ...readAcknowledged() })) {
    if (known.has(runId)) next[runId] = key;
  }
  for (const card of urgent) next[card.runId] = promptKey(card);
  saveAcknowledged(next);
  return next;
}

/** An urgent card the user has not had in front of them in the open panel. */
export function isCanopyUnacknowledged(
  acknowledged: Record<string, string>,
  card: Pick<CanopyCard, "runId" | "spawnedAt" | "revision">
): boolean {
  return acknowledged[card.runId] !== promptKey(card);
}

function loadScope(): CanopyScope {
  try {
    return window.localStorage.getItem(SCOPE_STORAGE_KEY) === "project" ? "project" : "all";
  } catch {
    return "all";
  }
}

function saveScope(scope: CanopyScope): void {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // Best effort: the choice still holds for this session.
  }
}

/**
 * Read once the user opened this incarnation after the screen they were shown
 * was read. A card that has not been read off the screen yet is read as soon
 * as the run is opened at all.
 */
export function isCanopyRead(
  read: CanopyRead | undefined,
  spawnedAt: number,
  card: Pick<CanopyCard, "spawnedAt" | "observedAt"> | null
): boolean {
  if (read === undefined || read.spawnedAt !== spawnedAt) return false;
  return card === null || card.spawnedAt !== spawnedAt || card.observedAt <= read.at;
}

function opened(state: CanopyState, snapshot: CanopySnapshot | null): Partial<CanopyState> {
  const acknowledged = acknowledgeUrgent(state.acknowledged, snapshot);
  return acknowledged ? { isOpen: true, acknowledged } : { isOpen: true };
}

/**
 * Open state for the canopy panel, and the latest cards main pushed.
 *
 * A store for the same reason as `pilotStore`: the panel opens from an action,
 * a keybinding and a toolbar button, and is lazy-mounted only once open. The
 * snapshot is kept across closes so reopening shows the last cards at once,
 * while main rescans in the background.
 */
export const useCanopyStore = create<CanopyState>((set) => ({
  isOpen: false,
  snapshot: null,
  reads: {},
  acknowledged: readAcknowledged(),
  orders: {},
  setOrder: (scope, order) => set((state) => ({ orders: { ...state.orders, [scope]: order } })),
  archivedExpanded: false,
  setArchivedExpanded: (expanded) => set({ archivedExpanded: expanded }),
  scope: loadScope(),
  setScope: (scope) => {
    saveScope(scope);
    set({ scope });
  },
  open: () => set((state) => opened(state, state.snapshot)),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => (state.isOpen ? { isOpen: false } : opened(state, state.snapshot))),
  applySnapshot: (snapshot) =>
    set((state) => {
      // A pull answered after a newer push is older news.
      const held = state.snapshot?.sequence;
      if (held !== undefined && snapshot.sequence !== undefined && snapshot.sequence < held) {
        return state;
      }
      if (!state.isOpen) return { snapshot };
      const acknowledged = acknowledgeUrgent(state.acknowledged, snapshot);
      return acknowledged ? { snapshot, acknowledged } : { snapshot };
    }),
  markRead: (runId, spawnedAt, at = Date.now()) =>
    set((state) => ({ reads: { ...state.reads, [runId]: { spawnedAt, at } } })),
  pruneReads: (live) =>
    set((state) => {
      const departed = Object.keys(state.reads).filter((runId) => !live.has(runId));
      if (departed.length === 0) return state;
      const reads = { ...state.reads };
      for (const runId of departed) delete reads[runId];
      return { reads };
    }),
}));

// A sibling project view opened the panel: its badge cleared, so this one does too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== CANOPY_ACKNOWLEDGED_STORAGE_KEY) return;
    useCanopyStore.setState({ acknowledged: readAcknowledged() });
  });
}
