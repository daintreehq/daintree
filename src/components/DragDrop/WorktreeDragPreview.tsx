import { CircleDot } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import type { WorktreeSnapshot } from "@shared/types";

interface WorktreeDragPreviewProps {
  worktree: WorktreeSnapshot;
}

export function WorktreeDragPreview({ worktree }: WorktreeDragPreviewProps) {
  const branchLabel = worktree.isMainWorktree ? worktree.name : (worktree.branch ?? worktree.name);
  const hasIssueTitle = !!(worktree.issueNumber && worktree.issueTitle);

  return (
    <div
      style={{
        width: 220,
        backgroundColor: "var(--color-daintree-sidebar)",
        border: "1px solid var(--color-daintree-border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--theme-shadow-floating)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        padding: "10px 12px",
        gap: 4,
      }}
    >
      {hasIssueTitle ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <CircleDot
              style={{
                width: 12,
                height: 12,
                color: "var(--color-github-open)",
                flexShrink: 0,
              }}
              aria-hidden="true"
            />
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-text-primary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {worktree.issueTitle}
            </span>
          </div>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "color-mix(in srgb, var(--color-daintree-text) 50%, transparent)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {branchLabel}
          </span>
        </>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <FolderGit2
            style={{
              width: 12,
              height: 12,
              color: "color-mix(in srgb, var(--color-daintree-text) 50%, transparent)",
              flexShrink: 0,
            }}
            aria-hidden="true"
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 500,
              color: "var(--color-daintree-text)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {branchLabel}
          </span>
        </div>
      )}
    </div>
  );
}
