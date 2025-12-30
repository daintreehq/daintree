import { useCallback, useMemo } from "react";
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
  Check,
  CheckCircle2,
  CircleDot,
  Copy,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Shield,
} from "lucide-react";

const DROPDOWN_COMPONENTS: WorktreeMenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

export interface WorktreeHeaderProps {
  worktree: WorktreeState;
  isActive: boolean;
  isMainWorktree: boolean;
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
          {isActive && (
            <CheckCircle2
              className="w-3.5 h-3.5 text-canopy-accent shrink-0 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in motion-safe:duration-200"
              aria-hidden="true"
            />
          )}
          {isMainWorktree && <Shield className="w-3.5 h-3.5 text-canopy-text/30 shrink-0" />}
          <BranchLabel label={branchLabel} isActive={isActive} isMainWorktree={isMainWorktree} />
          {worktree.isDetached && (
            <span className="text-amber-500 text-xs font-medium shrink-0">(detached)</span>
          )}
        </div>

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
              sideOffset={4}
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
                counts={menu.counts}
                onLaunchAgent={menu.onLaunchAgent ? handleLaunchAgent : undefined}
                onCopyContext={menu.onCopyContext}
                onOpenEditor={menu.onOpenEditor}
                onRevealInFinder={menu.onRevealInFinder}
                onOpenIssue={menu.onOpenIssue}
                onOpenPR={menu.onOpenPR}
                onRunRecipe={menu.onRunRecipe}
                onSaveLayout={menu.onSaveLayout}
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
        <div className="flex items-center gap-2">
          <TooltipProvider>
            {worktree.issueNumber && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      badges.onOpenIssue?.();
                    }}
                    className="flex items-center gap-1 text-xs text-emerald-400/80 hover:text-emerald-400 hover:underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                  >
                    <CircleDot className="w-2.5 h-2.5" />
                    <span className="font-mono">#{worktree.issueNumber}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>{worktree.issueTitle || "Open Issue on GitHub"}</TooltipContent>
              </Tooltip>
            )}
            {worktree.prNumber && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      badges.onOpenPR?.();
                    }}
                    className={cn(
                      "flex items-center gap-1 text-xs hover:underline transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                      worktree.prState === "merged"
                        ? "text-violet-400/80 hover:text-violet-400"
                        : worktree.prState === "closed"
                          ? "text-red-400/80 hover:text-red-400"
                          : "text-sky-400/80 hover:text-sky-400"
                    )}
                  >
                    <GitPullRequest className="w-2.5 h-2.5" />
                    <span className="font-mono">#{worktree.prNumber}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {worktree.prTitle || `PR #${worktree.prNumber} · ${worktree.prState ?? "open"}`}
                </TooltipContent>
              </Tooltip>
            )}
          </TooltipProvider>
        </div>
      )}
    </div>
  );
}
