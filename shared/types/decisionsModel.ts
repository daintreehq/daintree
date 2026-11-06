import type { DecisionsModelAdapter } from "./decisions.js";

/**
 * One confidence band of an evaluation (#16027): the past answers the model
 * answered with a confidence in it, and how many matched the person's own.
 * The confidence is the model's own estimate, not a calibrated probability.
 */
export interface DecisionsModelBucket {
  /** Inclusive. */
  lo: number;
  /** Exclusive, except the last band's, which holds 1. */
  hi: number;
  answered: number;
  matched: number;
}

/**
 * The model package's replay of the person's history through one CLI, as
 * counts: each past question predicted from only the answers given before it
 * was asked. It names no question.
 */
export interface DecisionsModelReport {
  /** Past answers the replay read. */
  total: number;
  /** Those with a choice among offered options, which can be compared with what the person chose. */
  scored: number;
  /** Of those, the ones the model gave an answer for. */
  answered: number;
  /** Of those, the ones that matched the person's own answer. */
  matched: number;
  /** Scored answers the model gave no answer for. */
  abstained: number;
  /** By confidence band, lowest first. */
  buckets: DecisionsModelBucket[];
  /** Why the model gave no answer, by the library's reason code. */
  abstainReasons: Record<string, number>;
  /** By the library's question kind (`choice`, `approval`, …). */
  byKind: Record<string, { answered: number; matched: number }>;
  /** The share of answers at or above a threshold that must match for it to be recommended. */
  targetAccuracy: number;
  /** The answers at or above a threshold needed for it to be recommended. */
  minSamples: number;
  /** The lowest band floor that met both, as the library found; null when none did. */
  recommendedThreshold: number | null;
}

/** A confidence the model may answer automatically from, with the replay's evidence for it. */
export interface DecisionsModelThreshold {
  threshold: number;
  /** Replayed answers at or above it, and how many of them matched the person's. */
  answered: number;
  matched: number;
}

export interface DecisionsModelEvaluation {
  /** The CLI the replay ran. */
  adapter: DecisionsModelAdapter;
  /** Epoch ms; names this evaluation when choosing a threshold for it. */
  evaluatedAt: number;
  report: DecisionsModelReport;
  /** The confidence chosen after reading this report; null until one is. */
  autoAnswerThreshold: number | null;
  /** The thresholds the library honours against this report, lowest first: only these can be chosen. */
  thresholds: DecisionsModelThreshold[];
}

/** An evaluation running now. It goes on when Settings closes. */
export interface DecisionsModelRun {
  runId: string;
  adapter: DecisionsModelAdapter;
  /** Epoch ms. */
  startedAt: number;
  /** Answers in the history when it started. */
  historyCount: number;
}

/** How the latest evaluation that didn't produce a report ended. */
export interface DecisionsModelRunEnd {
  runId: string;
  result: "cancelled" | "failed";
}

/**
 * The model's history as observed: open with the answers it holds, closed
 * because learning is off (with whether a history file is still stored), or
 * not open although learning is on (Decisions' store isn't open, or the
 * history couldn't be opened).
 */
export type DecisionsModelHistory =
  | { state: "open"; count: number }
  | { state: "closed"; stored: boolean }
  | { state: "unavailable" };

/** Settings → Decisions → Decision model (#16027). Read only while Decisions is on. */
export interface DecisionsModelState {
  /** Rises with every change; the higher of two reads is the newer. */
  revision: number;
  learning: boolean;
  adapter: DecisionsModelAdapter | null;
  /** When the person agreed to what learning keeps and sends; absent until then. */
  consentedAt?: number;
  history: DecisionsModelHistory;
  /** The chosen CLI's latest evaluation; null while learning is off, no CLI is chosen, or none is stored. */
  evaluation: DecisionsModelEvaluation | null;
  running: DecisionsModelRun | null;
  lastRun: DecisionsModelRunEnd | null;
  /** The confidence the model answers automatically from now; null while it answers nothing. */
  answeringFrom: number | null;
}

export interface SetDecisionsModelPayload {
  learning: boolean;
  adapter: DecisionsModelAdapter | null;
  /** The person agreed, just now, to what learning keeps and sends. */
  consent?: boolean;
}

export interface SetDecisionsModelThresholdPayload {
  /** Null stops automatic answers. */
  threshold: number | null;
  /** The evaluation it was chosen from, so a choice made on an older report is refused. */
  evaluatedAt: number;
}

export interface CancelDecisionsModelEvaluationPayload {
  runId: string;
}
