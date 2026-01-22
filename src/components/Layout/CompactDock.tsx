import { useCallback, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { ChevronUp, ChevronLeft, ChevronRight, Layers } from "lucide-react";
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
import {
  SortableDockItem,
  SortableDockPlaceholder,
  DOCK_PLACEHOLDER_ID,
} from "@/components/DragDrop";
import { useKeybindingDisplay, useHorizontalScrollControls, useNativeContextMenu } from "@/hooks";
import { useWorktrees } from "@/hooks/useWorktrees";
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
}

export function CompactDock({ dockedCount, shouldFadeForInput = false }: CompactDockProps) {
  const { showMenu } = useNativeContextMenu();
  const setMode = useDockStore((state) => state.setMode);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const toggleShortcut = useKeybindingDisplay("panel.toggleDock");

  const dockTerminals = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) =>
          t.location === "dock" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
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
            isOver &&
              "bg-white/[0.03] ring-1 ring-canopy-accent/30 ring-inset rounded"
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
