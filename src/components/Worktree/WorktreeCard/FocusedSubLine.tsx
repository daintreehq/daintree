import { cn } from "@/lib/utils";
import { SECTION_TEXT_COLUMN } from "./sectionChrome";
import { isValidPastTimestamp } from "@/utils/timestamps";
import { LiveTimeAgo } from "../LiveTimeAgo";

export interface FocusedSubLineProps {
  open: boolean;
  changedFileCount?: number | null;
  lastActivityTimestamp?: number | null;
  statusLabel?: string | null;
}

export function FocusedSubLine({
  open,
  changedFileCount,
  lastActivityTimestamp,
  statusLabel,
}: FocusedSubLineProps) {
  const showChanges = typeof changedFileCount === "number" && changedFileCount > 0;
  const hasTimestamp = isValidPastTimestamp(lastActivityTimestamp);
  const hasLabel = typeof statusLabel === "string" && statusLabel.trim().length > 0;
  const hasContent = showChanges || hasTimestamp || hasLabel;
  const isVisible = open && hasContent;

  const segments: ("changes" | "time" | "label")[] = [];
  if (showChanges) segments.push("changes");
  if (hasTimestamp) segments.push("time");
  if (hasLabel) segments.push("label");

  return (
    <div
      data-open={isVisible ? "" : undefined}
      data-testid="worktree-focused-subline"
      aria-hidden={!isVisible}
      className={cn(
        "overflow-hidden h-0 data-[open]:h-auto",
        "transition-[height] duration-150 ease-out",
        "motion-reduce:transition-none"
      )}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 pb-1 text-xs text-text-secondary",
          // Lands on the card's text column, under the title it summarises,
          // rather than on the glyph column one tier left of it.
          SECTION_TEXT_COLUMN,
          "opacity-0 delay-[30ms] data-[open]:opacity-100",
          "transition-opacity duration-150 ease-out",
          "motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:delay-0"
        )}
        data-open={isVisible ? "" : undefined}
      >
        {isVisible &&
          segments.map((seg, i) => (
            <span key={seg} className={cn("flex items-center", seg === "label" && "min-w-0")}>
              {i > 0 && (
                <span aria-hidden="true" className="mr-1.5 text-text-muted">
                  ·
                </span>
              )}
              {seg === "changes" && (
                <span className="shrink-0 tabular-nums">
                  {changedFileCount} file{changedFileCount !== 1 ? "s" : ""}
                </span>
              )}
              {seg === "time" && (
                <LiveTimeAgo timestamp={lastActivityTimestamp} className="shrink-0" />
              )}
              {seg === "label" && <span className="truncate">{statusLabel}</span>}
            </span>
          ))}
      </div>
    </div>
  );
}
