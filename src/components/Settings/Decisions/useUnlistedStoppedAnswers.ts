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
 * How many stopped answers only the attention list holds, for Settings to
 * offer that list beside the inbox: read when the section shows, each time
 * the list closes, and as the inbox's stopped count `stopped` moves, from two
 * reads that both landed. Zero until then, when either fails, and while
 * Decisions isn't delivering. An answer that stops with nothing in the inbox
 * moving shows here once Settings is opened again.
 */
export function useUnlistedStoppedAnswers(stopped: number): number {
  const [count, setCount] = useState(0);
  const listOpen = useDecisionsAttentionStore((state) => state.isOpen);

  useEffect(() => {
    if (listOpen) return;
    let live = true;
    let reads: Promise<[DecisionsAttentionList, DecisionQuestionList]>;
    try {
      reads = Promise.all([decisionsClient.listAttention(), decisionsClient.listQuestions()]);
    } catch {
      // A bridge without the reads offers the inbox alone.
      return;
    }
    reads.then(
      ([attention, list]) => {
        if (!live) return;
        setCount(
          attention.result === "listed" ? unlistedAnswers(attention.items, list.questions) : 0
        );
      },
      () => {
        if (live) setCount(0);
      }
    );
    return () => {
      live = false;
    };
  }, [listOpen, stopped]);

  return count;
}
