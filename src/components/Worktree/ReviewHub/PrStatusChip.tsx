import { ExternalLink, GitPullRequest } from "lucide-react";
import type { CIStatus, NormalizedPRState } from "@shared/types/forge";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";

interface WorktreePR {
  prNumber: number;
  prUrl: string;
  prState: NormalizedPRState;
  prCiStatus?: CIStatus;
}

interface PrStatusChipProps {
  hasRemote: boolean | undefined;
  worktreePR: WorktreePR | null;
  onOpenExternal: (url: string) => void;
}

export function PrStatusChip({ hasRemote, worktreePR, onOpenExternal }: PrStatusChipProps) {
  if (hasRemote && worktreePR && worktreePR.prUrl) {
    const ciVisual = getCIStatusVisual(worktreePR.prCiStatus);
    const prStateLabel =
      worktreePR.prState === "merged"
        ? "merged"
        : worktreePR.prState === "closed" || worktreePR.prState === "declined"
          ? "closed"
          : "open";
    return (
      <>
        <Badge
          tone="outline"
          className="text-[11px] font-mono"
          aria-label={
            ciVisual
              ? `Pull request #${worktreePR.prNumber} ${prStateLabel} — CI ${ciVisual.shortLabel}`
              : `Pull request #${worktreePR.prNumber} ${prStateLabel}`
          }
        >
          <GitPullRequest
            className={cn(
              "w-3 h-3 shrink-0",
              worktreePR.prState === "merged"
                ? "text-pr-merged"
                : worktreePR.prState === "closed" || worktreePR.prState === "declined"
                  ? "text-pr-closed"
                  : "text-pr-open"
            )}
          />
          <span
            className={
              worktreePR.prState === "merged"
                ? "text-pr-merged"
                : worktreePR.prState === "closed" || worktreePR.prState === "declined"
                  ? "text-pr-closed"
                  : "text-pr-open"
            }
          >
            #{worktreePR.prNumber}
          </span>
          <span className="text-daintree-text/40">·</span>
          <span className="text-daintree-text/60">{prStateLabel}</span>
          {ciVisual && (
            <>
              <span className="text-daintree-text/40">·</span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-flex items-center justify-center w-3 h-3 shrink-0"
                  aria-hidden="true"
                >
                  <ciVisual.Icon className={cn("w-3 h-3", ciVisual.colorClass)} />
                </span>
                <span className={ciVisual.colorClass}>{ciVisual.shortLabel}</span>
              </span>
            </>
          )}
        </Badge>
        <button
          type="button"
          onClick={() => onOpenExternal(worktreePR.prUrl)}
          className={cn(
            "inline-flex items-center justify-center p-0.5 rounded",
            "text-daintree-text/60 hover:bg-tint/5 hover:text-daintree-text",
            "transition-colors cursor-pointer",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
          )}
          aria-label={`View pull request #${worktreePR.prNumber}`}
        >
          <ExternalLink className="w-3 h-3" />
        </button>
      </>
    );
  }

  if (hasRemote && !worktreePR) {
    return (
      <Badge tone="outline" className="text-[11px] text-daintree-text/40">
        <GitPullRequest />
        <span>No PR</span>
      </Badge>
    );
  }

  return null;
}
