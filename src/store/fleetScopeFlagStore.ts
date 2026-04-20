import { create } from "zustand";

export type FleetScopeMode = "legacy" | "scoped";

interface FleetScopeFlagState {
  mode: FleetScopeMode;
  isHydrated: boolean;

  setMode: (mode: FleetScopeMode) => void;
  hydrate: (mode: FleetScopeMode | undefined) => void;
}

export const useFleetScopeFlagStore = create<FleetScopeFlagState>()((set, get) => ({
  mode: "scoped",
  isHydrated: false,

  setMode: (mode) => {
    if (get().mode === mode) return;
    set({ mode, isHydrated: true });
    void persistMode(mode);
  },

  hydrate: (mode) => {
    if (get().isHydrated) return;
    set({ mode: mode === "legacy" ? "legacy" : "scoped", isHydrated: true });
  },
}));

async function persistMode(mode: FleetScopeMode): Promise<void> {
  try {
    const { appClient } = await import("@/clients");
    await appClient.setState({ fleetScopeMode: mode });
  } catch (error) {
    console.error("Failed to persist fleet scope mode:", error);
  }
}
