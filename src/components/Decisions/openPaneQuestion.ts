import { decisionsClient } from "@/clients/decisionsClient";
import { currentHostId, isRemoteWindow } from "@/hooks/useHostPlatform";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { findAsked } from "./decisionsInboxModel";

/**
 * Opens one of a pane's questions (#18047): in the inbox at that question,
 * with the pane as its opener, wherever the inbox lists it; else in the
 * question view, stepping through the pane's questions. This computer's panes
 * are always in its list; a Remote Host window's only once that Host is
 * enrolled (#17230) and has reported the question.
 */
export async function openPaneQuestion(
  terminalId: string,
  questionIds: readonly string[],
  questionId: string
): Promise<void> {
  if (!isRemoteWindow()) {
    useDecisionsInboxStore.getState().open({ terminalId, question: { terminalId, questionId } });
    return;
  }
  const list = await decisionsClient.listQuestions().catch(() => null);
  const listed =
    list === null
      ? undefined
      : findAsked(list.questions, { terminalId, questionId }, currentHostId());
  if (listed === undefined) {
    useDecisionsQuestionViewStore.getState().open(terminalId, questionIds, questionId);
    return;
  }
  useDecisionsInboxStore
    .getState()
    .open({ terminalId, question: { terminalId, questionId, reference: listed.reference } });
}
