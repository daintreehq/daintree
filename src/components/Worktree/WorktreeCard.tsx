import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeState, AgentState } from "../../types";
import { ActivityLight } from "./ActivityLight";
import { BranchLabel } from "./BranchLabel";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { WorktreeDetails } from "./WorktreeDetails";
import { useWorktreeTerminals } from "../../hooks/useWorktreeTerminals";
import {
  useErrorStore,
  useTerminalStore,
  type RetryAction,
  type TerminalInstance,
} from "../../store";
import { useRecipeStore } from "../../store/recipeStore";
import { useWorktreeSelectionStore } from "../../store/worktreeStore";
import { systemClient, errorsClient } from "@/clients";
import { cn } from "../../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "../ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuLabel,
} from "../ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../ui/tooltip";
import { ConfirmDialog } from "../Terminal/ConfirmDialog";
import { WorktreeDeleteDialog } from "./WorktreeDeleteDialog";
import {
  Check,
  Copy,
  Code,
  CircleDot,
  GitPullRequest,
  Play,
  Plus,
  MoreHorizontal,
  Folder,
  ChevronRight,
  GitCommit,
  Shield,
  Terminal,
  LayoutGrid,
  PanelBottom,
  ExternalLink,
  Trash2,
  Save,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { ClaudeIcon, GeminiIcon, CodexIcon } from "@/components/icons";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { STATE_ICONS, STATE_COLORS, STATE_LABELS, STATE_PRIORITY } from "./terminalStateConfig";

interface StateIconProps {
  state: AgentState;
  count: number;
}

function StateIcon({ state, count }: StateIconProps) {
  const Icon = STATE_ICONS[state];
  const colorClass = STATE_COLORS[state];
  const label = STATE_LABELS[state];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("flex items-center gap-1", colorClass)}
          role="img"
          aria-label={`${count} ${label}`}
        >
          <Icon className={cn("w-3 h-3", state === "working" && "animate-spin")} aria-hidden />
          <span className="font-mono">{count}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {count} {label}
      </TooltipContent>
    </Tooltip>
  );
}

export interface WorktreeCardProps {
  worktree: WorktreeState;
  isActive: boolean;
  isFocused: boolean;
  onSelect: () => void;
  onCopyTree: () => Promise<string | undefined> | void;
  onOpenEditor: () => void;
  onOpenIssue?: () => void;
  onOpenPR?: () => void;
  onCreateRecipe?: () => void;
  onSaveLayout?: () => void;
  onLaunchAgent?: (agentId: string) => void;
  agentAvailability?: UseAgentLauncherReturn["availability"];
  agentSettings?: UseAgentLauncherReturn["agentSettings"];
  homeDir?: string;
}

const MAIN_WORKTREE_NOTE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function WorktreeCard({
  worktree,
  isActive,
  isFocused,
  onSelect,
  onCopyTree,
  onOpenEditor,
  onOpenIssue,
  onOpenPR,
  onCreateRecipe,
  onSaveLayout,
  onLaunchAgent,
  agentAvailability,
  agentSettings,
  homeDir,
}: WorktreeCardProps) {
  const isExpanded = useWorktreeSelectionStore(
    useCallback((state) => state.expandedWorktrees.has(worktree.id), [worktree.id])
  );
  const toggleWorktreeExpanded = useWorktreeSelectionStore((state) => state.toggleWorktreeExpanded);

  const getRecipesForWorktree = useRecipeStore((state) => state.getRecipesForWorktree);
  const runRecipe = useRecipeStore((state) => state.runRecipe);
  const recipes = getRecipesForWorktree(worktree.id);
  const [runningRecipeId, setRunningRecipeId] = useState<string | null>(null);

  const [treeCopied, setTreeCopied] = useState(false);
  const [isCopyingTree, setIsCopyingTree] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const treeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (treeCopyTimeoutRef.current) {
        clearTimeout(treeCopyTimeoutRef.current);
        treeCopyTimeoutRef.current = null;
      }
    };
  }, []);

  const { counts: terminalCounts, terminals: worktreeTerminals } = useWorktreeTerminals(
    worktree.id
  );
  const setFocused = useTerminalStore((state) => state.setFocused);
  const pingTerminal = useTerminalStore((state) => state.pingTerminal);
  const openDockTerminal = useTerminalStore((state) => state.openDockTerminal);

  const bulkCloseByWorktree = useTerminalStore((state) => state.bulkCloseByWorktree);
  const completedCount = terminalCounts.byState.completed;
  const failedCount = terminalCounts.byState.failed;
  const totalTerminalCount = terminalCounts.total;

  const [confirmDialog, setConfirmDialog] = useState({
    isOpen: false,
    title: "",
    description: "",
    onConfirm: () => {},
  });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const worktreeErrors = useErrorStore(
    useShallow((state) =>
      state.errors.filter((e) => e.context?.worktreeId === worktree.id && !e.dismissed)
    )
  );
  const dismissError = useErrorStore((state) => state.dismissError);
  const removeError = useErrorStore((state) => state.removeError);

  const handleErrorRetry = useCallback(
    async (errorId: string, action: RetryAction, args?: Record<string, unknown>) => {
      try {
        await errorsClient.retry(errorId, action, args);
        removeError(errorId);
      } catch (error) {
        console.error("Error retry failed:", error);
      }
    },
    [removeError]
  );

  const [now, setNow] = useState(() => Date.now());
  // Use the isMainWorktree flag from the worktree state for consistent detection
  const isMainWorktree = worktree.isMainWorktree;

  useEffect(() => {
    if (!isMainWorktree || !worktree.aiNote || !worktree.aiNoteTimestamp) {
      return;
    }

    const expiresAt = worktree.aiNoteTimestamp + MAIN_WORKTREE_NOTE_TTL_MS;
    const timeUntilExpiry = expiresAt - Date.now();

    if (timeUntilExpiry <= 0) {
      setNow(Date.now());
      return;
    }

    const timer = setTimeout(() => {
      setNow(Date.now());
    }, timeUntilExpiry);

    return () => clearTimeout(timer);
  }, [isMainWorktree, worktree.aiNote, worktree.aiNoteTimestamp]);

  const effectiveNote = useMemo(() => {
    const trimmed = worktree.aiNote?.trim();
    if (!trimmed) return undefined;

    if (isMainWorktree && worktree.aiNoteTimestamp) {
      const age = now - worktree.aiNoteTimestamp;
      if (age > MAIN_WORKTREE_NOTE_TTL_MS) {
        return undefined;
      }
    }

    return trimmed;
  }, [worktree.aiNote, isMainWorktree, worktree.aiNoteTimestamp, now]);

  const handlePathClick = useCallback(() => {
    systemClient.openPath(worktree.path);
  }, [worktree.path]);

  const handleOpenIssue = useCallback(() => {
    if (worktree.issueNumber && onOpenIssue) {
      onOpenIssue();
    }
  }, [worktree.issueNumber, onOpenIssue]);

  const handleOpenPR = useCallback(() => {
    if (worktree.prNumber && onOpenPR) {
      onOpenPR();
    }
  }, [worktree.prNumber, onOpenPR]);

  const handleRunRecipe = useCallback(
    async (recipeId: string) => {
      if (runningRecipeId !== null) {
        return;
      }

      setRunningRecipeId(recipeId);
      try {
        await runRecipe(recipeId, worktree.path, worktree.id);
      } catch (error) {
        console.error("Failed to run recipe:", error);
      } finally {
        setRunningRecipeId(null);
      }
    },
    [runRecipe, worktree.path, worktree.id, runningRecipeId]
  );

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handleCloseCompleted = useCallback(() => {
    bulkCloseByWorktree(worktree.id, "completed");
  }, [bulkCloseByWorktree, worktree.id]);

  const handleCloseFailed = useCallback(() => {
    bulkCloseByWorktree(worktree.id, "failed");
  }, [bulkCloseByWorktree, worktree.id]);

  const handleCloseAllTerminals = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: "Close All Sessions",
      description: `This will close ${totalTerminalCount} session${totalTerminalCount !== 1 ? "s" : ""} (including agents and shells) for this worktree. This action cannot be undone.`,
      onConfirm: () => {
        bulkCloseByWorktree(worktree.id);
        closeConfirmDialog();
      },
    });
  }, [totalTerminalCount, bulkCloseByWorktree, worktree.id, closeConfirmDialog]);

  const handleLaunchAgent = useCallback(
    (agentId: string, e?: React.MouseEvent) => {
      if (e) {
        e.stopPropagation();
      }
      onLaunchAgent?.(agentId);
    },
    [onLaunchAgent]
  );

  const handleTerminalSelect = useCallback(
    (terminal: TerminalInstance) => {
      // Switch to this worktree if it isn't already active
      if (!isActive) {
        onSelect();
      }

      // Focus the terminal (Dock or Grid)
      if (terminal.location === "dock") {
        openDockTerminal(terminal.id);
      } else {
        setFocused(terminal.id);
      }

      // Trigger the ping animation
      pingTerminal(terminal.id);
    },
    [isActive, onSelect, setFocused, pingTerminal, openDockTerminal]
  );

  const handleCopyTree = useCallback(async () => {
    if (isCopyingTree) return; // Prevent multiple clicks

    setIsCopyingTree(true);

    try {
      // Await the result from App.tsx
      const resultMessage = await onCopyTree();

      if (!isMountedRef.current) return; // Prevent state update if unmounted

      if (resultMessage) {
        setTreeCopied(true);
        setCopyFeedback(resultMessage);

        if (treeCopyTimeoutRef.current) {
          clearTimeout(treeCopyTimeoutRef.current);
        }

        treeCopyTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            setTreeCopied(false);
            setCopyFeedback("");
            treeCopyTimeoutRef.current = null;
          }
        }, 2000);
      }
    } finally {
      if (isMountedRef.current) {
        setIsCopyingTree(false);
      }
    }
  }, [onCopyTree, isCopyingTree]);

  const handleCopyTreeClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.currentTarget.blur();
      await handleCopyTree();
    },
    [handleCopyTree]
  );

  const branchLabel = worktree.branch ?? worktree.name;
  const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
  const rawLastCommitMessage = worktree.worktreeChanges?.lastCommitMessage;
  const firstLineLastCommitMessage = rawLastCommitMessage?.split("\n")[0].trim();

  // The summary often duplicates the last commit message.
  const isSummarySameAsCommit = useMemo(() => {
    if (!worktree.summary || !rawLastCommitMessage) return false;
    const s = worktree.summary.trim().toLowerCase();
    const c = rawLastCommitMessage.trim().toLowerCase();
    // Check if summary is equal to the raw message, or includes it, or vice versa.
    // Also check against the first line of the commit message.
    const firstLineC = firstLineLastCommitMessage?.toLowerCase();
    return (
      s === c ||
      s.includes(c) ||
      c.includes(s) ||
      (firstLineC && (s === firstLineC || s.includes(firstLineC)))
    );
  }, [worktree.summary, rawLastCommitMessage, firstLineLastCommitMessage]);

  const effectiveSummary = isSummarySameAsCommit ? null : worktree.summary;

  const handleToggleExpand = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleWorktreeExpanded(worktree.id);
    },
    [toggleWorktreeExpanded, worktree.id]
  );

  const hasExpandableContent =
    hasChanges ||
    effectiveNote ||
    !!effectiveSummary ||
    worktreeErrors.length > 0 ||
    terminalCounts.total > 0 ||
    !!rawLastCommitMessage;

  const showTimeInHeader = !hasExpandableContent;

  const showMetaFooter = terminalCounts.total > 0;

  const orderedWorktreeTerminals = useMemo(() => {
    if (worktreeTerminals.length === 0) return worktreeTerminals;

    const getStatePriority = (state: AgentState): number => {
      switch (state) {
        case "working":
          return 0;
        case "waiting":
          return 1;
        case "running":
          return 2;
        case "idle":
          return 3;
        case "completed":
          return 4;
        case "failed":
          return 5;
        default:
          return 10;
      }
    };

    const isAgentTerminal = (terminal: TerminalInstance) =>
      terminal.type === "claude" || terminal.type === "gemini" || terminal.type === "codex";

    return [...worktreeTerminals].sort((a, b) => {
      const aIsAgent = isAgentTerminal(a);
      const bIsAgent = isAgentTerminal(b);

      if (aIsAgent !== bIsAgent) {
        return aIsAgent ? -1 : 1;
      }

      const aState = a.agentState ?? "idle";
      const bState = b.agentState ?? "idle";
      const aPriority = getStatePriority(aState);
      const bPriority = getStatePriority(bState);

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      return (a.title || "").localeCompare(b.title || "");
    });
  }, [worktreeTerminals]);

  const detailsId = useMemo(() => `worktree-${worktree.id}-details`, [worktree.id]);

  const workspaceScenario: "dirty" | "clean-feature" | "clean-main" = useMemo(() => {
    if (hasChanges) {
      return "dirty";
    }
    if (isMainWorktree) {
      return "clean-main";
    }
    return "clean-feature";
  }, [hasChanges, isMainWorktree]);

  type SpineState = "error" | "dirty" | "current" | "stale" | "idle";
  const spineState: SpineState = useMemo(() => {
    if (worktreeErrors.length > 0 || worktree.mood === "error") return "error";
    if (hasChanges) return "dirty";
    if (worktree.isCurrent) return "current";
    if (worktree.mood === "stale") return "stale";
    return "idle";
  }, [worktreeErrors.length, worktree.mood, hasChanges, worktree.isCurrent]);

  const isIdleCard = spineState === "idle";
  const isStaleCard = spineState === "stale";

  const cardContent = (
    <div
      className={cn(
        "group relative border-b border-canopy-border transition-all duration-200",
        isActive
          ? "bg-white/[0.03] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
          : "hover:bg-white/[0.02] bg-transparent",
        isFocused && !isActive && "bg-white/[0.02]",
        (isIdleCard || isStaleCard) && !isActive && !isFocused && "opacity-70 hover:opacity-100",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
      )}
      onClick={onSelect}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Worktree: ${branchLabel}${isActive ? " (selected)" : ""}${worktree.isCurrent ? " (current)" : ""}, Status: ${spineState}${worktreeErrors.length > 0 ? `, ${worktreeErrors.length} error${worktreeErrors.length !== 1 ? "s" : ""}` : ""}${hasChanges ? ", has uncommitted changes" : ""}`}
    >
      {/* Status Spine - multi-state health rail on left edge */}
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-[3px] transition-all duration-300",
          spineState === "error" && "bg-red-500",
          spineState === "dirty" && "bg-amber-500 shadow-[0_0_6px_rgba(251,191,36,0.3)]",
          spineState === "stale" && "bg-zinc-500",
          spineState === "current" && "bg-teal-500",
          spineState === "idle" && "bg-transparent"
        )}
        aria-hidden="true"
      />
      <div className="px-3 py-5">
        {/* Header section with chevron gutter (grid layout) */}
        <div className="flex gap-2">
          {/* Chevron column */}
          <div className="flex items-start pt-0.5 w-4 shrink-0">
            {hasExpandableContent && (
              <button
                onClick={handleToggleExpand}
                className="p-0.5 text-canopy-text/60 hover:text-canopy-text transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
                aria-label={isExpanded ? "Collapse details" : "Expand details"}
                aria-expanded={isExpanded}
                aria-controls={detailsId}
              >
                <ChevronRight
                  className={cn(
                    "w-3.5 h-3.5 transition-transform duration-150 motion-reduce:transition-none",
                    isExpanded && "rotate-90"
                  )}
                />
              </button>
            )}
          </div>

          {/* Main content column */}
          <div className="flex-1 min-w-0 space-y-1">
            {/* Row 1: Identity bar */}
            <div className="flex items-center gap-2 min-h-[22px]">
              {/* Left: Branch identity */}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {isActive && (
                  <CheckCircle2
                    className="w-3.5 h-3.5 text-canopy-accent shrink-0 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in motion-safe:duration-200"
                    aria-hidden="true"
                  />
                )}
                {isMainWorktree && <Shield className="w-3.5 h-3.5 text-canopy-text/30 shrink-0" />}
                <BranchLabel
                  label={branchLabel}
                  isActive={isActive}
                  isMainWorktree={isMainWorktree}
                />
                {!worktree.branch && (
                  <span className="text-amber-500 text-xs font-medium shrink-0">(detached)</span>
                )}
              </div>

              {/* Center: Activity chip (only shown in header for main worktree or when no expandable content) */}
              {showTimeInHeader && (
                <div
                  className={cn(
                    "flex items-center gap-1.5 shrink-0 text-xs px-2 py-0.5 rounded-full",
                    worktree.lastActivityTimestamp
                      ? "bg-white/[0.03] text-canopy-text/60"
                      : "bg-transparent text-canopy-text/40"
                  )}
                  title={
                    worktree.lastActivityTimestamp
                      ? `Last activity: ${new Date(worktree.lastActivityTimestamp).toLocaleString()}`
                      : "No recent activity recorded"
                  }
                >
                  <ActivityLight lastActivityTimestamp={worktree.lastActivityTimestamp} />
                  <LiveTimeAgo timestamp={worktree.lastActivityTimestamp} className="font-medium" />
                </div>
              )}

              {/* Right: Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <TooltipProvider>
                  <Tooltip open={treeCopied} delayDuration={0}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleCopyTreeClick}
                        disabled={isCopyingTree}
                        className={cn(
                          "p-1 rounded transition-colors",
                          treeCopied
                            ? "text-green-400 bg-green-400/10"
                            : "text-canopy-text/40 hover:text-canopy-text hover:bg-white/5",
                          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                          isCopyingTree && "cursor-wait opacity-70"
                        )}
                        aria-label={treeCopied ? "Context Copied" : "Copy Context"}
                      >
                        {isCopyingTree ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-canopy-text" />
                        ) : treeCopied ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="font-medium">
                      <span role="status" aria-live="polite">
                        {copyFeedback}
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
                  >
                    <DropdownMenuItem onClick={() => handleCopyTree()} disabled={isCopyingTree}>
                      <Copy className="w-3.5 h-3.5 mr-2" />
                      Copy Context
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onOpenEditor()}>
                      <Code className="w-3.5 h-3.5 mr-2" />
                      Open in Editor
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handlePathClick()}>
                      <Folder className="w-3.5 h-3.5 mr-2" />
                      Reveal in Finder
                    </DropdownMenuItem>

                    {(worktree.issueNumber || worktree.prNumber) && <DropdownMenuSeparator />}

                    {worktree.issueNumber && onOpenIssue && (
                      <DropdownMenuItem onClick={() => handleOpenIssue()}>
                        <CircleDot className="w-3.5 h-3.5 mr-2" />
                        Open Issue #{worktree.issueNumber}
                      </DropdownMenuItem>
                    )}
                    {worktree.prNumber && onOpenPR && (
                      <DropdownMenuItem onClick={() => handleOpenPR()}>
                        <GitPullRequest className="w-3.5 h-3.5 mr-2" />
                        Open PR #{worktree.prNumber}
                      </DropdownMenuItem>
                    )}

                    {(recipes.length > 0 || onCreateRecipe) && <DropdownMenuSeparator />}

                    {recipes.length > 0 && (
                      <>
                        <DropdownMenuLabel>Recipes</DropdownMenuLabel>
                        {recipes.map((recipe) => (
                          <DropdownMenuItem
                            key={recipe.id}
                            onClick={() => handleRunRecipe(recipe.id)}
                            disabled={runningRecipeId !== null}
                          >
                            <Play className="w-3.5 h-3.5 mr-2" />
                            {recipe.name}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                    {onCreateRecipe && (
                      <DropdownMenuItem onClick={onCreateRecipe}>
                        <Plus className="w-3.5 h-3.5 mr-2" />
                        Create Recipe...
                      </DropdownMenuItem>
                    )}
                    {onSaveLayout && totalTerminalCount > 0 && (
                      <DropdownMenuItem onClick={onSaveLayout}>
                        <Save className="w-3.5 h-3.5 mr-2" />
                        Save Layout as Recipe
                      </DropdownMenuItem>
                    )}

                    {totalTerminalCount > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Sessions</DropdownMenuLabel>
                        <DropdownMenuItem
                          onClick={handleCloseCompleted}
                          disabled={completedCount === 0}
                        >
                          Close Completed ({completedCount})
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={handleCloseFailed} disabled={failedCount === 0}>
                          Close Failed ({failedCount})
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={handleCloseAllTerminals}
                          className="text-[var(--color-status-error)] focus:text-[var(--color-status-error)]"
                        >
                          Close All...
                        </DropdownMenuItem>
                      </>
                    )}

                    {!isMainWorktree && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowDeleteDialog(true);
                          }}
                          className="text-[var(--color-status-error)] focus:text-[var(--color-status-error)]"
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" />
                          Delete Worktree...
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Row 2: Context Badges (PR/Issue) */}
            {(worktree.issueNumber || worktree.prNumber) && (
              <div className="flex items-center gap-2">
                {worktree.issueNumber && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenIssue?.();
                    }}
                    className="group/issue flex items-center gap-1 text-xs text-[var(--color-status-info)] hover:brightness-110 hover:underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                    title="Open Issue on GitHub"
                  >
                    <CircleDot className="w-2.5 h-2.5" />
                    <span className="font-mono">#{worktree.issueNumber}</span>
                    <ExternalLink className="w-3 h-3 opacity-60 group-hover/issue:opacity-100 transition-opacity" />
                  </button>
                )}
                {worktree.prNumber && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPR?.();
                    }}
                    className={cn(
                      "group/pr flex items-center gap-1 text-xs hover:underline transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                      worktree.prState === "merged"
                        ? "text-[var(--color-status-success)] hover:brightness-110"
                        : worktree.prState === "closed"
                          ? "text-[var(--color-status-error)] hover:brightness-110"
                          : "text-[var(--color-status-info)] hover:brightness-110"
                    )}
                    title={`PR #${worktree.prNumber} · ${worktree.prState ?? "open"}`}
                  >
                    <GitPullRequest className="w-2.5 h-2.5" />
                    <span className="font-mono">#{worktree.prNumber}</span>
                    <ExternalLink className="w-3 h-3 opacity-60 group-hover/pr:opacity-100 transition-opacity" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Details Container - same styling for collapsed (pulse) and expanded */}
        {hasExpandableContent && (
          <div
            id={detailsId}
            className="mt-3 p-3 bg-white/[0.01] rounded-[var(--radius-lg)] border border-white/5"
          >
            {isExpanded ? (
              /* Expanded: full WorktreeDetails */
              <WorktreeDetails
                worktree={worktree}
                homeDir={homeDir}
                effectiveNote={effectiveNote}
                effectiveSummary={effectiveSummary}
                worktreeErrors={worktreeErrors}
                hasChanges={hasChanges}
                isFocused={isFocused}
                onPathClick={handlePathClick}
                onDismissError={dismissError}
                onRetryError={handleErrorRetry}
                showLastCommit={true}
                lastActivityTimestamp={worktree.lastActivityTimestamp}
                showTime={!showTimeInHeader}
              />
            ) : (
              /* Collapsed: Pulse line summary */
              <div className="-m-3">
                <button
                  onClick={handleToggleExpand}
                  aria-expanded={false}
                  aria-controls={detailsId}
                  className="w-full p-3 flex items-center justify-between min-w-0 text-left rounded-[var(--radius-lg)] transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
                >
                  {/* LEFT SLOT: Git Signal + Commit Message */}
                  <div className="flex items-center gap-2 min-w-0 flex-1 text-xs font-sans text-canopy-text/60">
                    {workspaceScenario === "dirty" && worktree.worktreeChanges && (
                      <>
                        <span className="shrink-0">
                          {worktree.worktreeChanges.changedFileCount} file
                          {worktree.worktreeChanges.changedFileCount !== 1 ? "s" : ""}
                        </span>
                        {((worktree.worktreeChanges.insertions ?? 0) > 0 ||
                          (worktree.worktreeChanges.deletions ?? 0) > 0) && (
                          <>
                            <span className="text-canopy-text/40 shrink-0">·</span>
                            <span className="shrink-0">
                              {(worktree.worktreeChanges.insertions ?? 0) > 0 && (
                                <span className="text-[var(--color-status-success)]">
                                  +{worktree.worktreeChanges.insertions}
                                </span>
                              )}
                              {(worktree.worktreeChanges.insertions ?? 0) > 0 &&
                                (worktree.worktreeChanges.deletions ?? 0) > 0 && (
                                  <span className="text-canopy-text/40">/</span>
                                )}
                              {(worktree.worktreeChanges.deletions ?? 0) > 0 && (
                                <span className="text-[var(--color-status-error)]">
                                  -{worktree.worktreeChanges.deletions}
                                </span>
                              )}
                            </span>
                          </>
                        )}
                        {/* Commit message in remaining space */}
                        {firstLineLastCommitMessage && (
                          <>
                            <span className="text-canopy-text/30 shrink-0">·</span>
                            <span className="truncate text-canopy-text/40">
                              {firstLineLastCommitMessage}
                            </span>
                          </>
                        )}
                      </>
                    )}
                    {workspaceScenario !== "dirty" && firstLineLastCommitMessage && (
                      <>
                        <GitCommit className="w-3 h-3 shrink-0 opacity-60" />
                        <span className="truncate">{firstLineLastCommitMessage}</span>
                      </>
                    )}
                  </div>

                  {/* RIGHT SLOT: Time & Runtime Signal */}
                  <div className="flex items-center gap-3 shrink-0 ml-2">
                    {/* Time display (only when moved from header) */}
                    {!showTimeInHeader && (
                      <div
                        className="flex items-center gap-1.5 text-xs text-canopy-text/40"
                        title={
                          worktree.lastActivityTimestamp
                            ? `Last activity: ${new Date(worktree.lastActivityTimestamp).toLocaleString()}`
                            : "No recent activity recorded"
                        }
                      >
                        <ActivityLight
                          lastActivityTimestamp={worktree.lastActivityTimestamp}
                          className="w-1.5 h-1.5"
                        />
                        <LiveTimeAgo timestamp={worktree.lastActivityTimestamp} />
                      </div>
                    )}
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Terminal Footer - clickable to open terminal switcher */}
        {showMetaFooter && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="w-full flex items-center justify-between mt-5 py-1.5 px-2 text-xs text-canopy-text/60 hover:text-canopy-text/80 bg-white/[0.02] rounded transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Left: Terminal icon + total count */}
                <div className="flex items-center gap-1.5">
                  <Terminal className="w-3 h-3" />
                  <span className="inline-flex items-center gap-1">
                    <span className="font-mono tabular-nums">{terminalCounts.total}</span>
                    <span className="font-sans">active</span>
                  </span>
                </div>

                {/* Right: State breakdown (icons + counts) */}
                <TooltipProvider>
                  <div className="flex items-center gap-3">
                    {STATE_PRIORITY.map((state) => {
                      const count = terminalCounts.byState[state];
                      if (count === 0) return null;
                      return <StateIcon key={state} state={state} count={count} />;
                    })}
                  </div>
                </TooltipProvider>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-[var(--radix-dropdown-menu-trigger-width)]"
              sideOffset={0}
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal normal-case">
                Active Sessions ({worktreeTerminals.length})
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="max-h-[300px] overflow-y-auto">
                {orderedWorktreeTerminals.map((term) => (
                  <DropdownMenuItem
                    key={term.id}
                    onSelect={() => handleTerminalSelect(term)}
                    className="flex items-center justify-between gap-2.5 px-2.5 py-1.5 cursor-pointer group focus:bg-white/5 focus:text-inherit data-[highlighted]:bg-white/5 data-[highlighted]:text-inherit"
                  >
                    {/* LEFT SIDE: Icon + Title */}
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                        <TerminalIcon type={term.type} agentId={term.agentId} className="w-3 h-3" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium truncate text-canopy-text/70 group-hover:text-canopy-text transition-colors">
                          {term.title}
                        </span>
                        {term.type === "terminal" &&
                          term.agentState === "running" &&
                          term.lastCommand && (
                            <span
                              className="text-[11px] font-mono text-canopy-text/50 truncate"
                              title={term.lastCommand}
                            >
                              {term.lastCommand}
                            </span>
                          )}
                      </div>
                    </div>

                    {/* RIGHT SIDE: State Icons + Location */}
                    <div className="flex items-center gap-2.5 shrink-0">
                      {term.agentState === "working" && (
                        <Loader2
                          className="w-3 h-3 animate-spin text-[var(--color-state-working)]"
                          aria-label="Working"
                        />
                      )}

                      {term.agentState === "running" && (
                        <Play
                          className="w-3 h-3 text-[var(--color-status-info)]"
                          aria-label="Running"
                        />
                      )}

                      {term.agentState === "waiting" && (
                        <AlertCircle
                          className="w-3 h-3 text-amber-400"
                          aria-label="Waiting for input"
                        />
                      )}

                      {term.agentState === "failed" && (
                        <XCircle
                          className="w-3 h-3 text-[var(--color-status-error)]"
                          aria-label="Failed"
                        />
                      )}

                      {term.agentState === "completed" && (
                        <CheckCircle2
                          className="w-3 h-3 text-[var(--color-status-success)]"
                          aria-label="Completed"
                        />
                      )}

                      {/* Location Indicator (Grid vs Dock) */}
                      <div
                        className="text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors"
                        title={term.location === "dock" ? "Docked" : "On Grid"}
                      >
                        {term.location === "dock" ? (
                          <PanelBottom className="w-3 h-3" />
                        ) : (
                          <LayoutGrid className="w-3 h-3" />
                        )}
                      </div>
                    </div>
                  </DropdownMenuItem>
                ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          description={confirmDialog.description}
          onConfirm={confirmDialog.onConfirm}
          onCancel={closeConfirmDialog}
        />

        <WorktreeDeleteDialog
          isOpen={showDeleteDialog}
          onClose={() => setShowDeleteDialog(false)}
          worktree={worktree}
        />
      </div>
    </div>
  );

  if (!onLaunchAgent) {
    return cardContent;
  }

  const isClaudeEnabled =
    agentAvailability?.claude && (agentSettings?.agents?.claude?.enabled ?? true);
  const isGeminiEnabled =
    agentAvailability?.gemini && (agentSettings?.agents?.gemini?.enabled ?? true);
  const isCodexEnabled =
    agentAvailability?.codex && (agentSettings?.agents?.codex?.enabled ?? true);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{cardContent}</ContextMenuTrigger>
      <ContextMenuContent onClick={(e) => e.stopPropagation()}>
        <ContextMenuLabel>Launch Agent</ContextMenuLabel>
        <ContextMenuItem onClick={() => handleLaunchAgent("claude")} disabled={!isClaudeEnabled}>
          <ClaudeIcon className="w-3.5 h-3.5 mr-2" />
          Claude
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleLaunchAgent("gemini")} disabled={!isGeminiEnabled}>
          <GeminiIcon className="w-3.5 h-3.5 mr-2" />
          Gemini
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleLaunchAgent("codex")} disabled={!isCodexEnabled}>
          <CodexIcon className="w-3.5 h-3.5 mr-2" />
          Codex
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => handleLaunchAgent("terminal")}>
          <Terminal className="w-3.5 h-3.5 mr-2" />
          Open Terminal
        </ContextMenuItem>
        {!isMainWorktree && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={(e) => {
                e.stopPropagation();
                setShowDeleteDialog(true);
              }}
              className="text-[var(--color-status-error)] focus:text-[var(--color-status-error)]"
            >
              <Trash2 className="w-3.5 h-3.5 mr-2" />
              Delete Worktree
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
