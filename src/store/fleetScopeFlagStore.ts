import { create } from "zustand";
import { appClient } from "@/clients";

export type FleetScopeMode = "legacy" | "scoped";

interface FleetScopeFlagState {
  mode: FleetScopeMode;
  isHydrated: boolean;

  setMode: (mode: FleetScopeMode) => void;
  hydrate: (mode: FleetScopeMode | undefined) => void;
}

export const useFleetScopeFlagStore = create<FleetScopeFlagState>()((set, get) => ({
  mode: "legacy",
  isHydrated: false,

  setMode: (mode) => {
    if (get().mode === mode) return;
    set({ mode, isHydrated: true });
    void persistMode(mode);
  },

  hydrate: (mode) => {
    if (get().isHydrated) return;
    set({ mode: mode === "scoped" ? "scoped" : "legacy", isHydrated: true });
  },
}));

async function persistMode(mode: FleetScopeMode): Promise<void> {
  try {
    await appClient.setState({ fleetScopeMode: mode });
  } catch (error) {
    console.error("Failed to persist fleet scope mode:", error);
  }
}
