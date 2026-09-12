import { create } from "zustand";

/**
 * Session dismissals for global banners whose condition has no dismissal of
 * its own. The coordinator reads this so a dismissed banner gives up the slot
 * instead of rendering nothing while still holding it; the entry is cleared
 * when the condition clears, so the next occurrence shows again.
 */
export type DismissibleGlobalBannerSlot = "watchdog-disabled" | "plugin-document";

interface GlobalBannerDismissalState {
  dismissed: ReadonlySet<DismissibleGlobalBannerSlot>;
  dismiss: (slot: DismissibleGlobalBannerSlot) => void;
  reset: (slot: DismissibleGlobalBannerSlot) => void;
}

export const useGlobalBannerDismissalStore = create<GlobalBannerDismissalState>((set) => ({
  dismissed: new Set(),
  dismiss: (slot) =>
    set((s) => (s.dismissed.has(slot) ? s : { dismissed: new Set(s.dismissed).add(slot) })),
  reset: (slot) =>
    set((s) => {
      if (!s.dismissed.has(slot)) return s;
      const next = new Set(s.dismissed);
      next.delete(slot);
      return { dismissed: next };
    }),
}));
