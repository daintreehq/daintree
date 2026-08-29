import { useEffect, useRef } from "react";
import { useAssistantStore, type AssistantTimers } from "@/store/assistantStore";
import { notify } from "@/lib/notify";

/**
 * Tells the user when a scheduled timer has actually fired.
 *
 * This is the half the timer system never had. A timer's own fire deliberately does
 * NOT wake the assistant — a reminder is for a human, not a prompt — and a scheduled
 * tool call that SUCCEEDS publishes into the engine's queue at `info`, below the
 * threshold that surfaces anything. So the whole feature was silent: you asked to be
 * reminded in twenty minutes, twenty minutes passed, and nothing on screen changed.
 *
 * The engine now announces the fire (`timer:fired`), but that event carries an id and
 * nothing else, so this hook re-reads the list to find out what actually happened and
 * notifies from the OUTCOME. One extra round trip per fire, which is affordable
 * precisely because firing is rare.
 *
 * Routing follows the notification matrix: `grid-bar`, the least-restricted surface
 * that crosses a pane boundary. A timer fires outside whatever the user is looking
 * at, and being noticed is the entire purpose of the thing they scheduled — but it is
 * not a toast, because a toast is the most restricted surface and a reminder landing
 * on time is not an interruption.
 */
export function useAssistantTimerNotifications({
  timers,
  timersStale,
  sessionId,
  requestTimers,
}: {
  timers: AssistantTimers | null;
  timersStale: boolean;
  sessionId: string | null;
  requestTimers: () => void;
}) {
  /**
   * Outcomes already accounted for, as `eventId:count`.
   *
   * The count is in the key because a repeating timer publishes under ONE dedupe key
   * — the fourth failure updates the first row rather than adding a fourth — so an
   * id alone would announce a nightly job's first failure and then go quiet for every
   * one after it.
   */
  const seen = useRef<Set<string> | null>(null);
  const session = useRef<string | null>(null);

  // A timer fired while nothing was showing the list. Re-read it, so the notification
  // below can say WHAT happened rather than only that something did.
  useEffect(() => {
    if (timersStale && sessionId) requestTimers();
  }, [timersStale, sessionId, requestTimers]);

  useEffect(() => {
    // A new session starts a new baseline. Without this, reconnecting to a project
    // would replay every outcome still in the queue as though it had just happened —
    // a burst of notifications about work that finished yesterday.
    if (session.current !== sessionId) {
      session.current = sessionId;
      seen.current = null;
    }
    if (!timers) return;

    const keys = new Set(timers.outcomes.map((o) => `${o.eventId}:${o.count}`));

    // The FIRST reading of a session is the baseline, announced to nobody. It is the
    // state of the world on arrival, not news.
    if (seen.current === null) {
      seen.current = keys;
      return;
    }

    for (const outcome of timers.outcomes) {
      const key = `${outcome.eventId}:${outcome.count}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);

      const failed = outcome.severity === "error";
      notify({
        type: failed ? "error" : "info",
        placement: "grid-bar",
        title: failed ? "Scheduled timer failed" : "Scheduled timer fired",
        message: outcome.summary || outcome.title,
        inboxMessage: outcome.summary || outcome.title,
        // One live signal per timer: a repeat that fails every night should replace
        // its own notice rather than stack a new one beside it each time.
        supersedeKey: `assistant-timer:${outcome.timerId}`,
        // `agent` is the assistant acting on its own — which is exactly what a timer
        // is. Its policy is "active", so this reaches the user when they are here and
        // waits in the inbox when they are not, which is the right shape for
        // something that fires whether or not anyone is watching. Not `completed`:
        // that is passive, inbox-only, and a reminder nobody sees is a reminder that
        // did not work.
        context: { eventKind: "agent" },
      });
    }
    seen.current = keys;
  }, [timers, sessionId]);
}

/** Reads the pieces this hook needs straight off the store. */
export function useAssistantTimerNotificationsFromStore(requestTimers: () => void) {
  const timers = useAssistantStore((s) => s.timers);
  const timersStale = useAssistantStore((s) => s.timersStale);
  const sessionId = useAssistantStore((s) => s.sessionId);
  useAssistantTimerNotifications({ timers, timersStale, sessionId, requestTimers });
}
