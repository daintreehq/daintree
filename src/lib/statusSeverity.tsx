import { AlertTriangle, Check, CircleAlert, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared severity vocabulary for status marks that carry their meaning in the
 * mark itself — audit-log outcomes, mostly, where the row's visible text is an
 * id and the severity word lives only in the accessible name.
 *
 * A glyph, not a coloured dot: `forced-colors: active` forces every author
 * background to Canvas, so a disc painted with a status background renders as
 * nothing at all and takes the severity distinction with it (#12000). A glyph strokes in
 * `currentColor`, which the UA repaints rather than erases, so the shape keeps
 * the levels apart where the palette can no longer tell them apart.
 *
 * The four shapes are the ones `ReadinessRail` settled on in #11983 plus
 * `worktreeCIStatus`'s `Check`, so the app speaks one severity language.
 */
export type StatusSeverity = "success" | "error" | "warning" | "info";

export const SEVERITY_VISUAL: Record<StatusSeverity, { Icon: typeof Check; toneClass: string }> = {
  success: { Icon: Check, toneClass: "text-status-success" },
  error: { Icon: CircleAlert, toneClass: "text-status-danger" },
  warning: { Icon: AlertTriangle, toneClass: "text-status-warning" },
  // `text-secondary`, not `text-muted`, for the reason ReadinessRail gives: as
  // the only visual carrier the glyph owes the 3:1 non-text floor, and
  // `text-muted` only clears that on light themes (`shared/theme/contrast.ts`).
  info: { Icon: Info, toneClass: "text-text-secondary" },
};

/**
 * The glyph in the leading slot of a log row. `label` is the outcome in words —
 * usually the row's only statement of severity, so it lands on both the
 * accessible name and the hover title. Pass `decorative` where the row already
 * announces its outcome and the glyph would only repeat it.
 */
export function SeverityMark({
  severity,
  label,
  className,
  decorative = false,
}: {
  severity: StatusSeverity;
  label: string;
  className?: string;
  decorative?: boolean;
}) {
  const { Icon, toneClass } = SEVERITY_VISUAL[severity];
  // Wrapped rather than bare: `title` is what gave the dot it replaces a hover
  // tooltip, and Lucide's props don't carry one through to the SVG. The wrapper
  // owns the semantics and the layout box; the glyph just fills it.
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      title={label}
      className={cn("inline-flex shrink-0", className)}
    >
      <Icon aria-hidden="true" className={cn("h-full w-full", toneClass)} />
    </span>
  );
}
