import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface AnimatedLabelProps {
  /** The current label text. Changing this triggers the crossfade. */
  label: string;
  /**
   * Optional override for the change detection key. Defaults to `label`.
   * Use this when the visible text stays the same but the underlying state
   * differs (e.g., re-armed at the same count) and you still want a swap.
   */
  animateKey?: string;
  /** Wrapper grid container className. */
  className?: string;
  /** Per-text-span className (applied to both incoming and outgoing). */
  textClassName?: string;
}

/**
 * Crossfade primitive for short labels and ticking counts. Both the outgoing
 * and incoming spans live in the same CSS grid cell so the wrapper width is
 * the natural max of the two — no layout shift during the swap. The outgoing
 * span gets `aria-hidden` so screen readers only announce the live label.
 */
export function AnimatedLabel({ label, animateKey, className, textClassName }: AnimatedLabelProps) {
  const key = animateKey ?? label;
  const prevKeyRef = useRef(key);
  const prevLabelRef = useRef(label);
  const [isAnimating, setIsAnimating] = useState(false);
  const [outgoing, setOutgoing] = useState<string | null>(null);

  useEffect(() => {
    if (prevKeyRef.current !== key) {
      setOutgoing(prevLabelRef.current);
      setIsAnimating(true);
      prevKeyRef.current = key;
      prevLabelRef.current = label;
    } else {
      prevLabelRef.current = label;
    }
  }, [key, label]);

  // Safety cleanup — under reduced-motion the keyframe animation is replaced
  // by a short opacity transition, so `animationend` may not fire from the
  // outgoing span in the same way. The 250ms timeout matches the canonical
  // pattern in AgentStatusIndicator and prevents the latch from sticking.
  useEffect(() => {
    if (!isAnimating) return;
    const timer = setTimeout(() => {
      setIsAnimating(false);
      setOutgoing(null);
    }, 250);
    return () => clearTimeout(timer);
  }, [isAnimating]);

  const handleAnimationEnd = () => {
    setIsAnimating(false);
    setOutgoing(null);
  };

  return (
    <span className={cn("relative inline-grid align-baseline", className)}>
      <span
        key={`current-${key}`}
        className={cn(
          "[grid-area:1/1] inline-flex items-center justify-center",
          isAnimating && "animate-label-swap-in",
          textClassName
        )}
        aria-live="polite"
      >
        {label}
      </span>
      {isAnimating && outgoing !== null && outgoing !== label && (
        <span
          key={`prev-${key}`}
          className={cn(
            "[grid-area:1/1] inline-flex items-center justify-center pointer-events-none animate-label-swap-out",
            textClassName
          )}
          aria-hidden="true"
          onAnimationEnd={handleAnimationEnd}
        >
          {outgoing}
        </span>
      )}
    </span>
  );
}
