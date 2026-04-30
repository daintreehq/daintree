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
