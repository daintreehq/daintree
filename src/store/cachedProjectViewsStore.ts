import { create } from "zustand";

interface CachedProjectViewsState {
  cachedProjectViews: number;
  setCachedProjectViews: (n: number) => void;
}

export const useCachedProjectViewsStore = create<CachedProjectViewsState>()((set) => ({
  cachedProjectViews: 1,
  setCachedProjectViews: (n) => set({ cachedProjectViews: n }),
}));
