/**
 * What the canopy panel sends to be read, what comes back, and what is done
 * with the answers. Screens are read by Canopy's own service
 * (`canopyBackend.ts`); every card it writes goes through the checks here
 * before it reaches a row.
 */
import {
  CANOPY_CATEGORIES,
  type CanopyCategory,
  type CanopyChanges,
  type CanopyTests,
} from "../../../shared/types/ipc/canopy.js";
import type { CanopyDigest } from "./canopyDigest.js";

export class CanopyProviderError extends Error {
  constructor(
    readonly provider: "classifier" | "describer",
    message: string,
    /**
     * Worth trying again shortly rather than reporting: a rate limit, a worker
     * still starting, a timeout or a dropped connection.
     */
    readonly transient = false
  ) {
    super(message);
    this.name = "CanopyProviderError";
  }
}

export interface CanopyScreenInput {
  /** Which run this is, for main's own bookkeeping; never sent to the service. */
  runId?: string;
  agent: string;
  title: string;
  screen: string;
  /** Rows of `screen`, for the question-line choice. */
  lines: readonly string[];
  /** What Daintree's own state tracking saw, offered as a tie-breaker. */
  observed: CanopyObservedState;
  /** The user's last action on this run from the panel, if any. */
  userAction?: CanopyUserAction | null;
  /** For a working run, what the describer wrote about it last time. */
  previousReading?: CanopyPreviousReading | null;
  /** What the history above the screen says: the user's requests, the agent's plan. */
  digest?: CanopyDigest | null;
  /** The title already given to this run's task, kept unless the user set a new one. */
  currentTask?: string | null;
  /** The describer's own notes on this run from its last reading; never shown to the user. */
  note?: CanopyNote | null;
  /** The output that scrolled out of view since the describer's last reading, oldest first. */
  sinceLastReading?: string | null;
  /**
   * The failure count the last reading gave, when the screen has not changed
   * since: an unchanged screen shows no new run, so the count cannot rise.
   */
  failureRepeatsCap?: number | null;
}

/**
 * The describer's working memory for one terminal: written by it on every
 * reading and handed back on the next, so what scrolled off the screen — the
 * user's goal, decisions, milestones, a failure that keeps coming back — is
 * still known. Hidden from the user; it shapes the card, it is not part of it.
 */
export interface CanopyNote {
  text: string;
  /** How long ago it was written. */
  secondsAgo: number;
}

/**
 * An explicit instruction from the user against what the agent did or asks to
 * do: asking leave for it, still breaking it, broken and undoable, or broken
 * for good.
 */
export const CANOPY_INSTRUCTION_STATES = [
  "none",
  "asked",
  "ongoing",
  "done",
  "irreversible",
] as const;
export type CanopyInstructionState = (typeof CANOPY_INSTRUCTION_STATES)[number];

/** Longest note kept, in characters; a longer one is cut at a line. */
export const CANOPY_NOTE_MAX_CHARS = 700;

/** The describer's last words about a run, offered so its next ones say what moved. */
export interface CanopyPreviousReading {
  category: CanopyCategory;
  task: string | null;
  headline: string | null;
  summary: string | null;
  /** How long ago those words were written. */
  secondsAgo: number;
}

export interface CanopyUserAction {
  kind: "archived" | "replied";
  secondsAgo: number;
  /** The screen's text has changed since the action. */
  screenChangedSince: boolean;
}

export interface CanopyObservedState {
  agentState: string | null;
  waitingReason: string | null;
  secondsInState: number | null;
  /**
   * How long nothing on the screen has moved except ticking timers and
   * spinners; absent while it moved within the last minute.
   */
  screenUnchangedSeconds?: number;
}

export interface ClassifierResult {
  category: CanopyCategory;
  confidence: number;
  /** Probability, 0–1, that the terminal needs the user to act now. */
  attention: number;
  /**
   * Probability, 0–1, that the program is stopped on a decision only a person
   * can make — an approval, a question, a choice — rather than just done. What
   * an ask's priority is scaled by.
   */
  blocked: number;
  /** The row the classifier picked as the prompt being asked, verbatim. */
  question: string | null;
  /**
   * The line the classifier picked as saying most about the run at a glance —
   * the ask, the step, the agent's report or the error — verbatim; null when
   * it picked none. Shown on the row until the describer has written its words.
   */
  status?: string | null;
  /**
   * Probability, 0–1, that the screen shows something the user would want to
   * read or answer: anything that needs them, or a busy agent saying something
   * worth a look while it works. 0 when absent.
   */
  notable?: number;
}

export interface DescriberResult {
  category: CanopyCategory;
  task: string | null;
  headline: string;
  summary: string;
  question: string | null;
  options: string[];
  /** 0–100: how much the terminal needs the user right now. */
  attentionScore: number;
  risk: "none" | "caution" | "unknown";
  riskReason: string | null;
  /** What an approval would let the agent do, verbatim: the command, file or tool. */
  action: string | null;
  /** 0–100, how much of the user's task is done; null when nothing shows it. */
  progress: number | null;
  tests: CanopyTests;
  changes: CanopyChanges;
  /** The describer's notes for its next reading of this run; absent or null when it wrote none. */
  note?: string | null;
  /** How many runs in a row the same failure has come back, as the note counts them; 0 when none. */
  failureRepeats?: number;
  /** An explicit instruction from the user against what the agent did or asks to do. */
  instruction?: CanopyInstructionState;
}

/** The card as a model writes it: snake_case, every field loose until checked. */
export type RawCanopyCard = Partial<
  Omit<
    DescriberResult,
    | "attentionScore"
    | "task"
    | "risk"
    | "riskReason"
    | "progress"
    | "tests"
    | "changes"
    | "action"
    | "note"
    | "failureRepeats"
    | "instruction"
  >
> & {
  progress?: unknown;
  action?: unknown;
  tests?: unknown;
  changes?: unknown;
  attention_score?: unknown;
  note?: unknown;
  failure_repeats?: unknown;
  instruction?: unknown;
  task?: unknown;
  risk?: unknown;
  risk_reason?: unknown;
};

/**
 * A card the service wrote, checked and held to the score bands its own facts set.
 */
export function toDescriberResult(card: unknown, input: CanopyScreenInput): DescriberResult {
  if (typeof card !== "object" || card === null || Array.isArray(card)) {
    throw new CanopyProviderError("describer", "unexpected response shape");
  }
  const parsed = card as RawCanopyCard;
  if (!CANOPY_CATEGORIES.includes(parsed.category as CanopyCategory)) {
    throw new CanopyProviderError("describer", "unexpected category");
  }
  const failureRepeats = Math.min(
    clampRepeats(parsed.failure_repeats),
    input.failureRepeatsCap ?? Number.POSITIVE_INFINITY
  );
  const instruction = CANOPY_INSTRUCTION_STATES.includes(
    parsed.instruction as CanopyInstructionState
  )
    ? (parsed.instruction as CanopyInstructionState)
    : "none";
  // Asking leave for what the user ruled out makes the approval a risky one.
  const risk = parsed.category === "approval" && instruction === "asked" ? "caution" : parsed.risk;
  return {
    category: parsed.category as CanopyCategory,
    headline: clip(parsed.headline, 120),
    summary: clip(parsed.summary, 300),
    question: present(parsed.question) ? parsed.question : null,
    options: Array.isArray(parsed.options)
      ? parsed.options
          .filter((o): o is string => typeof o === "string" && o.trim() !== "")
          .slice(0, 9)
      : [],
    attentionScore: reconcileScore(
      clampScore(parsed.attention_score),
      parsed.category as CanopyCategory,
      risk,
      parsed.changes,
      parsed.tests,
      clampProgress(parsed.progress),
      failureRepeats,
      input.observed.secondsInState,
      instruction
    ),
    failureRepeats,
    instruction,
    task: present(parsed.task) ? clip(parsed.task, 80) : null,
    progress: clampProgress(parsed.progress),
    action: present(parsed.action) ? clip(parsed.action.split("\n")[0], 160) : null,
    tests: TESTS.includes(parsed.tests as CanopyTests) ? (parsed.tests as CanopyTests) : "unknown",
    changes: CHANGES.includes(parsed.changes as CanopyChanges)
      ? (parsed.changes as CanopyChanges)
      : "unknown",
    note: present(parsed.note) ? clipNote(parsed.note) : null,
    risk: risk === "caution" || risk === "none" ? risk : ("unknown" as const),
    riskReason:
      risk === "caution" && typeof parsed.risk_reason === "string" && parsed.risk_reason.trim()
        ? clip(parsed.risk_reason, 80)
        : null,
  };
}

/**
 * A card's words as they stream. No score: the card's score is held to facts
 * that arrive after it (risk, changes, tests, progress), so one taken early
 * moves once they land, and the run would jump in the list.
 */
export interface CanopyPartialDescription {
  category?: CanopyCategory;
  headline?: string;
  summary?: string;
}

export function toPartialDescription(card: RawCanopyCard): CanopyPartialDescription {
  const partial: CanopyPartialDescription = {};
  if (!CANOPY_CATEGORIES.includes(card.category as CanopyCategory)) return partial;
  const category = card.category as CanopyCategory;
  partial.category = category;
  if (present(card.headline)) partial.headline = clip(card.headline, 120);
  if (present(card.summary)) partial.summary = clip(card.summary, 300);
  return partial;
}

const TESTS: readonly CanopyTests[] = ["passing", "failing", "not_run", "unknown"];
const CHANGES: readonly CanopyChanges[] = ["uncommitted", "committed", "pushed", "none", "unknown"];

function clampProgress(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const progress = Number(value);
  return Number.isFinite(progress) ? Math.round(Math.min(100, Math.max(0, progress))) : null;
}

/**
 * The score bands that follow from the card's own facts, held whatever number
 * the model picked: the same situation must always rank the same, and these
 * are the cases a model slips on — a finished turn that left work uncommitted,
 * failing or undone scored as cleanly done, a risky approval scored as routine.
 */
export function reconcileScore(
  score: number,
  category: CanopyCategory,
  risk: unknown,
  changes: unknown,
  tests: unknown,
  progress: number | null,
  failureRepeats = 0,
  secondsInState: number | null = null,
  instruction: CanopyInstructionState = "none"
): number {
  if (category === "approval" && risk === "caution") return Math.max(score, 98);
  // A broken instruction ranks by whether harm is still being done; all stay
  // under the permission prompts, since the reading behind them is a model's.
  if (instruction !== "none" && instruction !== "asked") {
    score = Math.max(score, BROKEN_INSTRUCTION_SCORE[instruction]);
  }
  // A question blocks the agent on the user: no other reason pulls it lower.
  if (category === "question") return Math.max(score, QUESTION_SCORE);
  // Busy, but going round in circles: the spinner says working, the note says
  // the same failure has come back run after run.
  if (busyCategoryOf(category) && failureRepeats >= STUCK_REPEATS) return Math.max(score, 70);
  if (category === "finished") {
    const looseEnds =
      changes === "uncommitted" || tests === "failing" || (progress !== null && progress < 100);
    if (looseEnds) return Math.max(score, 55);
    // 20 is for a finished turn nobody has needed for half an hour; a fresh
    // one, done and clean, is still something to look at.
    if (secondsInState !== null && secondsInState < SETTLED_FINISHED_SECONDS) {
      return Math.max(score, 40);
    }
  }
  return score;
}

/** Where a broken instruction ranks: harm still being done or not undoable, above a question; done and undoable, above an error-free finish. */
const BROKEN_INSTRUCTION_SCORE = { ongoing: 75, done: 65, irreversible: 88 } as const;

/** The question anchor. */
const QUESTION_SCORE = 86;

/** A finished turn left alone this long has settled: its anchor drops from 40 to 20. */
const SETTLED_FINISHED_SECONDS = 1800;

/** Runs of one failure, in a row, after which a busy agent counts as stuck. */
export const STUCK_REPEATS = 3;

function busyCategoryOf(category: CanopyCategory): boolean {
  return category === "working" || category === "running";
}

function clampRepeats(value: unknown): number {
  const repeats = Number(value);
  return Number.isFinite(repeats) ? Math.round(Math.min(99, Math.max(0, repeats))) : 0;
}

/** A string with something in it — not blank, and not a null the model spelt out. */
function present(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  return text !== "" && text !== "null" && text !== "none" && text !== "n/a";
}

function clampScore(value: unknown): number {
  const score = Number(value);
  return Number.isFinite(score) ? Math.round(Math.min(100, Math.max(0, score))) : 0;
}

/**
 * The order the panel lists runs in. A described run takes the describer's
 * score: the classifier's probability already decided it was worth describing,
 * and it sits near 1 for nearly every waiting run, so averaging it in only
 * squeezed every score into the same band. A run that was only classified has
 * only the classifier's word for it.
 */
export function combinePriority(attention: number, attentionScore: number | null): number {
  return Math.round(attentionScore === null ? attention * 100 : attentionScore);
}

/** A note within `CANOPY_NOTE_MAX_CHARS`, cut at the last whole line that fits. */
function clipNote(note: string): string {
  const text = note.trim();
  if (text.length <= CANOPY_NOTE_MAX_CHARS) return text;
  const cut = text.slice(0, CANOPY_NOTE_MAX_CHARS);
  const line = cut.lastIndexOf("\n");
  return line > 0 ? cut.slice(0, line) : cut;
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
