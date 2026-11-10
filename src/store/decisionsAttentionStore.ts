import { create } from "zustand";

/** Where an opening of the needs-attention list starts: a pane's answers, or the top. */
export interface DecisionsAttentionRequest {
  /** The pane whose chip opened it; its first answer takes the focus. */
  terminalId: string | null;
  /**
   * The id of the element the close returns to once the control that opened
   * the list has gone — a Canopy row, whose banner leaves with its last answer.
   * Null for a pane's chip, whose pane is found by `terminalId`.
   */
  returnFocusTo: string | null;
  /** Rises with every opening, so opening again while open still lands. */
  seq: number;
}

interface DecisionsAttentionState {
  isOpen: boolean;
  request: DecisionsAttentionRequest;
  open: (terminalId?: string | null, options?: { returnFocusTo?: string }) => void;
  close: () => void;
}

/**
 * The Decisions needs-attention list (#16020), one per view: opened from a
 * pane's Decisions chip, from Settings, and in the Canopy window from a run's
 * pane or row menu (#16637). Kept by the view's own dialog host so it outlives
 * whatever opened it, which goes once its last answer is dealt with.
 */
export const useDecisionsAttentionStore = create<DecisionsAttentionState>()((set) => ({
  isOpen: false,
  request: { terminalId: null, returnFocusTo: null, seq: 0 },
  open: (terminalId = null, options) =>
    set((state) => ({
      isOpen: true,
      request: {
        terminalId,
        returnFocusTo: options?.returnFocusTo ?? null,
        seq: state.request.seq + 1,
      },
    })),
  close: () => set({ isOpen: false }),
}));
