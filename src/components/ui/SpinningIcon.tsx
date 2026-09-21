import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPerformanceModeFloor, UI_SPIN_CYCLE_MS } from "@/lib/animationUtils";

interface SpinningIconProps extends Omit<LucideProps, "ref"> {
  /** The Lucide icon to render (e.g. `RefreshCw`). Every other prop, including
   *  `className`, goes to its `<svg>` unchanged. */
  icon: LucideIcon;
  /** True while the underlying operation is running. Drives the spin. */
  active: boolean;
  /** Classes for the wrapper that rotates. Placement such as margins belongs
   *  here rather than on the icon: a margin inside the rotating box would move
   *  its centre off the glyph. */
  wrapperClassName?: string;
}

/**
 * A refresh/reload icon that spins correctly: it always plays at least one full
 * rotation, keeps spinning while `active`, and — crucially — finishes the
 * current rotation before stopping rather than snapping back to 0°.
 *
 * The rotation runs on an HTML wrapper, not the `<svg>`: Chromium cannot run a
 * transform animation on the compositor when its target is an svg, so it
 * re-runs style on the main thread every frame for as long as the icon spins
 * (#12584). Wrapped, the same spin composites.
 *
 * The stop is driven by the wrapper's own `animationiteration` DOM event, not a
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
export function SpinningIcon({
  icon: Icon,
  active,
  className,
  wrapperClassName,
  ...rest
}: SpinningIconProps) {
  const [spinning, setSpinning] = useState(active);

  const wrapperRef = useRef<HTMLSpanElement | null>(null);
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
      if (event.target !== wrapperRef.current) return;
      // Only Tailwind's `spin` keyframe marks a rotation boundary — a second
      // looping animation on this wrapper would otherwise stop the spin at its own
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

  const setWrapperRef = useCallback(
    (node: HTMLSpanElement | null) => {
      const previous = wrapperRef.current;
      if (previous && previous !== node) {
        previous.removeEventListener("animationiteration", handleIteration);
      }
      wrapperRef.current = node;
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

  return (
    // Block-level and shrink-wrapped, like the `display: block` svg it wraps:
    // an inline box would add a line box to buttons that are not flex
    // containers, and a full-width one would rotate about the wrong centre.
    <span
      ref={setWrapperRef}
      className={cn("flex w-fit shrink-0", wrapperClassName, spinning && "animate-spin")}
    >
      <Icon {...rest} className={className} />
    </span>
  );
}
