import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

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

const ANIMATION_DURATION = 250; // ms

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
    (uniqueKey: string) => {
      if (completedRef.current.has(uniqueKey)) return;
      completedRef.current.add(uniqueKey);

      setTransitions((prev) => prev.filter((t) => t.uniqueKey !== uniqueKey));

      // Extract id from uniqueKey for callback
      const id = uniqueKey.split("-")[0];
      onTransitionComplete?.(id);

      // Clean up ref after a short delay
      setTimeout(() => {
        completedRef.current.delete(uniqueKey);
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
          onComplete={() => handleAnimationEnd(transition.uniqueKey)}
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
  const { direction, sourceRect, targetRect } = transition;
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    // Start from source position
    element.style.left = `${sourceRect.x}px`;
    element.style.top = `${sourceRect.y}px`;
    element.style.width = `${sourceRect.width}px`;
    element.style.height = `${sourceRect.height}px`;
    element.style.opacity = "1";

    // Force reflow to ensure initial styles are applied
    void element.offsetHeight;

    // Calculate scale factors for the target size
    const scaleX = targetRect.width / sourceRect.width;
    const scaleY = targetRect.height / sourceRect.height;

    // Calculate translation to center of target
    const translateX = targetRect.x + targetRect.width / 2 - (sourceRect.x + sourceRect.width / 2);
    const translateY =
      targetRect.y + targetRect.height / 2 - (sourceRect.y + sourceRect.height / 2);

    // Apply transform to animate
    requestAnimationFrame(() => {
      element.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
      element.style.opacity = direction === "minimize" ? "0.3" : "0";
    });

    const timer = setTimeout(onComplete, ANIMATION_DURATION);
    return () => clearTimeout(timer);
  }, [sourceRect, targetRect, direction, onComplete]);

  return (
    <div
      ref={elementRef}
      className={cn(
        "absolute rounded border-2 transition-all ease-out",
        direction === "minimize"
          ? "border-canopy-accent/60 bg-canopy-accent/10"
          : "border-canopy-accent/40 bg-canopy-accent/5"
      )}
      style={{
        transitionDuration: `${ANIMATION_DURATION}ms`,
        transitionProperty: "transform, opacity",
        transformOrigin: "center center",
        willChange: "transform, opacity",
      }}
    />
  );
}
