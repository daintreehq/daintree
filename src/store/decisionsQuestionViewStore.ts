import { create } from "zustand";
import {
  paneQuestion,
  referencedQuestion,
  targetKey,
  type DecisionQuestionTarget,
} from "@/components/Decisions/decisionQuestionTarget";
import type { DecisionQuestionReference } from "@shared/types/decisionsQuestion";

/**
 * The question being read in the Decisions question view (#17098): ids only.
 * The content is read on demand by the view and never stored here.
 */
export interface DecisionsQuestionViewRequest {
  /** The questions in the order they were listed; the view steps through these. */
  questions: DecisionQuestionTarget[];
  index: number;
  /**
   * The follow-up in the opened question's thread to show once it is read
   * (#17235); a step to another question drops it.
   */
  threadMessageId?: string;
}

interface DecisionsQuestionViewState {
  isOpen: boolean;
  request: DecisionsQuestionViewRequest | null;
  /** One of a pane's questions, from its dropdown, read for this view's project. */
  open: (terminalId: string, questionIds: readonly string[], questionId: string) => void;
  /**
   * A question by its reference (#17229), from any window on this computer,
   * stepping through `references` in their order, at `threadMessageId` in its
   * thread when given.
   */
  openReference: (
    references: readonly DecisionQuestionReference[],
    reference: DecisionQuestionReference,
    threadMessageId?: string
  ) => void;
  step: (delta: number) => void;
  close: () => void;
}

/** Each question once, opened on `chosen`; null when `chosen` isn't among them. */
function requestOf(
  questions: readonly DecisionQuestionTarget[],
  chosen: DecisionQuestionTarget
): DecisionsQuestionViewRequest | null {
  const seen = new Set<string>();
  const listed = questions.filter((question) => {
    const key = targetKey(question);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const chosenKey = targetKey(chosen);
  const index = listed.findIndex((question) => targetKey(question) === chosenKey);
  return index === -1 ? null : { questions: listed, index };
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
    const request = requestOf(
      questionIds.map((id) => paneQuestion(terminalId, id)),
      paneQuestion(terminalId, questionId)
    );
    if (request !== null) set({ isOpen: true, request });
  },
  openReference: (references, reference, threadMessageId) => {
    const request = requestOf(references.map(referencedQuestion), referencedQuestion(reference));
    if (request === null) return;
    set({
      isOpen: true,
      request: threadMessageId === undefined ? request : { ...request, threadMessageId },
    });
  },
  step: (delta) =>
    set((state) => {
      const request = state.request;
      if (request === null) return state;
      const index = request.index + delta;
      if (index < 0 || index >= request.questions.length || index === request.index) {
        return state;
      }
      return { request: { questions: request.questions, index } };
    }),
  // The request stays until the next opening, so the closing dialog keeps its content on screen.
  close: () => set({ isOpen: false }),
}));
