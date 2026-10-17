import { create } from "zustand";
import { getViewWorkspaceId } from "./viewWorkspaceId";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
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
  /**
   * The host the panel shows when it isn't the window's own: picked in the
   * panel's header, and back to the window's own host each time it opens.
   * Only the panel reads it; the toolbar always counts the window's own host.
   */
  hostId: HostId | null;
  setHostId: (hostId: HostId | null) => void;
  /** Each other host's order for all its projects, kept apart from this host's and each other's. */
  hostOrders: Record<HostId, CanopyOrder>;
  setHostOrder: (hostId: HostId, order: CanopyOrder) => void;
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
 * The host this view runs on. Read off the window rather than through the host
 * connection hook, which would pull the connection stores in with it.
 */
export function canopyOwnHostId(): HostId {
  const id = typeof window === "undefined" ? undefined : window.__DAINTREE_HOST_ID__?.id;
  return typeof id === "string" && id.length > 0 ? id : LOCAL_HOST_ID;
}

/**
 * Where a host's order for a scope is stored: every project view shares the
 * one for every project's agents on that host, and keeps its own for its
 * project's. Keyed by host, so one host's order never opens another's list.
 */
function orderSlot(hostId: HostId, scope: CanopyScope): string {
  return scope === "all" ? `${hostId}|all` : `${hostId}|project:${getViewWorkspaceId() ?? ""}`;
}

/** Where this machine's orders were kept before they were kept per host. */
function legacyOrderSlot(scope: CanopyScope): string {
  return scope === "all" ? "all" : `project:${getViewWorkspaceId() ?? ""}`;
}

function readStoredOrders(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "null");
  return parsed && typeof parsed === "object" ? { ...parsed } : {};
}

function storedIds(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;
}

/**
 * Ranked for no scan this view has seen, so the open places it afresh by what
 * is known now, starting from the order it was left in.
 */
function unranked(ids: string[]): CanopyOrder {
  return { ids, rankedFor: null, urgent: [] };
}

/** Where a host's stored order came from: its own slot, or, for this machine, the old one. */
function storedOrder(
  stored: Record<string, unknown>,
  hostId: HostId,
  scope: CanopyScope
): string[] | null {
  return (
    storedIds(stored[orderSlot(hostId, scope)]) ??
    (hostId === LOCAL_HOST_ID ? storedIds(stored[legacyOrderSlot(scope)]) : null)
  );
}

function loadOrders(): {
  orders: Partial<Record<CanopyScope, CanopyOrder>>;
  hostOrders: Record<HostId, CanopyOrder>;
} {
  try {
    const stored = readStoredOrders();
    const own = canopyOwnHostId();
    const orders: Partial<Record<CanopyScope, CanopyOrder>> = {};
    for (const scope of ["all", "project"] as const) {
      const ids = storedOrder(stored, own, scope);
      if (ids) orders[scope] = unranked(ids);
    }
    const hostOrders: Record<HostId, CanopyOrder> = {};
    const others = new Set(
      Object.keys(stored)
        .filter((slot) => slot.endsWith("|all"))
        .map((slot) => slot.slice(0, -"|all".length))
    );
    others.add(LOCAL_HOST_ID);
    others.delete(own);
    for (const hostId of others) {
      const ids = storedOrder(stored, hostId, "all");
      if (ids) hostOrders[hostId] = unranked(ids);
    }
    return { orders, hostOrders };
  } catch {
    return { orders: {}, hostOrders: {} };
  }
}

/**
 * Saves one host's order for a scope over what is stored, so a project view
 * saving its own never drops what another view saved meanwhile.
 */
function saveOrder(hostId: HostId, scope: CanopyScope, ids: readonly string[]): void {
  try {
    const slot = orderSlot(hostId, scope);
    const stored = readStoredOrders();
    delete stored[slot];
    // Kept per host from here on: the old copy would only go stale.
    if (hostId === LOCAL_HOST_ID) delete stored[legacyOrderSlot(scope)];
    stored[slot] = ids;
    const projects = Object.keys(stored).filter(
      (key) => key.startsWith("project:") || key.includes("|project:")
    );
    for (const key of projects.slice(0, Math.max(0, projects.length - MAX_PROJECT_ORDERS))) {
      delete stored[key];
    }
    window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Best effort: this view still keeps it for the session.
  }
}

function sameIds(was: readonly string[] | undefined, ids: readonly string[]): boolean {
  return was !== undefined && was.length === ids.length && was.every((id, i) => ids[i] === id);
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
  ...loadOrders(),
  setOrder: (scope, order) =>
    set((state) => {
      if (!sameIds(state.orders[scope]?.ids, order.ids)) {
        saveOrder(canopyOwnHostId(), scope, order.ids);
      }
      return { orders: { ...state.orders, [scope]: order } };
    }),
  hostId: null,
  setHostId: (hostId) => set({ hostId: hostId === canopyOwnHostId() ? null : hostId }),
  setHostOrder: (hostId, order) =>
    set((state) => {
      if (!sameIds(state.hostOrders[hostId]?.ids, order.ids)) saveOrder(hostId, "all", order.ids);
      return { hostOrders: { ...state.hostOrders, [hostId]: order } };
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
  // Every opening starts on the window's own host.
  open: () =>
    set((state) =>
      state.mode === "hidden" || state.isOpen ? state : { isOpen: true, hostId: null }
    ),
  close: () => set({ isOpen: false }),
  toggle: () =>
    set((state) =>
      state.isOpen
        ? { isOpen: false }
        : state.mode === "hidden"
          ? state
          : { isOpen: true, hostId: null }
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
