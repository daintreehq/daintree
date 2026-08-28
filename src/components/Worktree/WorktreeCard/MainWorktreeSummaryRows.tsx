import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { CheckCircle2, XCircle, Clock, CircleMinus, GitPullRequest, CircleDot } from "lucide-react";

export interface AggregateCounts {
  worktrees: number;
  working: number;
  waiting: number;
  finished: number;
}

interface MainWorktreeSummaryRowsProps {
  health: ForgeProjectHealthPayload | null;
}

function ciStatusIcon(status: ForgeProjectHealthPayload["ciStatus"]) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="w-2.5 h-2.5 text-status-success" />;
    case "failure":
    case "error":
      return <XCircle className="w-2.5 h-2.5 text-status-error" />;
    case "pending":
    case "expected":
      return <Clock className="w-2.5 h-2.5 text-status-warning" />;
    default:
      return <CircleMinus className="w-2.5 h-2.5 text-daintree-text/40" />;
  }
}

function ciStatusLabel(status: ForgeProjectHealthPayload["ciStatus"]): string {
  switch (status) {
    case "success":
      return "passing";
    case "failure":
      return "failing";
    case "error":
      return "error";
    case "pending":
    case "expected":
      return "pending";
    default:
      return "no CI";
  }
}

export function MainWorktreeSummaryRows({ health }: MainWorktreeSummaryRowsProps) {
  if (!health) return null;

  return (
    <div className="flex flex-col gap-1 mt-2" data-testid="main-worktree-summary">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex items-center gap-2 text-3xs text-text-secondary"
            data-testid="github-pulse-row"
          >
            <span className="flex items-center gap-0.5">
              {ciStatusIcon(health.ciStatus)}
              <span className="font-mono tabular-nums">{ciStatusLabel(health.ciStatus)}</span>
            </span>
            <span className="flex items-center gap-0.5">
              <GitPullRequest className="w-2.5 h-2.5" />
              <span className="font-mono tabular-nums">{health.prCount}</span>
            </span>
            <span className="flex items-center gap-0.5">
              <CircleDot className="w-2.5 h-2.5 text-pr-open" />
              <span className="font-mono tabular-nums">{health.issueCount}</span>
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          CI: {ciStatusLabel(health.ciStatus)} · {health.prCount} open PR
          {health.prCount !== 1 ? "s" : ""} · {health.issueCount} open issue
          {health.issueCount !== 1 ? "s" : ""}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
