import { create } from "zustand";
import { fleetDeckController } from "@/controllers/FleetDeckController";

export type FleetDeckStateFilter = "all" | "waiting" | "working" | "idle" | "completed" | "failed";

interface FleetDeckState {
  isOpen: boolean;
  stateFilter: FleetDeckStateFilter;
  isHydrated: boolean;
  alwaysPreview: boolean;
  quorumThreshold: number;

  open: () => void;
  close: () => void;
  toggle: () => void;
  setStateFilter: (filter: FleetDeckStateFilter) => void;
  setAlwaysPreview: (value: boolean) => void;
  setQuorumThreshold: (value: number) => void;
  hydrate: (state: Partial<Pick<FleetDeckState, "isOpen">>) => void;
}

export const useFleetDeckStore = create<FleetDeckState>()((set, get) => ({
  isOpen: false,
  stateFilter: "all",
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

  hydrate: (state) => {
    // If a user mutator ran before the async AppState hydration resolves,
    // their interaction wins — don't clobber it with stale persisted values.
    if (get().isHydrated) return;
    const patch: Partial<FleetDeckState> = { isHydrated: true };
    if (typeof state.isOpen === "boolean") patch.isOpen = state.isOpen;
    set(patch);
  },
}));

const persistOpen = (isOpen: boolean): Promise<void> => fleetDeckController.persistOpen(isOpen);

const persistAlwaysPreview = (value: boolean): Promise<void> =>
  fleetDeckController.persistAlwaysPreview(value);

const persistQuorumThreshold = (value: number): Promise<void> =>
  fleetDeckController.persistQuorumThreshold(value);
