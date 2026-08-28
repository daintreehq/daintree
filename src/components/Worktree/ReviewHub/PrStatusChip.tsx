import { ExternalLink, GitPullRequest } from "lucide-react";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
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
    const PrStateGlyph = getPrStateGlyph(worktreePR.prState);
    const prStateColor = getPrStateColor(worktreePR.prState);
    return (
      <>
        <Badge
          tone="outline"
          className="text-2xs font-mono"
          aria-label={
            ciVisual
              ? `Pull request #${worktreePR.prNumber} ${prStateLabel} — CI ${ciVisual.shortLabel}`
              : `Pull request #${worktreePR.prNumber} ${prStateLabel}`
          }
        >
          {/* Shape AND colour — see `getPrStateGlyph`. This chip does carry the
              state word beside it, but the glyph is what the eye reaches
              first, and it is shared with the card badge, which does not. */}
          <PrStateGlyph className={cn("w-3 h-3 shrink-0", prStateColor)} />
          <span className={prStateColor}>#{worktreePR.prNumber}</span>
          <span className="text-text-muted">·</span>
          <span className="text-text-secondary">{prStateLabel}</span>
          {ciVisual && (
            <>
              <span className="text-text-muted">·</span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-flex items-center justify-center w-3 h-3 shrink-0"
                  aria-hidden="true"
                >
                  {ciVisual.kind === "icon" ? (
                    <ciVisual.Icon className={cn("w-3 h-3", ciVisual.colorClass)} />
                  ) : (
                    <span
                      className={cn("status-mark block w-2 h-2 rounded-full", ciVisual.colorClass)}
                    />
                  )}
                </span>
                <span
                  className={ciVisual.kind === "icon" ? ciVisual.colorClass : ciVisual.labelClass}
                >
                  {ciVisual.shortLabel}
                </span>
              </span>
            </>
          )}
        </Badge>
        <button
          type="button"
          onClick={() => onOpenExternal(worktreePR.prUrl)}
          className={cn(
            "inline-flex items-center justify-center p-0.5 rounded",
            "text-daintree-text/60 hover:bg-tint/5 hover:text-text-primary",
            "transition-colors cursor-pointer",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
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
      <Badge tone="outline" className="text-2xs text-text-secondary">
        <GitPullRequest />
        <span>No PR</span>
      </Badge>
    );
  }

  return null;
}
