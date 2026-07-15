import { useEffect, useRef, useState } from "react";
import type { PanelKind } from "@/types";
import type { TerminalActivityStatus } from "@shared/types/terminal";
import { isAgentTerminal, type RuntimeAgentIdentityInput } from "@/utils/terminalType";
import { UI_TRANSIENT_HINT_DWELL_MS, getPerformanceModeFloor } from "@/lib/animationUtils";

/**
 * Plain-terminal dock activity — a deliberately SEPARATE resolution path from
 * `getDockDisplayAgentState` (useDockBlockedState.ts), whose contract is locked
 * by dockAgentState.test.ts to keep terminal-only process activity out of the
 * agent dock state. This module surfaces that same activity for non-agent
 * chips instead of suppressing it.
 *
 * For plain shells the backend only ever emits `"working"` (a command is
 * running) or `"success"` (idle) — never `"waiting"`/`"failure"`, and there is
 * no exit-code tracking — so the display state is effectively binary. We ignore
 * the other two `TerminalActivityStatus` members rather than imply a
 * running/finished distinction the data can't support.
 */
export type DockDisplayActivityState = "working" | "success";

export interface DockActivityStateSource extends RuntimeAgentIdentityInput {
  activityStatus?: TerminalActivityStatus;
  kind?: PanelKind;
}

export function getDockDisplayActivityState(
  terminal: DockActivityStateSource
): DockDisplayActivityState | undefined {
  // Agents own the agent-state indicator; never double up on their chips.
  if (isAgentTerminal(terminal)) return undefined;
  if (terminal.activityStatus === "working") return "working";
  if (terminal.activityStatus === "success") return "success";
  return undefined;
}

/**
 * Group aggregate: any plain terminal running → "working"; else if at least one
 * plain terminal is idle/finished → "success"; else undefined. Agent tabs are
 * skipped (their state rides the agent path), mirroring how the group's blocked
 * highlight aggregates only agent-typed values in useDockBlockedState.ts.
 */
export function getGroupDockDisplayActivityState(
  terminals: ReadonlyArray<DockActivityStateSource>
): DockDisplayActivityState | undefined {
  let hasWorking = false;
  let hasSuccess = false;
  for (const terminal of terminals) {
    const state = getDockDisplayActivityState(terminal);
    if (state === "working") hasWorking = true;
    else if (state === "success") hasSuccess = true;
  }
  if (hasWorking) return "working";
  if (hasSuccess) return "success";
  return undefined;
}

/**
 * Identity of the plain terminals that FEED the group aggregate — the subject
 * the transient cue observes. Keyed on the contributing (non-agent) tabs' ids,
 * NOT the raw membership, so a running plain tab that gets agent-detected
 * mid-command (it drops out of the aggregate, flipping working→success) changes
 * this key and re-baselines the cue instead of flashing a false "finished". A
 * genuine working→success of the same members leaves the key unchanged, so real
 * completions still register.
 */
export function getGroupActivityScopeKey(
  terminals: ReadonlyArray<{ id: string } & DockActivityStateSource>
): string {
  const plainIds: string[] = [];
  for (const terminal of terminals) {
    if (getDockDisplayActivityState(terminal) !== undefined) plainIds.push(terminal.id);
  }
  return plainIds.sort().join("|");
}

/**
 * Renderer-local transient "finished" cue. There is no backend timestamp for
 * when `activityStatus` last changed (updateActivity just overwrites the
 * field), so a brief completion flash has to be derived here from a
 * `"working" → "success"` transition and held for a fixed dwell.
 *
 * `scopeKey` identifies the observed subject (a terminal id, or a group's
 * sorted membership). When it changes — a group gains/loses a tab, or the chip
 * is reused for a different terminal — we reset the baseline instead of reading
 * the membership change as a completion (closing a running tab must not flash
 * "finished").
 *
 * The dwell timeout is guarded by a generation counter (not bare clearTimeout
 * trust — see the codebase's "queued timer defeats effect cleanup" caution): a
 * callback the event loop already picked up checks its generation before hiding
 * the cue, so a rapid working→success→working→success flap can't let a stale
 * timer hide a newer cue. The render gate additionally requires the current
 * state to still be `"success"`, so a restart shows the spinner immediately.
 */
export function useTransientDockFinishedCue(
  activityState: DockDisplayActivityState | undefined,
  scopeKey: string
): boolean {
  // The cue carries the scope it was raised under so a membership change hides
  // it synchronously in render — before the passive effect commits — rather than
  // surfacing a stale cue for one frame under the new scope.
  const [finished, setFinished] = useState<{ shown: boolean; scope: string }>({
    shown: false,
    scope: scopeKey,
  });
  const prevStateRef = useRef<DockDisplayActivityState | undefined>(activityState);
  const prevScopeRef = useRef(scopeKey);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const prevScope = prevScopeRef.current;
    const prevState = prevStateRef.current;
    prevScopeRef.current = scopeKey;
    prevStateRef.current = activityState;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    // Subject changed (group membership / reused chip): re-baseline, never treat
    // it as a completion.
    if (prevScope !== scopeKey) {
      clearTimer();
      generationRef.current++;
      setFinished({ shown: false, scope: scopeKey });
      return;
    }

    // A command just finished: flash the cue for one dwell window.
    if (prevState === "working" && activityState === "success") {
      clearTimer();
      const generation = ++generationRef.current;
      setFinished({ shown: true, scope: scopeKey });
      timerRef.current = setTimeout(() => {
        // Only the newest completion may hide the cue.
        if (generationRef.current === generation) {
          setFinished({ shown: false, scope: scopeKey });
        }
      }, getPerformanceModeFloor(UI_TRANSIENT_HINT_DWELL_MS));
      return;
    }

    // Any restart (back to working) or unknown state invalidates a pending timer
    // and hides the cue immediately. A plain re-render that lands on "success"
    // without a working→success transition leaves the current cue untouched.
    if (activityState !== "success") {
      clearTimer();
      generationRef.current++;
      setFinished({ shown: false, scope: scopeKey });
    }
  }, [activityState, scopeKey]);

  useEffect(
    () => () => {
      // Invalidate any already-queued dwell callback so it can't fire a setter
      // after unmount, then clear the timer.
      generationRef.current++;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  // Working always wins over a lingering cue, even before the effect commits;
  // the scope guard drops a cue raised under a now-stale subject.
  return finished.shown && finished.scope === scopeKey && activityState === "success";
}
