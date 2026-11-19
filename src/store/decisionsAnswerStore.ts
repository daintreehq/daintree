import { create } from "zustand";
import type {
  AnswerDecisionQuestionPayload,
  DeclineDecisionQuestionPayload,
  DecisionAnswerOutcome,
  DecisionDeclineOutcome,
  DecisionQuestionReference,
} from "@shared/types/decisionsQuestion";
import type { AnswerDraft } from "@/components/Decisions/decisionComposeModel";
import type { DecisionQuestionTarget } from "@/components/Decisions/decisionQuestionTarget";

/**
 * Where a person's answer from this view stands (#17102):
 * - `sending`: handed to main, no reply yet;
 * - `checking`: the reply was lost, so its standing is being read by its id;
 * - `settled`: main replied with the library's outcome (`queued` keeps being read);
 * - `lost`: neither the reply nor its standing could be read; Retry reads it again;
 * - `refused`: nothing was signed, for the reason given.
 */
export type AnswerPhase =
  | { kind: "sending" }
  | { kind: "checking" }
  | { kind: "settled"; outcome: DecisionAnswerOutcome }
  | { kind: "lost" }
  | { kind: "refused"; reason: AnswerRefusal };

export type AnswerRefusal = "not-found" | "not-owner" | "unreadable" | "invalid" | "off";

export interface AnswerSubmission {
  answerId: string;
  /** Exactly what was signed, so a retry is the same answer under the same id. */
  payload: AnswerDecisionQuestionPayload;
  /** How the question was read, to read it again before an answer never committed goes again. */
  target: DecisionQuestionTarget;
  phase: AnswerPhase;
  /** It was sent again on its own once already; after that only Retry sends it again, under the same id. */
  resubmitted: boolean;
}

/**
 * Where a person's dismissal of a question from this view stands (#17239),
 * in the same phases as an answer: `settled` carries the library's outcome
 * (`queued` keeps being read), and `refused` why nothing was signed.
 */
export type DeclinePhase =
  | { kind: "sending" }
  | { kind: "checking" }
  | { kind: "settled"; outcome: DecisionDeclineOutcome }
  | { kind: "lost" }
  | { kind: "refused"; reason: DeclineRefusal };

export type DeclineRefusal = "not-found" | "not-owner" | "invalid" | "off";

export interface DeclineSubmission {
  declineId: string;
  /** Exactly what was signed, so a retry is the same decline under the same id. */
  payload: DeclineDecisionQuestionPayload;
  phase: DeclinePhase;
  /** It was sent again on its own once already; after that only Retry sends it again, under the same id. */
  resubmitted: boolean;
  /**
   * When this computer last read the question (epoch ms), for one signed from
   * that read while its Remote Host was away (#17946); absent otherwise.
   */
  lastReadAt?: number;
}

/**
 * Why the last Send ended with nothing sent: the question's last read found
 * it closed or changed, or it couldn't be read.
 */
export type AnswerHold = "closed" | "changed" | "unreadable" | "not-running" | "failed";

export interface AnswerRecord {
  draft: AnswerDraft | null;
  submission: AnswerSubmission | null;
  /** A Send is reading the question again before it signs. */
  preparing: boolean;
  hold: AnswerHold | null;
  /** The person's dismissal of the question from here, once one was asked for. */
  decline: DeclineSubmission | null;
}

/** Questions whose record is kept; past it, the oldest with nothing in flight goes first. */
const MAX_RECORDS = 64;

const EMPTY: AnswerRecord = Object.freeze({
  draft: null,
  submission: null,
  preparing: false,
  hold: null,
  decline: null,
});

/** One question wherever it is read from: a pane's and its reference's are the same question. */
export function answerKey(reference: DecisionQuestionReference): string {
  return [reference.hostId, reference.projectId, reference.terminalId, reference.questionId].join(
    "\u0000"
  );
}

/** An answer whose fate isn't known yet: never let go, or its id would be forgotten. */
export function isInFlight(record: AnswerRecord): boolean {
  if (record.preparing) return true;
  const phase = record.submission?.phase;
  if (phase === undefined) return false;
  return (
    phase.kind === "sending" ||
    phase.kind === "checking" ||
    phase.kind === "lost" ||
    (phase.kind === "settled" && phase.outcome.status === "queued")
  );
}

/** A dismissal whose fate isn't known yet: never let go, or its id would be forgotten. */
export function isDeclineInFlight(record: AnswerRecord): boolean {
  const phase = record.decline?.phase;
  if (phase === undefined) return false;
  return (
    phase.kind === "sending" ||
    phase.kind === "checking" ||
    phase.kind === "lost" ||
    (phase.kind === "settled" && phase.outcome.status === "queued")
  );
}

interface DecisionsAnswerState {
  records: Readonly<Record<string, AnswerRecord>>;
  /** Rises on every clear, so a reply that lands after one changes nothing. */
  generation: number;
  update: (key: string, change: (record: AnswerRecord) => AnswerRecord) => void;
  clear: () => void;
}

/**
 * The person's drafts, answers and dismissals in the question view, per
 * question, in memory only: never persisted, never logged. One per view, like the image
 * review record, and cleared once Decisions is turned off.
 */
export const useDecisionsAnswerStore = create<DecisionsAnswerState>()((set) => ({
  records: {},
  generation: 0,
  update: (key, change) =>
    set((state) => {
      const current = state.records[key] ?? EMPTY;
      const next = change(current);
      if (next === current) return state;
      const rest = Object.entries(state.records).filter(([other]) => other !== key);
      // Oldest first, so the ones let go past the cap are those touched longest ago.
      let excess = rest.length + 1 - MAX_RECORDS;
      const kept = rest.filter(([, record]) => {
        if (excess <= 0 || isInFlight(record) || isDeclineInFlight(record)) return true;
        excess -= 1;
        return false;
      });
      return { records: Object.fromEntries([...kept, [key, next]]) };
    }),
  clear: () => set((state) => ({ records: {}, generation: state.generation + 1 })),
}));

export function useAnswerRecord(key: string): AnswerRecord {
  return useDecisionsAnswerStore((state) => state.records[key] ?? EMPTY);
}

export function readAnswerRecord(key: string): AnswerRecord {
  return useDecisionsAnswerStore.getState().records[key] ?? EMPTY;
}
