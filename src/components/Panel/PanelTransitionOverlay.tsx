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

/**
 * The receiving cue's opacity across the flight plus one state-change tier: it
 * rises while the ghost is still on its way, holds through the arrival, and
 * fades once the ghost has gone. Offsets are fractions of the flight, rescaled
 * onto the cue's longer clock when it is armed.
 */
const CUE_STOPS_IN_FLIGHT: Stops = [
  [0, 0],
  [0.5, 1],
  [1, 1],
];

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
  /** The destination's own corner radius, so the ghost lands with its shape. */
  radius: string | null;
}

function resolveTarget(target: TransitionTarget): Resolved | null {
  const value = typeof target === "function" ? target() : target;
  if (!value) return null;
  if (value instanceof Element) {
    const { x, y, width, height } = value.getBoundingClientRect();
    const rect = { x, y, width, height };
    const radius = getComputedStyle(value).borderTopLeftRadius || null;
    return hasArea(rect) ? { rect, radius } : null;
  }
  return hasArea(value) ? { rect: value, radius: null } : null;
}

function withRadius(rect: TransitionRect, radius: string | null) {
  return radius ? { ...toBox(rect), borderRadius: radius } : toBox(rect);
}

/**
 * The start box that puts a straight [start, end] flight at `current` when
 * `progress` of the way there. Re-aiming with it keeps the ghost where it is on
 * screen and bends the rest of its path to the new end, on the same curve and
 * the same deadline.
 */
function reanchor(current: TransitionRect, end: TransitionRect, progress: number): TransitionRect {
  const solve = (c: number, e: number) => (c - e * progress) / (1 - progress);
  return {
    x: solve(current.x, end.x),
    y: solve(current.y, end.y),
    width: solve(current.width, end.width),
    height: solve(current.height, end.height),
  };
}

function lerpRect(a: TransitionRect, b: TransitionRect, t: number): TransitionRect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t,
  };
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
  const cueRef = useRef<HTMLDivElement>(null);

  // Layout effect, not a passive one: the flight is armed before the first
  // paint, so the ghost is never seen at a size it was not meant to have.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const duration = getPanelTransitionDuration(direction);
    const easing = direction === "minimize" ? PANEL_MINIMIZE_EASING : PANEL_RESTORE_EASING;
    // The ghost starts with its own (the pane's) radius; spelled out so a
    // landing radius has something to interpolate from.
    const startRadius = getComputedStyle(element).borderTopLeftRadius;
    let start = sourceRect;
    let end = sourceRect;
    let endRadius: string | null = null;
    let frame = 0;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let animations: Animation[] = [];
    let geometry: Animation | null = null;
    let settled = false;

    const settle = (landed: boolean) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      onDone(key, id, landed);
    };

    const placeCue = (rect: TransitionRect, radius: string | null) => {
      const cue = cueRef.current;
      if (!cue) return;
      Object.assign(cue.style, toBox(rect), radius ? { borderRadius: radius } : {});
    };

    const track = () => {
      frame = requestAnimationFrame(() => {
        if (settled || !geometry) return;
        const next = resolveTarget(target);
        if (!next) {
          animations.forEach((animation) => animation.cancel());
          return;
        }
        placeCue(next.rect, next.radius);
        const effect = geometry.effect;
        const progress = effect?.getComputedTiming().progress;
        if (
          !sameRect(next.rect, end) &&
          effect instanceof KeyframeEffect &&
          typeof progress === "number" &&
          progress < 1
        ) {
          // Re-aim without restarting the clock or moving the ghost: solve for
          // the start that puts the new path through where it is right now.
          start = reanchor(lerpRect(start, end, progress), next.rect, progress);
          end = next.rect;
          effect.setKeyframes([
            withRadius(start, startRadius),
            withRadius(end, next.radius ?? endRadius),
          ]);
        }
        track();
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
      end = resolved.rect;
      endRadius = resolved.radius;
      const timing = { duration, fill: "both" as const };
      geometry = element.animate([withRadius(start, startRadius), withRadius(end, endRadius)], {
        ...timing,
        easing,
      });
      animations = [
        geometry,
        element.animate(toStops(CONTAINER_OPACITY[direction]), { ...timing, easing: "linear" }),
      ];
      const titleStops = TITLE_OPACITY[direction];
      if (titleStops && titleRef.current) {
        animations.push(
          titleRef.current.animate(toStops(titleStops), { ...timing, easing: "linear" })
        );
      }
      // A minimized pane becomes a chip the ghost only reaches as it dissolves,
      // so a hairline on the chip names the exact destination before the ghost
      // is gone. It is drawn here rather than on the chip, as a real border, so
      // it survives forced colors and never touches the chip's own styling.
      let total = duration;
      if (direction === "minimize" && cueRef.current) {
        total = duration + UI_ANIMATION_DURATION;
        placeCue(end, endRadius);
        animations.push(
          cueRef.current.animate(
            [
              ...CUE_STOPS_IN_FLIGHT.map(([offset, opacity]) => ({
                offset: (offset * duration) / total,
                opacity,
              })),
              { offset: 1, opacity: 0 },
            ],
            { duration: total, easing: "linear", fill: "both" }
          )
        );
      }
      for (const animation of animations) animation.id = PANEL_TRANSITION_ANIMATION_ID;

      geometry.finished.catch(() => settle(false));
      Promise.all(animations.map((animation) => animation.finished)).then(
        () => settle(true),
        () => settle(false)
      );
      // Belt and braces: a finished promise that never settles (a detached
      // element, a throttled background window) must not strand the ghost.
      fallback = setTimeout(() => settle(true), total * 2);
      track();
    };
    launch();

    return () => {
      // Torn down, not finished: whoever re-runs or unmounts this effect owns
      // what happens next, so the cancellations below must not report back.
      settled = true;
      cancelAnimationFrame(frame);
      if (fallback) clearTimeout(fallback);
      animations.forEach((animation) => animation.cancel());
    };
  }, [key, id, direction, sourceRect, target, onDone]);

  return (
    <>
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
      {direction === "minimize" && (
        <div
          ref={cueRef}
          data-panel-transition-cue
          className="absolute rounded-[var(--radius-md)] border border-text-secondary"
          style={{ opacity: 0 }}
        />
      )}
    </>
  );
}
