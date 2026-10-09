import { create } from "zustand";
import { getViewWorkspaceId } from "./viewWorkspaceId";
import type { CanopyOrder } from "@/components/Canopy/canopyOrder";
import {
  CANOPY_URGENT_PRIORITY,
  type CanopyCard,
  type CanopyMode,
  type CanopySnapshot,
} from "@shared/types/ipc/canopy";

interface CanopyState {
  isOpen: boolean;
  /**
   * Where the user stands on Canopy: from the hydrate payload before main has
   * answered, then from each snapshot. Hidden, nothing opens it.
   */
  mode: CanopyMode;
  /** The mode the view hydrated with; a snapshot already held is newer and wins. */
  seedMode: (mode: CanopyMode) => void;
  /** Null until main has answered once — distinct from "no cards yet". */
  snapshot: CanopySnapshot | null;
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
  /** The open panel shows these runs: their urgent prompts count as seen. */
  acknowledge: (runIds: readonly string[]) => void;
  /**
   * The inbox's order as last shown, run ids first to last, and the scan it was
   * ranked after: kept across opens, so the list opens as it was left.
   */
  orders: Partial<Record<CanopyScope, CanopyOrder>>;
  setOrder: (scope: CanopyScope, order: CanopyOrder) => void;
  /** The inbox's "Archived" group is unfolded; kept across opens. */
  archivedExpanded: boolean;
  setArchivedExpanded: (expanded: boolean) => void;
  /** The inbox shows only unread runs; kept across opens for the session. */
  unreadOnly: boolean;
  setUnreadOnly: (unreadOnly: boolean) => void;
  /** Every project's agents, or only the project this view shows; remembered across launches. */
  scope: CanopyScope;
  setScope: (scope: CanopyScope) => void;
}

export type CanopyScope = "all" | "project";

export type { CanopyOrder };

const SCOPE_STORAGE_KEY = "daintree-canopy-scope";
/** Read by every project view, so a view opened or reloaded since still opens on the order last shown. */
const ORDER_STORAGE_KEY = "daintree-canopy-order";
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
 * Marks the urgent prompts of the runs the panel shows as seen — only those: a
 * panel scoped to one project leaves another project's asks on the badge.
 * Merged over what is stored rather than this view's copy, since every project
 * view writes the key, and pruned to the runs Canopy still has cards for.
 */
function acknowledgeUrgent(
  current: Record<string, string>,
  snapshot: CanopySnapshot | null,
  shown: ReadonlySet<string>
): Record<string, string> | null {
  if (!snapshot) return null;
  const urgent = snapshot.cards.filter(
    (card) =>
      shown.has(card.runId) &&
      card.priority >= CANOPY_URGENT_PRIORITY &&
      current[card.runId] !== promptKey(card)
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

/** Project orders kept at most, the least recently saved dropped first. */
const MAX_PROJECT_ORDERS = 20;

/**
 * Where a scope's order is stored: every project view shares the one for every
 * project's agents, and keeps its own for its project's.
 */
function orderSlot(scope: CanopyScope): string {
  return scope === "all" ? "all" : `project:${getViewWorkspaceId() ?? ""}`;
}

function readStoredOrders(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "null");
  return parsed && typeof parsed === "object" ? { ...parsed } : {};
}

function loadOrders(): Partial<Record<CanopyScope, CanopyOrder>> {
  try {
    const stored = readStoredOrders();
    const orders: Partial<Record<CanopyScope, CanopyOrder>> = {};
    for (const scope of ["all", "project"] as const) {
      const ids = stored[orderSlot(scope)];
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
        // Ranked for no scan this view has seen, so the open places it afresh
        // by what is known now, starting from the order it was left in.
        orders[scope] = { ids, rankedFor: null, urgent: [] };
      }
    }
    return orders;
  } catch {
    return {};
  }
}

/**
 * Saves one scope's order over what is stored, so a project view saving its
 * own never drops what another view saved meanwhile.
 */
function saveOrder(scope: CanopyScope, ids: readonly string[]): void {
  try {
    const slot = orderSlot(scope);
    const stored = readStoredOrders();
    delete stored[slot];
    stored[slot] = ids;
    const projects = Object.keys(stored).filter((key) => key.startsWith("project:"));
    for (const key of projects.slice(0, Math.max(0, projects.length - MAX_PROJECT_ORDERS))) {
      delete stored[key];
    }
    window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Best effort: this view still keeps it for the session.
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
 * Open state for the canopy panel, and the latest cards main pushed.
 *
 * A store for the same reason as `pilotStore`: the panel opens from an action,
 * a keybinding and a toolbar button, and is lazy-mounted only once open. The
 * snapshot is kept across closes so reopening shows the last cards at once,
 * while main rescans in the background.
 */
export const useCanopyStore = create<CanopyState>((set) => ({
  isOpen: false,
  mode: "unset",
  seedMode: (mode) => set((state) => (state.snapshot === null ? { mode } : state)),
  snapshot: null,
  acknowledged: readAcknowledged(),
  acknowledge: (runIds) =>
    set((state) => {
      if (!state.isOpen) return state;
      const acknowledged = acknowledgeUrgent(state.acknowledged, state.snapshot, new Set(runIds));
      return acknowledged ? { acknowledged } : state;
    }),
  orders: loadOrders(),
  setOrder: (scope, order) =>
    set((state) => {
      const was = state.orders[scope]?.ids;
      if (
        was === undefined ||
        was.length !== order.ids.length ||
        was.some((id, i) => order.ids[i] !== id)
      ) {
        saveOrder(scope, order.ids);
      }
      return { orders: { ...state.orders, [scope]: order } };
    }),
  archivedExpanded: false,
  setArchivedExpanded: (expanded) => set({ archivedExpanded: expanded }),
  unreadOnly: false,
  setUnreadOnly: (unreadOnly) => set({ unreadOnly }),
  scope: loadScope(),
  setScope: (scope) => {
    saveScope(scope);
    set({ scope });
  },
  open: () => set((state) => (state.mode === "hidden" ? state : { isOpen: true })),
  close: () => set({ isOpen: false }),
  toggle: () =>
    set((state) =>
      state.isOpen ? { isOpen: false } : state.mode === "hidden" ? state : { isOpen: true }
    ),
  applySnapshot: (snapshot) =>
    set((state) => {
      // A pull answered after a newer push is older news.
      const held = state.snapshot?.sequence;
      if (held !== undefined && snapshot.sequence !== undefined && snapshot.sequence < held) {
        return state;
      }
      const mode = snapshot.mode;
      // Hidden from another view, or from Settings: a panel this view held open goes too.
      if (mode === "hidden") return { snapshot, mode, isOpen: false };
      return { snapshot, mode };
    }),
}));

// A sibling project view opened the panel: its badge cleared, so this one does too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== CANOPY_ACKNOWLEDGED_STORAGE_KEY) return;
    useCanopyStore.setState({ acknowledged: readAcknowledged() });
  });
}
