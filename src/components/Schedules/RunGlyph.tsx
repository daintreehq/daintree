import { CircleSlash, CircleStop, Timer } from "@/components/icons";
import { SEVERITY_GLYPH, type StatusSeverity } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import type { ScheduledRun } from "@shared/types/scheduledRuns";
import { lastRunWords } from "./lastRunWords";

export const SEVERITY_TONE: Record<StatusSeverity, string> = {
  success: "text-status-success",
  warning: "text-status-warning",
  error: "text-status-error",
  info: "text-status-info",
};

/**
 * A run's outcome mark, the same in the list and the history. Every outcome has
 * a shape, so colour never carries it alone; an open run is neutral, since an
 * open run says nothing about whether its agent is working.
 */
export function RunGlyph({ run, className }: { run: ScheduledRun; className?: string }) {
  const { severity } = lastRunWords(run);
  const base = cn("shrink-0", className);
  if (severity) {
    const Glyph = SEVERITY_GLYPH[severity];
    return <Glyph className={cn(base, SEVERITY_TONE[severity])} aria-hidden="true" />;
  }
  const Glyph =
    run.settlement.state === "open"
      ? Timer
      : run.settlement.outcome === "skipped"
        ? CircleSlash
        : CircleStop;
  return <Glyph className={cn(base, "text-text-secondary")} aria-hidden="true" />;
}
