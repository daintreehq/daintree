import { create } from "zustand";
import type { RecentDictation } from "@shared/types";

interface RecentDictationsState {
  /**
   * This view's copy of the app session's recent dictations, newest first.
   * Main owns the list (`recentDictations` IPC) so it outlives this view;
   * nothing here is persisted.
   */
  dictations: RecentDictation[];
  setDictations: (dictations: RecentDictation[]) => void;
  /** The dictation the palette should open on, asked for by the toolbar menu's "View full dictation…". */
  revealId: string | null;
  reveal: (id: string | null) => void;
}

export const useRecentDictationsStore = create<RecentDictationsState>()((set) => ({
  dictations: [],
  setDictations: (dictations) => set({ dictations }),
  revealId: null,
  reveal: (revealId) => set({ revealId }),
}));

/** Which of a dictation's two texts a recovery uses. */
export type RecentDictationVersion = "cleaned" | "original";

/** The cleaned-up text when cleanup changed it, else what was heard; or always what was heard. */
export function recentDictationText(
  dictation: RecentDictation,
  version: RecentDictationVersion = "cleaned"
): string {
  return version === "original"
    ? dictation.rawText
    : (dictation.correctedText ?? dictation.rawText);
}
