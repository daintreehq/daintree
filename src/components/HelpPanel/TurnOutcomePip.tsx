import { cn } from "@/lib/utils";
import type { TurnOutcomeAlertClass } from "@shared/types/ipc/mcpServer";

/**
 * Footer-relative copy for each alertable outcome (#10018). The label names
 * what happened; the title spells out the why and the dismiss affordance. Kept
 * deliberately terse — this is a Tier 1 ambient signal, not a diagnostic.
 */
const OUTCOME_COPY: Record<TurnOutcomeAlertClass, { label: string; title: string }> = {
  "agent-stuck": {
    label: "Stopped early",
    title: "Assistant stopped early without finishing the turn. Click to dismiss.",
  },
  "reasoning-loop": {
    label: "Repeating steps",
    title: "Assistant kept repeating the same step. Click to dismiss.",
  },
};

interface TurnOutcomePipProps {
  /** The pending alertable outcome, or null when nothing is to show. */
  outcome: TurnOutcomeAlertClass | null;
  /** Click handler that dismisses the pip. */
  onDismiss: () => void;
}

/**
 * Ambient pip surfaced in the Assistant footer when the most recent turn for
 * the bound help session classified as `agent-stuck` or `reasoning-loop`
 * (#10018). A single warning-toned dot + short label, click-to-dismiss — no
 * toast, no accent color. A single visual treatment covers both outcomes
 * (the label differentiates), keeping the accent budget intact.
 */
export function TurnOutcomePip({ outcome, onDismiss }: TurnOutcomePipProps) {
  // Guard nullish (not just `null`): a snapshot that predates this field would
  // pass `undefined`, and indexing OUTCOME_COPY with it would throw.
  if (!outcome) return null;
  const { label, title } = OUTCOME_COPY[outcome];
  return (
    <button
      type="button"
      onClick={onDismiss}
      title={title}
      aria-label={title}
      className={cn(
        "flex items-center gap-1.5 min-w-0 shrink-0 text-status-warning",
        "transition-colors duration-150 ease-out hover:text-status-warning/80",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
      )}
    >
      <span
        aria-hidden
        className="status-mark w-1.5 h-1.5 rounded-full shrink-0 bg-status-warning"
      />
      <span className="truncate font-medium">{label}</span>
    </button>
  );
}
