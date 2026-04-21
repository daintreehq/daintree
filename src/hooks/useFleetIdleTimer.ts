import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetIdleStore } from "@/store/fleetIdleStore";

/** Idle timeout before showing the "Still broadcasting?" warning strip. */
export const FLEET_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Grace period after the warning strip appears before auto-exiting. */
export const FLEET_IDLE_GRACE_MS = 2 * 60 * 1000;
/** Reschedule delay when confirming/submitting blocks an auto-exit. */
export const FLEET_IDLE_RESCHEDULE_MS = 30 * 1000;
/** Maximum confirm/submit-driven reschedules before auto-exiting regardless. */
export const FLEET_IDLE_MAX_RETRIES = 2;

interface UseFleetIdleTimerOptions {
  isConfirmingRef: RefObject<boolean>;
  isSubmittingRef: RefObject<boolean>;
  isDryRunOpenRef: RefObject<boolean>;
}

interface UseFleetIdleTimerResult {
  /** Reset both timers and return to idle phase. Call on any activity signal. */
  resetIdleTimer: () => void;
  /** Clear the armed set immediately (user clicked "Exit"). */
  exitNow: () => void;
}

const noop = () => {};

/**
 * Two-phase idle timer for broadcast mode:
 *   1. After FLEET_IDLE_TIMEOUT_MS with no activity → warning phase (UI renders strip)
 *   2. After FLEET_IDLE_GRACE_MS more → auto-exit (clear armed set)
 *
 * Activity is signalled by the component (typing, focus, arm-changes, sends).
 * When confirming/submitting/dry-run is active at grace-fire time, the exit is
 * deferred by FLEET_IDLE_RESCHEDULE_MS, up to FLEET_IDLE_MAX_RETRIES before
 * forcing exit.
 *
 * Timer IDs live in refs (not Zustand) to avoid stale closures and cross-instance
 * collisions. Store state (`phase`) only drives UI rendering. The retry callback
 * is a hoisted `function` declaration (not `const`) so it can reference itself
 * for recursive rescheduling without tripping React Compiler's TDZ analysis.
 */
export function useFleetIdleTimer(options: UseFleetIdleTimerOptions): UseFleetIdleTimerResult {
  const { isConfirmingRef, isSubmittingRef, isDryRunOpenRef } = options;

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef<number>(0);
  const scheduleIdleRef = useRef<() => void>(noop);
  const clearTimersRef = useRef<() => void>(noop);

  useEffect(() => {
    function clearTimers() {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (graceTimerRef.current !== null) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
    }

    function fireGrace() {
      graceTimerRef.current = null;
      // Defer auto-exit if the user is mid-confirmation, a send is in flight,
      // or the dry-run preview dialog is open — those are explicit attention.
      // Cap reschedules to avoid zombie deferrals.
      if (
        (isConfirmingRef.current || isSubmittingRef.current || isDryRunOpenRef.current) &&
        retryCountRef.current < FLEET_IDLE_MAX_RETRIES
      ) {
        retryCountRef.current += 1;
        graceTimerRef.current = setTimeout(fireGrace, FLEET_IDLE_RESCHEDULE_MS);
        return;
      }
      useFleetIdleStore.getState().reset();
      useFleetArmingStore.getState().clear();
    }

    function scheduleIdle() {
      clearTimers();
      retryCountRef.current = 0;
      useFleetIdleStore.getState().reset();
      // Defensive: never schedule a timer that could transition state while no
      // agents are armed. Callers are expected to only call us while armed, but
      // this guard prevents a stray warning if the component ever mounts empty.
      if (useFleetArmingStore.getState().armedIds.size === 0) return;
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        useFleetIdleStore.getState().enterWarning(Date.now());
        graceTimerRef.current = setTimeout(fireGrace, FLEET_IDLE_GRACE_MS);
      }, FLEET_IDLE_TIMEOUT_MS);
    }

    scheduleIdleRef.current = scheduleIdle;
    clearTimersRef.current = clearTimers;

    scheduleIdle();

    const unsubscribe = useFleetArmingStore.subscribe((state, prev) => {
      if (state.armedIds === prev.armedIds) return;
      if (state.armedIds.size === 0) {
        clearTimers();
        useFleetIdleStore.getState().reset();
        return;
      }
      scheduleIdle();
    });

    return () => {
      unsubscribe();
      clearTimers();
      useFleetIdleStore.getState().reset();
      scheduleIdleRef.current = noop;
      clearTimersRef.current = noop;
    };
  }, [isConfirmingRef, isSubmittingRef, isDryRunOpenRef]);

  const resetIdleTimer = useCallback(() => {
    if (useFleetArmingStore.getState().armedIds.size === 0) return;
    scheduleIdleRef.current();
  }, []);

  const exitNow = useCallback(() => {
    clearTimersRef.current();
    useFleetIdleStore.getState().reset();
    useFleetArmingStore.getState().clear();
  }, []);

  return { resetIdleTimer, exitNow };
}
