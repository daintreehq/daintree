import { decisionsClient } from "@/clients/decisionsClient";
import { readDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import type { DecisionsAttentionItem } from "@shared/types/decisionsAttention";
import type {
  DecisionQuestionListItem,
  DecisionQuestionReference,
} from "@shared/types/decisionsQuestion";
import { resolvesHere } from "./useInboxAttentionItem";

/** The pane, or Canopy run, whose stopped deliveries are reviewed. */
export interface StoppedAnswersScope {
  terminalId: string;
  /** Its project, when known: a terminal id names a pane only within its project. */
  projectId?: string;
  /** Its stalled questions in the order the opener lists them, when it knows them. */
  questionIds?: readonly string[];
}

/** Where the close returns, and whether the opener still wants it once the reads land. */
export interface StoppedAnswersOpener {
  /** The pane's chip opened it: the close goes back there. */
  fromPane?: boolean;
  /** The element the close returns to once the opening control has gone (a Canopy card). */
  returnFocusTo?: string;
  /** False once the opener's view has moved on, as Canopy does to another host. */
  stillWanted?: () => boolean;
}

/** The first of `items` in the opener's order, else in their own. */
function firstInOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  order: readonly string[] = []
): T | undefined {
  const rank = (item: T) => {
    const index = order.indexOf(idOf(item));
    return index < 0 ? order.length : index;
  };
  let first: T | undefined;
  for (const item of items) {
    if (first === undefined || rank(item) < rank(first)) first = item;
  }
  return first;
}

/**
 * The stalled question this computer resolves in the inbox, of those
 * `scope` names: the first in the opener's order, else the list's oldest.
 * Undefined when the list holds none of them.
 */
export function stoppedQuestion(
  questions: readonly DecisionQuestionListItem[],
  scope: StoppedAnswersScope
): DecisionQuestionListItem | undefined {
  return firstInOrder(
    questions.filter(
      (item) =>
        resolvesHere(item) &&
        item.reference.terminalId === scope.terminalId &&
        (scope.projectId === undefined || item.reference.projectId === scope.projectId)
    ),
    (item) => item.reference.questionId,
    scope.questionIds
  );
}

/**
 * The reference the inbox names `scope`'s first stopped answer by, from the
 * attention list, when this computer asked it from a pane: a stall the
 * question list hasn't published yet. Undefined for one it can't list, asked
 * with no pane or by another machine, which only the attention list holds.
 */
export function stoppedReference(
  items: readonly DecisionsAttentionItem[],
  scope: StoppedAnswersScope
): DecisionQuestionReference | undefined {
  const first = firstInOrder(
    items.filter(
      (item) =>
        item.origin.paneId === scope.terminalId &&
        (scope.projectId === undefined || item.origin.projectId === scope.projectId)
    ),
    (item) => item.questionId,
    scope.questionIds
  );
  if (first === undefined || first.reference === null || first.origin.otherHost !== null) {
    return undefined;
  }
  return first.reference;
}

/** A read that failed, by rejecting or by throwing, reads as nothing. */
async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Rises with every review asked for, so only the latest one opens anything. */
let latest = 0;

/**
 * Review answers (#18048): opens the inbox at the stalled question `scope`
 * names, where this computer resolves its delivery in place. The question
 * list is ids only, so nothing's words are read to choose it; only when it
 * doesn't hold one, or couldn't be read, does the attention list say whether
 * the inbox can name it all the same (not yet published). One the inbox can't
 * list (asked with no pane, or by another machine), or when neither read can
 * say, opens the standalone list of answers needing attention, which holds
 * every one and says why it can't read them when it can't. Only this
 * computer's windows offer it: a Remote Host keeps its own panes' deliveries.
 */
export async function openStoppedAnswers(
  scope: StoppedAnswersScope,
  opener: StoppedAnswersOpener = {}
): Promise<void> {
  const ticket = ++latest;
  const inboxAt = useDecisionsInboxStore.getState().request;
  const listAt = useDecisionsAttentionStore.getState().request.seq;
  // A later press decides, as does anything that opened the inbox or the list meanwhile (a
  // notification's click); Decisions switched off holds nothing to review, and an opener that
  // moved on wants nothing opened over where it went.
  const wanted = () => {
    const inbox = useDecisionsInboxStore.getState().request;
    return (
      ticket === latest &&
      inbox.seq === inboxAt.seq &&
      inbox.ask === inboxAt.ask &&
      useDecisionsAttentionStore.getState().request.seq === listAt &&
      readDecisionsSwitch() !== "off" &&
      (opener.stillWanted?.() ?? true)
    );
  };
  const list = await readOrNull(() => decisionsClient.listQuestions());
  if (!wanted()) return;
  let reference = list === null ? undefined : stoppedQuestion(list.questions, scope)?.reference;
  if (reference === undefined) {
    const attention = await readOrNull(() => decisionsClient.listAttention());
    if (!wanted()) return;
    reference =
      attention?.result === "listed" ? stoppedReference(attention.items, scope) : undefined;
  }
  const returnFocusTo =
    opener.returnFocusTo === undefined ? {} : { returnFocusTo: opener.returnFocusTo };
  if (reference === undefined) {
    useDecisionsAttentionStore
      .getState()
      .open(scope.terminalId, opener.returnFocusTo === undefined ? undefined : returnFocusTo);
    return;
  }
  useDecisionsInboxStore.getState().open({
    terminalId: opener.fromPane === true ? scope.terminalId : null,
    question: { terminalId: reference.terminalId, questionId: reference.questionId, reference },
    ...returnFocusTo,
  });
}
