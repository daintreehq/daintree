import { useCallback, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import {
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Layers,
  AlertCircle,
  XCircle,
  Trash2,
} from "lucide-react";
import { cn, getBaseTitle } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import {
  useTerminalStore,
  useProjectStore,
  useWorktreeSelectionStore,
  useDockStore,
} from "@/store";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { WaitingContainer } from "./WaitingContainer";
import { FailedContainer } from "./FailedContainer";
import { TrashContainer } from "./TrashContainer";
import { AssistantDockButton } from "@/components/Dock/AssistantDockButton";
import {
  SortableDockItem,
  SortableDockPlaceholder,
  DOCK_PLACEHOLDER_ID,
} from "@/components/DragDrop";
import { useKeybindingDisplay, useHorizontalScrollControls, useNativeContextMenu } from "@/hooks";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useWaitingTerminals, useFailedTerminals } from "@/hooks/useTerminalSelectors";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import type { MenuItemOption } from "@/types";
import type { TerminalType, TerminalKind, AgentState } from "@shared/types";
import { actionService } from "@/services/ActionService";

const AGENT_OPTIONS = [
  { type: "claude" as const, label: "Claude" },
  { type: "gemini" as const, label: "Gemini" },
  { type: "codex" as const, label: "Codex" },
  { type: "opencode" as const, label: "OpenCode" },
  { type: "terminal" as const, label: "Terminal" },
  { type: "browser" as const, label: "Browser" },
];

interface CompactDockProps {
  dockedCount: number;
  shouldFadeForInput?: boolean;
  ultraMinimal?: boolean;
}

export function CompactDock({
  dockedCount,
  shouldFadeForInput = false,
  ultraMinimal = false,
}: CompactDockProps) {
  const { showMenu } = useNativeContextMenu();
  const setMode = useDockStore((state) => state.setMode);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const toggleShortcut = useKeybindingDisplay("panel.toggleDock");

  const dockTerminals = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) =>
          t.location === "dock" &&
          // Show terminals that match active worktree OR have no worktree (global terminals)
          (t.worktreeId == null || t.worktreeId === activeWorktreeId)
      )
    )
  );

  const trashedTerminals = useTerminalStore(useShallow((state) => state.trashedTerminals));
  const terminals = useTerminalStore((state) => state.terminals);
  const activateTerminal = useTerminalStore((state) => state.activateTerminal);
  const openDockTerminal = useTerminalStore((state) => state.openDockTerminal);
  const currentProject = useProjectStore((s) => s.currentProject);

  const { worktrees } = useWorktrees();

  const activeWorktree = activeWorktreeId ? worktrees.find((w) => w.id === activeWorktreeId) : null;
  const cwd = activeWorktree?.path ?? currentProject?.path ?? "";

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, scrollLeft, scrollRight } =
    useHorizontalScrollControls(scrollContainerRef);

  const { setNodeRef: setDockDropRef, isOver } = useDroppable({
    id: "dock-container",
    data: { container: "dock" },
  });

  const combinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollContainerRef.current = node;
      setDockDropRef(node);
    },
    [setDockDropRef]
  );

  const handleAddTerminal = useCallback(
    (agentId: string) => {
      void actionService.dispatch(
        "agent.launch",
        {
          agentId: agentId as any,
          location: "dock",
          cwd,
          worktreeId: activeWorktreeId || undefined,
        },
        { source: "context-menu" }
      );
    },
    [activeWorktreeId, cwd]
  );

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      const template: MenuItemOption[] = AGENT_OPTIONS.map(({ type, label }) => ({
        id: `new:${type}`,
        label: `New ${label}`,
      }));

      const actionId = await showMenu(event, template);
      if (!actionId) return;

      if (actionId.startsWith("new:")) {
        handleAddTerminal(actionId.slice("new:".length));
      }
    },
    [handleAddTerminal, showMenu]
  );

  const handleExpandClick = () => {
    setMode("expanded");
  };

  const trashedItems = Array.from(trashedTerminals.values())
    .map((trashed) => ({
      terminal: terminals.find((t) => t.id === trashed.id),
      trashedInfo: trashed,
    }))
    .filter((item) => item.terminal !== undefined) as {
    terminal: (typeof terminals)[0];
    trashedInfo: typeof trashedTerminals extends Map<string, infer V> ? V : never;
  }[];

  const terminalIds = useMemo(() => {
    if (dockTerminals.length === 0) {
      return [DOCK_PLACEHOLDER_ID];
    }
    return dockTerminals.map((t) => t.id);
  }, [dockTerminals]);

  const expandTooltip = ["Expand dock", toggleShortcut && `(${toggleShortcut})`]
    .filter(Boolean)
    .join(" ");

  const waitingTerminals = useWaitingTerminals();
  const failedTerminals = useFailedTerminals();
  const waitingCount = waitingTerminals.length;
  const failedCount = failedTerminals.length;
  const trashedCount = trashedItems.length;

  if (ultraMinimal) {
    return (
      <UltraMinimalDock
        dockTerminals={dockTerminals}
        waitingCount={waitingCount}
        failedCount={failedCount}
        trashedCount={trashedCount}
        shouldFadeForInput={shouldFadeForInput}
        onExpandClick={handleExpandClick}
        onTerminalClick={(terminal) => {
          setMode("expanded");
          openDockTerminal(terminal.id);
        }}
        onTerminalDoubleClick={(terminal) => activateTerminal(terminal.id)}
        onContextMenu={handleContextMenu}
        expandTooltip={expandTooltip}
      />
    );
  }

  return (
    <div
      onContextMenu={handleContextMenu}
      className={cn(
        "bg-[var(--dock-bg)]/90 backdrop-blur-sm",
        "border-t border-[var(--dock-border)]/50",
        "shadow-sm",
        "flex items-center h-7 px-1.5 gap-1.5",
        "z-40 shrink-0",
        "transition-opacity duration-200",
        shouldFadeForInput ? "opacity-25 hover:opacity-90" : "opacity-100"
      )}
      data-dock-mode="compact"
      data-dock-density="compact"
    >
      {/* Left: Expand button + docked count */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={handleExpandClick}
          className={cn(
            "flex items-center justify-center",
            "w-5 h-5 rounded",
            "bg-white/[0.03] hover:bg-white/[0.06]",
            "border border-white/[0.04] hover:border-white/[0.08]",
            "text-canopy-text/40 hover:text-canopy-text/70",
            "transition-colors duration-150",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
          )}
          title={expandTooltip}
          aria-label={expandTooltip}
        >
          <ChevronUp className="w-3 h-3" aria-hidden="true" />
        </button>

        {dockedCount > 0 && (
          <div
            className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-white/[0.03] text-canopy-text/40"
            title={`${dockedCount} docked panel${dockedCount === 1 ? "" : "s"}`}
          >
            <Layers className="w-2.5 h-2.5" aria-hidden="true" />
            <span className="text-[10px] font-medium tabular-nums">{dockedCount}</span>
          </div>
        )}
      </div>

      {/* Separator */}
      {dockTerminals.length > 0 && <div className="w-px h-4 bg-[var(--dock-border)]/50 shrink-0" />}

      {/* Center: Panel icons (scrollable) */}
      <div className="relative flex-1 min-w-0">
        {canScrollLeft && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-r from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pr-1">
            <button
              type="button"
              onClick={scrollLeft}
              className={cn(
                "pointer-events-auto p-0.5 text-canopy-text/50 hover:text-canopy-text",
                "rounded transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              )}
              aria-label="Scroll left"
              title="Scroll left"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
          </div>
        )}

        <div
          ref={combinedRef}
          className={cn(
            "flex items-center gap-0.5 overflow-x-auto flex-1 min-h-5 no-scrollbar scroll-smooth px-0.5",
            isOver && "bg-white/[0.03] ring-1 ring-canopy-accent/30 ring-inset rounded"
          )}
        >
          <SortableContext
            id="dock-container"
            items={terminalIds}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex items-center gap-0.5 min-w-[40px] min-h-5">
              {dockTerminals.length === 0 ? (
                <SortableDockPlaceholder />
              ) : (
                dockTerminals.map((terminal, index) => (
                  <SortableDockItem key={terminal.id} terminal={terminal} sourceIndex={index}>
                    <CompactTerminalIcon
                      terminal={terminal}
                      onClick={() => {
                        setMode("expanded");
                        openDockTerminal(terminal.id);
                      }}
                      onDoubleClick={() => activateTerminal(terminal.id)}
                    />
                  </SortableDockItem>
                ))
              )}
            </div>
          </SortableContext>
        </div>

        {canScrollRight && (
          <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-l from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pl-1">
            <button
              type="button"
              onClick={scrollRight}
              className={cn(
                "pointer-events-auto p-0.5 text-canopy-text/50 hover:text-canopy-text",
                "rounded transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              )}
              aria-label="Scroll right"
              title="Scroll right"
            >
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Separator before status */}
      <div className="w-px h-4 bg-[var(--dock-border)]/50 shrink-0" />

      {/* Right: Status indicators */}
      <div className="shrink-0 flex items-center gap-1">
        <WaitingContainer compact />
        <FailedContainer compact />
        <TrashContainer trashedTerminals={trashedItems} compact />
        <AssistantDockButton />
      </div>
    </div>
  );
}

interface CompactTerminalIconProps {
  terminal: {
    id: string;
    type?: TerminalType;
    kind?: TerminalKind;
    agentId?: string;
    title: string;
    agentState?: AgentState;
  };
  onClick: () => void;
  onDoubleClick: () => void;
}

function CompactTerminalIcon({ terminal, onClick, onDoubleClick }: CompactTerminalIconProps) {
  const brandColor = getBrandColorHex(terminal.type);
  const displayTitle = getBaseTitle(terminal.title);
  const isActive = terminal.agentState === "working" || terminal.agentState === "running";
  const isWaiting = terminal.agentState === "waiting";

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        onDoubleClick();
      } else {
        onClick();
      }
    }
  };

  return (
    <button
      type="button"
      className={cn(
        "flex items-center justify-center",
        "w-5 h-5 rounded",
        "bg-white/[0.02] hover:bg-white/[0.05]",
        "border border-transparent hover:border-white/[0.08]",
        "transition-all duration-150",
        "cursor-grab active:cursor-grabbing",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
        isActive && "ring-1 ring-canopy-accent/30",
        isWaiting && "ring-1 ring-amber-400/30"
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
      onKeyDown={handleKeyDown}
      title={`${displayTitle} - Click to expand and preview, double-click to restore`}
      aria-label={`${displayTitle} - Press Enter to expand and preview, Shift+Enter to restore to grid`}
    >
      <TerminalIcon
        type={terminal.type}
        kind={terminal.kind}
        agentId={terminal.agentId}
        className={cn("w-3 h-3", isActive && "animate-pulse motion-reduce:animate-none")}
        brandColor={brandColor}
      />
    </button>
  );
}

interface UltraMinimalDockProps {
  dockTerminals: Array<{
    id: string;
    type?: TerminalType;
    kind?: TerminalKind;
    agentId?: string;
    title: string;
    agentState?: AgentState;
  }>;
  waitingCount: number;
  failedCount: number;
  trashedCount: number;
  shouldFadeForInput: boolean;
  onExpandClick: () => void;
  onTerminalClick: (terminal: { id: string }) => void;
  onTerminalDoubleClick: (terminal: { id: string }) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  expandTooltip: string;
}

function UltraMinimalDock({
  dockTerminals,
  waitingCount,
  failedCount,
  trashedCount,
  shouldFadeForInput,
  onExpandClick,
  onTerminalClick,
  onTerminalDoubleClick,
  onContextMenu,
  expandTooltip,
}: UltraMinimalDockProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const isExpanded = isHovered || isFocused;

  return (
    <TooltipProvider delayDuration={200}>
      <div
        onContextMenu={onContextMenu}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onFocus={() => setIsFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsFocused(false);
          }
        }}
        className={cn(
          "bg-[var(--dock-bg)]/80 backdrop-blur-sm",
          "border-t border-[var(--dock-border)]/30",
          "flex items-stretch h-1.5",
          "z-40 shrink-0",
          "transition-all duration-200",
          shouldFadeForInput
            ? "opacity-20 hover:opacity-90 focus-within:opacity-90"
            : "opacity-100",
          isExpanded && "h-5 bg-[var(--dock-bg)]/95"
        )}
        data-dock-mode="ultra-minimal"
        data-dock-density="ultra-minimal"
        style={{ minHeight: isExpanded ? "20px" : "6px" }}
      >
        {/* Left: Expand strip - clickable area to expand dock */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onExpandClick}
              className={cn(
                "w-8 shrink-0",
                "bg-canopy-accent/20 hover:bg-canopy-accent/40",
                "transition-colors duration-150",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                isExpanded && "flex items-center justify-center"
              )}
              aria-label={expandTooltip}
            >
              {isExpanded && <ChevronUp className="w-3 h-3 text-canopy-text/60" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <span>{expandTooltip}</span>
          </TooltipContent>
        </Tooltip>

        {/* Center: Docked terminal strips */}
        <div className="flex-1 flex items-stretch gap-px overflow-hidden">
          {dockTerminals.map((terminal) => (
            <TerminalStrip
              key={terminal.id}
              terminal={terminal}
              isExpanded={isExpanded}
              onClick={() => onTerminalClick(terminal)}
              onDoubleClick={() => onTerminalDoubleClick(terminal)}
            />
          ))}
        </div>

        {/* Right: Status strips */}
        <div className="flex items-stretch gap-px shrink-0">
          {waitingCount > 0 && (
            <StatusStrip type="waiting" count={waitingCount} isExpanded={isExpanded} />
          )}
          {failedCount > 0 && (
            <StatusStrip type="failed" count={failedCount} isExpanded={isExpanded} />
          )}
          {trashedCount > 0 && (
            <StatusStrip type="trashed" count={trashedCount} isExpanded={isExpanded} />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

interface TerminalStripProps {
  terminal: {
    id: string;
    type?: TerminalType;
    kind?: TerminalKind;
    agentId?: string;
    title: string;
    agentState?: AgentState;
  };
  isExpanded: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

function TerminalStrip({ terminal, isExpanded, onClick, onDoubleClick }: TerminalStripProps) {
  const brandColor = getBrandColorHex(terminal.type) ?? getBrandColorHex(terminal.agentId);
  const displayTitle = getBaseTitle(terminal.title);
  const isActive = terminal.agentState === "working" || terminal.agentState === "running";
  const isWaiting = terminal.agentState === "waiting";

  const stripColor = brandColor ?? "rgb(156, 163, 175)";
  const opacity = isActive ? 1 : isWaiting ? 0.7 : 0.5;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        onDoubleClick();
      } else {
        onClick();
      }
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onDoubleClick();
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-1 min-w-[4px] transition-all duration-150",
            !isExpanded && "hover:w-2 hover:min-w-[8px]",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
            isActive && "animate-pulse motion-reduce:animate-none",
            isExpanded && "flex items-center justify-center w-4 min-w-[16px]"
          )}
          style={{
            backgroundColor: stripColor,
            opacity: opacity,
          }}
          aria-label={`${displayTitle} - Press Enter to preview, Shift+Enter to restore`}
        >
          {isExpanded && (
            <TerminalIcon
              type={terminal.type}
              kind={terminal.kind}
              agentId={terminal.agentId}
              className="w-2.5 h-2.5"
              brandColor={brandColor}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <div className="flex items-center gap-1.5">
          <TerminalIcon
            type={terminal.type}
            kind={terminal.kind}
            agentId={terminal.agentId}
            className="w-3 h-3"
            brandColor={brandColor}
          />
          <span>{displayTitle}</span>
          {isActive && <span className="text-canopy-accent text-[10px]">working</span>}
          {isWaiting && <span className="text-amber-400 text-[10px]">waiting</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface StatusStripProps {
  type: "waiting" | "failed" | "trashed";
  count: number;
  isExpanded: boolean;
}

function StatusStrip({ type, count, isExpanded }: StatusStripProps) {
  const { activateTerminal, pingTerminal } = useTerminalStore(
    useShallow((state) => ({
      activateTerminal: state.activateTerminal,
      pingTerminal: state.pingTerminal,
    }))
  );
  const { activeWorktreeId, selectWorktree, trackTerminalFocus } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      selectWorktree: state.selectWorktree,
      trackTerminalFocus: state.trackTerminalFocus,
    }))
  );

  const waitingTerminals = useWaitingTerminals();
  const failedTerminals = useFailedTerminals();

  const config = {
    waiting: {
      color: "rgb(251, 191, 36)", // amber-400
      hoverColor: "rgb(245, 158, 11)", // amber-500
      icon: AlertCircle,
      label: "waiting for input",
      terminals: waitingTerminals,
    },
    failed: {
      color: "rgb(248, 113, 113)", // red-400
      hoverColor: "rgb(239, 68, 68)", // red-500
      icon: XCircle,
      label: "failed",
      terminals: failedTerminals,
    },
    trashed: {
      color: "var(--muted-foreground)",
      hoverColor: "var(--canopy-text)",
      icon: Trash2,
      label: "in trash",
      terminals: [],
    },
  }[type];

  const Icon = config.icon;
  const baseWidth = Math.min(count * 6, 24);

  const handleClick = () => {
    if (type !== "trashed" && config.terminals.length > 0) {
      const firstTerminal = config.terminals[0];
      if (firstTerminal.worktreeId && firstTerminal.worktreeId !== activeWorktreeId) {
        trackTerminalFocus(firstTerminal.worktreeId, firstTerminal.id);
        selectWorktree(firstTerminal.worktreeId);
      }
      activateTerminal(firstTerminal.id);
      pingTerminal(firstTerminal.id);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className={cn(
            "transition-all duration-150",
            "hover:opacity-100",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
            isExpanded && "flex items-center justify-center gap-0.5 px-1"
          )}
          style={{
            backgroundColor: config.color,
            width: isExpanded ? "auto" : `${baseWidth}px`,
            minWidth: isExpanded ? "24px" : `${baseWidth}px`,
            opacity: 0.8,
          }}
          aria-label={`${count} ${type}`}
        >
          {isExpanded && (
            <>
              <Icon className="w-2.5 h-2.5 text-white/90" />
              <span className="text-[10px] font-medium text-white/90">{count}</span>
            </>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <div className="flex items-center gap-1.5">
          <Icon className="w-3 h-3" style={{ color: config.color }} />
          <span>
            {count} {config.label}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
