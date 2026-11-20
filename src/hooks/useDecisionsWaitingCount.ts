import { useSyncExternalStore } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { asksByDeadline, nextAskDeadline } from "@/components/Decisions/decisionDeadline";
import { onClockJump } from "@/components/Decisions/useDecisionsClock";
import { currentHostId } from "@/hooks/useHostPlatform";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import type {
  DecisionQuestionList,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";
import { deliveryNeedsPerson, isWaitingOnPerson } from "@shared/utils/decisionWaiting";

/**
 * How many of this computer's questions wait on the person, and how many
 * deliveries stopped on their answer (#18045), shared by every reader in the
 * view: one list watch however many ask, held while any of them is mounted
 * and asking. Zero until the list is read, and when it can't be. The same
 * list says which of each pane's questions the person cleared (#18053), for
 * the pane's chip.
 */
let count = 0;
let stopped = 0;
/** By `paneKey`, the ids of the pane's questions cleared here, joined. */
let clearedByPane: ReadonlyMap<string, string> = new Map();
/** The same questions, each by its pane and id. */
let clearedQuestions: ReadonlySet<string> = new Set();
let holders = 0;
let stopWatch: (() => void) | null = null;
/** The last list watched, counted again as a deadline passes or the clock jumps. */
let latest: DecisionQuestionList | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
let stopJumps: (() => void) | null = null;
const listeners = new Set<() => void>();

/** setTimeout fires at once past a signed 32-bit delay, so a far deadline is waited out in chunks. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function notifyAll(): void {
  for (const notify of [...listeners]) notify();
}

function set(nextCount: number, nextStopped: number): void {
  if (nextCount === count && nextStopped === stopped) return;
  count = nextCount;
  stopped = nextStopped;
  notifyAll();
}

/** A pane by the machine it runs on, as the list names it: aliases and ids repeat across Hosts. */
function paneKey(hostId: string, terminalId: string): string {
  return JSON.stringify([hostId, terminalId]);
}

/**
 * Each pane's questions the person cleared from Needs you. A question still
 * asking holds a clear while its list row carries one. One answered or closed
 * since keeps the clear it had, since the pane's own state can list it open a
 * moment longer than the list. A stopped delivery can stand over a question
 * that still waits, and asks something new there unseen, so it keeps none.
 * Every reader is told when any pane's changed, since a clear can leave the
 * count where it was.
 */
/** Standings a question reaches once answered or closed: none of them asks anything of the person. */
const PAST_ASKING: ReadonlySet<DecisionQuestionStanding["kind"]> = new Set([
  "to-type",
  "settled",
  "send-failed",
]);

function readCleared(list: DecisionQuestionList | null): void {
  const held = new Set<string>();
  const ids = new Map<string, string[]>();
  for (const item of list?.questions ?? []) {
    const pane = paneKey(item.remoteHost?.hostId ?? LOCAL_HOST_ID, item.reference.terminalId);
    const id = JSON.stringify([pane, item.reference.questionId]);
    const cleared = asksByDeadline(item.standing)
      ? item.inbox?.cleared === true
      : PAST_ASKING.has(item.standing.kind) && clearedQuestions.has(id);
    if (!cleared) continue;
    held.add(id);
    const listed = ids.get(pane);
    if (listed === undefined) ids.set(pane, [item.reference.questionId]);
    else listed.push(item.reference.questionId);
  }
  clearedQuestions = held;
  const next = new Map([...ids].map(([pane, listed]) => [pane, listed.sort().join("\u0000")]));
  const same =
    next.size === clearedByPane.size &&
    [...next].every(([pane, joined]) => clearedByPane.get(pane) === joined);
  if (same) return;
  clearedByPane = next;
  notifyAll();
}

/** Counts the latest list against the clock now, and waits for the next deadline to pass. */
function recount(): void {
  clearTimeout(deadlineTimer);
  deadlineTimer = undefined;
  if (latest === null) return;
  const now = Date.now();
  set(
    latest.questions.filter((item) => isWaitingOnPerson(item, now)).length,
    latest.questions.filter((item) => deliveryNeedsPerson(item.standing)).length
  );
  // Only a deadline passing changes the count: no timer for the minutes ticking down.
  const next = nextAskDeadline(latest.questions, now);
  if (next === null) return;
  deadlineTimer = setTimeout(recount, Math.min(next - now, MAX_TIMEOUT_MS));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  holders += 1;
  if (holders === 1) {
    // The toolbar must never come down with a bridge that is missing or throws.
    try {
      stopWatch = decisionsClient.watchQuestions((list) => {
        latest = list;
        readCleared(list);
        recount();
      });
    } catch {
      stopWatch = null;
    }
    stopJumps = onClockJump(recount);
  }
  return () => {
    listeners.delete(listener);
    holders -= 1;
    if (holders > 0) return;
    stopWatch?.();
    stopWatch = null;
    stopJumps?.();
    stopJumps = null;
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    latest = null;
    // The next watcher reads afresh rather than showing a count nobody kept up.
    count = 0;
    stopped = 0;
    clearedByPane = new Map();
    clearedQuestions = new Set();
  };
}

function subscribeNothing(): () => void {
  return () => {};
}

function getCount(): number {
  return count;
}

function getStopped(): number {
  return stopped;
}

function getZero(): number {
  return 0;
}

/**
 * Questions waiting on the person, watched only while `active`: nothing is
 * read while Decisions is off.
 */
export function useDecisionsWaitingCount(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribe : subscribeNothing,
    active ? getCount : getZero,
    active ? getCount : getZero
  );
}

/**
 * Deliveries stopped on the person's answer or follow-up, from the same watch:
 * read only while `active`.
 */
export function useDecisionsStoppedCount(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribe : subscribeNothing,
    active ? getStopped : getZero,
    active ? getStopped : getZero
  );
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The ids of this view's pane `terminalId`'s questions the person cleared from
 * Needs you on this computer (#18053), from the shared list watch, held only
 * while `active`. Empty until the list is read, and in a window whose machine
 * the list doesn't name.
 */
export function usePaneClearedQuestions(terminalId: string, active: boolean): ReadonlySet<string> {
  const joined = useSyncExternalStore(
    active ? subscribe : subscribeNothing,
    () => (active ? (clearedByPane.get(paneKey(currentHostId(), terminalId)) ?? "") : ""),
    () => ""
  );
  return joined === "" ? NO_IDS : new Set(joined.split("\u0000"));
}
