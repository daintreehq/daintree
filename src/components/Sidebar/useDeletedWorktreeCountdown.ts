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
  // A held readout shows the sweep's own held remaining, so ticking it would
  // only re-render for nothing (#17051). Resync before paint whenever the clock
  // starts again (arming, or a hold lifting): it slept, and the first frame must
  // not read the deadline the sweep re-pinned against a stale `now`.
  const isTicking = hasCountdown && hold === undefined;
  useVisibilityAwareInterval(() => setNowTick(Date.now()), 1000, isTicking);
  useLayoutEffect(() => {
    if (isTicking) setNowTick(Date.now());
  }, [isTicking]);
  // Clamp to the TTL: the sweep arms the deadline off its own clock, so the
  // first tick after arming can otherwise read a whole second past full ("61s").
  const cleanupMs = cleanupSeconds * 1000;
  const clampToTtl = (ms: number) => (cleanupMs > 0 ? Math.min(ms, cleanupMs) : ms);
  const rawRemainingMs = expiresAt !== null ? Math.max(0, expiresAt - nowTick) : 0;
  // While held, show the remaining the sweep is holding at rather than
  // re-deriving it from the deadline. The sweep re-pins `expiresAt` to
  // `now + remaining` on every pass, and its phase is independent of this
  // clock, so a derived readout alternates between N and N+1 forever — a held
  // row visibly flips 38s/37s/38s — and with the clock asleep it would read the
  // whole hold as time left. The sweep's value also follows what it alone
  // knows: a TTL change re-arms a full window, a change of reason keeps the
  // remaining, and cleanup switched off and on re-arms from scratch.
  const remainingMs =
    hold !== undefined && worktree.heldRemainingMs !== undefined
      ? clampToTtl(worktree.heldRemainingMs)
      : clampToTtl(rawRemainingMs);
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
