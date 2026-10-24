import { useState } from "react";
import { formatCountdown } from "@/utils/formatCountdown";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";

// Per-tool grant expiry countdown. Re-renders once a second — a semantic
// countdown (the decay IS the signal), so it sits outside the motion tiers.
// The push event (`grant.expired`) is authoritative for removal; this is only
// the display, so reaching zero shows "expiring" until the row is pulled out.
export function GrantCountdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  // Per-second tick that pauses while the window is hidden (the canonical
  // compliant timer wrapper — direct setInterval is lint-restricted).
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000);
  const remainingMs = expiresAt - now;
  return (
    <span role="timer" className="font-mono text-text-secondary tabular-nums shrink-0">
      {remainingMs <= 0 ? "expiring" : `${formatCountdown(remainingMs / 1000)} left`}
    </span>
  );
}
