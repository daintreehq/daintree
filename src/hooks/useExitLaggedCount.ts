import { useEffect, useState } from "react";

/**
 * Holds the last non-zero count so an element fading out via a presence
 * transition (e.g. `.dock-status-pill`) keeps showing its final value
 * instead of flashing "(0)" during the exit fade. Returns the live count
 * whenever it is non-zero.
 */
export function useExitLaggedCount(count: number): number {
  const [lastNonZero, setLastNonZero] = useState(count);

  useEffect(() => {
    if (count > 0) setLastNonZero(count);
  }, [count]);

  return count > 0 ? count : lastNonZero;
}
