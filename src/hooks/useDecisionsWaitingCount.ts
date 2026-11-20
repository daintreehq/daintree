import { useSyncExternalStore } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { groupOf } from "@/components/Decisions/decisionsInboxModel";
import type { DecisionQuestionListItem } from "@shared/types/decisionsQuestion";

/**
 * A question waits on the person while it can be answered and they haven't
 * seen or cleared what it asks now (#17895): the inbox's "Needs you" group,
 * less what they've already looked at or set aside on this computer.
 */
export function isWaitingOnPerson(
  item: Pick<DecisionQuestionListItem, "standing" | "inbox">
): boolean {
  return (
    groupOf(item.standing) === "needs-you" &&
    item.inbox?.seen !== true &&
    item.inbox?.cleared !== true
  );
}

/**
 * How many of this computer's questions wait on the person, shared by every
 * reader in the view: one list watch however many ask, held while any of them
 * is mounted and asking. Zero until the list is read, and when it can't be.
 */
let count = 0;
let holders = 0;
let stopWatch: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: number): void {
  if (next === count) return;
  count = next;
  for (const notify of [...listeners]) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  holders += 1;
  if (holders === 1) {
    // The toolbar must never come down with a bridge that is missing or throws.
    try {
      stopWatch = decisionsClient.watchQuestions((list) =>
        set(list.questions.filter(isWaitingOnPerson).length)
      );
    } catch {
      stopWatch = null;
    }
  }
  return () => {
    listeners.delete(listener);
    holders -= 1;
    if (holders > 0) return;
    stopWatch?.();
    stopWatch = null;
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
