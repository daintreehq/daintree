import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
} from "../../shared/types/decisionsQuestion.js";

/**
 * Every question this computer's Decisions holds (#17229), as it last
 * observed them. A leaf module, so the IPC namespace and main's own consumers
 * (notifications, the Dock badge) can read it and hear it change without
 * importing Decisions: Decisions loads only while it is on, and installs its
 * list here for that lifetime. An empty list is exactly Decisions off.
 * Anything startup loads imports it on demand: Decisions adds no module to
 * startup (`scripts/decisions-lazy-boundary.test.ts`).
 */
let list: DecisionQuestionList = { revision: 0, questions: [] };
let key = keyOf([], []);
const listeners = new Set<(list: DecisionQuestionList) => void>();

/** The list now. Shared with every reader: never mutate it. */
export function getDecisionQuestionList(): DecisionQuestionList {
  return list;
}

function keyOf(
  questions: readonly DecisionQuestionListItem[],
  hostsAway: readonly string[]
): string {
  return JSON.stringify([questions, hostsAway]);
}

/**
 * Replaces the list (empty clears it), and the Remote Hosts away with it,
 * telling listeners only on a change. Returns the new list, or null when
 * nothing changed.
 */
export function setDecisionQuestions(
  questions: readonly DecisionQuestionListItem[],
  hostsAway: readonly string[] = []
): DecisionQuestionList | null {
  const next = keyOf(questions, hostsAway);
  if (next === key) return null;
  key = next;
  list = {
    revision: list.revision + 1,
    questions: [...questions],
    ...(hostsAway.length > 0 ? { hostsAway: [...hostsAway] } : {}),
  };
  const changed = list;
  for (const listener of [...listeners]) {
    try {
      listener(changed);
    } catch (err) {
      // One consumer failing never keeps the others from hearing it.
      console.warn("[Decisions] A question list listener threw:", err);
    }
  }
  return changed;
}

/** Be told each time the list changes, with the new list. Returns the unsubscribe. */
export function onDecisionQuestionsChanged(
  listener: (list: DecisionQuestionList) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
