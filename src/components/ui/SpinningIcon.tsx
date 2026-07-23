import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPerformanceModeFloor, UI_SPIN_CYCLE_MS } from "@/lib/animationUtils";

interface SpinningIconProps extends Omit<LucideProps, "ref"> {
  /** The Lucide icon to render (e.g. `RefreshCw`). Rendered directly, so the
   *  spin runs on the same `<svg>` the call site would have rendered itself —
   *  no wrapping element, no changed transform origin. Must be a STABLE
   *  component identity: swapping `icon` mid-spin replaces the `<svg>` and
   *  restarts its animation from 0°. */
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
 * the `animate-spin` class is present continuously from press to boundary. The
 * ≥1-rotation guarantee holds for a spin that starts from rest and commits
 * `active: true` for at least one render (an entirely-batched true→false pulse
 * commits nothing and cannot spin — that is the caller's contract, satisfied by
 * the async loading flags every call site drives this with). Re-activating
 * during the finishing tail keeps the existing rotation going (smooth, never a
 * snap) rather than re-arming a fresh full-rotation debt for the new press.
 */
export function SpinningIcon({ icon: Icon, active, className, ...rest }: SpinningIconProps) {
  const [spinning, setSpinning] = useState(active);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A stop was requested (active went false) but we're waiting for the current
  // rotation to complete. Cleared when it does, or when active rises again.
  const stopRequestedRef = useRef(false);
  // Latest committed `spinning`, read by the falling-edge effect to decide
  // whether there is anything to gracefully stop.
  const spinningRef = useRef(spinning);

  // Mirror the latest committed `spinning` for the falling-edge effect below.
  // Declared first: layout effects run in declaration order within a commit, so
  // the mirror is current before the falling-edge effect reads it. No dep array
  // — it must also refresh on the flushSync(setSpinning(false)) commit from the
  // iteration handler. (A render-phase write would be simpler but violates the
  // Rules of React and is rejected by the React Compiler.)
  useLayoutEffect(() => {
    spinningRef.current = spinning;
  });

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
      // Only Tailwind's `spin` keyframe marks a rotation boundary — a second
      // looping animation on this SVG would otherwise stop the spin at its own
      // (arbitrary) phase. Plain Events (jsdom, which never runs CSS animations)
      // aren't AnimationEvents and pass through.
      if (
        typeof AnimationEvent !== "undefined" &&
        event instanceof AnimationEvent &&
        event.animationName !== "spin"
      ) {
        return;
      }
      if (!stopRequestedRef.current) return;
      stopRequestedRef.current = false;
      clearTimer();
      // Commit synchronously: `animationiteration` is not a discrete event, so a
      // scheduled update could remove the class a frame or two after the 0°
      // boundary, letting the compositor over-rotate and snap. flushSync drops
      // the class within this handler, before the next paint.
      flushSync(() => setSpinning(false));
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

  return <Icon {...rest} ref={setSvgRef} className={cn(className, spinning && "animate-spin")} />;
}
