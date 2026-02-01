import { useCallback, useMemo, useState, memo } from "react";
import type React from "react";
import type { TerminalRecipe, WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { BranchLabel } from "../BranchLabel";
import {
  WorktreeMenuItems,
  type WorktreeLaunchAgentItem,
  type WorktreeMenuComponents,
} from "../WorktreeMenuItems";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../../ui/tooltip";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CircleDot,
  Copy,
  CornerDownRight,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Pin,
  Shield,
} from "lucide-react";
import { useIssueTooltip, usePRTooltip } from "@/hooks/useGitHubTooltip";
import { useWorktreeConflicts } from "@/hooks/useConflictDetector";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { getConflictingWorktreeNames } from "@/utils/conflictDetector";
import { IssueTooltipContent, PRTooltipContent, TooltipLoading } from "./GitHubTooltipContent";

const DROPDOWN_COMPONENTS: WorktreeMenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

interface IssueBadgeProps {
  issueNumber: number;
  issueTitle?: string;
  worktreePath: string;
  onOpen?: () => void;
}

const IssueBadge = memo(function IssueBadge({
  issueNumber,
  issueTitle,
  worktreePath,
  onOpen,
}: IssueBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data, loading, error, fetchTooltip, reset } = useIssueTooltip(worktreePath, issueNumber);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        fetchTooltip();
      } else {
        reset();
      }
    },
    [fetchTooltip, reset]
  );

  return (
    <TooltipProvider>
      <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen?.();
            }}
            className="flex items-center gap-1.5 text-xs text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent min-w-0"
            aria-label={
              issueTitle
                ? `Open issue #${issueNumber}: ${issueTitle}`
                : `Open issue #${issueNumber} on GitHub`
            }
          >
            <CircleDot className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" />
            <span className="truncate text-canopy-text/90 flex-1 min-w-0">
              {issueTitle || <span className="text-emerald-400 font-mono">#{issueNumber}</span>}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" className="p-3">
          {loading ? (
            <TooltipLoading type="issue" />
          ) : data ? (
            <IssueTooltipContent data={data} />
          ) : error ? (
            <span className="text-xs text-canopy-text/70">Failed to load issue details</span>
          ) : (
            <span className="text-xs text-canopy-text/70">Issue #{issueNumber}</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

interface PRBadgeProps {
  prNumber: number;
  prState?: "open" | "merged" | "closed";
  worktreePath: string;
  isSubordinate: boolean;
  onOpen?: () => void;
}

const PRBadge = memo(function PRBadge({
  prNumber,
  prState,
  worktreePath,
  isSubordinate,
  onOpen,
}: PRBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data, loading, error, fetchTooltip, reset } = usePRTooltip(worktreePath, prNumber);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        fetchTooltip();
      } else {
        reset();
      }
    },
    [fetchTooltip, reset]
  );

  const prStateColor =
    prState === "merged"
      ? "text-violet-400"
      : prState === "closed"
        ? "text-red-400"
        : "text-sky-400";

  const prStateLabel = prState === "merged" ? "merged" : prState === "closed" ? "closed" : "open";

  return (
    <TooltipProvider>
      <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen?.();
            }}
            className="flex items-center gap-1 text-xs text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
            aria-label={`Open ${prStateLabel} pull request #${prNumber} on GitHub`}
          >
            {isSubordinate && (
              <CornerDownRight
                className="w-3 h-3 text-canopy-text/30 shrink-0"
                aria-hidden="true"
              />
            )}
            <GitPullRequest className={cn("w-3 h-3 shrink-0", prStateColor)} aria-hidden="true" />
            <span className={cn("font-mono", prStateColor)}>#{prNumber}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" className="p-3">
          {loading ? (
            <TooltipLoading type="pr" />
          ) : data ? (
            <PRTooltipContent data={data} />
          ) : error ? (
            <span className="text-xs text-canopy-text/70">Failed to load PR details</span>
          ) : (
            <span className="text-xs text-canopy-text/70">PR #{prNumber}</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

interface ConflictBadgeProps {
  worktreeId: string;
}

const ConflictBadge = memo(function ConflictBadge({ worktreeId }: ConflictBadgeProps) {
  const { conflictCount, conflicts } = useWorktreeConflicts(worktreeId);
  const worktreeMap = useWorktreeDataStore((state) => state.worktrees);

  const tooltipContent = useMemo(() => {
    const lines: { file: string; fullPath: string; worktrees: string }[] = [];
    for (const conflict of conflicts) {
      const otherWorktrees = getConflictingWorktreeNames(worktreeId, conflict, worktreeMap);
      const pathSegments = conflict.filePath.split("/");
      const fileName = pathSegments[pathSegments.length - 1] ?? conflict.filePath;
      const parentDir = pathSegments.length > 1 ? pathSegments[pathSegments.length - 2] : "";
      const displayPath = parentDir ? `${parentDir}/${fileName}` : fileName;

      lines.push({
        file: displayPath,
        fullPath: conflict.filePath,
        worktrees: otherWorktrees.join(", "),
      });
    }
    return lines;
  }, [conflicts, worktreeId, worktreeMap]);

  if (conflictCount === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-0.5 text-amber-400 text-xs font-mono shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent rounded px-0.5 -mx-0.5"
            aria-label={`${conflictCount} potential merge conflict${conflictCount !== 1 ? "s" : ""}`}
          >
            <AlertTriangle className="w-3 h-3" aria-hidden="true" />
            <span>{conflictCount}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-sm">
          <div className="space-y-1">
            <div className="font-medium text-xs">
              Potential merge conflict{conflictCount !== 1 ? "s" : ""}
            </div>
            <div className="text-xs text-canopy-text/70 space-y-0.5">
              {tooltipContent.map((entry, i) => (
                <div key={i} className="break-words" title={entry.fullPath}>
                  {entry.file} → {entry.worktrees}
                </div>
              ))}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export interface WorktreeHeaderProps {
  worktree: WorktreeState;
  isActive: boolean;
  isMainWorktree: boolean;
  isPinned: boolean;
  branchLabel: string;
  worktreeErrorCount: number;

  copy: {
    treeCopied: boolean;
    isCopyingTree: boolean;
    copyFeedback: string;
    onCopyTreeClick: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  };

  badges: {
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
  };

  menu: {
    launchAgents: WorktreeLaunchAgentItem[];
    recipes: TerminalRecipe[];
    runningRecipeId: string | null;
    isRestartValidating: boolean;
    counts: {
      grid: number;
      dock: number;
      active: number;
      completed: number;
      failed: number;
      all: number;
    };
    onCopyContext: () => void;
    onOpenEditor: () => void;
    onRevealInFinder: () => void;
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
    onRunRecipe: (recipeId: string) => void;
    onSaveLayout?: () => void;
    onTogglePin?: () => void;
    onLaunchAgent?: (agentId: string) => void;
    onMinimizeAll: () => void;
    onMaximizeAll: () => void;
    onRestartAll: () => void;
    onCloseCompleted: () => void;
    onCloseFailed: () => void;
    onCloseAll: () => void;
    onEndAll: () => void;
    onDeleteWorktree?: () => void;
  };
}

export function WorktreeHeader({
  worktree,
  isActive,
  isMainWorktree,
  isPinned,
  branchLabel,
  worktreeErrorCount,
  copy,
  badges,
  menu,
}: WorktreeHeaderProps) {
  const recipeOptions = useMemo(
    () => menu.recipes.map((r) => ({ id: r.id, name: r.name })),
    [menu.recipes]
  );

  const handleLaunchAgent = useCallback(
    (agentId: string) => {
      menu.onLaunchAgent?.(agentId);
    },
    [menu]
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 min-h-[22px]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isMainWorktree && (
            <Shield
              className="w-3.5 h-3.5 text-canopy-text/30 shrink-0"
              aria-label="Main worktree"
            />
          )}
          {isPinned && !isMainWorktree && (
            <Pin className="w-3 h-3 text-canopy-text/40 shrink-0" aria-label="Pinned" />
          )}
          <BranchLabel label={branchLabel} isActive={isActive} isMainWorktree={isMainWorktree} />
          {worktree.isDetached && (
            <span className="text-amber-500 text-xs font-medium shrink-0">(detached)</span>
          )}
        </div>

        <ConflictBadge worktreeId={worktree.id} />

        {worktreeErrorCount > 0 && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-0.5 text-[var(--color-status-error)] text-xs font-mono shrink-0">
                  <AlertCircle className="w-3 h-3" />
                  <span>{worktreeErrorCount}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {worktreeErrorCount} error{worktreeErrorCount !== 1 ? "s" : ""}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <div
          className={cn(
            "flex items-center gap-1 shrink-0 transition-opacity duration-150",
            isActive || copy.treeCopied || copy.isCopyingTree
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          )}
        >
          <TooltipProvider>
            <Tooltip open={copy.treeCopied} delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  onClick={copy.onCopyTreeClick}
                  disabled={copy.isCopyingTree}
                  className={cn(
                    "p-1 rounded transition-colors",
                    copy.treeCopied
                      ? "text-green-400 bg-green-400/10"
                      : "text-canopy-text/40 hover:text-canopy-text hover:bg-white/5",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                    copy.isCopyingTree && "cursor-wait opacity-70"
                  )}
                  aria-label={copy.treeCopied ? "Context Copied" : "Copy Context"}
                >
                  {copy.isCopyingTree ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none text-canopy-text" />
                  ) : copy.treeCopied ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="font-medium">
                <span role="status" aria-live="polite">
                  {copy.copyFeedback}
                </span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                className="p-1 text-canopy-text/60 hover:text-white hover:bg-white/5 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                aria-label="More actions"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="bottom"
              sideOffset={4}
              collisionPadding={8}
              onClick={(e) => e.stopPropagation()}
              className="w-64"
            >
              <WorktreeMenuItems
                worktree={worktree}
                components={DROPDOWN_COMPONENTS}
                launchAgents={menu.launchAgents}
                recipes={recipeOptions}
                runningRecipeId={menu.runningRecipeId}
                isRestartValidating={menu.isRestartValidating}
                isPinned={isPinned}
                counts={menu.counts}
                onLaunchAgent={menu.onLaunchAgent ? handleLaunchAgent : undefined}
                onCopyContext={menu.onCopyContext}
                onOpenEditor={menu.onOpenEditor}
                onRevealInFinder={menu.onRevealInFinder}
                onOpenIssue={menu.onOpenIssue}
                onOpenPR={menu.onOpenPR}
                onRunRecipe={menu.onRunRecipe}
                onSaveLayout={menu.onSaveLayout}
                onTogglePin={menu.onTogglePin}
                onMinimizeAll={menu.onMinimizeAll}
                onMaximizeAll={menu.onMaximizeAll}
                onRestartAll={menu.onRestartAll}
                onCloseCompleted={menu.onCloseCompleted}
                onCloseFailed={menu.onCloseFailed}
                onCloseAll={menu.onCloseAll}
                onEndAll={menu.onEndAll}
                onDeleteWorktree={menu.onDeleteWorktree}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {(worktree.issueNumber || worktree.prNumber) && (
        <div className="flex flex-col gap-0.5">
          {worktree.issueNumber && (
            <IssueBadge
              issueNumber={worktree.issueNumber}
              issueTitle={worktree.issueTitle}
              worktreePath={worktree.path}
              onOpen={badges.onOpenIssue}
            />
          )}
          {worktree.prNumber && (
            <PRBadge
              prNumber={worktree.prNumber}
              prState={worktree.prState}
              worktreePath={worktree.path}
              isSubordinate={!!worktree.issueNumber}
              onOpen={badges.onOpenPR}
            />
          )}
        </div>
      )}
    </div>
  );
}
