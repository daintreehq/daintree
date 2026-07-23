import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPerformanceModeFloor, UI_SPIN_CYCLE_MS } from "@/lib/animationUtils";

interface SpinningIconProps extends Omit<LucideProps, "ref"> {
  /** The Lucide icon to render (e.g. `RefreshCw`). Rendered directly, so the
   *  spin runs on the same `<svg>` the call site would have rendered itself —
   *  no wrapping element, no changed transform origin. */
  icon: LucideIcon;
  /** True while the underlying operation is running. Drives the spin. */
  active: boolean;
}

/**
 * A refresh/reload icon that spins correctly: it always plays at least one full
 * rotation, keeps spinning while `active`, and — crucially — finishes the
 * current rotation before stopping rather than snapping back to 0°.
 *
 * The stop is driven by the icon's own `animationiteration` DOM event, not a
 * wall-clock timer: the class is removed only at a true 360° boundary (visually
 * identical to 0°), and the compositor's animation clock stays correct even when
 * Chromium throttles background tabs. Requirement mapping:
 *   - "≥1 full rotation even if the op resolves instantly": `spinning` is only
 *     ever lowered at an iteration boundary or the backstop, so a same-tick
 *     `active` true→false still runs a whole turn.
 *   - "keep spinning while running": `active` holds `spinning` true.
 *   - "finish the current rotation, never snap": the falling edge NEVER lowers
 *     `spinning` in render — it only requests a stop at the next boundary.
 *   - "never stuck forever": a one-shot backstop timer clears the spin when the
 *     CSS animation is suppressed (reduced-motion / performance mode) and no
 *     `animationiteration` event will ever fire.
 *
 * `spinning` is set true only by the rising-edge layout effect and false only by
 * the iteration handler or the backstop — never transiently during a render, so
 * the `animate-spin` class is present continuously from press to boundary.
 */
export function SpinningIcon({ icon: Icon, active, className, ...rest }: SpinningIconProps) {
  const [spinning, setSpinning] = useState(active);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A stop was requested (active went false) but we're waiting for the current
  // rotation to complete. Cleared when it does, or when active rises again.
  const stopRequestedRef = useRef(false);
  // Latest committed `spinning`, read by the falling-edge effect to decide
  // whether there is anything to gracefully stop. Written during render so it is
  // current by the time the layout effect runs.
  const spinningRef = useRef(spinning);
  spinningRef.current = spinning;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleIteration = useCallback(
    (event: Event) => {
      // Ignore a bubbling animation from a descendant or from a stale node that
      // has already been swapped out.
      if (event.target !== svgRef.current) return;
      if (!stopRequestedRef.current) return;
      stopRequestedRef.current = false;
      clearTimer();
      setSpinning(false);
    },
    [clearTimer]
  );

  const setSvgRef = useCallback(
    (node: SVGSVGElement | null) => {
      const previous = svgRef.current;
      if (previous && previous !== node) {
        previous.removeEventListener("animationiteration", handleIteration);
      }
      svgRef.current = node;
      if (node) node.addEventListener("animationiteration", handleIteration);
    },
    [handleIteration]
  );

  useLayoutEffect(() => {
    if (active) {
      // Rising edge (or re-activation during the finishing tail): cancel any
      // pending graceful stop and make sure we're spinning.
      stopRequestedRef.current = false;
      clearTimer();
      setSpinning(true);
      return;
    }
    // Falling edge: keep the class on (do NOT lower `spinning` here, or the
    // animation would restart at 0° and snap). Request a stop at the next
    // rotation boundary and arm a backstop for the case where the CSS animation
    // is suppressed (reduced-motion / performance mode) and no boundary fires.
    if (!spinningRef.current) return;
    stopRequestedRef.current = true;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // A re-activation may have cancelled the stop between arming and firing.
      if (!stopRequestedRef.current) return;
      stopRequestedRef.current = false;
      setSpinning(false);
    }, getPerformanceModeFloor(UI_SPIN_CYCLE_MS));
  }, [active, clearTimer]);

  useLayoutEffect(() => () => clearTimer(), [clearTimer]);

  return <Icon ref={setSvgRef} className={cn(className, spinning && "animate-spin")} {...rest} />;
}
