import { useEffect, useState } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import type { DecisionsAttentionItem } from "@shared/types/decisionsAttention";
import type { DecisionQuestionListItem } from "@shared/types/decisionsQuestion";

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

/** A read, or null when it failed by rejecting or by throwing. */
async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
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
    Promise.all([
      settle(() => decisionsClient.listAttention()),
      settle(() => decisionsClient.listQuestions()),
    ]).then(([attention, list]) => {
      if (!live) return;
      // Not delivering holds nothing to review, whatever the other read did.
      if (attention !== null && attention.result !== "listed") setUnlisted(0);
      else if (attention === null || list === null) setUnlisted("unknown");
      else setUnlisted(unlistedAnswers(attention.items, list.questions));
    });
    return () => {
      live = false;
    };
  }, [listOpen, stopped]);

  return unlisted;
}
