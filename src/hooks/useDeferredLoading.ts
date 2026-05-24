import { useState, useEffect, useRef } from "react";

import {
  UI_DOHERTY_THRESHOLD,
  UI_SKELETON_GATE_MS,
  UI_SKELETON_FLOOR_MS,
} from "@/lib/animationUtils";

export function useDeferredLoading(isPending: boolean, delay: number): boolean {
  const [showLoader, setShowLoader] = useState(isPending && delay <= 0);

  useEffect(() => {
    if (!isPending) {
      setShowLoader(false);
      return;
    }
    if (delay <= 0) {
      setShowLoader(true);
      return;
    }
    const timer = setTimeout(() => setShowLoader(true), delay);
    return () => clearTimeout(timer);
  }, [isPending, delay]);

  return showLoader;
}

export function useDohertyGate(isPending: boolean): boolean {
  return useDeferredLoading(isPending, UI_DOHERTY_THRESHOLD);
}

// NOTE: Never wire an animate-pulse-delayed skeleton as a Suspense fallback.
// React 19 hardcodes FALLBACK_THROTTLE_MS = 300 (react-reconciler/src/ReactFiberWorkLoop.js)
// and animate-pulse-delayed carries a 400ms CSS animation-delay. Stacked, a
// Suspense-wired skeleton produces a ~700ms blank dead-zone before the pulse is
// even visible, followed by a layout-shifting pop. Every Suspense in App.tsx
// uses fallback={null} — this note is preventive. If a real fallback is ever
// needed, defer with useTransition (which bypasses the throttle and keeps
// isPending true) rather than wiring a skeleton as the fallback.
export function useSkeletonGate(isPending: boolean): boolean {
  return useDeferredLoading(isPending, UI_SKELETON_GATE_MS);
}

/** Resolve the effective display floor, honoring the performance-mode bypass.
 *  Mirrors `getUiAnimationDuration`: performance mode collapses JS timers to 0
 *  so callers complete synchronously. Reduced-motion is intentionally NOT read
 *  here — CSS owns reduced-motion presentation, not JS timers. Reads
 *  `document.body` lazily (never at module load) for SSR/JSDOM safety. */
function getEffectiveFloor(floorMs: number): number {
  if (typeof document === "undefined") {
    return floorMs;
  }
  const performanceMode = document.body?.dataset.performanceMode === "true";
  return performanceMode ? 0 : floorMs;
}

/**
 * Hold a skeleton (or any loading placeholder) visible for at least `floorMs`
 * once it first shows, preventing a same-frame teardown flash when the
 * underlying work resolves just after the onset gate clears.
 *
 * Pairs with the onset gates (`useSkeletonGate` / `useDohertyGate`): those
 * suppress *early* display, this guarantees *minimum* display. Output goes
 * true the moment `isShowing` is true and stays true for the floor even if
 * `isShowing` flips back to false in the interim. Performance mode bypasses
 * the floor (mirrors `isShowing` immediately).
 */
export function useSkeletonDisplayFloor(
  isShowing: boolean,
  floorMs: number = UI_SKELETON_FLOOR_MS
): boolean {
  const [showing, setShowing] = useState(isShowing);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp the placeholder first became visible; the floor is measured from
  // here so re-renders and a true→false flap can't reset or escape it. Seeded
  // at mount so the floor still applies if isShowing flips false before the
  // first effect commits (standalone use without a paired onset gate).
  const shownAtRef = useRef<number | null>(isShowing ? Date.now() : null);

  useEffect(() => {
    const floor = getEffectiveFloor(floorMs);

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    // Bypass (performance mode / non-positive floor): mirror input directly.
    if (floor <= 0) {
      clearTimer();
      shownAtRef.current = null;
      setShowing(isShowing);
      return;
    }

    // Showing: reveal now, cancel any pending hide, and start the floor clock
    // on the first reveal (kept across re-renders so the floor stays anchored).
    if (isShowing) {
      clearTimer();
      if (shownAtRef.current === null) {
        shownAtRef.current = Date.now();
      }
      setShowing(true);
      return;
    }

    // Hiding while never shown: nothing to floor.
    if (shownAtRef.current === null) {
      setShowing(false);
      return;
    }

    // Hiding within the floor: hold for the remaining time, then release.
    const remaining = floor - (Date.now() - shownAtRef.current);
    if (remaining <= 0) {
      shownAtRef.current = null;
      setShowing(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      shownAtRef.current = null;
      setShowing(false);
    }, remaining);

    return clearTimer;
  }, [isShowing, floorMs]);

  return showing;
}

export function useSkeletonFloor(isShowing: boolean): boolean {
  return useSkeletonDisplayFloor(isShowing, UI_SKELETON_FLOOR_MS);
}
