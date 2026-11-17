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
 */
let list: DecisionQuestionList = { revision: 0, questions: [] };
let key = "[]";
const listeners = new Set<(list: DecisionQuestionList) => void>();

/** The list now. Shared with every reader: never mutate it. */
export function getDecisionQuestionList(): DecisionQuestionList {
  return list;
}

/**
 * Replaces the list (empty clears it), telling listeners only on a change.
 * Returns the new list, or null when nothing changed.
 */
export function setDecisionQuestions(
  questions: readonly DecisionQuestionListItem[]
): DecisionQuestionList | null {
  const next = JSON.stringify(questions);
  if (next === key) return null;
  key = next;
  list = { revision: list.revision + 1, questions: [...questions] };
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
