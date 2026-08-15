import { useEffect, useState } from "react";

// 30-second cadence keeps minute-boundary refreshes within at most 30 s of
// the actual transition while only firing twice per minute.
const INTERVAL_MS = 30_000;

let globalTick = 0;
const listeners = new Set<(tick: number) => void>();
let intervalId: number | null = null;

function emitTick() {
  globalTick++;
  listeners.forEach((listener) => listener(globalTick));
}

function startGlobalTicker() {
  if (intervalId !== null) return;
  intervalId = window.setInterval(emitTick, INTERVAL_MS);
}

function stopGlobalTicker() {
  if (intervalId === null) return;
  clearInterval(intervalId);
  intervalId = null;
}

function handleVisibility() {
  if (document.hidden) {
    stopGlobalTicker();
  } else {
    emitTick();
    startGlobalTicker();
  }
}

export function useGlobalMinuteTicker(): number {
  const [tick, setTick] = useState(globalTick);

  useEffect(() => {
    listeners.add(setTick);
    if (listeners.size === 1) {
      document.addEventListener("visibilitychange", handleVisibility);
      if (!document.hidden) {
        startGlobalTicker();
      }
    }

    return () => {
      listeners.delete(setTick);
      if (listeners.size === 0) {
        stopGlobalTicker();
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, []);

  return tick;
}

/**
 * The shared ticker as a wall-clock timestamp, held in state (#11791).
 *
 * The distinction from reading `Date.now()` during render is the whole point.
 * React Compiler auto-memoizes components, so a clock read in a render body can
 * be cached and silently freeze; a clock kept in state is a tracked value, which
 * both re-runs the holder's own body on every tick and invalidates the memo of
 * any child it is passed to. Callers thread the result down as a prop rather
 * than re-reading the time further in.
 */
export function useGlobalMinuteClock(): number {
  const tick = useGlobalMinuteTicker();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
  }, [tick]);

  return nowMs;
}
