import { useSyncExternalStore } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { nextAskDeadline } from "@/components/Decisions/decisionDeadline";
import { onClockJump } from "@/components/Decisions/useDecisionsClock";
import type { DecisionQuestionList } from "@shared/types/decisionsQuestion";
import { isWaitingOnPerson } from "@shared/utils/decisionWaiting";

/**
 * How many of this computer's questions wait on the person, shared by every
 * reader in the view: one list watch however many ask, held while any of them
 * is mounted and asking. Zero until the list is read, and when it can't be.
 */
let count = 0;
let holders = 0;
let stopWatch: (() => void) | null = null;
/** The last list watched, counted again as a deadline passes or the clock jumps. */
let latest: DecisionQuestionList | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
let stopJumps: (() => void) | null = null;
const listeners = new Set<() => void>();

/** setTimeout fires at once past a signed 32-bit delay, so a far deadline is waited out in chunks. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function set(next: number): void {
  if (next === count) return;
  count = next;
  for (const notify of [...listeners]) notify();
}

/** Counts the latest list against the clock now, and waits for the next deadline to pass. */
function recount(): void {
  clearTimeout(deadlineTimer);
  deadlineTimer = undefined;
  if (latest === null) return;
  const now = Date.now();
  set(latest.questions.filter((item) => isWaitingOnPerson(item, now)).length);
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
  };
}

function subscribeNothing(): () => void {
  return () => {};
}

function getCount(): number {
  return count;
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
