import { create } from "zustand";

interface UIState {
  overlayCount: number;
  pushOverlay: () => void;
  popOverlay: () => void;
  hasOpenOverlays: () => boolean;
  notificationCenterOpen: boolean;
  openNotificationCenter: () => void;
  closeNotificationCenter: () => void;
  toggleNotificationCenter: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  overlayCount: 0,

  pushOverlay: () => set((state) => ({ overlayCount: state.overlayCount + 1 })),

  popOverlay: () =>
    set((state) => ({
      overlayCount: Math.max(0, state.overlayCount - 1),
    })),

  hasOpenOverlays: () => get().overlayCount > 0,

  notificationCenterOpen: false,
  openNotificationCenter: () => set({ notificationCenterOpen: true }),
  closeNotificationCenter: () => set({ notificationCenterOpen: false }),
  toggleNotificationCenter: () =>
    set((state) => ({ notificationCenterOpen: !state.notificationCenterOpen })),
}));
