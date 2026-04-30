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
 * the natural max of the two — no layout shift during the swap.
 *
 * Accessibility: the outgoing span is `aria-hidden`. The current span has no
 * live-region attributes — callers own their own announcement strategy
 * (PanelHeader uses `role="status"` on its container, FleetArmingRibbon
 * uses an explicit announcer store), so adding `aria-live` here would
 * double-announce.
 */
export function AnimatedLabel({ label, animateKey, className, textClassName }: AnimatedLabelProps) {
  const key = animateKey ?? label;
  const prevKeyRef = useRef(key);
  const prevLabelRef = useRef(label);
  // generation increments on every change so React remounts the spans and
  // restarts the keyframe animation even when a new transition arrives
  // inside the previous one's animation window.
  const [generation, setGeneration] = useState(0);
  const [outgoing, setOutgoing] = useState<string | null>(null);

  useEffect(() => {
    if (prevKeyRef.current !== key) {
      setOutgoing(prevLabelRef.current);
      setGeneration((g) => g + 1);
      prevKeyRef.current = key;
      prevLabelRef.current = label;
    } else {
      prevLabelRef.current = label;
    }
  }, [key, label]);

  // Safety cleanup — under reduced-motion the keyframe animation is replaced
  // with a static state so `animationend` never fires from the outgoing span.
  // The 250ms timeout matches the canonical pattern in AgentStatusIndicator
  // and prevents the outgoing label from latching in the DOM.
  useEffect(() => {
    if (outgoing === null) return;
    const timer = setTimeout(() => setOutgoing(null), 250);
    return () => clearTimeout(timer);
  }, [outgoing, generation]);

  const isAnimating = outgoing !== null;
  const handleAnimationEnd = () => setOutgoing(null);

  return (
    <span className={cn("relative inline-grid align-baseline", className)}>
      <span
        key={`current-${generation}`}
        className={cn(
          "[grid-area:1/1] inline-flex items-center justify-center",
          isAnimating && "animate-label-swap-in",
          textClassName
        )}
      >
        {label}
      </span>
      {isAnimating && (
        <span
          key={`prev-${generation}`}
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
