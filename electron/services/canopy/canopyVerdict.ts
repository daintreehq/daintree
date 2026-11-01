import type { FleetRunRow, RunCanopyRefinement } from "../../../shared/types/ipc/fleet.js";
import {
  CANOPY_ATTENTION_THRESHOLD,
  CANOPY_URGENT_PRIORITY,
  type CanopyCard,
  type CanopyCategory,
} from "../../../shared/types/ipc/canopy.js";
import { isAskableStop } from "../../../shared/utils/canopyRefinement.js";
import type { ClassifierResult } from "./canopyProviders.js";
import { isUnread, type ReadTrack } from "./canopyReads.js";
import { promptKey } from "./canopyScreen.js";

/**
 * What the classifier's newest reading quoted that is really on the screen
 * it read, and the turn that reading speaks for.
 */
export interface CanopyEvidence {
  turn: number;
  /** The screen it was read from (`contentHash`) and what Daintree observed then (`observedKey`). */
  hash: string | null;
  state: string;
  question: string | null;
  status: string | null;
}

/** What `refinementOf` reads of a run's entry: its latest reading and what the user has seen. */
export interface RefinementInput {
  readonly card: Pick<CanopyCard, "activity" | "glance"> | null;
  readonly cleared: boolean;
  readonly classified: ClassifierResult | null;
  readonly evidence: Readonly<CanopyEvidence> | null;
  readonly contentHash: string | null;
  readonly reads: Readonly<ReadTrack>;
  readonly pending: boolean;
  readonly readState: string;
  readonly readAt: number;
}

/** What `returnsToInbox` reads of how the user put a run aside. */
export interface InboxDisposition {
  readonly contentHash: string | null;
  readonly question: string | null;
  readonly sawWork: boolean;
}

/**
 * The priority each reading gives before its words are set: the words' own
 * anchors for the same situations, so a run keeps its place when they land.
 * The verdict alone can't tell a finished turn with loose ends (55) from a
 * clean one (40), so it sits between them.
 */
export const CANOPY_CLASSIFIER_ANCHORS = {
  approval: 92,
  question: 86,
  stuck: 70,
  error: 70,
  finished: 50,
  notable: 30,
  idle: 20,
  busy: 5,
} as const;
/**
 * How an ask's priority follows the classifier's probability that the agent
 * is blocked on a person: the finished anchor at `from` or below, the ask's
 * own anchor at `to` or above, and a straight line between. Measured on the
 * gold set, real approvals and questions read 0.91–0.98 and finished turns
 * 0.30 at most, so only a confident ask reaches the urgent band.
 */
export const CANOPY_BLOCKED_SCALE = { from: 0.5, to: 0.9 } as const;
/** Below this category confidence the classifier's approval or question is not taken as one. */
const ASK_CONFIDENCE = 0.5;
/** A busy run the classifier gives at least this attention probability is read as stuck. */
const STUCK_ATTENTION = 0.8;
/** A busy run the classifier gives at least this notable probability is worth a look. */
const NOTABLE_PROBABILITY = 0.5;

/**
 * Whether a run the user put aside has something new to say, the way a new
 * reply brings a thread back into a mail inbox. Its screen must have changed
 * and now need the user — and either the agent worked in between (so this is
 * a new stop, not the one the user saw), or it is asking a different question.
 * A screen that only scrolled, an echoed reply, or the same prompt still
 * drawn never brings it back.
 */
export function returnsToInbox(
  disposition: InboxDisposition,
  contentHash: string,
  question: string | null
): boolean {
  if (contentHash === disposition.contentHash) return false;
  if (disposition.sawWork) return true;
  return question !== null && promptKey(question) !== disposition.question;
}

export function busyCategory(category: CanopyCategory | null): boolean {
  return category === "working" || category === "running";
}

/**
 * What a reading made of a screen, as far as its words go: its state, whether
 * it needs the user, and whether a busy run looks stuck. Not the finer score:
 * on a screen that has not moved, how notable it reads drifts as it ages, and
 * that is no reason to write its words again.
 */
export function verdictOf(classified: ClassifierResult, run: FleetRunRow): string {
  const stuck = busyCategory(classified.category) && classified.attention >= STUCK_ATTENTION;
  return `${classified.category}:${needsAttention(classified.attention)}:${stuck}:${blockedOn(classified, run) !== null}`;
}

/** What Daintree observes of a run, as far as reading it goes: its state and why it waits. */
export function observedKey(run: FleetRunRow): string {
  return `${run.agentState ?? ""}:${run.waitingReason ?? ""}`;
}

/** An `observedKey` taken while the run was at work. */
const BUSY_READ_STATE = /^(working|directing):/;

/**
 * What a run's reading refines of where it lands, or null when it refines
 * nothing. The classifier's category is the verdict and its verbatim words the
 * evidence; no score or priority places a run, so a finished turn with loose
 * ends — which can score high — stays where the free rules put it.
 */
export function refinementOf(
  entry: RefinementInput,
  run: FleetRunRow,
  stalledSince: number | null,
  now: number
): RunCanopyRefinement | null {
  if (run.agentState === undefined) return null;
  if (isBusy(run)) {
    const quote = (entry.card?.activity ?? entry.card?.glance.doing ?? "").trim();
    if (stalledSince === null || entry.cleared || !quote) return null;
    return { kind: "stalled", quote, readAt: now, stalledSince };
  }
  const classified = entry.classified;
  const evidence = entry.evidence;
  // Only a reading of this turn speaks for it: one kept through a failed read
  // is about the stop before, and a pass under way is about a newer screen.
  // A reading that landed while the turn was still being held speaks for the
  // turn it then became, as long as the screen and the observed state are the
  // ones it read: an unchanged screen is never sent to be read again.
  const sameRead =
    evidence !== null && evidence.hash === entry.contentHash && evidence.state === observedKey(run);
  if (classified === null || evidence === null) return null;
  if (evidence.turn !== entry.reads.turn && !sameRead) return null;
  if (entry.pending || classified.confidence < ASK_CONFIDENCE) return null;
  if (!isAskableStop(run.agentState, run.waitingReason)) return null;
  const seen = !isUnread(entry.reads);
  if (classified.category === "question" || classified.category === "approval") {
    // Read while stopped: a reading of the run at work says nothing of what it
    // stopped on. Whatever wait the patterns named, the reading is the ask.
    if (BUSY_READ_STATE.test(entry.readState)) return null;
    const quote = evidence.question?.trim();
    return quote ? { kind: "asked", quote, readAt: entry.readAt, seen } : null;
  }
  if (run.agentState === "waiting" && run.waitingReason === "question") {
    // Only a reading of this very wait can say it asks nothing.
    if (entry.readState !== observedKey(run)) return null;
    if (classified.category !== "finished" && classified.category !== "idle") return null;
    if (classified.question !== null && classified.question.trim() !== "") return null;
    const quote = (evidence.status ?? entry.card?.activity ?? "").trim();
    return quote ? { kind: "not-asking", quote, readAt: entry.readAt, seen } : null;
  }
  return null;
}

export function isBusy(run: FleetRunRow): boolean {
  return run.agentState === "working" || run.agentState === "directing";
}

/**
 * The priority of an approval or a question the classifier read, scaled by
 * how sure it is the agent is blocked on a person; null for any other
 * reading. Daintree's own state seeing the same approval counts as sure.
 */
function askScore(classified: ClassifierResult, run: FleetRunRow): number | null {
  const category = classified.category;
  if (category !== "approval" && category !== "question") return null;
  if (!needsAttention(classified.attention) || classified.confidence < ASK_CONFIDENCE) return null;
  const blocked =
    category === "approval" && run.waitingReason === "approval"
      ? Math.max(classified.blocked, CANOPY_BLOCKED_SCALE.to)
      : classified.blocked;
  const { from, to } = CANOPY_BLOCKED_SCALE;
  const scale = Math.min(1, Math.max(0, (blocked - from) / (to - from)));
  const low = CANOPY_CLASSIFIER_ANCHORS.finished;
  return Math.round(low + (CANOPY_CLASSIFIER_ANCHORS[category] - low) * scale);
}

/**
 * Whether what the classifier concluded from a screen holds whatever Daintree
 * observes of the run: everything but an approval it was unsure blocks the
 * agent, which `askScore` raises once Daintree sees the agent waiting on one.
 */
export function readingIgnoresState(classified: ClassifierResult): boolean {
  return classified.category !== "approval" || classified.blocked >= CANOPY_BLOCKED_SCALE.to;
}

/** What the agent is blocked on, when the classifier's reading of it is urgent; null otherwise. */
export function blockedOn(
  classified: ClassifierResult,
  run: FleetRunRow
): "approval" | "question" | null {
  const score = askScore(classified, run);
  if (score === null || score < CANOPY_URGENT_PRIORITY) return null;
  return classified.category as "approval" | "question";
}

/**
 * A run's priority from the classifier alone: fixed by what it read and how
 * sure it is, so the same reading always ranks the same.
 */
export function classifierPriority(classified: ClassifierResult, run: FleetRunRow): number {
  const anchors = CANOPY_CLASSIFIER_ANCHORS;
  const ask = askScore(classified, run);
  if (ask !== null) return ask;
  const needs = needsAttention(classified.attention);
  switch (classified.category) {
    case "approval":
    case "question":
    case "finished":
      return needs ? anchors.finished : anchors.idle;
    case "error":
      return needs ? anchors.error : anchors.finished;
    case "idle":
      return anchors.idle;
    case "working":
    case "running":
      if (classified.attention >= STUCK_ATTENTION) return anchors.stuck;
      return (classified.notable ?? 0) >= NOTABLE_PROBABILITY ? anchors.notable : anchors.busy;
  }
}

/**
 * The lowest priority a described run can have: an urgent ask the reading saw
 * keeps its place whatever score its words carry, and that score stands above it.
 */
function askFloor(classified: ClassifierResult, run: FleetRunRow): number {
  return blockedOn(classified, run) === null ? 0 : (askScore(classified, run) ?? 0);
}

/**
 * The lowest a described run ranks, by what the reading saw: an ask keeps its
 * place, and a busy agent showing something notable keeps the notable band,
 * whatever lower score its words carry.
 */
export function readingFloor(classified: ClassifierResult, run: FleetRunRow): number {
  const busy = classified.category === "working" || classified.category === "running";
  const notable =
    busy && (classified.notable ?? 0) >= NOTABLE_PROBABILITY
      ? CANOPY_CLASSIFIER_ANCHORS.notable
      : 0;
  return Math.max(askFloor(classified, run), notable);
}

export function needsAttention(probability: number): boolean {
  return probability >= CANOPY_ATTENTION_THRESHOLD;
}
