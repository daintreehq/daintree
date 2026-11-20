import { decisionsClient } from "@/clients/decisionsClient";
import { readDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import type { DecisionQuestionListItem } from "@shared/types/decisionsQuestion";
import { resolvesHere } from "./useInboxAttentionItem";

/** The pane, or Canopy run, whose stopped deliveries are reviewed. */
export interface StoppedAnswersScope {
  terminalId: string;
  /** Its project, when known: a terminal id names a pane only within its project. */
  projectId?: string;
  /** Its stalled questions in the order the opener lists them, when it knows them. */
  questionIds?: readonly string[];
}

/** Where the close returns. */
export interface StoppedAnswersOpener {
  /** The pane's chip opened it: the close goes back there. */
  fromPane?: boolean;
  /** The element the close returns to once the opening control has gone (a Canopy card). */
  returnFocusTo?: string;
}

/**
 * The stalled question this computer resolves in the inbox, of those
 * `scope` names: the first in the opener's order, else the list's oldest.
 * Undefined when the list holds none of them, or couldn't be read.
 */
export function stoppedQuestion(
  questions: readonly DecisionQuestionListItem[],
  scope: StoppedAnswersScope
): DecisionQuestionListItem | undefined {
  const candidates = questions.filter(
    (item) =>
      resolvesHere(item) &&
      item.reference.terminalId === scope.terminalId &&
      (scope.projectId === undefined || item.reference.projectId === scope.projectId)
  );
  const order = scope.questionIds ?? [];
  const rank = (item: DecisionQuestionListItem) => {
    const index = order.indexOf(item.reference.questionId);
    return index < 0 ? order.length : index;
  };
  let first: DecisionQuestionListItem | undefined;
  for (const item of candidates) {
    if (first === undefined || rank(item) < rank(first)) first = item;
  }
  return first;
}

/** Rises with every review asked for, so only the latest one opens anything. */
let latest = 0;

/**
 * Review answers (#18048): opens the inbox at the stalled question `scope`
 * names, where this computer resolves its delivery in place. The question
 * list is ids only, so nothing's words are read to choose it. One the list
 * doesn't hold (not yet published, or a stall the inbox can't list: asked
 * with no pane, or by another machine) opens the standalone list of answers
 * needing attention instead, which holds every one, and says why it can't
 * read them when it can't. Only this computer's windows offer it: a Remote
 * Host keeps its own panes' deliveries.
 */
export async function openStoppedAnswers(
  scope: StoppedAnswersScope,
  opener: StoppedAnswersOpener = {}
): Promise<void> {
  const ticket = ++latest;
  const list = await decisionsClient.listQuestions().catch(() => null);
  // A later press decides, and Decisions switched off holds nothing to review.
  if (ticket !== latest || readDecisionsSwitch() === "off") return;
  const found = list === null ? undefined : stoppedQuestion(list.questions, scope);
  if (found === undefined) {
    useDecisionsAttentionStore
      .getState()
      .open(
        scope.terminalId,
        opener.returnFocusTo === undefined ? undefined : { returnFocusTo: opener.returnFocusTo }
      );
    return;
  }
  const { reference } = found;
  useDecisionsInboxStore.getState().open({
    terminalId: opener.fromPane === true ? scope.terminalId : null,
    question: { terminalId: reference.terminalId, questionId: reference.questionId, reference },
    ...(opener.returnFocusTo === undefined ? {} : { returnFocusTo: opener.returnFocusTo }),
  });
}
