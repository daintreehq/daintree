import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { observedCanopyKind, observedCaughtUp } from "@shared/utils/canopyObservedKind";
import {
  CANOPY_ATTENTION_CATEGORIES,
  CANOPY_NEEDS_YOU_PRIORITY,
  type CanopyCard,
  type CanopyCategory,
  type CanopyDisposition,
  type CanopyGlance,
  type CanopyReadMark,
  type CanopyRunGlance,
  type CanopySeen,
  isCanopyUnread,
} from "@shared/types/ipc/canopy";
import type { PilotProjectGroup, PilotRow } from "@/components/Pilot/pilotRows";
import { getTerminalTaskTitle } from "@/utils/terminalTitleDisplay";

export interface CanopyItem {
  runId: string;
  workspaceId: string;
  row: PilotRow;
  workspace: Pick<PilotProjectGroup, "name" | "emoji" | "color" | "kind" | "isCurrent">;
  /** What the card is drawn as. The classifier's reading once it has one. */
  kind: CanopyCategory;
  /** The classifier's card, when it still describes the run's current state. */
  card: CanopyCard | null;
  /**
   * What the run's screen says at a glance, read with no model: the card's,
   * or — before the classifier has read the run — the screen read's own.
   */
  glance: CanopyGlance | null;
  /** Words for the card are on their way: its first read, a describe, or a re-read. */
  pending: boolean;
  /**
   * The run's state moved after its card was read. Its words may still show,
   * but nothing that acts on a prompt is offered until it is read again.
   */
  stale: boolean;
  /** The last read of this run failed; anything shown is from before it. */
  failed: boolean;
  /**
   * The user archived or replied to it from the panel, and the agent has said
   * nothing new since; null while it is in the inbox.
   */
  disposition: CanopyDisposition | null;
  /**
   * When the user last had this terminal in front of them — in its own pane or
   * open here — for this incarnation; null when not since Daintree started.
   */
  seenAt: number | null;
  /** What the user has read of what the run did, for this incarnation; null when nothing is known. */
  readMark: CanopyReadMark | null;
  /**
   * The run did something since the user last looked — stopped, started on
   * its own, asked something new — or they marked it unread. Never on a run
   * put aside: whatever brings it back is what is new.
   */
  unread: boolean;
}

/** Worst first: a menu blocks a turn outright, a finished run only waits. */
const KIND_RANK: Record<CanopyCategory, number> = {
  approval: 0,
  question: 1,
  error: 2,
  finished: 3,
  working: 4,
  running: 5,
  idle: 6,
};

/**
 * The run's kind from Daintree's own state tracking, used until the classifier
 * has read the screen — so the panel lays out at once instead of waiting.
 */
export function observedKind(run: FleetRunRow): CanopyCategory {
  return observedCanopyKind(run);
}

/**
 * A card read from a screen older than the run's latest state change no longer
 * describes it. Its words stay until the fresh read replaces them — a row never
 * blanks between readings — but never its prompt: an old question or menu
 * beside a new one would invite answering the wrong thing. When the observed
 * state no longer matches the card's kind, the run is placed and ranked by what
 * Daintree observed until it is read again.
 */
const STALE_GRACE_MS = 1_000;

function currentCard(
  run: FleetRunRow,
  card: CanopyCard | undefined
): { card: CanopyCard | null; stale: boolean } {
  if (!card) return { card: null, stale: false };
  // Read from a terminal that has since been respawned under the same id.
  if (card.spawnedAt !== run.spawnedAt) return { card: null, stale: false };
  if (run.since !== undefined && run.since > card.observedAt + STALE_GRACE_MS) {
    // Daintree's own eye only caught up with what the reading saw: the card
    // still holds, and its facts and choices stay where they are. A state the
    // reading already saw, reached again, is a new episode.
    const then = card.observedWhenRead;
    if (then !== undefined && observedCaughtUp(card.category, then, run, card.observedAt)) {
      return { card, stale: false };
    }
    const moved = observedKind(run) !== card.category;
    return {
      card: {
        ...card,
        question: null,
        options: [],
        ...(moved
          ? {
              category: observedKind(run),
              attentionProbability: CANOPY_ATTENTION_CATEGORIES.has(observedKind(run)) ? 1 : 0,
              priorityFromEarlierRead: true,
            }
          : {}),
      },
      stale: true,
    };
  }
  return { card, stale: false };
}

/** Whether a missing card is still coming: never after a failed read. */
export interface CanopyReadState {
  failed: boolean;
  /** Runs whose own last read failed. */
  failedRuns?: ReadonlySet<string>;
}

const READING: CanopyReadState = { failed: false };

/**
 * Where a permission prompt sits at the lowest: Daintree saw the agent stop on
 * an approval dialog, which outranks anything a reading can say about another
 * run. The one keypress the user keeps missing.
 */
export const PERMISSION_FLOOR = 92;

/** Daintree itself sees the agent stopped on an approval dialog, and nobody has answered it. */
export function itemAwaitsPermission(item: CanopyItem): boolean {
  const run = item.row.run;
  return (
    run.agentState === "waiting" &&
    run.waitingReason === "approval" &&
    !itemHandled(item) &&
    !itemArchived(item)
  );
}

/**
 * Where a run sits before either model has read it, on the same 0–100 scale as
 * a card's priority: what Daintree itself saw, ranked by how blocked it is.
 */
const OBSERVED_PRIORITY: Record<CanopyCategory, number> = {
  approval: PERMISSION_FLOOR,
  question: 80,
  error: 60,
  finished: 45,
  idle: 15,
  working: 10,
  running: 10,
};

/** A run the user checks on rather than answers: busy, by the reading or by Daintree's own eye. */
export function itemIsBusy(item: CanopyItem): boolean {
  if (item.kind === "working" || item.kind === "running") return true;
  // Before a read lands, Daintree's own state places it.
  if (item.card !== null && !item.card.priorityFromEarlierRead) return false;
  const state = item.row.run.agentState;
  return state === "working" || state === "directing";
}

/**
 * A busy agent's claim on the user grows the longer it goes unlooked-at: from
 * the floor of a run working normally, fifteen points every five minutes, to a
 * ceiling that passes routine finished work (25–44) but never anything waiting
 * on a decision. In steps rather than a point at a time, so the number beside
 * it doesn't tick up while the user reads. Going quiet while working is
 * Daintree's own stall observation, and ranks it above anything finished.
 */
export const CHECK_IN_FLOOR = 10;
export const CHECK_IN_CEILING = 55;
const CHECK_IN_STEP = 15;
const CHECK_IN_STEP_MINUTES = 5;
export const QUIET_PRIORITY = 60;
/** Below this long unseen, a busy row doesn't say so: it is not why it ranks where it does. */
export const UNSEEN_SHOWN_AFTER_MS = 5 * 60_000;

/** How long a busy run has gone without the user looking at it, from its spawn at the latest. */
export function unseenFor(item: CanopyItem, nowMs: number): number {
  const since = Math.max(item.seenAt ?? 0, item.row.run.spawnedAt);
  return Math.max(0, nowMs - since);
}

/**
 * Working, and no visible progress for minutes: Daintree saw no output at all
 * (quiet), or Canopy saw the screen stand still behind a ticking spinner.
 * Stuck or just slow, it is worth a look.
 */
export function itemStalled(item: CanopyItem): boolean {
  if (!itemIsBusy(item)) return false;
  return item.row.run.quietSince !== undefined || item.card?.stalledSince != null;
}

function checkInPriority(item: CanopyItem, nowMs: number): number {
  if (itemStalled(item)) return QUIET_PRIORITY;
  const steps = Math.floor(unseenFor(item, nowMs) / (CHECK_IN_STEP_MINUTES * 60_000));
  return Math.min(CHECK_IN_CEILING, CHECK_IN_FLOOR + steps * CHECK_IN_STEP);
}

/** The readers' priority, or what Daintree observed before a read. */
function readPriority(item: CanopyItem): number {
  const card = item.card;
  if (card === null || card.priorityFromEarlierRead) return OBSERVED_PRIORITY[item.kind];
  return card.priority;
}

/**
 * Where a run sorts, on one 0–100 scale for every run: what it is waiting on
 * the user for, as the readers scored it — and, for a busy one, how long it has
 * gone unlooked-at, since checking on progress is as much the job as answering.
 */
export function itemPriority(item: CanopyItem, nowMs: number): number {
  // Answered from the panel: out of the queue until it has something new, card
  // or no card — before its first read, Daintree's observation alone would
  // otherwise rank it as the prompt the user just answered.
  if (itemHandled(item)) return 0;
  const read = readPriority(item);
  if (itemAwaitsPermission(item)) return Math.max(read, PERMISSION_FLOOR);
  if (!itemIsBusy(item)) return read;
  return Math.max(read, checkInPriority(item, nowMs));
}

/**
 * The priority to show beside a run, or null when nothing stands behind one: a
 * reading of the screen as it is now, or — for a busy run — the time it has gone
 * unseen, which is Daintree's own observation and needs no reading.
 */
export function shownPriority(item: CanopyItem, nowMs: number): number | null {
  // Answered: out of the queue at 0 until it says something new, whatever
  // Daintree sees it doing meanwhile.
  if (itemHandled(item)) return 0;
  const card = item.card;
  // A reading stands until the next replaces it while the run stays the kind
  // it was read as; once Daintree sees it change kind, the number goes.
  const read = card === null || card.priorityFromEarlierRead ? null : card.priority;
  // Daintree's own observation needs no reading behind it.
  if (itemAwaitsPermission(item)) return Math.max(read ?? 0, PERMISSION_FLOOR);
  if (!itemIsBusy(item) || itemHandled(item)) return read;
  return Math.max(read ?? 0, checkInPriority(item, nowMs));
}

/**
 * Why a busy run sits where it does, when it isn't the readers' doing: it has
 * gone a while without the user looking. Null for a run looked at lately, one
 * that isn't busy, and one Daintree already shows as quiet.
 */
export function unseenLabelMs(item: CanopyItem, nowMs: number): number | null {
  if (!itemIsBusy(item) || itemHandled(item) || itemStalled(item)) return null;
  const unseen = unseenFor(item, nowMs);
  return unseen >= UNSEEN_SHOWN_AFTER_MS ? unseen : null;
}

/**
 * The row's name: the one the agent's pane goes by everywhere else in
 * Daintree — a name the user gave it, or the title the agent gave its own
 * task — so the same agent is never called two things. Only a pane that goes
 * by its agent's name alone borrows the readers' title for the user's request,
 * or failing that its worktree's name.
 */
export function itemSubject(item: CanopyItem): string {
  const { row } = item;
  const run = row.run;
  const panelNamesWork =
    run.titleMode === "user" ||
    getTerminalTaskTitle({
      title: run.title ?? row.chrome.label,
      ...(run.titleMode !== undefined ? { titleMode: run.titleMode } : {}),
      ...(run.lastObservedTitle !== undefined ? { lastObservedTitle: run.lastObservedTitle } : {}),
      ...(run.agentId !== undefined ? { detectedAgentId: run.agentId } : {}),
      ...(run.agentState !== undefined ? { agentState: run.agentState } : {}),
      cwd: run.cwd,
    }) !== null;
  if (panelNamesWork) return row.title;
  // A pane named only for its agent says nothing about which one this is; where
  // it runs does, until the readers have titled the work.
  return item.card?.task ?? row.worktreeLabel ?? item.workspace.name ?? row.title;
}

/** How far through the user's task a run is, as the row shows it; null when nothing says. */
export interface ItemProgress {
  /** 0–100. */
  value: number;
  /** "3/4" when counted off the agent's checklist, else "75%". */
  label: string;
  /** Read aloud: "3 of 4 steps done" or "about 75% done". */
  spoken: string;
}

/**
 * The run's progress through its task, while there is a task to be part way
 * through. Not for an idle run, nor for one finished in full — the row says
 * that already — and only once the readers have worded the run.
 */
export function itemProgress(item: CanopyItem): ItemProgress | null {
  const card = item.card;
  if (card === null || card.progress === null || card.stage !== "described") return null;
  if (item.kind === "idle") return null;
  if (item.kind === "finished" && card.progress >= 100) return null;
  // Back at work after a stop: the stop's progress was about the work before,
  // until a reading of the new work replaces it.
  const busy = itemIsBusy(item);
  if (busy && card.progress >= 100) return null;
  const wordsAboutWork = card.wordsCategory === "working" || card.wordsCategory === "running";
  if (busy && card.wordsFromEarlierRead && !wordsAboutWork) return null;
  // Nothing done yet is no news beside a run blocked before it started.
  if (card.progress <= 0) return null;
  // Always a percentage, so a glance down the column compares like with like;
  // a checklist's count is still said, where it is exact.
  const steps = card.steps;
  if (steps !== null && steps.total > 0) {
    return {
      value: card.progress,
      label: `${card.progress}%`,
      spoken: `${steps.done} of ${steps.total} steps done`,
    };
  }
  return {
    value: card.progress,
    label: `${card.progress}%`,
    spoken: `about ${card.progress}% done`,
  };
}

const TESTS_FACT: Record<CanopyCard["tests"], string | null> = {
  passing: "Tests pass",
  failing: "Tests failing",
  not_run: "Tests not run",
  unknown: null,
};

const CHANGES_FACT: Record<CanopyCard["changes"], string | null> = {
  uncommitted: "Not committed",
  committed: "Committed",
  pushed: "Pushed",
  none: null,
  unknown: null,
};

/**
 * What the agent last reported about its tests and its changes, in words, for
 * a run that has stopped: the loose ends a finished turn leaves. A working run's
 * tests and commits are still moving, so it says nothing yet.
 */
export function itemFacts(item: CanopyItem): string[] {
  const card = item.card;
  // Only what the newest reading reported: an earlier one may be about the
  // previous turn, and an old "Tests pass" beside a new stop is a false claim.
  if (card === null || card.stage !== "described" || item.stale || card.wordsFromEarlierRead) {
    return [];
  }
  if (itemIsBusy(item) || item.kind === "idle") return [];
  return [TESTS_FACT[card.tests], CHANGES_FACT[card.changes]].filter(
    (fact): fact is string => fact !== null
  );
}

/**
 * The choices a run's dialog offers that the user can pick from the list with
 * one key: an approval or a menu read off the screen as it is now, while
 * Daintree itself sees the agent waiting. Never a secret prompt, and never
 * choices read off an earlier screen.
 */
export function answerOptions(item: CanopyItem): string[] {
  const card = item.card;
  if (card === null || card.stage !== "described") return [];
  if (item.stale || card.wordsFromEarlierRead || card.priorityFromEarlierRead) return [];
  if (card.secretPrompt || itemHandled(item) || itemArchived(item)) return [];
  if (card.category !== "approval" && card.category !== "question") return [];
  if (item.row.run.agentState !== "waiting") return [];
  return card.options.slice(0, 9);
}

/**
 * The option "Y" picks: the first, and only when the readers judged the action
 * safe. A risk they flagged, or never assessed, takes its number instead.
 */
export function quickApproveOption(item: CanopyItem): string | null {
  const options = answerOptions(item);
  if (options.length === 0 || item.card?.risk !== "none") return null;
  return options[0]!;
}

/**
 * A choice that takes two presses of its number: any choice on an action the
 * readers flagged as risky, where one stray key would let it run.
 */
export function answerNeedsConfirm(item: CanopyItem): boolean {
  return item.card?.risk === "caution";
}

/** At or below this share of context left, the row says so: the agent is near compacting. */
export const LOW_CONTEXT_PERCENT = 15;

/** "8% context left", for a run whose own footer says it is nearly out; null otherwise. */
export function itemContextWarning(item: CanopyItem): string | null {
  const left = item.card?.contextLeft ?? null;
  if (left === null || left > LOW_CONTEXT_PERCENT || item.kind === "idle") return null;
  return `${left}% context left`;
}

/** Answered from the panel, and nothing new read since. */
export function itemHandled(item: CanopyItem): boolean {
  return item.disposition?.kind === "replied" || item.card?.handledAt != null;
}

/**
 * The latest reading — the classifier's, or the describer's once it has
 * written the card — says the agent finished its task, and Daintree itself
 * sees it stopped rather than working. A reading only an LLM can make, offered
 * as a suggestion: the panel suggests closing the terminal, it never does.
 */
export function itemLooksDone(item: CanopyItem): boolean {
  const card = item.card;
  // Only a reading of the screen as it is now: a suggestion to trash must not
  // rest on a screen that has since moved.
  if (card === null || item.stale || card.priorityFromEarlierRead) return false;
  if (card.category !== "finished") return false;
  // Stopped is not done: an interrupted turn, or one that left tests failing.
  if (card.progress !== null && card.progress < 100) return false;
  if (card.tests === "failing") return false;
  const state = item.row.run.agentState;
  return state === "waiting" || state === "completed" || state === "idle";
}

export function itemArchived(item: CanopyItem): boolean {
  return item.disposition?.kind === "archived";
}

/** When the user replied from the panel, while that reply still stands. */
export function repliedAt(item: CanopyItem): number | null {
  if (item.disposition?.kind === "replied") return item.disposition.at;
  return item.card?.handledAt ?? null;
}

/**
 * The run likely needs a person: the classifier said so, or — before it has
 * read the screen — Daintree's own state says the agent is waiting.
 */
export function itemNeedsAttention(item: CanopyItem): boolean {
  if (itemHandled(item) || itemArchived(item)) return false;
  if (itemAwaitsPermission(item)) return true;
  // Daintree's own stall observation: working, and no output for ten minutes.
  // Whether it is stuck or just slow, it is worth a look.
  if (itemStalled(item)) return true;
  // Every layer answers on one scale, the score's own bands: 55 and up is
  // something left to check, decide or answer. A finished turn with nothing
  // left (40), an idle session (20) or work going normally (5) stays in the
  // list but is not counted: a count that includes what needs no action
  // teaches the user to stop reading it. The quick classifier's probability
  // leans towards "needs you" (it passed fresh, idle sessions at 0.55–0.72) —
  // right for a gate, wrong for the count, and counting by it made a run flip
  // in and out of the count as the classifier's and the describer's readings
  // took turns. Its own priority (a finished turn at 50, an ask at 86–92)
  // sits on the same bands as the describer's score.
  return readPriority(item) >= NEEDS_YOU_FLOOR;
}

/** The lowest score band that leaves the user something to do: loose ends on a finished turn. */
export const NEEDS_YOU_FLOOR = CANOPY_NEEDS_YOU_PRIORITY;

/**
 * The inbox: every run in one ranked list — waiting, finished and working alike,
 * since a run that needs no answer may still need checking on — and what the
 * user archived beside it. A section for "everything else" would fold away
 * exactly the runs a wrong reading under-ranks.
 */
export interface CanopyInbox {
  inbox: CanopyItem[];
  archived: CanopyItem[];
}

export function splitInbox(items: readonly CanopyItem[]): CanopyInbox {
  const inbox: CanopyItem[] = [];
  const archived: CanopyItem[] = [];
  for (const item of items) (itemArchived(item) ? archived : inbox).push(item);
  return { inbox, archived };
}

export function buildCanopyInbox(
  groups: readonly PilotProjectGroup[],
  cards: ReadonlyMap<string, CanopyCard>,
  read: CanopyReadState = READING,
  dispositions: ReadonlyMap<string, CanopyDisposition> = new Map(),
  seen: ReadonlyMap<string, CanopySeen> = new Map(),
  nowMs: number = Date.now(),
  glances: ReadonlyMap<string, CanopyRunGlance> = new Map(),
  reads: ReadonlyMap<string, CanopyReadMark> = new Map()
): CanopyItem[] {
  const items: CanopyItem[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      const { card, stale } = currentCard(row.run, cards.get(row.run.runId));
      const entry = dispositions.get(row.run.runId);
      // Only for the incarnation it was set on: a respawn starts in the inbox.
      const disposition =
        entry !== undefined && entry.spawnedAt === row.run.spawnedAt ? entry : null;
      const look = seen.get(row.run.runId);
      const screenGlance = glances.get(row.run.runId);
      const mark = reads.get(row.run.runId);
      const readMark = mark !== undefined && mark.spawnedAt === row.run.spawnedAt ? mark : null;
      items.push({
        runId: row.run.runId,
        workspaceId: row.run.workspaceId,
        row,
        workspace: {
          name: group.name,
          emoji: group.emoji,
          color: group.color,
          kind: group.kind,
          isCurrent: group.isCurrent,
        },
        kind: card?.category ?? observedKind(row.run),
        card,
        // A card read before the run's state moved carries an old screen's
        // words; they never stand in as what it is doing now.
        glance: stale
          ? null
          : (card?.glance ??
            (screenGlance !== undefined && screenGlance.spawnedAt === row.run.spawnedAt
              ? screenGlance.glance
              : null)),
        // A bone promises words. After a failed read nothing is writing them
        // now, so it draws none; a run put aside is not read for words until
        // it comes back.
        pending:
          card === null
            ? !read.failed && disposition === null
            : card.describing || (stale && !read.failed && disposition === null),
        stale,
        failed: read.failedRuns?.has(row.run.runId) ?? false,
        disposition,
        seenAt: look !== undefined && look.spawnedAt === row.run.spawnedAt ? look.at : null,
        readMark,
        unread: disposition?.kind !== "archived" && isCanopyUnread(readMark),
      });
    }
  }

  // One list, most in need of a person first: the readers' priority, or what
  // Daintree observed for a run not read yet, raised for a busy run the user
  // hasn't looked at in a while.
  items.sort((a, b) => {
    const byPriority = itemPriority(b, nowMs) - itemPriority(a, nowMs);
    if (byPriority !== 0) return byPriority;
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    // Then whoever has been in that state longest.
    return (
      (a.row.run.since ?? Number.MAX_SAFE_INTEGER) - (b.row.run.since ?? Number.MAX_SAFE_INTEGER)
    );
  });
  return items;
}
