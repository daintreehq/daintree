import { useEffect, useRef } from "react";
import { logError } from "@/utils/logger";

/**
 * A phase-aligned poll tick shared by every subscriber on the same interval.
 *
 * `useVisibilityAwareInterval` gives each caller its own `setInterval`, so the
 * phase is set by whenever that component happened to mount and independent
 * pollers drift into arbitrary offsets. For per-second labels that is fine —
 * nothing downstream cares when the tick lands.
 *
 * It matters for filesystem polling. Main de-duplicates fingerprint reads for
 * requests that arrive close together (`FileObservationService.sampleCoalesced`),
 * so a window showing several file panes over one project only shares that work
 * if the panes actually ask at the same moment. Aligning them onto one ticker
 * turns "they coalesce when their timers happen to collide" into "they always
 * coalesce", without changing the polled model or any pane's change latency.
 *
 * Pausing and the fire-on-reveal edge match `useVisibilityAwareInterval`: a
 * hidden document polls nothing, and becoming visible samples immediately
 * rather than waiting out a full interval.
 */

interface SharedTicker {
  readonly subscribers: Set<() => void>;
  intervalId: ReturnType<typeof setInterval> | null;
  readonly onVisibilityChange: () => void;
}

/** Interval in ms → the single ticker driving every subscriber at that rate. */
const tickers = new Map<number, SharedTicker>();

function fire(ticker: SharedTicker): void {
  // Snapshot before dispatch: a subscriber unmounting in response to its own
  // tick would otherwise mutate the set mid-iteration.
  for (const subscriber of Array.from(ticker.subscribers)) {
    // ...but an entry the snapshot still holds may have been released by an
    // earlier callback in this same pass, and a released subscriber must not
    // be called again.
    if (!ticker.subscribers.has(subscriber)) continue;
    try {
      subscriber();
    } catch (error) {
      // One bad subscriber must not stop the rest of the window polling.
      logError("Shared poll tick subscriber threw", error);
    }
  }
}

function acquire(intervalMs: number, subscriber: () => void): () => void {
  let ticker = tickers.get(intervalMs);

  if (ticker === undefined) {
    const created: SharedTicker = {
      subscribers: new Set(),
      intervalId: null,
      onVisibilityChange: () => {
        if (document.hidden) {
          stopInterval(created);
          return;
        }
        fire(created);
        // `fire` runs subscriber callbacks synchronously, and one of them may
        // release the last subscription — which tears this ticker down and
        // unregisters this very listener. Restarting unconditionally would
        // then leave an interval running on a detached ticker with nothing to
        // notify and no way to reach it again, and the map would report
        // nothing wrong.
        if (tickers.get(intervalMs) !== created || created.subscribers.size === 0) return;
        startInterval(created, intervalMs);
      },
    };
    document.addEventListener("visibilitychange", created.onVisibilityChange);
    ticker = created;
    tickers.set(intervalMs, created);
  }

  const owner = ticker;
  owner.subscribers.add(subscriber);
  if (!document.hidden) startInterval(owner, intervalMs);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    owner.subscribers.delete(subscriber);
    if (owner.subscribers.size > 0) return;
    stopInterval(owner);
    document.removeEventListener("visibilitychange", owner.onVisibilityChange);
    // Only drop the entry if it is still the live one for this interval.
    if (tickers.get(intervalMs) === owner) tickers.delete(intervalMs);
  };
}

function startInterval(ticker: SharedTicker, intervalMs: number): void {
  if (ticker.intervalId !== null) return;
  ticker.intervalId = setInterval(() => fire(ticker), intervalMs);
}

function stopInterval(ticker: SharedTicker): void {
  if (ticker.intervalId === null) return;
  clearInterval(ticker.intervalId);
  ticker.intervalId = null;
}

export function useSharedPollTick(callback: () => void, intervalMs: number, enabled = true): void {
  // Kept in a ref so a caller passing an inline closure does not re-subscribe
  // (and so re-phase the shared ticker) on every render.
  const savedCallback = useRef(callback);
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;
    return acquire(intervalMs, () => savedCallback.current());
  }, [intervalMs, enabled]);
}

/**
 * Live ticker count. Diagnostics and tests only.
 *
 * Note this counts registered tickers, so it cannot by itself prove the absence
 * of a leak: an interval left running on a ticker already dropped from the map
 * would not appear here. A leak test has to assert on the environment's live
 * timer count.
 */
export function sharedPollTickerCount(): number {
  return tickers.size;
}
