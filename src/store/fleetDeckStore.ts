import { create } from "zustand";
import { fleetDeckController } from "@/controllers/FleetDeckController";

export const FLEET_DECK_MIN_WIDTH = 360;
export const FLEET_DECK_MAX_WIDTH = 900;
export const FLEET_DECK_DEFAULT_WIDTH = 480;
export const FLEET_DECK_MIN_HEIGHT = 240;
export const FLEET_DECK_MAX_HEIGHT = 900;
export const FLEET_DECK_DEFAULT_HEIGHT = 320;
export const FLEET_DECK_LIVE_TILE_CAP = 4;

export type FleetDeckEdge = "right" | "left" | "bottom";
export type FleetDeckScope = "current" | "all";
export type FleetDeckStateFilter = "all" | "waiting" | "working" | "idle" | "completed" | "failed";

interface FleetDeckState {
  isOpen: boolean;
  edge: FleetDeckEdge;
  width: number;
  height: number;
  scope: FleetDeckScope;
  stateFilter: FleetDeckStateFilter;
  pinnedLiveIds: Set<string>;
  isHydrated: boolean;
  alwaysPreview: boolean;
  quorumThreshold: number;

  open: () => void;
  openWithScope: (scope: FleetDeckScope) => void;
  close: () => void;
  toggle: () => void;
  setEdge: (edge: FleetDeckEdge) => void;
  setWidth: (width: number) => void;
  setHeight: (height: number) => void;
  setScope: (scope: FleetDeckScope) => void;
  setStateFilter: (filter: FleetDeckStateFilter) => void;
  setAlwaysPreview: (value: boolean) => void;
  setQuorumThreshold: (value: number) => void;
  pinLive: (id: string) => void;
  unpinLive: (id: string) => void;
  togglePinLive: (id: string) => void;
  prunePins: (validIds: Set<string>) => void;
  hydrate: (state: Partial<Pick<FleetDeckState, "isOpen" | "edge" | "width" | "height">>) => void;
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return FLEET_DECK_DEFAULT_WIDTH;
  return Math.min(Math.max(width, FLEET_DECK_MIN_WIDTH), FLEET_DECK_MAX_WIDTH);
}

function clampHeight(height: number): number {
  if (!Number.isFinite(height)) return FLEET_DECK_DEFAULT_HEIGHT;
  return Math.min(Math.max(height, FLEET_DECK_MIN_HEIGHT), FLEET_DECK_MAX_HEIGHT);
}

function normalizeEdge(edge: FleetDeckEdge | undefined): FleetDeckEdge {
  // Side-dock only in this iteration; bottom falls back to right until implemented.
  if (edge === "left") return "left";
  return "right";
}

export const useFleetDeckStore = create<FleetDeckState>()((set, get) => ({
  isOpen: false,
  edge: "right",
  width: FLEET_DECK_DEFAULT_WIDTH,
  height: FLEET_DECK_DEFAULT_HEIGHT,
  scope: "current",
  stateFilter: "all",
  pinnedLiveIds: new Set<string>(),
  isHydrated: false,
  alwaysPreview: false,
  quorumThreshold: 5,

  open: () => {
    if (get().isOpen) return;
    // User interaction before hydrate() resolves wins; hydrate() becomes a
    // no-op once isHydrated flips (whether via this path or the explicit
    // hydrate call).
    set({ isOpen: true, isHydrated: true });
    void persistOpen(true);
  },

  openWithScope: (scope) => {
    const s = get();
    if (s.scope !== scope) set({ scope });
    if (!s.isOpen) {
      set({ isOpen: true, isHydrated: true });
      void persistOpen(true);
    }
  },

  close: () => {
    if (!get().isOpen) return;
    set({ isOpen: false, isHydrated: true });
    void persistOpen(false);
  },

  toggle: () => {
    const next = !get().isOpen;
    set({ isOpen: next, isHydrated: true });
    void persistOpen(next);
  },

  setEdge: (edge) => {
    const normalized = normalizeEdge(edge);
    if (get().edge === normalized) return;
    set({ edge: normalized, isHydrated: true });
    void persistEdge(normalized);
  },

  setWidth: (width) => {
    const clamped = clampWidth(width);
    if (get().width === clamped) return;
    set({ width: clamped, isHydrated: true });
    void persistWidth(clamped);
  },

  setHeight: (height) => {
    const clamped = clampHeight(height);
    if (get().height === clamped) return;
    set({ height: clamped, isHydrated: true });
    void persistHeight(clamped);
  },

  setScope: (scope) => {
    if (get().scope === scope) return;
    set({ scope });
  },

  setStateFilter: (filter) => {
    if (get().stateFilter === filter) return;
    set({ stateFilter: filter });
  },

  setAlwaysPreview: (value) => {
    if (get().alwaysPreview === value) return;
    set({ alwaysPreview: value });
    void persistAlwaysPreview(value);
  },

  setQuorumThreshold: (value) => {
    const clamped = Math.max(2, Math.min(50, value));
    if (get().quorumThreshold === clamped) return;
    set({ quorumThreshold: clamped });
    void persistQuorumThreshold(clamped);
  },

  pinLive: (id) =>
    set((s) => {
      if (s.pinnedLiveIds.has(id)) return {};
      const next = new Set(s.pinnedLiveIds);
      next.add(id);
      return { pinnedLiveIds: next };
    }),

  unpinLive: (id) =>
    set((s) => {
      if (!s.pinnedLiveIds.has(id)) return {};
      const next = new Set(s.pinnedLiveIds);
      next.delete(id);
      return { pinnedLiveIds: next };
    }),

  togglePinLive: (id) => {
    if (get().pinnedLiveIds.has(id)) {
      get().unpinLive(id);
    } else {
      get().pinLive(id);
    }
  },

  prunePins: (validIds) =>
    set((s) => {
      if (s.pinnedLiveIds.size === 0) return {};
      let changed = false;
      const next = new Set<string>();
      for (const id of s.pinnedLiveIds) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      if (!changed) return {};
      return { pinnedLiveIds: next };
    }),

  hydrate: (state) => {
    // If a user mutator ran before the async AppState hydration resolves,
    // their interaction wins — don't clobber it with stale persisted values.
    if (get().isHydrated) return;
    const patch: Partial<FleetDeckState> = { isHydrated: true };
    if (typeof state.isOpen === "boolean") patch.isOpen = state.isOpen;
    if (state.edge != null) patch.edge = normalizeEdge(state.edge);
    if (typeof state.width === "number") patch.width = clampWidth(state.width);
    if (typeof state.height === "number") patch.height = clampHeight(state.height);
    set(patch);
  },
}));

const persistOpen = (isOpen: boolean): Promise<void> => fleetDeckController.persistOpen(isOpen);

const persistEdge = (edge: FleetDeckEdge): Promise<void> => fleetDeckController.persistEdge(edge);

const persistWidth = (width: number): Promise<void> => fleetDeckController.persistWidth(width);

const persistHeight = (height: number): Promise<void> => fleetDeckController.persistHeight(height);

const persistAlwaysPreview = (_value: boolean): Promise<void> => Promise.resolve();

const persistQuorumThreshold = (_value: number): Promise<void> => Promise.resolve();
