import { cn } from "@/lib/utils";
import { STATE_ICONS, STATE_COLORS } from "../terminalStateConfig";
import { BranchLabel } from "../BranchLabel";
import { UpstreamSyncBadge } from "./UpstreamSyncBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { GitBranch } from "lucide-react";
import type { AggregateCounts } from "./MainWorktreeSummaryRows";

interface MainWorktreeSecondaryRowProps {
  branchLabel: string;
  isActive: boolean;
  isMuted?: boolean;
  hasUpstreamDelta: boolean;
  hasAuthFailedSignIn: boolean;
  aheadCount: number | undefined;
  behindCount: number | undefined;
  isFetchInFlight: boolean;
  lastFetchedAt: number | null | undefined;
  fetchAuthFailed: boolean;
  fetchNetworkFailed: boolean;
  isGitHubRemote: boolean;
  aggregateCounts?: AggregateCounts;
}

export function MainWorktreeSecondaryRow({
  branchLabel,
  isActive,
  isMuted,
  hasUpstreamDelta,
  hasAuthFailedSignIn,
  aheadCount,
  behindCount,
  isFetchInFlight,
  lastFetchedAt,
  fetchAuthFailed,
  fetchNetworkFailed,
  isGitHubRemote,
  aggregateCounts,
}: MainWorktreeSecondaryRowProps) {
  return (
    <div className="flex items-center gap-2 mt-1" data-testid="main-worktree-meta-row">
      <BranchLabel
        label={branchLabel}
        isActive={isActive}
        isMuted={isMuted}
        isMainWorktree={false}
      />
      {(hasUpstreamDelta || hasAuthFailedSignIn) && (
        <UpstreamSyncBadge
          aheadCount={aheadCount}
          behindCount={behindCount}
          isFetchInFlight={isFetchInFlight}
          lastFetchedAt={lastFetchedAt}
          fetchAuthFailed={fetchAuthFailed}
          fetchNetworkFailed={fetchNetworkFailed}
          isGitHubRemote={isGitHubRemote}
          containerGapClass="gap-1"
        />
      )}
      {aggregateCounts && aggregateCounts.worktrees > 0 && (
        <>
          <span className="text-text-muted/40 text-[10px]" aria-hidden="true">
            ·
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="flex items-center gap-1.5 text-[10px] text-daintree-text/50"
                data-testid="aggregate-worktree-row"
              >
                <span className="flex items-center gap-0.5">
                  <GitBranch className="w-2.5 h-2.5" aria-hidden="true" />
                  <span className="font-mono tabular-nums">{aggregateCounts.worktrees}</span>
                </span>
                {aggregateCounts.working > 0 && (
                  <span className={cn("flex items-center gap-0.5", STATE_COLORS.working)}>
                    <STATE_ICONS.working
                      className="w-2.5 h-2.5 animate-spin-slow motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    <span className="font-mono tabular-nums">{aggregateCounts.working}</span>
                  </span>
                )}
                {aggregateCounts.waiting > 0 && (
                  <span className={cn("flex items-center gap-0.5", STATE_COLORS.waiting)}>
                    <STATE_ICONS.waiting className="w-2.5 h-2.5" aria-hidden="true" />
                    <span className="font-mono tabular-nums">{aggregateCounts.waiting}</span>
                  </span>
                )}
                {aggregateCounts.finished > 0 &&
                  aggregateCounts.working === 0 &&
                  aggregateCounts.waiting === 0 && (
                    <span className={cn("flex items-center gap-0.5", STATE_COLORS.completed)}>
                      <STATE_ICONS.completed className="w-2.5 h-2.5" aria-hidden="true" />
                      <span className="font-mono tabular-nums">{aggregateCounts.finished}</span>
                    </span>
                  )}
              </span>
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
        </>
      )}
    </div>
  );
}
