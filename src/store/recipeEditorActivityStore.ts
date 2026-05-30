import { create } from "zustand";

/**
 * Tracks whether any recipe editor surface is currently open (#9186). The
 * focus-reload hook reads this so it doesn't repopulate the main-process
 * hash cache while the user is mid-edit — if it did, the editor's frozen
 * form snapshot could save over the freshly-loaded disk version without
 * tripping the staleness gate. With an editor open we let the existing
 * write-time `writeInRepoRecipeChecked` surface the conflict at Save instead.
 *
 * Counter-based (not boolean) so nested or overlapping editor surfaces
 * (recipe editor + manager simultaneously) all release the lock cleanly.
 */
interface RecipeEditorActivityState {
  openCount: number;
  isOpen: () => boolean;
  enter: () => void;
  leave: () => void;
}

export const useRecipeEditorActivityStore = create<RecipeEditorActivityState>()((set, get) => ({
  openCount: 0,
  isOpen: () => get().openCount > 0,
  enter: () => set((s) => ({ openCount: s.openCount + 1 })),
  leave: () => set((s) => ({ openCount: Math.max(0, s.openCount - 1) })),
}));
