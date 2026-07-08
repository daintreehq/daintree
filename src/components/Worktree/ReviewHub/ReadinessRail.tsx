import { cn } from "@/lib/utils";
import type {
  ReviewReadinessCta,
  ReviewReadinessItem,
  ReviewReadinessSummary,
} from "./reviewReadiness";

const MAX_VISIBLE_ITEMS = 3;

const LEVEL_CONFIG = {
  ready: {
    label: "Ready",
    chipClass: "bg-status-success/10 border-status-success/30 text-status-success",
    dotClass: "bg-status-success",
  },
  "needs-review": {
    label: "Needs attention",
    chipClass: "bg-status-warning/10 border-status-warning/30 text-status-warning",
    dotClass: "bg-status-warning",
  },
  blocked: {
    label: "Blocked",
    chipClass: "bg-status-error/10 border-status-error/30 text-status-error",
    dotClass: "bg-status-error",
  },
} as const;

const SEVERITY_DOT = {
  blocker: "bg-status-error",
  warning: "bg-status-warning",
  info: "bg-text-muted",
} as const;

const CTA_LABELS: Record<ReviewReadinessCta["kind"], string> = {
  "focus-conflicts": "Show conflicts",
  "focus-staged": "Show files",
  "pull-rebase": "Pull and rebase",
  "open-pr": "Open PR",
};

interface ReadinessRailProps {
  summary: ReviewReadinessSummary;
  onCta: (cta: ReviewReadinessCta) => void;
}

/**
 * Compact merge-readiness strip for the top of Review Hub. Shows the overall
 * level plus the 3 highest-priority items (blockers, then warnings, then
 * infos) with their safe next action. Purely presentational — all derivation
 * lives in `deriveReviewReadiness`, all mutations behind `onCta` stay on the
 * hub's existing confirmed paths.
 */
export function ReadinessRail({ summary, onCta }: ReadinessRailProps) {
  // "unknown" means staging status hasn't resolved — nothing useful to show.
  if (summary.level === "unknown") return null;

  const level = LEVEL_CONFIG[summary.level];
  const ordered = [...summary.blockers, ...summary.warnings, ...summary.infos];
  const visible = ordered.slice(0, MAX_VISIBLE_ITEMS);
  const hidden = ordered.slice(MAX_VISIBLE_ITEMS);

  return (
    <div
      data-testid="review-readiness-rail"
      role="group"
      aria-label="Review readiness"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 border-b border-divider bg-overlay-subtle text-[11px]"
    >
      <span
        data-testid="review-readiness-level"
        data-level={summary.level}
        role="status"
        className={cn(
          "inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded border font-medium shrink-0",
          level.chipClass
        )}
      >
        <span aria-hidden="true" className={cn("w-1.5 h-1.5 rounded-full", level.dotClass)} />
        {level.label}
      </span>
      {visible.map((item) => (
        <RailItem key={item.id} item={item} onCta={onCta} />
      ))}
      {hidden.length > 0 && (
        <span
          data-testid="review-readiness-overflow"
          className="text-daintree-text/40 shrink-0 cursor-help"
          title={hidden.map((item) => item.label).join("\n")}
          aria-label={`${hidden.length} more: ${hidden.map((item) => item.label).join(", ")}`}
        >
          +{hidden.length} more
        </span>
      )}
    </div>
  );
}

function RailItem({
  item,
  onCta,
}: {
  item: ReviewReadinessItem;
  onCta: (cta: ReviewReadinessCta) => void;
}) {
  return (
    <span
      data-testid={`readiness-item-${item.id}`}
      className="inline-flex items-center gap-1.5 min-w-0"
    >
      <span
        aria-hidden="true"
        className={cn("w-1.5 h-1.5 rounded-full shrink-0", SEVERITY_DOT[item.severity])}
      />
      <span className="truncate text-daintree-text/70">
        {item.label}
        {item.detail && <span className="text-daintree-text/40"> — {item.detail}</span>}
      </span>
      {item.action && (
        <button
          type="button"
          data-testid={`readiness-cta-${item.id}`}
          onClick={() => onCta(item.action!)}
          className={cn(
            "shrink-0 px-1.5 py-px rounded text-[10px] font-medium transition-colors",
            "bg-filter-selected-bg-soft hover:bg-tint/[0.14] text-daintree-text/80",
            "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent"
          )}
        >
          {CTA_LABELS[item.action.kind]}
        </button>
      )}
    </span>
  );
}
