import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import type { ErrorFallbackProps } from "@/components/ErrorBoundary/ErrorFallback";
import { Button } from "@/components/ui/button";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

/**
 * One sidebar row's worth of the shared fallback: same neutral surface, same
 * single red glyph, same `Try again` — compact enough that the list keeps its
 * rhythm around it.
 */
export function WorktreeCardErrorFallback({ error, resetError, displayName }: ErrorFallbackProps) {
  const subject = displayName?.trim() || "this worktree";
  const message = import.meta.env.DEV ? error.message : `Couldn't show ${subject}`;

  // Replaces the shared fallback, so it owns the announcement that one would
  // have made — a row that silently turns into an error is invisible to AT.
  const announcedRef = useRef(false);
  useEffect(() => {
    if (announcedRef.current) return;
    announcedRef.current = true;
    useAnnouncerStore.getState().announce(`Couldn't show ${subject}`, "polite");
  }, [subject]);

  return (
    <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
      <TriangleAlert className="size-3.5 shrink-0 text-status-error" aria-hidden="true" />
      <TruncatedTooltip content={message}>
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{message}</span>
      </TruncatedTooltip>
      <Button type="button" variant="subtle" size="xs" onClick={resetError} className="shrink-0">
        Try again
      </Button>
    </div>
  );
}
