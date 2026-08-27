import type React from "react";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import type { FileDecoration } from "@shared/types/forge";
import { cn } from "@/lib/utils";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { getBaseBranchStatusConfig } from "./reviewHubUtils";

interface BaseBranchFileRowProps {
  file: CrossWorktreeFile;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  unresolvedDecoration?: FileDecoration;
  onBadgeClick?: () => void;
}

export function BaseBranchFileRow({
  file,
  onClick,
  unresolvedDecoration,
  onBadgeClick,
}: BaseBranchFileRowProps) {
  const config = getBaseBranchStatusConfig(file.status);
  const normalized = file.path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
  const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  const insertions = file.insertions ?? 0;
  const deletions = file.deletions ?? 0;
  const hasChurn = insertions > 0 || deletions > 0;
  // Provider-authored badge semantics: the count lives in `decoration.badge`
  // and the accessible label in `decoration.tooltip` — the host must never
  // re-derive English phrases from a numeric count (issue #9953). The
  // badge is rendered only when a provider explicitly attached a
  // non-empty `badge`; the click target only when a `url` is present.
  const hasBadge =
    typeof unresolvedDecoration?.badge === "string" && unresolvedDecoration.badge.length > 0;
  const badgeLabel = unresolvedDecoration?.tooltip ?? `Unresolved review comments on ${file.path}`;

  return (
    <TruncatedTooltip content={file.path}>
      <div
        className={cn(
          "group/baserow w-full flex items-center text-xs rounded px-1.5 py-1.5",
          "hover:bg-tint/5 transition-colors"
        )}
      >
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "relative flex min-w-0 flex-1 items-baseline rounded text-left",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex items-center justify-center rounded-sm px-1 mr-2 shrink-0",
              "text-3xs font-medium leading-4 h-4 min-w-[16px]",
              config.bg,
              config.text
            )}
          >
            {config.label}
          </span>
          {dir && (
            <span
              data-testid="base-branch-file-row-dir"
              className={cn(
                "shrink truncate font-mono text-2xs transition-colors",
                "text-daintree-text/50 group-hover/baserow:text-daintree-text/70"
              )}
            >
              {dir}/
            </span>
          )}
          <span
            data-testid="base-branch-file-row-base"
            className={cn(
              "shrink truncate font-medium font-mono text-2xs transition-colors",
              "text-daintree-text group-hover/baserow:text-daintree-text"
            )}
          >
            {base}
          </span>
        </button>
        {hasChurn && (
          <div
            data-testid="base-branch-file-row-churn"
            className="ml-2 flex items-center gap-1 shrink-0 text-3xs tabular-nums"
          >
            {insertions > 0 && <span className="text-status-success/80">+{insertions}</span>}
            {deletions > 0 && <span className="text-status-error/80">-{deletions}</span>}
          </div>
        )}
        {hasBadge && (
          <button
            type="button"
            onClick={onBadgeClick}
            aria-label={badgeLabel}
            disabled={!onBadgeClick}
            className={cn(
              "shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 ml-2 rounded-full",
              "text-3xs font-semibold tabular-nums",
              "bg-status-warning/15 text-status-warning",
              onBadgeClick
                ? "hover:bg-status-warning/25 transition-colors cursor-pointer"
                : "cursor-default",
              "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-warning"
            )}
          >
            {unresolvedDecoration!.badge}
          </button>
        )}
      </div>
    </TruncatedTooltip>
  );
}
