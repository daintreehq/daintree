import { useEffect, useRef } from "react";
import { useAssistantStore, type AssistantTimers } from "@/store/assistantStore";

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
 * It reports into the PANEL, never the app. Everything the assistant does stays inside
 * the assistant: it can go and change the world, but its account of that belongs where
 * the conversation is rather than on a surface spanning the whole window. A timer
 * firing is the assistant describing its own work, so it says so in its own place.
 */
export function useAssistantTimerNotifications({
  timers,
  timersStale,
  sessionId,
  requestTimers,
  takeFiredTimerIds,
  pushNotice,
}: {
  timers: AssistantTimers | null;
  timersStale: boolean;
  sessionId: string | null;
  requestTimers: () => void;
  /** Read-and-clear the ids the engine has told us fired. */
  takeFiredTimerIds: () => string[];
  /** Append a notice to the ASSISTANT PANEL's own strip. */
  pushNotice: (level: "info" | "warning" | "error", message: string) => void;
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
  /**
   * Timers this session has been told fired, and whose outcome has not been reported.
   *
   * This is the half that made the whole feature look broken. The baseline below is
   * right for a reading that arrives unprompted — arriving in a project should not
   * replay yesterday's outcomes — but the FIRST reading of a session is very often the
   * one the fire itself asked for, and baselining that one swallows the exact event it
   * was fetched to describe. Schedule a timer, watch it fire, see nothing: the outcome
   * was on screen in the deck and had been announced to nobody.
   *
   * Keyed by TIMER ID, not by a time window. The fire event names the timer and every
   * outcome row names its timer, so the two correlate exactly — where a "stamped in
   * the last minute" rule could neither tell a fire that landed during a slow first
   * read apart from one that happened before anyone was watching, nor survive a first
   * read that took longer than the window.
   */
  const firedIds = useRef<Set<string>>(new Set());

  /**
   * A new session starts a new baseline, and it must be established BEFORE anything
   * this render records into it.
   *
   * Declared first on purpose. When the session id and a fire arrive in the same
   * commit — a replayed pre-ready `timer:fired`, or a reconnect that lands both at
   * once — effects run in declaration order, so a reset living further down would wipe
   * the fire that the effect above it had just recorded and silently baseline its
   * outcome. Ordering is the whole mechanism; do not fold this back into the announce
   * effect.
   */
  useEffect(() => {
    if (session.current === sessionId) return;
    session.current = sessionId;
    seen.current = null;
    firedIds.current = new Set();
  }, [sessionId]);

  /**
   * Read the list once, up front, so a baseline exists BEFORE anything can fire.
   *
   * Without this the list was fetched lazily — only when a fire marked it stale, or
   * when someone opened the deck — which meant the common case for a session's first
   * timer was that its own fire triggered the very first read. One cheap local read on
   * arrival makes that the rare case instead of the guaranteed one; `firedAt` below
   * still covers the race where a timer beats the answer back.
   */
  useEffect(() => {
    if (sessionId) requestTimers();
  }, [sessionId, requestTimers]);

  // A timer fired while nothing was showing the list. Re-read it, so the notification
  // below can say WHAT happened rather than only that something did — and remember
  // WHEN we were told, so a first reading that arrives carrying that fire can tell it
  // apart from the backlog it arrives alongside.
  useEffect(() => {
    if (!timersStale || !sessionId) return;
    for (const id of takeFiredTimerIds()) firedIds.current.add(id);
    requestTimers();
  }, [timersStale, sessionId, requestTimers, takeFiredTimerIds]);

  useEffect(() => {
    // The baseline reset lives in its own effect above, which runs first. Reading
    // `session.current` here would race it.
    if (!timers) return;

    const keys = new Set(timers.outcomes.map((o) => `${o.eventId}:${o.count}`));

    // The FIRST reading of a session is the baseline, announced to nobody. It is the
    // state of the world on arrival, not news — UNLESS we were told a timer fired and
    // this is the reading that answers it, in which case the fire's own outcome is the
    // one thing in here that IS news. Everything stamped before that signal is still
    // backlog and still goes in silently.
    if (seen.current === null) {
      const fired = firedIds.current;
      if (fired.size === 0) {
        seen.current = keys;
        return;
      }
      // Everything EXCEPT the outcomes belonging to a timer we were told fired goes
      // into the baseline silently. Those are the backlog; the rest is the news.
      seen.current = new Set(
        timers.outcomes.filter((o) => !fired.has(o.timerId)).map((o) => `${o.eventId}:${o.count}`)
      );
    }

    for (const outcome of timers.outcomes) {
      const key = `${outcome.eventId}:${outcome.count}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);

      const failed = outcome.severity === "error";
      // The panel's OWN strip, never the grid bar.
      //
      // Everything the assistant does stays inside the assistant. It can go and change
      // the world — spawn an agent, send a command — but its reporting belongs where the
      // conversation is, not on a surface that spans the whole window. A timer firing is
      // the assistant telling you about its own work, so it is told in its own place.
      //
      // A failure is a warning rather than an error: the timer did what it was asked, the
      // action it carried is what failed, and the panel's error level is reserved for the
      // session itself being broken.
      pushNotice(
        failed ? "warning" : "info",
        (failed ? "Scheduled timer failed: " : "Scheduled timer fired: ") +
          (outcome.summary || outcome.title)
      );
    }
    seen.current = keys;
  }, [timers, sessionId]);
}

/** Reads the pieces this hook needs straight off the store. */
export function useAssistantTimerNotificationsFromStore(requestTimers: () => void) {
  const timers = useAssistantStore((s) => s.timers);
  const timersStale = useAssistantStore((s) => s.timersStale);
  const sessionId = useAssistantStore((s) => s.sessionId);
  const takeFiredTimerIds = useAssistantStore((s) => s.takeFiredTimerIds);
  const pushNotice = useAssistantStore((s) => s.pushNotice);
  useAssistantTimerNotifications({
    timers,
    timersStale,
    sessionId,
    requestTimers,
    takeFiredTimerIds,
    pushNotice,
  });
}
