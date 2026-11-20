import { create } from "zustand";
import type {
  DecisionFollowUpOutcome,
  SendDecisionFollowUpPayload,
} from "@shared/types/decisionsQuestion";
import type { DecisionQuestionTarget } from "@/components/Decisions/decisionQuestionTarget";

/**
 * Where a person's follow-up from this view stands (#17238), as an answer's
 * does (`decisionsAnswerStore`):
 * - `sending`: handed to main, no reply yet;
 * - `checking`: the reply was lost, so its standing is being read by its id;
 * - `settled`: main replied with the library's outcome (`queued` keeps being read);
 * - `lost`: neither the reply nor its standing could be read; Retry reads it again;
 * - `refused`: nothing was signed, for the reason given.
 */
export type FollowUpPhase =
  | { kind: "sending" }
  | { kind: "checking" }
  | { kind: "settled"; outcome: DecisionFollowUpOutcome }
  | { kind: "lost" }
  | { kind: "refused"; reason: FollowUpRefusal };

export type FollowUpRefusal = "not-found" | "not-owner" | "invalid" | "off";

export interface FollowUpSubmission {
  messageId: string;
  /** Exactly what was signed, so a retry is the same message under the same id. */
  payload: SendDecisionFollowUpPayload;
  /** How the question was read, to read it again before a message never committed goes again. */
  target: DecisionQuestionTarget;
  phase: FollowUpPhase;
  /** It was sent again on its own once already; after that only Retry sends it again, under the same id. */
  resubmitted: boolean;
  /**
   * The agent's request for a reply this declines (#18030), by its message
   * id: sent only while the question still has that request outstanding.
   * Null for the person's own words.
   */
  declines: string | null;
}

/**
 * Why the last Send ended with nothing sent: the question's last read found
 * it closed, or it couldn't be read, or the reply request a decline was for
 * had been answered or replaced (#18030).
 */
export type FollowUpHold = "closed" | "unreadable" | "not-running" | "failed" | "request-moved";

export interface FollowUpRecord {
  /** What the person is writing; emptied once a message is taken. */
  draft: string;
  /** The latest message sent from here, until the next one replaces it. */
  submission: FollowUpSubmission | null;
  /** A Send is reading the question again before it signs. */
  preparing: boolean;
  hold: FollowUpHold | null;
}

/** Questions whose record is kept; past it, the oldest with nothing in flight goes first. */
const MAX_RECORDS = 64;

const EMPTY: FollowUpRecord = Object.freeze({
  draft: "",
  submission: null,
  preparing: false,
  hold: null,
});

/** A follow-up whose fate isn't known yet: never let go, or its id would be forgotten. */
export function isFollowUpInFlight(record: FollowUpRecord): boolean {
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

interface DecisionsFollowUpState {
  records: Readonly<Record<string, FollowUpRecord>>;
  /** Rises on every clear, so a reply that lands after one changes nothing. */
  generation: number;
  update: (key: string, change: (record: FollowUpRecord) => FollowUpRecord) => void;
  clear: () => void;
}

/**
 * The person's follow-up drafts and messages in the question view, per
 * question (keyed as answers are, by `answerKey`), in memory only: never
 * persisted, never logged, and cleared once Decisions is turned off.
 */
export const useDecisionsFollowUpStore = create<DecisionsFollowUpState>()((set) => ({
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
        if (excess <= 0 || isFollowUpInFlight(record)) return true;
        excess -= 1;
        return false;
      });
      return { records: Object.fromEntries([...kept, [key, next]]) };
    }),
  clear: () => set((state) => ({ records: {}, generation: state.generation + 1 })),
}));

export function useFollowUpRecord(key: string): FollowUpRecord {
  return useDecisionsFollowUpStore((state) => state.records[key] ?? EMPTY);
}

export function readFollowUpRecord(key: string): FollowUpRecord {
  return useDecisionsFollowUpStore.getState().records[key] ?? EMPTY;
}
