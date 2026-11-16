import { useLayoutEffect, useState } from "react";
import type { DeletedWorktree, DeletedWorktreeHoldReason } from "@/store/worktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";

/**
 * What a row says while its countdown is held. The visible label is what
 * carries the reason — it has to survive a narrow sidebar beside the title, so
 * it stays terse, and the tooltip expands it for anyone who wants the whole
 * sentence.
 */
export const DELETED_WORKTREE_HOLD_COPY: Record<
  DeletedWorktreeHoldReason,
  { label: string; tooltip: string }
> = {
  confirm: {
    label: "Confirming",
    tooltip: "Auto-close is paused while you confirm closing this row",
  },
  drag: {
    label: "Dragging",
    tooltip: "Auto-close is paused while a drag is in progress",
  },
  agent: {
    label: "Agent working",
    tooltip: "Auto-close is paused while an agent here is still working",
  },
};

export interface DeletedWorktreeCountdown {
  hasCountdown: boolean;
  hold: { label: string; tooltip: string } | undefined;
  remainingSeconds: number;
  /** 0..1 of the TTL left, snapped to 1 for the first moments after arming. */
  remainingFraction: number;
}

/**
 * Display-only view of a deleted row's auto-cleanup deadline
 * (`deletedWorktreeCleanup.ts` owns the deadline itself). Shared by the lone
 * card and the group's rail, so a held row reads the same wherever it shows.
 */
export function useDeletedWorktreeCountdown(worktree: DeletedWorktree): DeletedWorktreeCountdown {
  const cleanupSeconds = usePreferencesStore((s) => s.deletedWorktreeCleanupSeconds);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const expiresAt = worktree.expiresAt;
  const hasCountdown = expiresAt !== null && cleanupSeconds > 0;
  const hold =
    hasCountdown && worktree.holdReason !== null
      ? DELETED_WORKTREE_HOLD_COPY[worktree.holdReason]
      : undefined;
  // A held readout is frozen from captured state below, so ticking it would only
  // re-render for nothing (#17051).
  const isTicking = hasCountdown && hold === undefined;
  useVisibilityAwareInterval(() => setNowTick(Date.now()), 1000, isTicking);
  // Clamp to the TTL: the sweep arms the deadline off its own clock, so the
  // first tick after arming can otherwise read a whole second past full ("61s").
  const cleanupMs = cleanupSeconds * 1000;
  const rawRemainingMs = expiresAt !== null ? Math.max(0, expiresAt - nowTick) : 0;
  const derivedRemainingMs = cleanupMs > 0 ? Math.min(rawRemainingMs, cleanupMs) : rawRemainingMs;
  // While held, render the remaining captured when the hold began rather than
  // re-deriving it from the deadline. The sweep re-pins `expiresAt` to
  // `now + remaining` on every pass, and its phase is independent of this
  // tick, so each pins a value exactly one interval apart and the readout
  // alternates between N and N+1 forever — a held row visibly flips
  // 38s/37s/38s. Freezing is also the honest reading: a held countdown is not
  // advancing. The key follows the sweep's own capture: once per hold, again
  // only if the TTL preference changes underneath it, and never for a change of
  // reason alone (agent working, then a confirm opening), which the sweep
  // carries through on the same remaining.
  // Captured in state, not a ref: this value IS render output, and refs may not
  // be read or written during render (React Compiler enforces it). This is the
  // documented "adjust state when a prop changes" pattern — React re-runs the
  // component immediately, before paint, so no torn frame is observable.
  const holdKey = hold === undefined ? null : `held:${cleanupMs}`;
  // The clock stops while held, so it is resynced before paint whenever the
  // hold starts, re-keys or lifts; `clockKey` says which of those it was synced
  // for. A capture waits for that sync, so it never reads a deadline against
  // the stale `now` the hold left behind.
  const [clockKey, setClockKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!hasCountdown) return;
    setNowTick(Date.now());
    setClockKey(holdKey);
  }, [hasCountdown, holdKey]);
  const [heldRemaining, setHeldRemaining] = useState<{
    key: string;
    remainingMs: number;
  } | null>(null);
  if (holdKey === null) {
    if (heldRemaining !== null) setHeldRemaining(null);
  } else if (heldRemaining?.key !== holdKey && clockKey === holdKey) {
    setHeldRemaining({ key: holdKey, remainingMs: derivedRemainingMs });
  }
  // Until the capture lands, a re-keyed hold keeps showing what it captured
  // before, and a new hold the derived value (the clock was still running up
  // to it); either way the layout effect re-renders before paint.
  const remainingMs = heldRemaining !== null ? heldRemaining.remainingMs : derivedRemainingMs;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  // Snap the top of the range to exactly full: the tick that arms the row lands
  // somewhere inside the sweep's first second, so a bar that should read "just
  // deleted" would otherwise start a sliver short.
  const remainingFraction = hasCountdown
    ? remainingMs >= cleanupMs - 1500
      ? 1
      : Math.min(1, remainingMs / cleanupMs)
    : 0;

  return { hasCountdown, hold, remainingSeconds, remainingFraction };
}
