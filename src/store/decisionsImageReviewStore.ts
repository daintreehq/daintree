import { create } from "zustand";

/** A question's images a person has seen at full size: attachment id to the digest it was shown under. */
export type ReviewedImages = Readonly<Record<string, string>>;

/** Questions whose record is kept; the oldest goes first past it. */
const MAX_QUESTIONS = 64;

const NONE: ReviewedImages = Object.freeze({});
const NO_QUESTIONS: Readonly<Record<string, ReviewedImages>> = Object.freeze({});

export function reviewKey(terminalId: string, questionId: string): string {
  return `${terminalId}\u0000${questionId}`;
}

interface DecisionsImageReviewState {
  /** Per pane and question, each image seen at full size and the digest it was shown under. */
  byQuestion: Readonly<Record<string, ReviewedImages>>;
  markShown: (terminalId: string, questionId: string, attachmentId: string, sha256: string) => void;
  clear: () => void;
}

/**
 * Which of a question's images a person has actually seen at full size in
 * the question view (#17100), for the answer composer to apply the rule that
 * every image is opened before an approval. Ids and digests only, in memory:
 * never the images, never persisted. One per view, like the question view.
 */
export const useDecisionsImageReviewStore = create<DecisionsImageReviewState>()((set) => ({
  byQuestion: NO_QUESTIONS,
  markShown: (terminalId, questionId, attachmentId, sha256) =>
    set((state) => {
      const key = reviewKey(terminalId, questionId);
      const current = state.byQuestion[key] ?? NONE;
      if (current[attachmentId] === sha256) return state;
      const rest = Object.entries(state.byQuestion).filter(([other]) => other !== key);
      const kept = rest.slice(Math.max(0, rest.length - (MAX_QUESTIONS - 1)));
      return {
        byQuestion: Object.fromEntries([
          ...kept,
          [key, { ...current, [attachmentId]: sha256 }],
        ]) as Record<string, ReviewedImages>,
      };
    }),
  clear: () => set({ byQuestion: NO_QUESTIONS }),
}));

/** A question's record; the same empty record for every question with none. */
export function useReviewedImages(terminalId: string, questionId: string): ReviewedImages {
  return useDecisionsImageReviewStore(
    (state) => state.byQuestion[reviewKey(terminalId, questionId)] ?? NONE
  );
}
