import { useState } from "react";
import { formatCountdown } from "@/utils/formatCountdown";
import { grantDeadline } from "@/utils/grantDeadline";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";

// Grant expiry countdown. Re-renders once a second — a semantic countdown (the
// decay IS the signal), so it sits outside the motion tiers. It counts to the
// earlier of the sliding expiry and the 30-minute ceiling, and the parent's
// re-read on each use's `grant.refreshed` push moves it (#14998). The push
// event (`grant.expired`) is authoritative for removal; this is only the
// display, so reaching zero shows "expiring" until the row is pulled out.
export function GrantCountdown({
  expiresAt,
  maxExpiresAt,
}: {
  expiresAt: number;
  maxExpiresAt?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  // Per-second tick that pauses while the window is hidden (the canonical
  // compliant timer wrapper — direct setInterval is lint-restricted).
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000);
  const { endsAt, atCeiling } = grantDeadline(expiresAt, maxExpiresAt);
  const remainingMs = endsAt - now;
  return (
    <span role="timer" className="font-mono text-text-secondary tabular-nums shrink-0">
      {remainingMs <= 0
        ? "expiring"
        : `${formatCountdown(remainingMs / 1000)} left${atCeiling ? " · 30-minute limit" : ""}`}
    </span>
  );
}
