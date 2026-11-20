import { create } from "zustand";
import type { DecisionQuestionReference } from "@shared/types/decisionsQuestion";

/**
 * A question the inbox is asked to show (#18047): one of a pane's by its
 * terminal, or one named by its full reference from a notification or the
 * next-question action.
 */
export interface DecisionsInboxQuestion {
  terminalId: string;
  questionId: string;
  /** Matched exactly when given; otherwise the terminal and question id name it. */
  reference?: DecisionQuestionReference;
  /** The follow-up in its thread to scroll to once it's read (#17235). */
  threadMessageId?: string;
}

/** Where an opening of the inbox starts. */
export interface DecisionsInboxRequest {
  /**
   * The pane whose Decisions dropdown opened it: its first question is shown
   * first, and the close returns to its chip. Null from anywhere else.
   */
  terminalId: string | null;
  /** Rises with every opening, so opening again while open still lands. */
  seq: number;
  /** When it opened (epoch ms): the clock deadlines in the list are read against. */
  openedAt?: number;
  /** The question asked for, shown ahead of the pane's first. */
  question?: DecisionsInboxQuestion | null;
  /**
   * Rises with every question asked for, also while the inbox stays open, so
   * each one is shown even when it's asked for twice.
   */
  ask?: number;
}

interface DecisionsInboxState {
  isOpen: boolean;
  request: DecisionsInboxRequest;
  /**
   * Opens the inbox, at `question` when given. Asked for a question while
   * already open, it shows that question in the same opening, keeping the
   * list and where the close returns.
   */
  open: (options?: { terminalId?: string | null; question?: DecisionsInboxQuestion }) => void;
  close: () => void;
}

/**
 * The Decisions inbox (#17231), one per view: opened from a pane's Decisions
 * dropdown and question rows, from Settings, from a question's notification
 * and from the next-question action. Ids only: the questions' words are read
 * on demand by the inbox and never kept here.
 */
export const useDecisionsInboxStore = create<DecisionsInboxState>()((set) => ({
  isOpen: false,
  request: { terminalId: null, seq: 0 },
  open: (options) =>
    set((state) => {
      const question = options?.question ?? null;
      const ask = (state.request.ask ?? 0) + 1;
      if (state.isOpen && question !== null) {
        return { request: { ...state.request, question, ask } };
      }
      return {
        isOpen: true,
        request: {
          terminalId: options?.terminalId ?? null,
          seq: state.request.seq + 1,
          openedAt: Date.now(),
          question,
          ask,
        },
      };
    }),
  close: () => set({ isOpen: false }),
}));
