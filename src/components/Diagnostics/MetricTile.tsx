import { CircleAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export type MetricTone = "default" | "warn" | "alert";

const TONE_LABEL: Record<Exclude<MetricTone, "default">, string> = {
  warn: "Needs attention",
  alert: "Problem",
};

interface MetricTileProps {
  label: string;
  value: string;
  unit?: string;
  tone?: MetricTone;
  /** The threshold or reference the value is judged against, so the reader doesn't have to know it. */
  hint?: string;
}

/**
 * One reading in the Perf and Why slow? tabs. Tone rides on the border and a
 * glyph whose shape differs per tone; the value itself stays in the neutral
 * text ramp, because status-coloured text drops below 4.5:1 on most themes.
 */
export function MetricTile({ label, value, unit, tone = "default", hint }: MetricTileProps) {
  const Glyph = tone === "alert" ? CircleAlert : tone === "warn" ? TriangleAlert : null;
  return (
    <div
      data-tone={tone}
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-[var(--radius-md)] border bg-surface-panel px-2.5 py-1.5",
        tone === "default" && "border-border-default",
        tone === "warn" && "border-status-warning/60",
        tone === "alert" && "border-status-error/60"
      )}
    >
      <span className="flex items-center gap-1 truncate text-2xs text-text-secondary">
        {Glyph ? (
          <Glyph
            aria-hidden="true"
            className={cn(
              "h-3 w-3 shrink-0",
              tone === "warn" ? "text-status-warning" : "text-status-error"
            )}
          />
        ) : null}
        {label}
        {tone !== "default" ? <span className="sr-only">({TONE_LABEL[tone]})</span> : null}
      </span>
      <span className="flex items-baseline gap-1 truncate">
        <span className="text-sm font-medium tabular-nums text-text-primary">{value}</span>
        {unit ? <span className="text-2xs text-text-secondary">{unit}</span> : null}
        {hint ? <span className="truncate text-2xs text-text-secondary">· {hint}</span> : null}
      </span>
    </div>
  );
}
