import { create } from "zustand";

/** Where an opening of the inbox starts. */
export interface DecisionsInboxRequest {
  /**
   * The pane whose Decisions dropdown opened it: its first question is shown
   * first, and the close returns to its chip. Null from anywhere else.
   */
  terminalId: string | null;
  /** Rises with every opening, so opening again while open still lands. */
  seq: number;
}

interface DecisionsInboxState {
  isOpen: boolean;
  request: DecisionsInboxRequest;
  open: (options?: { terminalId?: string | null }) => void;
  close: () => void;
}

/**
 * The Decisions inbox (#17231), one per view: opened from a pane's Decisions
 * dropdown and from Settings. Ids only: the questions' words are read on
 * demand by the inbox and never kept here.
 */
export const useDecisionsInboxStore = create<DecisionsInboxState>()((set) => ({
  isOpen: false,
  request: { terminalId: null, seq: 0 },
  open: (options) =>
    set((state) => ({
      isOpen: true,
      request: { terminalId: options?.terminalId ?? null, seq: state.request.seq + 1 },
    })),
  close: () => set({ isOpen: false }),
}));
