import { useEffect, useRef, useState } from "react";
import { UI_FAILURE_SETTLE_MS } from "@/lib/animationUtils";
import { logWarn } from "@/utils/logger";

export type SidebarFailureKind = "service-error" | "load-error";

export interface SidebarFailure {
  kind: SidebarFailureKind;
  message: string;
}

interface TrackedFailure extends SidebarFailure {
  since: number;
  shown: boolean;
}

/**
 * True once a failure has stood continuously for `settleMs`, so a state that
 * reads as a failure only on the way to connecting never reaches the screen
 * (#14311). The clock runs on the presence of a failure, not its identity: one
 * failure handing over to another keeps it running, or a chain of short-lived
 * states could hold a real outage off screen indefinitely.
 *
 * Every candidate is logged with its message whether or not it is shown, so a
 * banner that would have flashed can still be identified after the fact.
 */
export function useSettledSidebarFailure(
  failure: SidebarFailure | null,
  settleMs: number = UI_FAILURE_SETTLE_MS
): boolean {
  const kind = failure?.kind ?? null;
  const message = failure?.message ?? null;
  const hasFailure = kind !== null;
  const [settled, setSettled] = useState(false);
  const trackedRef = useRef<TrackedFailure | null>(null);

  useEffect(() => {
    const prev = trackedRef.current;
    if (kind === null || message === null) {
      if (prev !== null) {
        trackedRef.current = null;
        logWarn("Worktree sidebar failure cleared", {
          kind: prev.kind,
          message: prev.message,
          elapsedMs: Date.now() - prev.since,
          shown: prev.shown,
        });
      }
      return;
    }
    if (prev !== null && prev.kind === kind && prev.message === message) return;
    trackedRef.current = {
      kind,
      message,
      since: prev?.since ?? Date.now(),
      shown: prev?.shown ?? false,
    };
    logWarn("Worktree sidebar failure pending", { kind, message, settleMs });
  }, [kind, message, settleMs]);

  useEffect(() => {
    if (!hasFailure) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => {
      setSettled(true);
      const tracked = trackedRef.current;
      if (tracked === null) return;
      tracked.shown = true;
      logWarn("Worktree sidebar failure banner shown", {
        kind: tracked.kind,
        message: tracked.message,
        elapsedMs: Date.now() - tracked.since,
      });
    }, settleMs);
    return () => clearTimeout(timer);
  }, [hasFailure, settleMs]);

  // `settled` resets a commit after the failure clears.
  return hasFailure && settled;
}
