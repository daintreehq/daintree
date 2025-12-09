import { useMemo, useRef, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { useTerminalStore, useProjectStore } from "@/store";
import { DockedTerminalItem } from "./DockedTerminalItem";
import { TrashContainer } from "./TrashContainer";
import { WaitingContainer } from "./WaitingContainer";
import {
  SortableDockItem,
  SortableDockPlaceholder,
  DOCK_PLACEHOLDER_ID,
} from "@/components/DragDrop";
import { ClaudeIcon, GeminiIcon, CodexIcon } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAgentLauncher, type AgentType } from "@/hooks/useAgentLauncher";
import { useWorktrees } from "@/hooks/useWorktrees";
import type { TerminalType } from "@shared/types";

const AGENT_OPTIONS = [
  { type: "claude" as const, label: "Claude", Icon: ClaudeIcon },
  { type: "gemini" as const, label: "Gemini", Icon: GeminiIcon },
  { type: "codex" as const, label: "Codex", Icon: CodexIcon },
  { type: "shell" as const, label: "Terminal", Icon: Terminal },
];

export function TerminalDock() {
  const dockTerminals = useTerminalStore(
    useShallow((state) => state.terminals.filter((t) => t.location === "dock"))
  );

  const trashedTerminals = useTerminalStore(useShallow((state) => state.trashedTerminals));
  const terminals = useTerminalStore((state) => state.terminals);
  const currentProject = useProjectStore((s) => s.currentProject);

  const { worktrees, activeId } = useWorktrees();
  const { launchAgent } = useAgentLauncher();

  const activeWorktree = worktrees.find((w) => w.id === activeId);
  const cwd = activeWorktree?.path ?? currentProject?.path ?? "";

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Make the dock terminals area droppable
  const { setNodeRef: setDockDropRef, isOver } = useDroppable({
    id: "dock-container",
    data: { container: "dock" },
  });

  // Sync droppable ref with scroll container ref using stable callback
  // This prevents ResizeObserver thrashing that causes infinite update loops
  const combinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollContainerRef.current = node;
      setDockDropRef(node);
    },
    [setDockDropRef]
  );

  const handleScroll = (direction: "left" | "right") => {
    if (scrollContainerRef.current) {
      const scrollAmount = 200;
      scrollContainerRef.current.scrollBy({
        left: direction === "left" ? -scrollAmount : scrollAmount,
        behavior: "smooth",
      });
    }
  };

  const handleAddTerminal = useCallback(
    (agentType: AgentType) => {
      launchAgent(agentType, { location: "dock", cwd });
    },
    [launchAgent, cwd]
  );

  const trashedItems = Array.from(trashedTerminals.values())
    .map((trashed) => ({
      terminal: terminals.find((t) => t.id === trashed.id),
      trashedInfo: trashed,
    }))
    .filter((item) => item.terminal !== undefined) as {
    terminal: (typeof terminals)[0];
    trashedInfo: typeof trashedTerminals extends Map<string, infer V> ? V : never;
  }[];

  const activeDockTerminals = dockTerminals;

  // Terminal IDs for SortableContext
  const terminalIds = useMemo(() => {
    if (activeDockTerminals.length === 0) {
      return [DOCK_PLACEHOLDER_ID];
    }
    return activeDockTerminals.map((t) => t.id);
  }, [activeDockTerminals]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "bg-canopy-bg/95 backdrop-blur-sm border-t-2 border-canopy-border/60 shadow-[0_-4px_12px_rgba(0,0,0,0.3)]",
            "flex items-center px-1.5 py-1.5 gap-1.5",
            "z-40 shrink-0"
          )}
          role="list"
        >
          <div className="flex items-center gap-1 flex-1 min-w-0">
            {/* Left Scroll Chevron */}
            <button
              onClick={() => handleScroll("left")}
              disabled={activeDockTerminals.length === 0}
              className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-white/10 rounded transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-canopy-text/40 disabled:hover:bg-transparent"
              aria-label="Scroll left"
              title="Scroll left"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {/* Scrollable Container - min-h ensures droppable area when empty */}
            <div
              ref={combinedRef}
              className={cn(
                "flex items-center gap-1.5 overflow-x-auto flex-1 min-h-[36px] no-scrollbar scroll-smooth px-1",
                isOver && "bg-white/[0.03] ring-2 ring-canopy-accent/30 ring-inset rounded-full"
              )}
            >
              <SortableContext
                id="dock-container"
                items={terminalIds}
                strategy={horizontalListSortingStrategy}
              >
                {/* min-w/min-h prevent dnd-kit measureRects loop when empty
                    (dnd-kit measures first child, which collapses to 0×0 without this) */}
                <div className="flex items-center gap-1.5 min-w-[100px] min-h-[32px]">
                  {activeDockTerminals.length === 0 ? (
                    <SortableDockPlaceholder />
                  ) : (
                    activeDockTerminals.map((terminal, index) => (
                      <SortableDockItem key={terminal.id} terminal={terminal} sourceIndex={index}>
                        <DockedTerminalItem terminal={terminal} />
                      </SortableDockItem>
                    ))
                  )}
                </div>
              </SortableContext>
            </div>

            {/* Right Scroll Chevron */}
            <button
              onClick={() => handleScroll("right")}
              disabled={activeDockTerminals.length === 0}
              className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-white/10 rounded transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-canopy-text/40 disabled:hover:bg-transparent"
              aria-label="Scroll right"
              title="Scroll right"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Separator between terminals and action containers */}
          {activeDockTerminals.length > 0 && (
            <div className="w-px h-5 bg-canopy-border mx-1 shrink-0" />
          )}

          {/* Action containers: Waiting + Trash */}
          <div className="shrink-0 pl-1 flex items-center gap-1.5">
            <WaitingContainer />
            <TrashContainer trashedTerminals={trashedItems} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {AGENT_OPTIONS.map(({ type, label, Icon }) => (
          <ContextMenuItem
            key={type}
            onClick={() => handleAddTerminal(type)}
            className="flex items-center gap-2"
          >
            <Icon
              className="w-4 h-4"
              style={
                type !== "shell" ? { color: getBrandColorHex(type as TerminalType) } : undefined
              }
            />
            <span>New {label}</span>
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
