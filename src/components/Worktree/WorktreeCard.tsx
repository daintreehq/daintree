import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import type React from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeState, AgentState } from "../../types";
import { ActivityLight } from "./ActivityLight";
import { BranchLabel } from "./BranchLabel";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { WorktreeDetails } from "./WorktreeDetails";
import { useWorktreeTerminals } from "../../hooks/useWorktreeTerminals";
import { useDroppable } from "@dnd-kit/core";
import {
  useErrorStore,
  useTerminalStore,
  type RetryAction,
  type TerminalInstance,
} from "../../store";
import { useRecipeStore } from "../../store/recipeStore";
import { useWorktreeSelectionStore } from "../../store/worktreeStore";
import { systemClient, errorsClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { cn } from "../../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../ui/tooltip";
import { ConfirmDialog } from "../Terminal/ConfirmDialog";
import { WorktreeDeleteDialog } from "./WorktreeDeleteDialog";
import { WorktreeMenuItems } from "./WorktreeMenuItems";
import {
  Check,
  Copy,
  CircleDot,
  GitPullRequest,
  Play,
  MoreHorizontal,
  ChevronRight,
  Shield,
  Terminal,
  LayoutGrid,
  PanelBottom,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { STATE_ICONS, STATE_COLORS, STATE_LABELS, STATE_PRIORITY } from "./terminalStateConfig";
import { useNativeContextMenu } from "@/hooks";
import type { MenuItemOption } from "@/types";

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
          <Icon
            className={cn(
              "w-3 h-3",
              state === "working" && "animate-spin motion-reduce:animate-none"
            )}
            aria-hidden
          />
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
  const { showMenu } = useNativeContextMenu();
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
  const bulkTrashByWorktree = useTerminalStore((state) => state.bulkTrashByWorktree);
  const bulkRestartByWorktree = useTerminalStore((state) => state.bulkRestartByWorktree);
  const bulkRestartPreflightCheckByWorktree = useTerminalStore(
    (state) => state.bulkRestartPreflightCheckByWorktree
  );
  const bulkMoveToDockByWorktree = useTerminalStore((state) => state.bulkMoveToDockByWorktree);
  const bulkMoveToGridByWorktree = useTerminalStore((state) => state.bulkMoveToGridByWorktree);
  const getCountByWorktree = useTerminalStore((state) => state.getCountByWorktree);
  const completedCount = terminalCounts.byState.completed;
  const failedCount = terminalCounts.byState.failed;
  const totalTerminalCount = terminalCounts.total;
  const allTerminalCount = getCountByWorktree(worktree.id);
  const gridCount = useMemo(
    () => worktreeTerminals.filter((t) => t.location === "grid" || t.location === undefined).length,
    [worktreeTerminals]
  );
  const dockCount = useMemo(
    () => worktreeTerminals.filter((t) => t.location === "dock").length,
    [worktreeTerminals]
  );

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

  const [isRestartValidating, setIsRestartValidating] = useState(false);

  const handleCloseCompleted = useCallback(() => {
    bulkCloseByWorktree(worktree.id, "completed");
  }, [bulkCloseByWorktree, worktree.id]);

  const handleCloseFailed = useCallback(() => {
    bulkCloseByWorktree(worktree.id, "failed");
  }, [bulkCloseByWorktree, worktree.id]);

  const handleMinimizeAll = useCallback(() => {
    bulkMoveToDockByWorktree(worktree.id);
  }, [bulkMoveToDockByWorktree, worktree.id]);

  const handleMaximizeAll = useCallback(() => {
    bulkMoveToGridByWorktree(worktree.id);
  }, [bulkMoveToGridByWorktree, worktree.id]);

  const handleResetAllRenderers = useCallback(() => {
    for (const terminal of worktreeTerminals) {
      terminalInstanceService.resetRenderer(terminal.id);
    }
  }, [worktreeTerminals]);

  const handleCloseAll = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: "Close All Sessions",
      description: `This will move ${totalTerminalCount} session${totalTerminalCount !== 1 ? "s" : ""} to trash for this worktree. They can be restored from the trash.`,
      onConfirm: () => {
        bulkTrashByWorktree(worktree.id);
        closeConfirmDialog();
      },
    });
  }, [totalTerminalCount, bulkTrashByWorktree, worktree.id, closeConfirmDialog]);

  const handleEndAll = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: "End All Sessions",
      description: `This will permanently end ${allTerminalCount} session${allTerminalCount !== 1 ? "s" : ""} and their processes for this worktree. This action cannot be undone.`,
      onConfirm: () => {
        bulkCloseByWorktree(worktree.id);
        closeConfirmDialog();
      },
    });
  }, [allTerminalCount, bulkCloseByWorktree, worktree.id, closeConfirmDialog]);

  const handleRestartAll = useCallback(async () => {
    if (isRestartValidating) return;
    setIsRestartValidating(true);
    try {
      const result = await bulkRestartPreflightCheckByWorktree(worktree.id);
      const hasIssues = result.invalid.length > 0;
      const validCount = result.valid.length;
      const invalidCount = result.invalid.length;

      let description = `This will restart ${validCount} session${validCount !== 1 ? "s" : ""} for this worktree.`;
      if (hasIssues) {
        description += `\n\n${invalidCount} session${invalidCount !== 1 ? "s" : ""} cannot be restarted due to invalid configuration (e.g., missing working directory).`;
      }

      setConfirmDialog({
        isOpen: true,
        title: hasIssues ? "Restart Sessions (Some Issues Found)" : "Restart All Sessions",
        description,
        onConfirm: () => {
          void bulkRestartByWorktree(worktree.id);
          closeConfirmDialog();
        },
      });
    } finally {
      setIsRestartValidating(false);
    }
  }, [
    isRestartValidating,
    bulkRestartPreflightCheckByWorktree,
    worktree.id,
    bulkRestartByWorktree,
    closeConfirmDialog,
  ]);

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

  // Priority-based computed subtitle for collapsed view
  // Note: Terminal states (waiting/failed) are shown in the footer, not here
  const computedSubtitle = useMemo((): {
    text: string;
    tone: "error" | "warning" | "info" | "muted";
  } => {
    // 1. Worktree errors take highest priority
    if (worktreeErrors.length > 0) {
      return {
        text: worktreeErrors.length === 1 ? "1 error" : `${worktreeErrors.length} errors`,
        tone: "error",
      };
    }

    // 2. Uncommitted changes - this is the primary git status info
    // Note: tone "changes" signals we need custom rendering with colored +/-
    if (hasChanges && worktree.worktreeChanges) {
      return { text: "", tone: "warning" };
    }

    // 3. Commit message
    if (firstLineLastCommitMessage) {
      return { text: firstLineLastCommitMessage, tone: "muted" };
    }

    // 4. Fallback
    return { text: "No recent activity", tone: "muted" };
  }, [worktreeErrors.length, hasChanges, worktree.worktreeChanges, firstLineLastCommitMessage]);

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
    terminalCounts.total > 0;

  const showTimeInHeader = !hasExpandableContent;

  const showMetaFooter = terminalCounts.total > 0;

  // Get the highest-priority state for simplified footer display
  const topTerminalState = useMemo((): { state: AgentState; count: number } | null => {
    for (const state of STATE_PRIORITY) {
      const count = terminalCounts.byState[state];
      if (count > 0) {
        return { state, count };
      }
    }
    return null;
  }, [terminalCounts.byState]);

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

  type SpineState = "error" | "dirty" | "current" | "stale" | "idle";
  const spineState: SpineState = useMemo(() => {
    if (worktreeErrors.length > 0 || worktree.mood === "error") return "error";
    if (hasChanges) return "dirty";
    if (worktree.isCurrent) return "current";
    if (worktree.mood === "stale") return "stale";
    return "idle";
  }, [worktreeErrors.length, worktree.mood, hasChanges, worktree.isCurrent]);

  const isClaudeEnabled =
    agentAvailability?.claude && (agentSettings?.agents?.claude?.enabled ?? true);
  const isGeminiEnabled =
    agentAvailability?.gemini && (agentSettings?.agents?.gemini?.enabled ?? true);
  const isCodexEnabled =
    agentAvailability?.codex && (agentSettings?.agents?.codex?.enabled ?? true);

  const isIdleCard = spineState === "idle";
  const isStaleCard = spineState === "stale";

  const { setNodeRef, isOver } = useDroppable({
    id: `worktree-drop-${worktree.id}`,
    data: {
      type: "worktree",
      worktreeId: worktree.id,
    },
    disabled: isActive,
  });

  const dropdownComponents = useMemo(
    () => ({
      Item: DropdownMenuItem,
      Label: DropdownMenuLabel,
      Separator: DropdownMenuSeparator,
      Shortcut: DropdownMenuShortcut,
      Sub: DropdownMenuSub,
      SubTrigger: DropdownMenuSubTrigger,
      SubContent: DropdownMenuSubContent,
    }),
    []
  );

  const contextMenuTemplate = useMemo((): MenuItemOption[] => {
    const template: MenuItemOption[] = [
      { id: "label:launch", label: "Launch", enabled: false },
      { id: "launch:claude", label: "Claude", enabled: Boolean(onLaunchAgent && isClaudeEnabled) },
      { id: "launch:gemini", label: "Gemini", enabled: Boolean(onLaunchAgent && isGeminiEnabled) },
      { id: "launch:codex", label: "Codex", enabled: Boolean(onLaunchAgent && isCodexEnabled) },
      { id: "launch:terminal", label: "Open Terminal", enabled: Boolean(onLaunchAgent) },
      { type: "separator" },

      { id: "label:sessions", label: "Sessions", enabled: false },
      {
        id: "sessions:minimize-all",
        label: `Minimize All (${gridCount})`,
        enabled: gridCount > 0,
      },
      {
        id: "sessions:maximize-all",
        label: `Maximize All (${dockCount})`,
        enabled: dockCount > 0,
      },
      {
        id: "sessions:restart-all",
        label: `${isRestartValidating ? "Checking..." : "Restart All"} (${totalTerminalCount})`,
        enabled: totalTerminalCount > 0 && !isRestartValidating,
      },
      {
        id: "sessions:reset-renderers",
        label: `Reset All Renderers (${totalTerminalCount})`,
        enabled: totalTerminalCount > 0,
      },
      { type: "separator" },

      {
        id: "sessions:close-completed",
        label: `Close Completed (${completedCount})`,
        enabled: completedCount > 0,
      },
      {
        id: "sessions:close-failed",
        label: `Close Failed (${failedCount})`,
        enabled: failedCount > 0,
      },
      { type: "separator" },

      {
        id: "sessions:close-all",
        label: `Close All (Trash) (${totalTerminalCount})`,
        enabled: totalTerminalCount > 0,
      },
      {
        id: "sessions:end-all",
        label: `End All (Kill) (${allTerminalCount})`,
        enabled: allTerminalCount > 0,
      },
      { type: "separator" },

      { id: "label:worktree", label: "Worktree", enabled: false },
      { id: "worktree:copy-context", label: "Copy Context" },
      { id: "worktree:open-editor", label: "Open in Editor" },
      { id: "worktree:reveal", label: "Reveal in Finder" },
    ];

    const hasIssueItem = Boolean(worktree.issueNumber && onOpenIssue);
    const hasPrItem = Boolean(worktree.issueNumber && worktree.prNumber && onOpenPR);
    if (hasIssueItem || hasPrItem) {
      template.push({ type: "separator" });
      if (hasIssueItem) {
        template.push({
          id: "worktree:open-issue",
          label: `Open Issue #${worktree.issueNumber}`,
        });
      }
      if (hasPrItem) {
        template.push({
          id: "worktree:open-pr",
          label: `Open PR #${worktree.prNumber}`,
        });
      }
    }

    const hasRecipeSection =
      recipes.length > 0 || !!onCreateRecipe || (onSaveLayout && totalTerminalCount > 0);
    if (hasRecipeSection) {
      template.push({ type: "separator" });
      template.push({ id: "label:recipes", label: "Recipes", enabled: false });

      if (recipes.length > 0) {
        template.push({
          id: "recipes:run",
          label: "Run Recipe",
          submenu: recipes.map((recipe) => ({
            id: `recipes:run:${recipe.id}`,
            label: recipe.name,
            enabled: runningRecipeId === null,
          })),
        });
      }

      if (onCreateRecipe) {
        template.push({ id: "recipes:create", label: "Create Recipe..." });
      }

      if (onSaveLayout && totalTerminalCount > 0) {
        template.push({ id: "recipes:save-layout", label: "Save Layout as Recipe" });
      }
    }

    if (!isMainWorktree) {
      template.push({ type: "separator" });
      template.push({
        id: "worktree:delete",
        label: "Delete Worktree...",
      });
    }

    return template;
  }, [
    allTerminalCount,
    completedCount,
    dockCount,
    failedCount,
    gridCount,
    isClaudeEnabled,
    isCodexEnabled,
    isGeminiEnabled,
    isMainWorktree,
    isRestartValidating,
    onCreateRecipe,
    onLaunchAgent,
    onOpenIssue,
    onOpenPR,
    onSaveLayout,
    recipes,
    runningRecipeId,
    totalTerminalCount,
    worktree.issueNumber,
    worktree.prNumber,
  ]);

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      const actionId = await showMenu(event, contextMenuTemplate);
      if (!actionId) return;

      if (actionId.startsWith("launch:")) {
        handleLaunchAgent(actionId.slice("launch:".length));
        return;
      }

      if (actionId.startsWith("recipes:run:")) {
        const recipeId = actionId.slice("recipes:run:".length);
        void handleRunRecipe(recipeId);
        return;
      }

      switch (actionId) {
        case "sessions:minimize-all":
          handleMinimizeAll();
          break;
        case "sessions:maximize-all":
          handleMaximizeAll();
          break;
        case "sessions:restart-all":
          void handleRestartAll();
          break;
        case "sessions:reset-renderers":
          handleResetAllRenderers();
          break;
        case "sessions:close-completed":
          handleCloseCompleted();
          break;
        case "sessions:close-failed":
          handleCloseFailed();
          break;
        case "sessions:close-all":
          handleCloseAll();
          break;
        case "sessions:end-all":
          handleEndAll();
          break;
        case "worktree:copy-context":
          void handleCopyTree();
          break;
        case "worktree:open-editor":
          onOpenEditor();
          break;
        case "worktree:reveal":
          handlePathClick();
          break;
        case "worktree:open-issue":
          handleOpenIssue();
          break;
        case "worktree:open-pr":
          handleOpenPR();
          break;
        case "recipes:create":
          onCreateRecipe?.();
          break;
        case "recipes:save-layout":
          onSaveLayout?.();
          break;
        case "worktree:delete":
          setShowDeleteDialog(true);
          break;
      }
    },
    [
      contextMenuTemplate,
      handleCloseAll,
      handleCloseCompleted,
      handleCloseFailed,
      handleCopyTree,
      handleEndAll,
      handleLaunchAgent,
      handleMaximizeAll,
      handleMinimizeAll,
      handleOpenIssue,
      handleOpenPR,
      handlePathClick,
      handleResetAllRenderers,
      handleRestartAll,
      handleRunRecipe,
      onCreateRecipe,
      onOpenEditor,
      onSaveLayout,
      showMenu,
    ]
  );

  const cardContent = (
    <div
      ref={isActive ? undefined : setNodeRef}
      className={cn(
        "group relative border-b border-divider transition-all duration-200",
        isActive
          ? "bg-white/[0.03] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
          : "hover:bg-white/[0.02] bg-transparent",
        isFocused && !isActive && "bg-white/[0.02]",
        (isIdleCard || isStaleCard) && !isActive && !isFocused && "opacity-70 hover:opacity-100",
        isOver &&
          !isActive &&
          "ring-2 ring-canopy-accent bg-canopy-accent/10 border-canopy-accent/50 transition-all duration-200",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
      )}
      onClick={onSelect}
      onContextMenu={handleContextMenu}
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
      {isOver && !isActive && (
        <div className="absolute inset-0 z-50 bg-canopy-accent/20 border-2 border-canopy-accent pointer-events-none animate-in fade-in duration-150" />
      )}
      {/* Status Spine - multi-state health rail on left edge */}
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-0.5 transition-all duration-300 rounded-r-sm",
          spineState === "error" && "bg-[var(--color-status-error)]",
          spineState === "dirty" &&
            "bg-[var(--color-status-warning)] shadow-[0_0_4px_rgba(251,191,36,0.2)]",
          spineState === "stale" && "bg-[var(--color-state-idle)]",
          spineState === "current" &&
            "bg-[var(--color-status-info)] shadow-[0_0_6px_rgba(56,189,248,0.25)]",
          spineState === "idle" && "bg-transparent"
        )}
        aria-hidden="true"
      />
      <div className="px-4 py-5">
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
                {worktree.isDetached && (
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

              {/* Right: Actions - hidden until hover/active */}
              <div
                className={cn(
                  "flex items-center gap-1 shrink-0 transition-opacity duration-150",
                  isActive || treeCopied || isCopyingTree
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                )}
              >
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
                          <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none text-canopy-text" />
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
                    className="w-64"
                  >
                    <WorktreeMenuItems
                      worktree={worktree}
                      components={dropdownComponents}
                      isClaudeEnabled={Boolean(isClaudeEnabled)}
                      isGeminiEnabled={Boolean(isGeminiEnabled)}
                      isCodexEnabled={Boolean(isCodexEnabled)}
                      recipes={recipes}
                      runningRecipeId={runningRecipeId}
                      isRestartValidating={isRestartValidating}
                      counts={{
                        grid: gridCount,
                        dock: dockCount,
                        active: totalTerminalCount,
                        completed: completedCount,
                        failed: failedCount,
                        all: allTerminalCount,
                      }}
                      onLaunchAgent={
                        onLaunchAgent ? (agentId) => handleLaunchAgent(agentId) : undefined
                      }
                      onCopyContext={() => void handleCopyTree()}
                      onOpenEditor={onOpenEditor}
                      onRevealInFinder={handlePathClick}
                      onOpenIssue={
                        worktree.issueNumber && onOpenIssue ? handleOpenIssue : undefined
                      }
                      onOpenPR={
                        worktree.issueNumber && worktree.prNumber && onOpenPR
                          ? handleOpenPR
                          : undefined
                      }
                      onRunRecipe={(recipeId) => void handleRunRecipe(recipeId)}
                      onCreateRecipe={onCreateRecipe}
                      onSaveLayout={onSaveLayout}
                      onMinimizeAll={handleMinimizeAll}
                      onMaximizeAll={handleMaximizeAll}
                      onRestartAll={() => void handleRestartAll()}
                      onCloseCompleted={handleCloseCompleted}
                      onCloseFailed={handleCloseFailed}
                      onCloseAll={handleCloseAll}
                      onEndAll={handleEndAll}
                      onDeleteWorktree={
                        !isMainWorktree
                          ? () => {
                              setShowDeleteDialog(true);
                            }
                          : undefined
                      }
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Row 2: Context Badges (PR/Issue) - PR only shown when linked to an issue */}
            {worktree.issueNumber && (
              <div className="flex items-center gap-2">
                {worktree.issueNumber && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenIssue?.();
                    }}
                    className="flex items-center gap-1 text-xs text-emerald-400/80 hover:text-emerald-400 hover:underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                    title="Open Issue on GitHub"
                  >
                    <CircleDot className="w-2.5 h-2.5" />
                    <span className="font-mono">#{worktree.issueNumber}</span>
                  </button>
                )}
                {worktree.prNumber && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPR?.();
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
                    title={`PR #${worktree.prNumber} · ${worktree.prState ?? "open"}`}
                  >
                    <GitPullRequest className="w-2.5 h-2.5" />
                    <span className="font-mono">#{worktree.prNumber}</span>
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
              /* Collapsed: Single subtitle + time */
              <div className="-m-3">
                <button
                  onClick={handleToggleExpand}
                  aria-expanded={false}
                  aria-controls={detailsId}
                  className="w-full p-3 flex items-center justify-between min-w-0 text-left rounded-[var(--radius-lg)] transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
                >
                  {/* LEFT: Priority-based subtitle */}
                  <span className="text-xs truncate min-w-0 flex-1">
                    {hasChanges && worktree.worktreeChanges ? (
                      // Custom rendering for git changes with colored +/-
                      <span className="flex items-center gap-1.5 text-canopy-text/60">
                        <span>
                          {worktree.worktreeChanges.changedFileCount} file
                          {worktree.worktreeChanges.changedFileCount !== 1 ? "s" : ""}
                        </span>
                        {((worktree.worktreeChanges.insertions ?? 0) > 0 ||
                          (worktree.worktreeChanges.deletions ?? 0) > 0) && (
                          <span className="flex items-center gap-0.5">
                            {(worktree.worktreeChanges.insertions ?? 0) > 0 && (
                              <span className="text-[var(--color-status-success)]">
                                +{worktree.worktreeChanges.insertions}
                              </span>
                            )}
                            {(worktree.worktreeChanges.insertions ?? 0) > 0 &&
                              (worktree.worktreeChanges.deletions ?? 0) > 0 && (
                                <span className="text-canopy-text/30">/</span>
                              )}
                            {(worktree.worktreeChanges.deletions ?? 0) > 0 && (
                              <span className="text-[var(--color-status-error)]">
                                -{worktree.worktreeChanges.deletions}
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                    ) : (
                      // Standard text rendering for other states
                      <span
                        className={cn(
                          computedSubtitle.tone === "error" && "text-[var(--color-status-error)]",
                          computedSubtitle.tone === "warning" &&
                            "text-[var(--color-status-warning)]",
                          computedSubtitle.tone === "info" && "text-[var(--color-status-info)]",
                          computedSubtitle.tone === "muted" && "text-canopy-text/50"
                        )}
                      >
                        {computedSubtitle.text}
                      </span>
                    )}
                  </span>

                  {/* RIGHT: Time (always visible) */}
                  <div
                    className="flex items-center gap-1.5 text-xs text-canopy-text/40 shrink-0 ml-3"
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
                className="w-full flex items-center justify-between mt-5 py-1.5 px-2 text-xs text-canopy-text/60 hover:text-canopy-text/80 bg-white/[0.02] rounded transition-colors cursor-pointer focus:outline-none"
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

                {/* Right: Top priority state only */}
                {topTerminalState && (
                  <TooltipProvider>
                    <StateIcon state={topTerminalState.state} count={topTerminalState.count} />
                  </TooltipProvider>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-[var(--radix-dropdown-menu-trigger-width)] active-sessions-menu"
              sideOffset={6}
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
                    className="flex items-center justify-between gap-2.5 cursor-pointer group"
                  >
                    {/* LEFT SIDE: Icon + Title */}
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="shrink-0 opacity-60 group-hover:opacity-100 group-data-[highlighted]:opacity-100 transition-opacity">
                        <TerminalIcon type={term.type} agentId={term.agentId} className="w-3 h-3" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium truncate text-canopy-text/70 group-hover:text-canopy-text group-data-[highlighted]:text-canopy-text transition-colors">
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
                          className="w-3 h-3 animate-spin motion-reduce:animate-none text-[var(--color-state-working)]"
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
                        className="text-muted-foreground/40 group-hover:text-muted-foreground/60 group-data-[highlighted]:text-muted-foreground/60 transition-colors"
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

  return cardContent;
}
