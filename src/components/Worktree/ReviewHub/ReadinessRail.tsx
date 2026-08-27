import { useState } from "react";
import { AlertTriangle, ChevronDown, CircleAlert, Info } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { cn } from "@/lib/utils";
import type {
  ReviewReadinessCta,
  ReviewReadinessItem,
  ReviewReadinessSeverity,
  ReviewReadinessSummary,
} from "./reviewReadiness";

/** Announced when the level changes; never painted, because the leading icon and the
 *  condition's own title already say more than the verdict word does. */
const LEVEL_LABEL = {
  ready: "Ready",
  "needs-review": "Needs attention",
  blocked: "Blocked",
} as const;

/**
 * Severity carries a distinct SHAPE, not just a hue. A `background-color` dot is
 * erased wholesale by `forced-colors: active`; a Lucide glyph strokes in
 * `currentColor` and survives it, which is also what the house rule in
 * `worktreeCIStatus.ts` asks for (terminal states get an icon).
 */
const SEVERITY: Record<ReviewReadinessSeverity, { Icon: typeof CircleAlert; toneClass: string }> = {
  blocker: { Icon: CircleAlert, toneClass: "text-status-error" },
  warning: { Icon: AlertTriangle, toneClass: "text-status-warning" },
  info: { Icon: Info, toneClass: "text-text-muted" },
};

const CTA_LABELS: Record<ReviewReadinessCta["kind"], string> = {
  "focus-conflicts": "Show conflicts",
  "focus-staged": "Show files",
  "pull-rebase": "Pull and rebase",
  "open-pr": "Open PR",
};

/* The action sits immediately after the message it belongs to rather than pinned to
   the far edge: "Show conflicts" only means anything next to "3 conflicted files",
   and a control stranded at the right margin of a wide strip is the one a screen
   magnifier never reaches. */
/* `focus-visible:outline-solid` is load-bearing, not decoration. Tailwind v4 compiles the
   outline-suppressing utility below to `--tw-outline-style: none` on the element
   unconditionally, and compiles `focus-visible:outline-2` to
   `outline-style: var(--tw-outline-style)` — so the two cancel and the ring never paints
   however right its colour and width look. Restating the style under the variant is what
   makes the focus indicator visible; the capture harness asserts the computed outline. */
const FOCUS_RING =
  "outline-hidden focus-visible:outline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";

const CTA_CLASS = cn(
  "inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
  "bg-filter-selected-bg-soft hover:bg-tint/[0.14] text-daintree-text/80",
  FOCUS_RING
);

interface ReadinessRailProps {
  summary: ReviewReadinessSummary;
  onCta: (cta: ReviewReadinessCta) => void;
}

/**
 * Merge-readiness strip for the top of Review Hub. Leads with the single
 * highest-priority condition and its own safe next action; everything else lives
 * behind a disclosure. Purely presentational — all derivation stays in
 * `deriveReviewReadiness`, all mutations stay on the hub's confirmed paths.
 *
 * It renders nothing at all when there is nothing to report. A clean worktree is
 * already announced by the hub's own empty state, and a full-width band restating
 * it in success green is exactly the chrome that trains people to stop reading the
 * strip before it ever carries a blocker.
 */
export function ReadinessRail({ summary, onCta }: ReadinessRailProps) {
  // "unknown" means staging status hasn't resolved — nothing useful to show.
  if (summary.level === "unknown") return null;

  const ordered = [...summary.blockers, ...summary.warnings, ...summary.infos];
  const [primary, ...rest] = ordered;

  // Nothing worth a row: silence is the readiness signal.
  if (!primary) return null;

  const { Icon, toneClass } = SEVERITY[primary.severity];
  const fullText = primary.detail ? `${primary.label} — ${primary.detail}` : primary.label;

  return (
    <div
      data-testid="review-readiness-rail"
      role="group"
      aria-label="Review readiness"
      className="flex items-center gap-2 px-4 py-1.5 border-b border-divider text-[11px]"
    >
      <span
        data-testid="review-readiness-level"
        data-level={summary.level}
        role="status"
        className="flex items-center shrink-0"
      >
        <Icon className={cn("w-3.5 h-3.5 shrink-0", toneClass)} aria-hidden="true" />
        <span className="sr-only">{LEVEL_LABEL[summary.level]}</span>
      </span>

      <TruncatedTooltip content={fullText}>
        <span data-testid={`readiness-item-${primary.id}`} className="min-w-0 truncate">
          {/* Weight and colour separate the condition from its advice — an em dash
              turns the pair into one run of prose, which is how three items used to
              read as a single sentence. Weight also survives `prefers-contrast:
              more`, where the colour difference is flattened away. */}
          <span className="font-medium text-daintree-text/85">{primary.label}</span>
          {primary.detail && (
            // The literal space stays: adjacent inline spans concatenate in the
            // accessibility tree, so dropping it would announce "changedCheck". The
            // margin is what opens the optical gap.
            <span className="ml-1 text-text-secondary"> {primary.detail}</span>
          )}
        </span>
      </TruncatedTooltip>

      {primary.action && (
        <button
          type="button"
          data-testid={`readiness-cta-${primary.id}`}
          onClick={() => onCta(primary.action!)}
          className={CTA_CLASS}
        >
          {CTA_LABELS[primary.action.kind]}
        </button>
      )}

      {rest.length > 0 && <ReadinessOverflow items={rest} onCta={onCta} />}
    </div>
  );
}

/**
 * The remaining conditions. A `title` attribute was never a control: it could not
 * be opened from the keyboard, and it dropped every hidden item's action on the
 * floor. Radix supplies `aria-expanded`, `aria-haspopup`, focus return and
 * Escape-to-close; the list semantics and the accessible name are ours to write.
 */
function ReadinessOverflow({
  items,
  onCta,
}: {
  items: ReviewReadinessItem[];
  onCta: (cta: ReviewReadinessCta) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        data-testid="review-readiness-overflow"
        aria-label={`${items.length} more: ${items.map((i) => i.label).join(", ")}`}
        className={cn(
          "inline-flex items-center gap-0.5 shrink-0 px-1.5 py-0.5 rounded text-[11px] transition-colors",
          "text-text-secondary hover:text-daintree-text hover:bg-tint/[0.06]",
          FOCUS_RING
        )}
      >
        {items.length} more
        <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-label="Other readiness conditions"
        className="p-1 min-w-64 max-w-sm text-xs"
      >
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const { Icon, toneClass } = SEVERITY[item.severity];
            return (
              <li
                key={item.id}
                data-testid={`readiness-item-${item.id}`}
                className="flex items-start gap-2 px-2 py-1.5 rounded"
              >
                <Icon className={cn("w-3.5 h-3.5 shrink-0 mt-px", toneClass)} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-daintree-text">{item.label}</span>
                  {item.detail && <span className="block text-text-secondary">{item.detail}</span>}
                </span>
                {item.action && (
                  <button
                    type="button"
                    data-testid={`readiness-cta-${item.id}`}
                    onClick={() => {
                      onCta(item.action!);
                      setOpen(false);
                    }}
                    className={CTA_CLASS}
                  >
                    {CTA_LABELS[item.action.kind]}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
