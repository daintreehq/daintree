import { CircleDot, SquareTerminal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isPtyPanel } from "@shared/types/panel";
import type { TerminalHandback } from "@shared/types/handback";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { TimeAgo } from "@/components/ui/TimeAgo";

interface HandbackEntry {
  panelId: string;
  title: string;
  handback: TerminalHandback;
}

interface LinkedIssue {
  worktreeId: string;
  label: string;
  title?: string;
}

interface ReviewHubContextProps {
  worktreePath: string;
  worktreeId: string | undefined;
}

/**
 * What the work was for and what the agent said it did, both read straight off
 * recorded state. Nothing here is inferred from agent state or terminal output,
 * and a worktree with neither shows nothing.
 */
export function ReviewHubContext({ worktreePath, worktreeId }: ReviewHubContextProps) {
  const issue = useWorktreeStore(
    useShallow((state): LinkedIssue | null => {
      for (const wt of state.worktrees.values()) {
        if (wt.path !== worktreePath) continue;
        if (!wt.issueNumber) return null;
        return {
          worktreeId: wt.id,
          label: wt.issueKey ?? `#${wt.issueNumber}`,
          title: wt.issueTitle ?? wt.branchDerivedTitle,
        };
      }
      return null;
    })
  );

  // Panel references are stable between store updates, so the shallow compare
  // holds; building entries inside the selector would mint new objects per call.
  const panels = usePanelStore(
    useShallow((state) => {
      if (!worktreeId) return [];
      return Object.values(state.panelsById).filter(
        (panel) =>
          isPtyPanel(panel) &&
          panel.location !== "trash" &&
          panel.worktreeId === worktreeId &&
          panel.lastHandback
      );
    })
  );
  const handbacks: HandbackEntry[] = panels
    .flatMap((panel) =>
      isPtyPanel(panel) && panel.lastHandback
        ? [{ panelId: panel.id, title: panel.title, handback: panel.lastHandback }]
        : []
    )
    .sort((a, b) => b.handback.observedAt - a.handback.observedAt);

  if (!issue && handbacks.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 border-b border-divider text-xs"
      data-testid="review-hub-context"
    >
      {issue && (
        <button
          type="button"
          className="flex items-center gap-1.5 min-w-0 text-left text-text-secondary hover:text-text-primary"
          aria-label={`Open issue ${issue.label}${issue.title ? ` ${issue.title}` : ""}`}
          data-testid="review-hub-linked-issue"
          onClick={() =>
            void actionService.dispatch(
              "worktree.openIssue",
              { worktreeId: issue.worktreeId },
              { source: "user" }
            )
          }
        >
          <CircleDot className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0 font-mono">{issue.label}</span>
          {issue.title && <span className="truncate">{issue.title}</span>}
        </button>
      )}
      {handbacks.map(({ panelId, title, handback }) => (
        <div
          key={panelId}
          className="flex flex-col gap-0.5 min-w-0"
          data-testid="review-hub-handback"
        >
          <div className="flex items-center gap-1.5 text-text-muted">
            <span className="shrink-0">Last handback from</span>
            <span className="truncate text-text-secondary">{title}</span>
            <span className="shrink-0">·</span>
            <TimeAgo timestamp={handback.observedAt} verbose />
            <button
              type="button"
              className="ml-auto shrink-0 inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
              aria-label={`Go to terminal ${title}`}
              onClick={() =>
                void actionService.dispatch("panel.focus", { panelId }, { source: "user" })
              }
            >
              <SquareTerminal className="size-3.5" aria-hidden="true" />
              <span>Go to terminal</span>
            </button>
          </div>
          <p className="text-text-primary whitespace-pre-wrap wrap-break-word">
            {handback.message ? (
              <>
                <span className="text-text-muted">The agent said: </span>“{handback.message}”
              </>
            ) : (
              <span className="text-text-muted">The agent sent a handback with no summary.</span>
            )}
            {handback.truncated && <span className="text-text-muted"> (truncated)</span>}
          </p>
        </div>
      ))}
    </div>
  );
}
