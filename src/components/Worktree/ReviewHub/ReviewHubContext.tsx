import { useId, useState } from "react";
import { CircleDot, SquareTerminal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isPtyPanel, type PtyPanelData, type TerminalFirstPrompt } from "@shared/types/panel";
import type { TerminalHandback } from "@shared/types/handback";
import { FIRST_PROMPT_MAX_CHARS } from "@shared/utils/firstPrompt";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface RunEntry {
  panelId: string;
  title: string;
  firstPrompt?: TerminalFirstPrompt;
  handback?: TerminalHandback;
}

/** Longer than this and a first prompt is clamped behind "Show more". */
const LONG_PROMPT_CHARS = 280;
const LONG_PROMPT_LINES = 4;

const FIRST_PROMPT_LABEL: Record<TerminalFirstPrompt["via"], string> = {
  launch: "Launched with",
  send: "First sent",
};

/**
 * A missing-CLI gate holds its launch's prompt for "Run anyway", but nothing
 * ran there yet, so it claims nothing.
 */
function shownFirstPrompt(panel: PtyPanelData): TerminalFirstPrompt | undefined {
  return panel.spawnStatus === "missing-cli" ? undefined : panel.firstPrompt;
}

function latestActivity(entry: RunEntry): number {
  return Math.max(entry.handback?.observedAt ?? 0, entry.firstPrompt?.at ?? 0);
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
 * recorded state: the linked issue, and for each terminal the first prompt
 * Daintree delivered to it and its last handback. Nothing here is inferred from
 * agent state, terminal output or the launch command, and a worktree with none
 * of them shows nothing.
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
          (panel.lastHandback || shownFirstPrompt(panel))
      );
    })
  );
  const runs: RunEntry[] = panels
    .flatMap((panel) =>
      isPtyPanel(panel)
        ? [
            {
              panelId: panel.id,
              title: panel.title,
              firstPrompt: shownFirstPrompt(panel),
              handback: panel.lastHandback,
            },
          ]
        : []
    )
    .sort((a, b) => latestActivity(b) - latestActivity(a));

  if (!issue && runs.length === 0) return null;

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
      {runs.map(({ panelId, title, firstPrompt, handback }) => (
        <div key={panelId} className="flex flex-col gap-1 min-w-0" data-testid="review-hub-run">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-text-secondary">{title}</span>
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
          {firstPrompt && <FirstPromptBlock firstPrompt={firstPrompt} />}
          {handback && (
            <div className="flex flex-col gap-0.5 min-w-0" data-testid="review-hub-handback">
              <div className="flex items-center gap-1.5 text-text-muted">
                <span className="shrink-0">Last handback</span>
                <span className="shrink-0">·</span>
                <TimeAgo timestamp={handback.observedAt} verbose />
              </div>
              <p className="text-text-primary whitespace-pre-wrap wrap-break-word">
                {handback.message ? (
                  <>
                    <span className="text-text-muted">The agent said: </span>“{handback.message}”
                  </>
                ) : (
                  <span className="text-text-muted">
                    The agent sent a handback with no summary.
                  </span>
                )}
                {handback.truncated && <span className="text-text-muted"> (truncated)</span>}
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The prompt exactly as recorded, as text: never rendered as Markdown or HTML,
 * since it is whatever the caller wrote.
 */
function FirstPromptBlock({ firstPrompt }: { firstPrompt: TerminalFirstPrompt }) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const long =
    firstPrompt.text.length > LONG_PROMPT_CHARS ||
    firstPrompt.text.split("\n").length > LONG_PROMPT_LINES;
  return (
    <div className="flex flex-col gap-0.5 min-w-0" data-testid="review-hub-first-prompt">
      <div className="flex items-center gap-1.5 text-text-muted">
        <span className="shrink-0">{FIRST_PROMPT_LABEL[firstPrompt.via]}</span>
        <span className="shrink-0">·</span>
        <TimeAgo timestamp={firstPrompt.at} verbose />
      </div>
      <p
        id={textId}
        className={cn(
          "text-text-primary whitespace-pre-wrap wrap-break-word",
          long && !expanded && "line-clamp-4"
        )}
      >
        {firstPrompt.text}
      </p>
      {firstPrompt.truncated && (
        <p className="text-text-muted">
          Only the first {FIRST_PROMPT_MAX_CHARS.toLocaleString()} characters were kept.
        </p>
      )}
      {long && (
        <Button
          variant="link"
          className="self-start"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}
