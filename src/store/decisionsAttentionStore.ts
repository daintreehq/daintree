import { create } from "zustand";

/** Where an opening of the needs-attention list starts: a pane's answers, or the top. */
export interface DecisionsAttentionRequest {
  /** The pane whose chip opened it; its first answer takes the focus. */
  terminalId: string | null;
  /** Rises with every opening, so opening again while open still lands. */
  seq: number;
}

interface DecisionsAttentionState {
  isOpen: boolean;
  request: DecisionsAttentionRequest;
  open: (terminalId?: string | null) => void;
  close: () => void;
}

/**
 * The Decisions needs-attention list (#16020), one per view: opened from a
 * pane's Decisions chip and from Settings, and kept by the project's dialog
 * host so it outlives the chip, which goes once its last answer is dealt with.
 */
export const useDecisionsAttentionStore = create<DecisionsAttentionState>()((set) => ({
  isOpen: false,
  request: { terminalId: null, seq: 0 },
  open: (terminalId = null) =>
    set((state) => ({ isOpen: true, request: { terminalId, seq: state.request.seq + 1 } })),
  close: () => set({ isOpen: false }),
}));
