import { useEffect, useState } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import type {
  DecisionsAttentionItem,
  DecisionsAttentionList,
} from "@shared/types/decisionsAttention";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
} from "@shared/types/decisionsQuestion";

/**
 * The answers needing a person whose question this computer's inbox doesn't
 * list (#18048): asked with no pane, or by another machine. A Host's row with
 * the same id is another machine's question, and lists nothing of this one.
 */
export function unlistedAnswers(
  items: readonly Pick<DecisionsAttentionItem, "questionId">[],
  questions: readonly Pick<DecisionQuestionListItem, "reference" | "remoteHost">[]
): number {
  const listed = new Set(
    questions
      .filter((question) => question.remoteHost === undefined)
      .map((question) => question.reference.questionId)
  );
  return items.filter((item) => !listed.has(item.questionId)).length;
}

/**
 * The stopped answers only the attention list holds: none read yet
 * (`unread`), how many once both reads landed (zero while Decisions isn't
 * delivering), or `unknown` when either read failed, in which case Settings
 * keeps the list reachable, as it did before #18048.
 */
export type UnlistedStoppedAnswers = "unread" | "unknown" | number;

/** Whether Settings offers the attention list beside the inbox. */
export function offersUnlisted(unlisted: UnlistedStoppedAnswers): boolean {
  return unlisted === "unknown" || (typeof unlisted === "number" && unlisted > 0);
}

/**
 * The stopped answers only the attention list holds, for Settings to offer
 * that list beside the inbox: read when the section shows, each time the list
 * closes, and as the inbox's stopped count `stopped` moves; an answer that
 * stops with nothing in the inbox moving shows here once Settings is opened
 * again. A read made before a later one began is dropped.
 */
export function useUnlistedStoppedAnswers(stopped: number): UnlistedStoppedAnswers {
  const [unlisted, setUnlisted] = useState<UnlistedStoppedAnswers>("unread");
  const listOpen = useDecisionsAttentionStore((state) => state.isOpen);

  useEffect(() => {
    if (listOpen) return;
    let live = true;
    // Async, so a bridge that throws rather than rejects fails the read the same way.
    const read = async (): Promise<[DecisionsAttentionList, DecisionQuestionList]> =>
      Promise.all([decisionsClient.listAttention(), decisionsClient.listQuestions()]);
    read().then(
      ([attention, list]) => {
        if (!live) return;
        setUnlisted(
          attention.result === "listed" ? unlistedAnswers(attention.items, list.questions) : 0
        );
      },
      () => {
        if (live) setUnlisted("unknown");
      }
    );
    return () => {
      live = false;
    };
  }, [listOpen, stopped]);

  return unlisted;
}
