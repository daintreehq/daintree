import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { TriangleAlert } from "@/components/icons";
import {
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_TYPING_LOCATOR_DWELL_MS,
  UI_TYPING_LOCATOR_REPORT_DWELL_MS,
} from "@/lib/animationUtils";
import { useTypingLocatorStore, type TypingLocatorKind } from "@/store/typingLocatorStore";

export function getTypingLocatorDwellMs(kind: TypingLocatorKind): number {
  return kind === "typing" ? UI_TYPING_LOCATOR_DWELL_MS : UI_TYPING_LOCATOR_REPORT_DWELL_MS;
}

/**
 * Transient pill naming the pane the user's typing is landing in (#11134).
 *
 * Neutral surface, no accent: the accent budget belongs to the focus anchor,
 * and the pulse on the pane itself is already carrying the signal. `aria-hidden`
 * because it is redundant for assistive tech — the rescue is disabled outright
 * under a screen reader, the locator only restates where focus already is, and
 * the file-reference receipts are announced by their caller.
 *
 * Opaque for the same reason as `ScrollPill`: it floats over pane headers and
 * terminal output, and anything translucent lets the covered text read through
 * the destination name it exists to show.
 */
export function TypingLocator() {
  const message = useTypingLocatorStore((s) => s.message);
  const revision = useTypingLocatorStore((s) => s.revision);
  const clearLocator = useTypingLocatorStore((s) => s.clearLocator);
  const [isLeaving, setIsLeaving] = useState(false);
  const kind = message?.kind ?? null;

  useEffect(() => {
    if (kind === null) return;
    // A repeat while the pill is fading out takes it straight back: the node
    // stays mounted, so this transitions up rather than replaying the entry.
    setIsLeaving(false);

    const dwellMs = getTypingLocatorDwellMs(kind);
    const dwell = window.setTimeout(() => setIsLeaving(true), dwellMs);
    const exit = window.setTimeout(clearLocator, dwellMs + UI_PALETTE_EXIT_DURATION);
    return () => {
      window.clearTimeout(dwell);
      window.clearTimeout(exit);
    };
    // `revision` restarts the dwell when the same pane is located again.
  }, [kind, revision, clearLocator]);

  if (message === null) return null;

  const hasTarget = message.target !== undefined;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-3"
    >
      <div
        data-typing-locator={message.kind}
        className={cn(
          "flex h-7 min-w-0 max-w-md items-center gap-1.5 rounded-full px-3",
          "border border-border-default bg-surface-panel-elevated shadow-[var(--theme-shadow-floating)]",
          "text-xs text-text-secondary",
          // `starting:` paints the first frame hidden so the entry actually
          // animates; Tailwind v4 `translate-*` sets `translate`, not `transform`.
          "motion-safe:transition-[opacity,translate] motion-safe:starting:opacity-0 motion-safe:starting:-translate-y-1",
          isLeaving ? "opacity-0" : "opacity-100"
        )}
        style={{
          transitionDuration: `${isLeaving ? UI_PALETTE_EXIT_DURATION : UI_PALETTE_ENTER_DURATION}ms`,
          transitionTimingFunction: isLeaving ? UI_EXIT_EASING : UI_ENTER_EASING,
        }}
      >
        {message.kind === "file-refused" && (
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span
          className={cn(
            "whitespace-nowrap",
            hasTarget ? "shrink-0" : "min-w-0 truncate text-text-primary"
          )}
        >
          {message.lead}
        </span>
        {hasTarget && (
          <span className="min-w-0 truncate font-medium text-text-primary">{message.target}</span>
        )}
      </div>
    </div>
  );
}
