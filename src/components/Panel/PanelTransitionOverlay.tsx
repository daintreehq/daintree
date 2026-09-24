import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getPanelTransitionDuration,
  PANEL_MINIMIZE_EASING,
  PANEL_RESTORE_EASING,
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
 * Where the ghost lands. A function is resolved once the move has committed, so
 * the ghost can aim at the element the pane actually became (its dock chip, its
 * grid slot) rather than a guess made before that element existed. Returning
 * `null` means "not there yet"; a target that never appears cancels the flight.
 */
export type TransitionTarget = TransitionRect | (() => TransitionRect | null);

interface TransitionState {
  key: number;
  id: string;
  title: string;
  direction: TransitionDirection;
  sourceRect: TransitionRect;
  target: TransitionTarget;
}

interface PanelTransitionOverlayProps {
  onTransitionComplete?: (id: string) => void;
}

/** Frames to wait for a lazily-resolved target before giving up on the flight. */
const TARGET_RESOLVE_FRAMES = 4;

/**
 * Minimize is an exit: the ghost stays solid through most of the flight so the
 * eye can follow it, then dissolves into the chip as it arrives. Restore is the
 * inverse — it condenses out of the chip, holds, and hands over to the pane that
 * is already rendered underneath. Offsets sit in eased progress, so "0.6" means
 * 60% of the way there, not 60% of the clock.
 */
const OPACITY_STOPS: Record<TransitionDirection, Array<[offset: number, opacity: number]>> = {
  minimize: [
    [0, 1],
    [0.6, 1],
    [1, 0],
  ],
  restore: [
    [0, 0],
    [0.2, 1],
    [0.7, 1],
    [1, 0],
  ],
};

type TransitionListener = (transition: TransitionState) => void;
const listeners = new Set<TransitionListener>();
let nextKey = 0;

function hasArea(rect: TransitionRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function triggerPanelTransition(
  id: string,
  direction: TransitionDirection,
  sourceRect: TransitionRect,
  target: TransitionTarget,
  title = ""
): void {
  if (prefersReducedMotion()) return;
  // A zero-size box has nothing to show, and would put NaN into the keyframes.
  if (!hasArea(sourceRect)) return;
  if (typeof target !== "function" && !hasArea(target)) return;

  const transition: TransitionState = {
    key: ++nextKey,
    id,
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
      // A newer flight for the same pane supersedes the old one; unrelated
      // flights keep going.
      setTransitions((prev) => [...prev.filter((t) => t.id !== transition.id), transition]);
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

function TransitionGhost({ transition, onDone }: TransitionGhostProps) {
  const { key, id, direction, sourceRect, target, title } = transition;
  const elementRef = useRef<HTMLDivElement>(null);

  // Layout effect, not a passive one: the flight is armed before the first
  // paint, so the ghost is never seen at a size it was not meant to have.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const duration = getPanelTransitionDuration(direction);
    const easing = direction === "minimize" ? PANEL_MINIMIZE_EASING : PANEL_RESTORE_EASING;
    let frame = 0;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let animation: Animation | null = null;
    let settled = false;
    const settle = (landed: boolean) => {
      if (settled) return;
      settled = true;
      onDone(key, id, landed);
    };

    // The destination is measured after the move commits — for most callers
    // that is before the next frame, but a move run inside a view transition
    // commits later, so give it a few frames before calling the flight off.
    let attempts = 0;
    const launch = () => {
      const resolved = typeof target === "function" ? target() : target;
      if (!resolved || !hasArea(resolved)) {
        if (++attempts < TARGET_RESOLVE_FRAMES) {
          frame = requestAnimationFrame(launch);
        } else {
          settle(false);
        }
        return;
      }
      const from = toBox(sourceRect);
      const to = toBox(resolved);
      const stops = OPACITY_STOPS[direction];
      animation = element.animate(
        stops.map(([offset, opacity], index) => ({
          offset,
          opacity,
          ...(index === 0 ? from : index === stops.length - 1 ? to : {}),
        })),
        { duration, easing, fill: "both" }
      );
      animation.finished.then(
        () => settle(true),
        () => settle(false)
      );
      // Belt and braces: a finished promise that never settles (a detached
      // element, a throttled background window) must not strand the ghost.
      fallback = setTimeout(() => settle(true), duration * 2);
    };
    launch();

    return () => {
      cancelAnimationFrame(frame);
      if (fallback) clearTimeout(fallback);
      animation?.cancel();
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
      <div className="flex h-full max-h-8 shrink-0 items-center border-b border-divider px-3">
        <span className="truncate text-xs text-text-secondary">{title}</span>
      </div>
    </div>
  );
}
