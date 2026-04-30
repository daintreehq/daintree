import { create } from "zustand";

interface UIState {
  overlayClaims: Set<string>;
  addOverlayClaim: (id: string) => void;
  removeOverlayClaim: (id: string) => void;
  hasOpenOverlays: () => boolean;
  notificationCenterOpen: boolean;
  openNotificationCenter: () => void;
  closeNotificationCenter: () => void;
  toggleNotificationCenter: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  overlayClaims: new Set<string>(),

  // Idempotent — return the same state reference when the claim is already
  // present so Zustand skips re-renders. Never mutate the existing Set; a new
  // instance is required so reference-equality subscribers update.
  addOverlayClaim: (id) =>
    set((state) => {
      if (state.overlayClaims.has(id)) return state;
      const next = new Set(state.overlayClaims);
      next.add(id);
      return { overlayClaims: next };
    }),

  removeOverlayClaim: (id) =>
    set((state) => {
      if (!state.overlayClaims.has(id)) return state;
      const next = new Set(state.overlayClaims);
      next.delete(id);
      return { overlayClaims: next };
    }),

  hasOpenOverlays: () => get().overlayClaims.size > 0,

  notificationCenterOpen: false,
  openNotificationCenter: () => set({ notificationCenterOpen: true }),
  closeNotificationCenter: () => set({ notificationCenterOpen: false }),
  toggleNotificationCenter: () =>
    set((state) => ({ notificationCenterOpen: !state.notificationCenterOpen })),
}));
