import { memo } from "react";
import type { ProjectHealthData } from "@shared/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { STATE_ICONS, STATE_COLORS } from "../terminalStateConfig";
import {
  GitBranch,
  CheckCircle2,
  XCircle,
  Clock,
  CircleMinus,
  GitPullRequest,
  CircleDot,
} from "lucide-react";

export interface AggregateCounts {
  worktrees: number;
  working: number;
  waiting: number;
  finished: number;
}

interface MainWorktreeSummaryRowsProps {
  aggregateCounts?: AggregateCounts;
  health: ProjectHealthData | null;
}

const WorkingIcon = STATE_ICONS.working;
const WaitingIcon = STATE_ICONS.waiting;
const CompletedIcon = STATE_ICONS.completed;

function ciStatusIcon(status: ProjectHealthData["ciStatus"]) {
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

function ciStatusLabel(status: ProjectHealthData["ciStatus"]): string {
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

export const MainWorktreeSummaryRows = memo(function MainWorktreeSummaryRows({
  aggregateCounts,
  health,
}: MainWorktreeSummaryRowsProps) {
  const hasWorktrees = aggregateCounts && aggregateCounts.worktrees > 0;
  const hasHealth = health !== null;

  if (!hasWorktrees && !hasHealth) return null;

  return (
    <div className="flex flex-col gap-1 mt-2" data-testid="main-worktree-summary">
      {hasWorktrees && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex items-center gap-2 text-[10px] text-daintree-text/60"
              data-testid="aggregate-worktree-row"
            >
              <span className="flex items-center gap-0.5">
                <GitBranch className="w-2.5 h-2.5" />
                <span className="font-mono tabular-nums">{aggregateCounts.worktrees}</span>
              </span>
              {aggregateCounts.working > 0 && (
                <span className={cn("flex items-center gap-0.5", STATE_COLORS.working)}>
                  <WorkingIcon className="w-2.5 h-2.5 animate-spin-slow motion-reduce:animate-none" />
                  <span className="font-mono tabular-nums">{aggregateCounts.working}</span>
                </span>
              )}
              {aggregateCounts.waiting > 0 && (
                <span className={cn("flex items-center gap-0.5", STATE_COLORS.waiting)}>
                  <WaitingIcon className="w-2.5 h-2.5" />
                  <span className="font-mono tabular-nums">{aggregateCounts.waiting}</span>
                </span>
              )}
              {aggregateCounts.finished > 0 &&
                aggregateCounts.working === 0 &&
                aggregateCounts.waiting === 0 && (
                  <span className={cn("flex items-center gap-0.5", STATE_COLORS.completed)}>
                    <CompletedIcon className="w-2.5 h-2.5" />
                    <span className="font-mono tabular-nums">{aggregateCounts.finished}</span>
                  </span>
                )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {aggregateCounts.worktrees} worktree
            {aggregateCounts.worktrees !== 1 ? "s" : ""}
            {(aggregateCounts.working > 0 ||
              aggregateCounts.waiting > 0 ||
              aggregateCounts.finished > 0) &&
              " — "}
            {[
              aggregateCounts.working > 0 && `${aggregateCounts.working} working`,
              aggregateCounts.waiting > 0 && `${aggregateCounts.waiting} waiting`,
              aggregateCounts.finished > 0 && `${aggregateCounts.finished} done`,
            ]
              .filter(Boolean)
              .join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
      {hasHealth && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex items-center gap-2 text-[10px] text-daintree-text/60"
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
                <CircleDot className="w-2.5 h-2.5 text-github-open" />
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
      )}
    </div>
  );
});
