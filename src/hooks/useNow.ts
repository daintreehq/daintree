import { useEffect, useState } from "react";

const DEFAULT_TICK_MS = 30_000;

/**
 * The wall clock on a slow tick, so an age or a staleness check keeps moving
 * while nothing else re-renders. Stands still while `active` is false.
 */
export function useNow(active = true, tickMs = DEFAULT_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [active, tickMs]);
  return now;
}
