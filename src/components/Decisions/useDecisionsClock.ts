import { useEffect, useState } from "react";
import { scheduleFlip } from "@/utils/flipScheduler";
import { deadlineMs, nextDeadlineChange } from "./decisionDeadline";

/**
 * Calls `refresh` whenever the wall clock may have jumped without a timer
 * firing: the machine woke (a timer armed before a sleep fires late, since
 * its clock doesn't run while asleep) or the window came back. Returns the stop.
 */
export function onClockJump(refresh: () => void): () => void {
  const offWake = window.electron?.systemSleep?.onWake?.(refresh);
  window.addEventListener("focus", refresh);
  return () => {
    offWake?.();
    window.removeEventListener("focus", refresh);
  };
}

/**
 * The time a surface showing Decisions deadlines renders from (#17943): read
 * as it mounts and whenever its deadlines change, then again only when what
 * one of them shows changes next (its time left, its row coming within a day,
 * or its passing) and after the machine wakes or the window comes back.
 * Never every second, and never in render, where React Compiler would keep
 * the first reading. While `active` is false nothing is scheduled.
 */
export function useDecisionsClock(
  deadlines: readonly (string | null | undefined)[],
  active = true
): number {
  const key = deadlines
    .map(deadlineMs)
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b)
    .join(",");
  const [reading, setReading] = useState(() => ({ key, now: Date.now() }));
  if (reading.key !== key) {
    // New deadlines are a new observation; read in the updater, never in render.
    setReading(() => ({ key, now: Date.now() }));
  }
  const { now } = reading;

  useEffect(() => {
    if (!active) return;
    const refresh = () => setReading({ key, now: Date.now() });
    const at = key === "" ? [] : key.split(",").map(Number);
    const delay = nextDeadlineChange(at, now);
    const offFlip = delay === null ? null : scheduleFlip(delay, refresh);
    const offJump = onClockJump(refresh);
    return () => {
      offFlip?.();
      offJump();
    };
  }, [key, now, active]);

  return now;
}

/** The longest a browser timer waits; a later deadline is checked again after this. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The time, moved on as `expiresAt` passes (or once the machine wakes or the
 * window comes back while it's still ahead), so a composer stops offering to
 * send then. Nothing ticks before it, and nothing once it has passed.
 */
export function useDeadlineClock(expiresAt: string | null): number {
  const [reading, setReading] = useState(() => ({ key: expiresAt, now: Date.now() }));
  if (reading.key !== expiresAt) {
    setReading(() => ({ key: expiresAt, now: Date.now() }));
  }
  const { now } = reading;

  useEffect(() => {
    const at = deadlineMs(expiresAt);
    // Nothing left to wait for once a render has seen it pass.
    if (at === null || now >= at) return;
    const refresh = () => setReading({ key: expiresAt, now: Date.now() });
    const timer = setTimeout(refresh, Math.min(Math.max(0, at - now) + 1, MAX_TIMER_MS));
    const offJump = onClockJump(refresh);
    return () => {
      clearTimeout(timer);
      offJump();
    };
  }, [expiresAt, now]);

  return now;
}
