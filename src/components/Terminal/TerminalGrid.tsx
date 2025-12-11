import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  useTerminalStore,
  useLayoutConfigStore,
  useWorktreeSelectionStore,
  MAX_GRID_TERMINALS,
  type TerminalInstance,
} from "@/store";
import { GridTerminalPane } from "./GridTerminalPane";
import { TerminalCountWarning } from "./TerminalCountWarning";
import { GridFullOverlay } from "./GridFullOverlay";
import {
  SortableTerminal,
  useDndPlaceholder,
  GRID_PLACEHOLDER_ID,
  SortableGridPlaceholder,
} from "@/components/DragDrop";
import { Terminal, AlertTriangle } from "lucide-react";
import { CanopyIcon, CodexIcon, ClaudeIcon, GeminiIcon } from "@/components/icons";
import { Kbd } from "@/components/ui/Kbd";
import { getBrandColorHex } from "@/lib/colorUtils";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { systemClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import { getAutoGridCols } from "@/lib/terminalLayout";
import { useWorktrees } from "@/hooks/useWorktrees";
import type { CliAvailability } from "@shared/types";

export interface TerminalGridProps {
  className?: string;
  defaultCwd?: string;
  onLaunchAgent?: (type: "claude" | "gemini" | "codex" | "terminal") => Promise<void> | void;
  agentAvailability?: CliAvailability;
  isCheckingAvailability?: boolean;
  onOpenSettings?: () => void;
}

interface LauncherCardProps {
  title: string;
  description: string;
  shortcut?: string;
  icon: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  available?: boolean;
  isLoading?: boolean;
  onUnavailableClick?: () => void;
}

function LauncherCard({
  title,
  description,
  shortcut,
  icon,
  onClick,
  available = true,
  isLoading = false,
  onUnavailableClick,
}: LauncherCardProps) {
  const handleClick = () => {
    if (isLoading) {
      return;
    }
    if (!available) {
      if (onUnavailableClick) {
        onUnavailableClick();
      }
      return;
    }
    onClick();
  };

  const tooltipText = isLoading
    ? `Checking ${title} CLI availability...`
    : available
      ? undefined
      : `${title} CLI not found. Click to install.`;

  return (
    <button
      onClick={handleClick}
      disabled={isLoading}
      title={tooltipText}
      className={cn(
        "group relative flex items-center text-left p-4 rounded-xl border transition-all duration-200 min-h-[100px]",
        "bg-canopy-bg hover:bg-surface",
        "border-canopy-border/20 hover:border-canopy-border/40",
        "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03),inset_0_-1px_0_0_rgba(0,0,0,0.2)]",
        "hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05),inset_0_-1px_0_0_rgba(0,0,0,0.3),0_4px_12px_-4px_rgba(0,0,0,0.4)]",
        !available && !isLoading && "opacity-60"
      )}
    >
      {!available && !isLoading && (
        <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-amber-500 rounded-full" />
      )}
      <div className="flex items-center justify-center p-2 rounded-lg mr-3 transition-colors">
        {icon}
      </div>

      <div className="flex-1">
        <div className="flex w-full items-center justify-between mb-1">
          <h4 className="font-medium text-base text-canopy-text/80 group-hover:text-canopy-text">
            {title}
          </h4>
          {shortcut && (
            <span className="text-[10px] font-mono text-white/30 border border-white/10 rounded px-1.5 py-0.5 group-hover:text-white/50 group-hover:border-white/20 transition-colors">
              {shortcut}
            </span>
          )}
        </div>
        <p className="text-xs text-canopy-text/60 group-hover:text-canopy-text/80 transition-colors leading-relaxed">
          {isLoading ? "Checking availability..." : !available ? "Click to install" : description}
        </p>
      </div>
    </button>
  );
}

function EmptyState({
  onLaunchAgent,
  hasActiveWorktree,
  agentAvailability,
  isCheckingAvailability,
  onOpenSettings,
  activeWorktreeName,
}: {
  onLaunchAgent: (type: "claude" | "gemini" | "codex" | "terminal") => void;
  hasActiveWorktree: boolean;
  agentAvailability?: CliAvailability;
  isCheckingAvailability?: boolean;
  onOpenSettings?: () => void;
  activeWorktreeName?: string | null;
}) {
  const handleOpenHelp = () => {
    void systemClient
      .openExternal("https://github.com/gregpriday/canopy-electron#readme")
      .catch((err) => {
        console.error("Failed to open documentation:", err);
      });
  };

  const handleAgentClick = (type: "claude" | "gemini" | "codex" | "terminal") => {
    if (!hasActiveWorktree) {
      console.warn("Cannot launch agent: no active worktree");
      return;
    }
    onLaunchAgent(type);
  };

  const handleUnavailableClick = () => {
    if (onOpenSettings) {
      onOpenSettings();
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8 animate-in fade-in duration-500">
      <div className="max-w-3xl w-full flex flex-col items-center">
        <div className="mb-12 flex flex-col items-center text-center">
          <CanopyIcon className="h-28 w-28 text-white/80 mb-8" />
          <h3 className="text-2xl font-semibold text-canopy-text tracking-tight mb-3">
            {activeWorktreeName || "Canopy"}
          </h3>
          <p className="text-sm text-canopy-text/60 max-w-md leading-relaxed font-medium">
            {activeWorktreeName
              ? "Workspace is empty. Launch an agent or terminal to begin."
              : "A habitat for your AI agents."}
          </p>
        </div>

        {!hasActiveWorktree && (
          <div
            className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-6 max-w-md text-center"
            role="status"
            aria-live="assertive"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Select a worktree in the sidebar to set the working directory for agents</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-3xl mb-8">
          <LauncherCard
            title="Claude Code"
            description="Great for deep, steady refactors."
            shortcut="Cmd/Ctrl+Alt+C"
            icon={<ClaudeIcon className="h-5 w-5" brandColor={getBrandColorHex("claude")} />}
            onClick={() => handleAgentClick("claude")}
            available={agentAvailability?.claude ?? false}
            isLoading={isCheckingAvailability}
            onUnavailableClick={handleUnavailableClick}
            primary
          />
          <LauncherCard
            title="Codex CLI"
            description="Good for careful, step-by-step changes."
            icon={<CodexIcon className="h-5 w-5" brandColor={getBrandColorHex("codex")} />}
            onClick={() => handleAgentClick("codex")}
            available={agentAvailability?.codex ?? false}
            isLoading={isCheckingAvailability}
            onUnavailableClick={handleUnavailableClick}
            primary
          />
          <LauncherCard
            title="Gemini CLI"
            description="Ideal for quick explorations and visual tasks."
            shortcut="Cmd/Ctrl+Alt+G"
            icon={<GeminiIcon className="h-5 w-5" brandColor={getBrandColorHex("gemini")} />}
            onClick={() => handleAgentClick("gemini")}
            available={agentAvailability?.gemini ?? false}
            isLoading={isCheckingAvailability}
            onUnavailableClick={handleUnavailableClick}
            primary
          />
          <LauncherCard
            title="Terminal"
            description="Direct terminal access."
            icon={<Terminal className="h-5 w-5" />}
            onClick={() => handleAgentClick("terminal")}
            available={true}
            isLoading={false}
          />
        </div>

        <div className="flex flex-col items-center gap-4 mt-4">
          <p className="text-xs text-canopy-text/60 text-center">
            Tip: Press <Kbd>⌘P</Kbd> to open the terminal palette or <Kbd>⌘T</Kbd> to start a new
            terminal
          </p>

          <button
            type="button"
            onClick={handleOpenHelp}
            className="flex items-center gap-3 p-2 pr-4 rounded-full hover:bg-white/5 transition-all group text-left border border-transparent hover:border-white/5"
          >
            <div className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center group-hover:bg-canopy-accent/20 transition-colors">
              <div className="w-0 h-0 border-t-[3px] border-t-transparent border-l-[6px] border-l-white/70 border-b-[3px] border-b-transparent ml-0.5 group-hover:border-l-canopy-accent transition-colors" />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-medium text-canopy-text/60 group-hover:text-canopy-text transition-colors">
                View documentation
              </span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

export function TerminalGrid({
  className,
  defaultCwd,
  onLaunchAgent,
  agentAvailability,
  isCheckingAvailability,
  onOpenSettings,
}: TerminalGridProps) {
  const { terminals, focusedId, maximizedId } = useTerminalStore(
    useShallow((state) => ({
      terminals: state.terminals,
      focusedId: state.focusedId,
      maximizedId: state.maximizedId,
    }))
  );

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const { worktreeMap } = useWorktrees();
  const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
  const hasActiveWorktree = activeWorktreeId !== null && activeWorktree !== undefined;
  const activeWorktreeName =
    activeWorktree?.branch ||
    activeWorktree?.name ||
    (activeWorktreeId ? "Unknown Worktree" : null);

  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const isInTrash = useTerminalStore((state) => state.isInTrash);

  const gridTerminals = useMemo(
    () =>
      terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      ),
    [terminals, activeWorktreeId]
  );

  const layoutConfig = useLayoutConfigStore((state) => state.layoutConfig);
  const isGridFull = gridTerminals.length >= MAX_GRID_TERMINALS;

  // Make the grid a droppable area
  const { setNodeRef, isOver } = useDroppable({
    id: "grid-container",
    data: { container: "grid" },
  });

  // Track container width for responsive layout decisions
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState<number | null>(null);

  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const newWidth = entry.contentRect.width;
        setGridWidth((prev) => (prev === newWidth ? prev : newWidth));
      }
    });

    observer.observe(container);
    setGridWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  // Get placeholder state from DnD context
  const { placeholderIndex, sourceContainer } = useDndPlaceholder();

  // Show placeholder when dragging from dock to grid (only if grid not full)
  const showPlaceholder = placeholderIndex !== null && sourceContainer === "dock" && !isGridFull;

  const gridCols = useMemo(() => {
    // Count includes placeholder when dragging from dock to grid
    const baseCount = gridTerminals.length;
    const count = showPlaceholder ? baseCount + 1 : baseCount;
    if (count === 0) return 1;

    const { strategy, value } = layoutConfig;

    if (strategy === "fixed-columns") {
      return Math.max(1, Math.min(value, 10));
    }

    if (strategy === "fixed-rows") {
      const rows = Math.max(1, Math.min(value, 10));
      return Math.ceil(count / rows);
    }

    // Automatic rectangular layout via deterministic mapping
    return getAutoGridCols(count, gridWidth);
  }, [gridTerminals.length, layoutConfig, gridWidth, showPlaceholder]);

  const handleLaunchAgent = useCallback(
    async (type: "claude" | "gemini" | "codex" | "terminal") => {
      if (onLaunchAgent) {
        try {
          await onLaunchAgent(type);
        } catch (error) {
          console.error(`Failed to launch ${type}:`, error);
        }
        return;
      }

      try {
        const cwd = defaultCwd || "";
        const command = type !== "terminal" ? type : undefined;
        await addTerminal({ type, cwd, command });
      } catch (error) {
        console.error(`Failed to launch ${type}:`, error);
      }
    },
    [addTerminal, defaultCwd, onLaunchAgent]
  );

  const placeholderInGrid =
    placeholderIndex !== null && placeholderIndex >= 0 && placeholderIndex <= gridTerminals.length;

  // Terminal IDs for SortableContext - Include placeholder if visible
  const terminalIds = useMemo(() => {
    const ids = gridTerminals.map((t) => t.id);
    if (showPlaceholder && placeholderInGrid) {
      const insertIndex = Math.min(Math.max(0, placeholderIndex), ids.length);
      ids.splice(insertIndex, 0, GRID_PLACEHOLDER_ID);
    }
    return ids;
  }, [gridTerminals, showPlaceholder, placeholderIndex, placeholderInGrid]);

  // Batch-fit grid terminals when layout (gridCols/count) changes
  useEffect(() => {
    const ids = gridTerminals.map((t) => t.id);
    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      let index = 0;
      const processNext = () => {
        if (cancelled || index >= ids.length) return;
        const id = ids[index++];
        const managed = terminalInstanceService.get(id);

        if (managed?.hostElement.isConnected) {
          terminalInstanceService.fit(id);
          terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
        }
        requestAnimationFrame(processNext);
      };
      processNext();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [gridCols, terminalIds, gridTerminals]);

  // Show "grid full" overlay when trying to drag from dock to a full grid
  const showGridFullOverlay = sourceContainer === "dock" && isGridFull;

  // Maximized terminal takes full screen
  if (maximizedId) {
    const terminal = gridTerminals.find((t: TerminalInstance) => t.id === maximizedId);
    if (terminal) {
      return (
        <div className={cn("h-full relative bg-canopy-bg", className)}>
          <GridTerminalPane terminal={terminal} isFocused={true} isMaximized={true} />
        </div>
      );
    }
  }

  const isEmpty = gridTerminals.length === 0;

  return (
    <div className={cn("h-full flex flex-col", className)}>
      <TerminalCountWarning className="mx-1 mt-1 shrink-0" />
      <div className="relative flex-1 min-h-0">
        <SortableContext id="grid-container" items={terminalIds} strategy={rectSortingStrategy}>
          <div
            ref={(node) => {
              setNodeRef(node);
              gridContainerRef.current = node;
            }}
            className={cn(
              "h-full bg-noise p-1",
              isOver && "ring-2 ring-canopy-accent/30 ring-inset"
            )}
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
              gridAutoRows: "1fr",
              gap: "4px",
              backgroundColor: "var(--color-grid-bg)",
            }}
            role="grid"
            id="terminal-grid"
            aria-label="Terminal grid"
          >
            {isEmpty && !showPlaceholder ? (
              <div className="col-span-full row-span-full">
                <EmptyState
                  onLaunchAgent={handleLaunchAgent}
                  hasActiveWorktree={hasActiveWorktree}
                  agentAvailability={agentAvailability}
                  isCheckingAvailability={isCheckingAvailability}
                  onOpenSettings={onOpenSettings}
                  activeWorktreeName={activeWorktreeName}
                />
              </div>
            ) : (
              <>
                {gridTerminals.map((terminal, index) => {
                  const isTerminalInTrash = isInTrash(terminal.id);
                  const elements: React.ReactNode[] = [];

                  if (showPlaceholder && placeholderInGrid && placeholderIndex === index) {
                    elements.push(<SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />);
                  }

                  elements.push(
                    <SortableTerminal
                      key={terminal.id}
                      terminal={terminal}
                      sourceLocation="grid"
                      sourceIndex={index}
                      disabled={isTerminalInTrash}
                    >
                      <GridTerminalPane terminal={terminal} isFocused={terminal.id === focusedId} />
                    </SortableTerminal>
                  );

                  return elements;
                })}
                {showPlaceholder &&
                  placeholderInGrid &&
                  placeholderIndex === gridTerminals.length && (
                    <SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />
                  )}
              </>
            )}
          </div>
        </SortableContext>

        <GridFullOverlay maxTerminals={MAX_GRID_TERMINALS} show={showGridFullOverlay} />
      </div>
    </div>
  );
}

export default TerminalGrid;
