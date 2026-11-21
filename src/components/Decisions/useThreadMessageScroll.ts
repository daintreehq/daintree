import { useEffect, useRef, type RefObject } from "react";
import type { TaggedRead } from "./useDecisionQuestionReader";

/**
 * Scrolls `container` to a follow-up in the shown question's thread (#17235),
 * once per `opening`, so a read again stays put. A read already on screen as
 * the opening starts can predate the follow-up: without it there, the thread
 * is shown once a read made for this opening lands. A null `opening` or no
 * `messageId` has nothing to scroll to, and forgets the last.
 */
export function useThreadMessageScroll(
  opening: unknown,
  messageId: string | undefined,
  shownRead: TaggedRead | null,
  container: RefObject<HTMLElement | null>
): void {
  const pending = useRef<{ opening: unknown; stale: TaggedRead | null; done: boolean } | null>(
    null
  );
  useEffect(() => {
    if (opening === null || messageId === undefined) {
      pending.current = null;
      return;
    }
    let current = pending.current;
    if (current === null || current.opening !== opening) {
      current = { opening, stale: shownRead, done: false };
      pending.current = current;
    }
    if (current.done || shownRead?.read.result !== "read") return;
    const body = container.current;
    const entry = body?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (entry == null && shownRead === current.stale) return;
    pending.current = { opening, stale: null, done: true };
    (entry ?? body?.querySelector('[data-testid="decision-question-thread"]'))?.scrollIntoView({
      block: "nearest",
    });
  }, [opening, messageId, shownRead, container]);
}
