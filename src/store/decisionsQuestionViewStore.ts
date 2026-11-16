import { create } from "zustand";

/**
 * The question being read in the Decisions question view (#17098): ids only.
 * The content is read on demand by the view and never stored here.
 */
export interface DecisionsQuestionViewRequest {
  terminalId: string;
  /** The pane's questions in the order the dropdown listed them; the view steps through these. */
  questionIds: string[];
  index: number;
}

interface DecisionsQuestionViewState {
  isOpen: boolean;
  request: DecisionsQuestionViewRequest | null;
  open: (terminalId: string, questionIds: readonly string[], questionId: string) => void;
  step: (delta: number) => void;
  close: () => void;
}

/**
 * One per view, kept by the view's dialog host rather than by the pane's chip:
 * the chip goes once its last question settles, and a question stays readable
 * after that.
 */
export const useDecisionsQuestionViewStore = create<DecisionsQuestionViewState>()((set) => ({
  isOpen: false,
  request: null,
  open: (terminalId, questionIds, questionId) => {
    const ids = [...new Set(questionIds)];
    const index = ids.indexOf(questionId);
    if (index === -1) return;
    set({ isOpen: true, request: { terminalId, questionIds: ids, index } });
  },
  step: (delta) =>
    set((state) => {
      const request = state.request;
      if (request === null) return state;
      const index = request.index + delta;
      if (index < 0 || index >= request.questionIds.length || index === request.index) {
        return state;
      }
      return { request: { ...request, index } };
    }),
  // The request stays until the next opening, so the closing dialog keeps its content on screen.
  close: () => set({ isOpen: false }),
}));
