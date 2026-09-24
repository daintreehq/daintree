import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getPanelTransitionDuration,
  PANEL_MINIMIZE_EASING,
  PANEL_RESTORE_EASING,
  UI_ANIMATION_DURATION,
} from "@/lib/animationUtils";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";

export type TransitionDirection = "minimize" | "restore";

export interface TransitionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the ghost lands. A function is resolved once the move has committed and
 * again on every frame of the flight, so the ghost aims at the element the pane
 * actually became (its dock chip, its grid slot) and follows it if it moves —
 * a chip inserted before it, a grid that scrolls the restored pane into view.
 * Returning `null` means "not there": before launch that waits a few frames,
 * during the flight it calls the flight off. Returning an element (rather than a
 * bare box) also lets a minimize mark the chip that received the pane.
 */
export type TransitionTarget = TransitionRect | (() => Element | TransitionRect | null);

interface TransitionState {
  key: number;
  id: string;
  /** What a newer flight supersedes — the pane, or the tab group it moves with. */
  identity: string;
  title: string;
  direction: TransitionDirection;
  sourceRect: TransitionRect;
  target: TransitionTarget;
}

interface PanelTransitionOverlayProps {
  onTransitionComplete?: (id: string) => void;
}

/**
 * Frames to wait for a lazily-resolved target before giving up on the flight. A
 * move run inside a view transition commits a frame or two late.
 */
const TARGET_RESOLVE_FRAMES = 8;

/** Id every animation this overlay starts carries, so a harness can find them all. */
export const PANEL_TRANSITION_ANIMATION_ID = "panel-transition";

type Stops = Array<[offset: number, opacity: number]>;

/**
 * Opacity runs on the clock, not on the geometry's easing: the geometry curves are
 * steep at one end, and fades keyed to them would spend the ghost's visibility in
 * a few milliseconds.
 *
 * Minimize is an exit: the ghost stays solid while it travels and dissolves into
 * the chip in the last stretch. Restore grows out of the chip already solid (the
 * chip has just gone), sheds its title first so it never doubles the real pane's
 * header, and hands over to the pane underneath before the clock runs out.
 */
const CONTAINER_OPACITY: Record<TransitionDirection, Stops> = {
  minimize: [
    [0, 1],
    [0.8, 1],
    [1, 0],
  ],
  restore: [
    [0, 1],
    [0.3, 1],
    [0.75, 0],
    [1, 0],
  ],
};

const TITLE_OPACITY: Partial<Record<TransitionDirection, Stops>> = {
  restore: [
    [0, 1],
    [0.3, 0],
    [1, 0],
  ],
};

const RECEIVING_CUE_SHADOW = "0 0 0 1px var(--color-border-strong)";
const NO_CUE_SHADOW = "0 0 0 1px transparent";

type TransitionListener = (transition: TransitionState) => void;
const listeners = new Set<TransitionListener>();
let nextKey = 0;

function hasArea(rect: TransitionRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function toStops(stops: Stops): Keyframe[] {
  return stops.map(([offset, opacity]) => ({ offset, opacity }));
}

export function triggerPanelTransition(
  id: string,
  direction: TransitionDirection,
  sourceRect: TransitionRect,
  target: TransitionTarget,
  title = "",
  identity = id
): void {
  if (prefersReducedMotion()) return;
  // A zero-size box has nothing to show, and would put NaN into the keyframes.
  if (!hasArea(sourceRect)) return;
  if (typeof target !== "function" && !hasArea(target)) return;

  const transition: TransitionState = {
    key: ++nextKey,
    id,
    identity,
    title,
    direction,
    sourceRect,
    target,
  };
  listeners.forEach((listener) => listener(transition));
}

export function PanelTransitionOverlay({ onTransitionComplete }: PanelTransitionOverlayProps) {
  const [transitions, setTransitions] = useState<TransitionState[]>([]);
  const onCompleteRef = useRef(onTransitionComplete);

  useEffect(() => {
    onCompleteRef.current = onTransitionComplete;
  }, [onTransitionComplete]);

  useEffect(() => {
    const handleTransition = (transition: TransitionState) => {
      // A newer flight for the same pane or group supersedes the old one;
      // unrelated flights keep going.
      setTransitions((prev) => [
        ...prev.filter((t) => t.identity !== transition.identity),
        transition,
      ]);
    };
    listeners.add(handleTransition);
    return () => {
      listeners.delete(handleTransition);
    };
  }, []);

  const handleDone = useCallback((key: number, id: string, landed: boolean) => {
    setTransitions((prev) => prev.filter((t) => t.key !== key));
    if (landed) onCompleteRef.current?.(id);
  }, []);

  if (transitions.length === 0) return null;

  return createPortal(
    <div
      data-panel-transition-overlay
      className="fixed inset-0 pointer-events-none z-[var(--z-visual-bell)]"
      aria-hidden="true"
    >
      {transitions.map((transition) => (
        <TransitionGhost key={transition.key} transition={transition} onDone={handleDone} />
      ))}
    </div>,
    document.body
  );
}

interface TransitionGhostProps {
  transition: TransitionState;
  onDone: (key: number, id: string, landed: boolean) => void;
}

function toBox(rect: TransitionRect) {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

interface Resolved {
  rect: TransitionRect;
  element: Element | null;
}

function resolveTarget(target: TransitionTarget): Resolved | null {
  const value = typeof target === "function" ? target() : target;
  if (!value) return null;
  if (value instanceof Element) {
    const { x, y, width, height } = value.getBoundingClientRect();
    const rect = { x, y, width, height };
    return hasArea(rect) ? { rect, element: value } : null;
  }
  return hasArea(value) ? { rect: value, element: null } : null;
}

function sameRect(a: TransitionRect, b: TransitionRect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

function TransitionGhost({ transition, onDone }: TransitionGhostProps) {
  const { key, id, direction, sourceRect, target, title } = transition;
  const elementRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);

  // Layout effect, not a passive one: the flight is armed before the first
  // paint, so the ghost is never seen at a size it was not meant to have.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const duration = getPanelTransitionDuration(direction);
    const easing = direction === "minimize" ? PANEL_MINIMIZE_EASING : PANEL_RESTORE_EASING;
    const from = toBox(sourceRect);
    let frame = 0;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let flight: Animation[] = [];
    let geometry: Animation | null = null;
    let cue: Animation | null = null;
    let settled = false;

    const settle = (landed: boolean) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      if (!landed) cue?.cancel();
      onDone(key, id, landed);
    };

    const markReceiver = (receiver: Element) => {
      // The chip snaps in before the ghost gets there; a neutral hairline around
      // it through the arrival names the exact destination before the ghost is
      // gone. Added to whatever shadow the chip already has, never replacing it.
      const total = duration + UI_ANIMATION_DURATION;
      cue = receiver.animate(
        [
          { offset: 0, boxShadow: NO_CUE_SHADOW },
          { offset: (duration * 0.5) / total, boxShadow: RECEIVING_CUE_SHADOW },
          { offset: duration / total, boxShadow: RECEIVING_CUE_SHADOW },
          { offset: 1, boxShadow: NO_CUE_SHADOW },
        ],
        { duration: total, easing: "linear", composite: "add" }
      );
      cue.id = PANEL_TRANSITION_ANIMATION_ID;
    };

    const track = (last: TransitionRect) => {
      frame = requestAnimationFrame(() => {
        if (settled || !geometry) return;
        const next = resolveTarget(target);
        if (!next) {
          flight.forEach((animation) => animation.cancel());
          return;
        }
        const effect = geometry.effect;
        if (!sameRect(next.rect, last) && effect instanceof KeyframeEffect) {
          // Re-aim without restarting the clock; the ghost bends toward the new
          // spot instead of snapping back to the start.
          effect.setKeyframes([from, toBox(next.rect)]);
        }
        track(next.rect);
      });
    };

    let attempts = 0;
    const launch = () => {
      const resolved = resolveTarget(target);
      if (!resolved) {
        if (++attempts < TARGET_RESOLVE_FRAMES) {
          frame = requestAnimationFrame(launch);
        } else {
          settle(false);
        }
        return;
      }
      const timing = { duration, fill: "both" as const };
      geometry = element.animate([from, toBox(resolved.rect)], { ...timing, easing });
      flight = [
        geometry,
        element.animate(toStops(CONTAINER_OPACITY[direction]), { ...timing, easing: "linear" }),
      ];
      const titleStops = TITLE_OPACITY[direction];
      if (titleStops && titleRef.current) {
        flight.push(titleRef.current.animate(toStops(titleStops), { ...timing, easing: "linear" }));
      }
      for (const animation of flight) animation.id = PANEL_TRANSITION_ANIMATION_ID;
      if (direction === "minimize" && resolved.element) markReceiver(resolved.element);

      geometry.finished.then(
        () => settle(true),
        () => settle(false)
      );
      // Belt and braces: a finished promise that never settles (a detached
      // element, a throttled background window) must not strand the ghost.
      fallback = setTimeout(() => settle(true), duration * 2);
      track(resolved.rect);
    };
    launch();

    return () => {
      // Torn down, not finished: whoever re-runs or unmounts this effect owns
      // what happens next, so the cancellations below must not report back.
      const interrupted = !settled;
      settled = true;
      cancelAnimationFrame(frame);
      if (fallback) clearTimeout(fallback);
      flight.forEach((animation) => animation.cancel());
      if (interrupted) cue?.cancel();
    };
  }, [key, id, direction, sourceRect, target, onDone]);

  return (
    <div
      ref={elementRef}
      data-panel-transition-ghost={direction}
      className="absolute flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border-strong bg-surface-panel shadow-overlay"
      // Parked at the source and invisible until the flight is armed, so a
      // flight that never finds its target is never seen at all.
      style={{ ...toBox(sourceRect), opacity: 0 }}
    >
      <div
        ref={titleRef}
        className="flex h-full max-h-8 shrink-0 items-center border-b border-divider px-3"
      >
        <span className="truncate text-xs text-text-secondary">{title}</span>
      </div>
    </div>
  );
}
