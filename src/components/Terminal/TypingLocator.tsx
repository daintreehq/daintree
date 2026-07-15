import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_TRANSIENT_HINT_DWELL_MS,
} from "@/lib/animationUtils";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";

/**
 * Transient pill naming the pane the user's typing is landing in (#11134).
 *
 * Neutral surface, no accent: the accent budget belongs to the focus anchor,
 * and the pulse on the pane itself is already carrying the signal. `aria-hidden`
 * because it is redundant for assistive tech — the rescue is disabled outright
 * under a screen reader, and the locator only restates where focus already is.
 */
export function TypingLocator() {
  const label = useTypingLocatorStore((s) => s.label);
  const revision = useTypingLocatorStore((s) => s.revision);
  const clearLocator = useTypingLocatorStore((s) => s.clearLocator);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    if (label === null) return;
    setIsLeaving(false);

    const dwell = window.setTimeout(() => setIsLeaving(true), UI_TRANSIENT_HINT_DWELL_MS);
    const exit = window.setTimeout(
      clearLocator,
      UI_TRANSIENT_HINT_DWELL_MS + UI_PALETTE_EXIT_DURATION
    );
    return () => {
      window.clearTimeout(dwell);
      window.clearTimeout(exit);
    };
    // `revision` restarts the dwell when the same pane is located again.
  }, [label, revision, clearLocator]);

  if (label === null) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center"
    >
      <div
        className={cn(
          "rounded-full border border-border-subtle bg-overlay-subtle px-3 py-1",
          "text-xs text-content-secondary shadow-sm backdrop-blur-sm",
          "motion-safe:transition-opacity",
          isLeaving ? "opacity-0" : "opacity-100"
        )}
        style={{
          transitionDuration: `${isLeaving ? UI_PALETTE_EXIT_DURATION : UI_PALETTE_ENTER_DURATION}ms`,
        }}
      >
        {label}
      </div>
    </div>
  );
}
