import { useEffect, useRef, useState, type RefObject } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { topmostOpenModal } from "@/lib/openModalFocus";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import type {
  DecisionQuestionContent,
  DecisionQuestionList,
  DecisionQuestionListItem,
} from "@shared/types/decisionsQuestion";
import { seeableAsk } from "./decisionsInboxModel";

/**
 * Someone can be reading `scope`: its view isn't cached or hidden, its window
 * has focus, and no other modal (an image opened full size, a confirmation)
 * covers the one it is in.
 */
function isWatched(scope: HTMLElement | null): boolean {
  if (scope === null || !isProjectViewObservable()) return false;
  if (typeof document === "undefined" || !document.hasFocus()) return false;
  const top = topmostOpenModal(null);
  return top === null || top.contains(scope);
}

/**
 * `isWatched`, kept current while `active`. Focus moving into a modal over it,
 * or back out of one, is when a cover comes or goes.
 */
function useWatched(active: boolean, scope: RefObject<HTMLElement | null>): boolean {
  const [watched, setWatched] = useState(false);
  useEffect(() => {
    if (!active) return;
    const check = () => setWatched(isWatched(scope.current));
    check();
    window.addEventListener("focus", check);
    window.addEventListener("blur", check);
    document.addEventListener("focusin", check);
    const offObservable = subscribeProjectViewObservability(check);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", check);
      document.removeEventListener("focusin", check);
      offObservable();
    };
  }, [active, scope]);
  return active && watched;
}

/**
 * Marks the question shown seen on this computer (#17895) once the person
 * has what it asks in front of them: the read on screen is of the question
 * the list names (`item`), in a view they can see and a window with focus,
 * and the agent's follow-up the ask takes in, when there is one, has been
 * scrolled into view inside `scope`. A follow-up that arrives below where
 * they're reading counts only once they reach it. Seeing answers nothing.
 */
export function useDecisionQuestionSeen(
  item: DecisionQuestionListItem | null,
  shown: DecisionQuestionContent | null,
  active: boolean,
  scope: RefObject<HTMLElement | null>
): void {
  const watched = useWatched(active, scope);
  const seeable = item !== null && shown !== null ? seeableAsk(item, shown) : null;
  const reference = seeable === null ? null : item!.reference;
  const hostId = reference?.hostId ?? null;
  const projectId = reference?.projectId ?? null;
  const terminalId = reference?.terminalId ?? null;
  const questionId = reference?.questionId ?? null;
  const ask = seeable?.ask ?? null;
  /** The ask last sent for, so a re-render before the list says it took sends nothing more. */
  const sent = useRef<string | null>(null);

  useEffect(() => {
    // Checked as it stands, not only as last heard: the reader can mount after the dialog
    // opened (an empty inbox's first question) with no focus moving to say so.
    if (!active || !isWatched(scope.current) || hostId === null || projectId === null) return;
    if (terminalId === null || questionId === null) return;
    const key = JSON.stringify([hostId, questionId, ask]);
    if (sent.current === key) return;
    // A look that ended (the question changed, focus left) sends nothing, even from a callback already queued.
    let retired = false;
    const send = () => {
      if (retired || sent.current === key || !isWatched(scope.current)) return;
      sent.current = key;
      const forget = () => {
        // Not taken, or nothing it named was marked: the next change to what's shown tries again.
        if (sent.current === key) sent.current = null;
      };
      decisionsClient
        .markQuestions("seen", [{ reference: { hostId, projectId, terminalId, questionId }, ask }])
        .then((result) => {
          if (result.result !== "marked" || result.marked === 0) forget();
        }, forget);
    };
    if (ask === null || typeof IntersectionObserver === "undefined") {
      send();
      return () => {
        retired = true;
      };
    }
    const entry = scope.current?.querySelector(`[data-message-id="${CSS.escape(ask)}"]`);
    if (entry == null) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((observed) => observed.isIntersecting)) return;
      observer.disconnect();
      send();
    });
    observer.observe(entry);
    return () => {
      retired = true;
      observer.disconnect();
    };
    // `watched` re-runs it as focus or a cover comes and goes; `shown` so a read that renders
    // the entry looks for it again.
  }, [active, watched, hostId, projectId, terminalId, questionId, ask, shown, scope]);
}

/**
 * The question `shown` is a read of, as this computer's list names it, while
 * `active`: what a view opened on one question, rather than from the list,
 * marks seen by. Null until both are read, and for a question the list
 * doesn't hold.
 */
export function useListedQuestion(
  shown: DecisionQuestionContent | null,
  active: boolean
): DecisionQuestionListItem | null {
  const [list, setList] = useState<DecisionQuestionList | null>(null);
  useEffect(() => {
    if (!active) return;
    // Seeing is a convenience: a bridge that is missing or throws never takes the view down.
    try {
      return decisionsClient.watchQuestions(setList);
    } catch {
      return;
    }
  }, [active]);
  if (!active || shown === null || list === null) return null;
  const { hostId, questionId } = shown.reference;
  return (
    list.questions.find(
      (item) => item.reference.hostId === hostId && item.reference.questionId === questionId
    ) ?? null
  );
}
