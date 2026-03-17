import { useEffect, useState } from "react";

let globalTick = 0;
const listeners = new Set<(tick: number) => void>();
let intervalId: number | null = null;

function emitTick() {
  globalTick++;
  listeners.forEach((listener) => listener(globalTick));
}

function startGlobalTicker() {
  if (intervalId !== null) return;
  intervalId = window.setInterval(emitTick, 1000);
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

export function useGlobalSecondTicker(): number {
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
