import { create } from "zustand";
import type { DecisionQuestionReference } from "@shared/types/decisionsQuestion";

/** Where an opening of the inbox starts. */
export interface DecisionsInboxRequest {
  /** The question selected on opening; null selects the first one listed. */
  reference: DecisionQuestionReference | null;
  /** Rises with every opening, so opening again while open still lands. */
  seq: number;
}

interface DecisionsInboxState {
  isOpen: boolean;
  request: DecisionsInboxRequest;
  open: (reference?: DecisionQuestionReference | null) => void;
  close: () => void;
}

/**
 * The Decisions inbox (#17231), one per view: opened from a pane's Decisions
 * dropdown and from Settings. Ids only: the questions' words are read on
 * demand by the inbox and never kept here.
 */
export const useDecisionsInboxStore = create<DecisionsInboxState>()((set) => ({
  isOpen: false,
  request: { reference: null, seq: 0 },
  open: (reference = null) =>
    set((state) => ({
      isOpen: true,
      request: { reference, seq: state.request.seq + 1 },
    })),
  close: () => set({ isOpen: false }),
}));
