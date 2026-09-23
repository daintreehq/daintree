import { useId } from "react";
import { cn } from "@/lib/utils";
import type { TurnOutcomeAlertClass } from "@shared/types/ipc/mcpServer";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FOOTER_ITEM_CLASS } from "./footerItem";

/**
 * Footer copy for each alertable outcome (#10018). Both labels say what was
 * observed, never what it means: the classifiers are heuristics, and a label
 * like "Repeating steps" read as a diagnosis nobody could act on. The title
 * spells out exactly what tripped and that a click clears it.
 */
const OUTCOME_COPY: Record<TurnOutcomeAlertClass, { label: string; title: string }> = {
  "agent-stuck": {
    label: "Went quiet",
    title: "The assistant stopped producing output before its turn finished. Click to dismiss.",
  },
  "reasoning-loop": {
    label: "Repeated tool call",
    title:
      "The assistant made the same tool call with the same arguments 3 or more times in one turn. Click to dismiss.",
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
 * toast, no accent color. It never truncates: the label is the signal.
 */
export function TurnOutcomePip({ outcome, onDismiss }: TurnOutcomePipProps) {
  const descriptionId = useId();
  // Guard nullish (not just `null`): a snapshot that predates this field would
  // pass `undefined`, and indexing OUTCOME_COPY with it would throw.
  if (!outcome) return null;
  const { label, title } = OUTCOME_COPY[outcome];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onDismiss}
          // Keeps the visible label in the name (WCAG 2.5.3) and says what a click does.
          aria-label={`Dismiss ${label.toLowerCase()} notice`}
          aria-describedby={descriptionId}
          className={cn(FOOTER_ITEM_CLASS, "shrink-0 text-status-warning")}
        >
          <span
            aria-hidden
            className="status-mark w-1.5 h-1.5 rounded-full shrink-0 bg-status-warning"
          />
          <span className="font-medium">{label}</span>
          <span id={descriptionId} className="sr-only">
            {title}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 whitespace-normal">
        {title}
      </TooltipContent>
    </Tooltip>
  );
}
