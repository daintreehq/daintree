import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

export type TransitionDirection = "minimize" | "restore";

export interface TransitionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TransitionState {
  id: string;
  direction: TransitionDirection;
  sourceRect: TransitionRect;
  targetRect: TransitionRect;
  startTime: number;
  uniqueKey: string;
}

interface PanelTransitionOverlayProps {
  onTransitionComplete?: (id: string) => void;
}

const ANIMATION_DURATION = 180; // ms - faster to minimize distortion visibility

// Singleton event system for triggering transitions
type TransitionListener = (transition: TransitionState) => void;
const listeners = new Set<TransitionListener>();

export function triggerPanelTransition(
  id: string,
  direction: TransitionDirection,
  sourceRect: TransitionRect,
  targetRect: TransitionRect
): void {
  // Check for reduced motion preference
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  // Check for performance mode
  if (document.body.getAttribute("data-performance-mode") === "true") {
    return;
  }

  // Guard against zero-size rects which would cause NaN/Infinity transforms
  if (
    sourceRect.width === 0 ||
    sourceRect.height === 0 ||
    targetRect.width === 0 ||
    targetRect.height === 0
  ) {
    return;
  }

  const startTime = performance.now();
  const transition: TransitionState = {
    id,
    direction,
    sourceRect,
    targetRect,
    startTime,
    uniqueKey: `${id}-${startTime}`,
  };

  listeners.forEach((listener) => listener(transition));
}

export function PanelTransitionOverlay({ onTransitionComplete }: PanelTransitionOverlayProps) {
  const [transitions, setTransitions] = useState<TransitionState[]>([]);
  const completedRef = useRef<Set<string>>(new Set());

  // Subscribe to transitions
  useEffect(() => {
    const handleTransition = (transition: TransitionState) => {
      setTransitions((prev) => [...prev, transition]);
    };

    listeners.add(handleTransition);
    return () => {
      listeners.delete(handleTransition);
    };
  }, []);

  // Clean up completed transitions
  const handleAnimationEnd = useCallback(
    (transition: TransitionState) => {
      if (completedRef.current.has(transition.uniqueKey)) return;
      completedRef.current.add(transition.uniqueKey);

      setTransitions((prev) => prev.filter((t) => t.uniqueKey !== transition.uniqueKey));

      // Use the actual transition ID instead of parsing uniqueKey
      onTransitionComplete?.(transition.id);

      // Clean up ref after a short delay
      setTimeout(() => {
        completedRef.current.delete(transition.uniqueKey);
      }, 100);
    },
    [onTransitionComplete]
  );

  if (transitions.length === 0) return null;

  return createPortal(
    <div className="fixed inset-0 pointer-events-none z-[100]" aria-hidden="true">
      {transitions.map((transition) => (
        <TransitionGhost
          key={transition.uniqueKey}
          transition={transition}
          onComplete={() => handleAnimationEnd(transition)}
        />
      ))}
    </div>,
    document.body
  );
}

interface TransitionGhostProps {
  transition: TransitionState;
  onComplete: () => void;
}

function TransitionGhost({ transition, onComplete }: TransitionGhostProps) {
  const { sourceRect, targetRect } = transition;
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    // Start from source position and size
    element.style.left = `${sourceRect.x}px`;
    element.style.top = `${sourceRect.y}px`;
    element.style.width = `${sourceRect.width}px`;
    element.style.height = `${sourceRect.height}px`;
    element.style.opacity = "0.8";
    element.style.transform = "none";

    // Force reflow to ensure initial styles are applied
    void element.offsetHeight;

    // Animate to target using width/height changes instead of scale
    // This prevents distortion of rounded corners
    requestAnimationFrame(() => {
      element.style.left = `${targetRect.x}px`;
      element.style.top = `${targetRect.y}px`;
      element.style.width = `${targetRect.width}px`;
      element.style.height = `${targetRect.height}px`;
      element.style.opacity = "0";
    });

    const timer = setTimeout(onComplete, ANIMATION_DURATION);
    return () => clearTimeout(timer);
  }, [sourceRect, targetRect, onComplete]);

  return (
    <div
      ref={elementRef}
      className="absolute border-2 border-canopy-accent/50 bg-canopy-accent/10"
      style={{
        transitionDuration: `${ANIMATION_DURATION}ms`,
        transitionProperty: "left, top, width, height, opacity",
        // Use expo ease-out for snappy, natural feel
        transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
        willChange: "left, top, width, height, opacity",
        // Use a consistent border-radius that doesn't scale
        borderRadius: "6px",
      }}
    />
  );
}
