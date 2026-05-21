import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Trash2 } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  useIsDragging,
  useIsWorktreeSortDragging,
  TRASH_DROPPABLE_ID,
} from "@/components/DragDrop";
import { DURATION_200, UI_TRANSIENT_HINT_DWELL_MS } from "@/lib/animationUtils";
import type { TerminalInstance } from "@/store";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";
import { TrashBinItem } from "./TrashBinItem";
import { TrashGroupItem } from "./TrashGroupItem";

const MOVED_HINT_MAX_SHOWS = 3;

interface TrashContainerProps {
  trashedTerminals: Array<{
    terminal: TerminalInstance;
    trashedInfo: TrashedTerminal;
  }>;
  compact?: boolean;
}

interface GroupedTrashItem {
  type: "single";
  terminal: TerminalInstance;
  trashedInfo: TrashedTerminal;
  sortKey: number;
}

interface GroupedTrashGroup {
  type: "group";
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: Array<{
    terminal: TerminalInstance;
    trashedInfo: TrashedTerminal;
  }>;
  earliestExpiry: number;
  latestExpiry: number;
  sortKey: number;
}

type TrashDisplayItem = GroupedTrashItem | GroupedTrashGroup;

export function TrashContainer({ trashedTerminals, compact = false }: TrashContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isTrashPulsing, setIsTrashPulsing] = useState(false);
  const [showMovedHint, setShowMovedHint] = useState(false);
  const prevLengthRef = useRef(trashedTerminals.length);
  const hintShowCountRef = useRef(0);
  const { worktreeMap } = useWorktrees();
  // Only show the ghost pill for panel drags — worktree-card sort drags also flip
  // isDragging but cannot drop on trash, and a phantom drop target is misleading.
  const isDragging = useIsDragging();
  const isWorktreeSortDragging = useIsWorktreeSortDragging();
  const isPanelDragging = isDragging && !isWorktreeSortDragging;
  const { setNodeRef, isOver } = useDroppable({ id: TRASH_DROPPABLE_ID });

  useEffect(() => {
    const increased = trashedTerminals.length > prevLengthRef.current;
    prevLengthRef.current = trashedTerminals.length;
    if (!increased) {
      setIsTrashPulsing(false);
      return;
    }
    setIsTrashPulsing(true);
    // Cap the visual coachmark; aria-live still fires below on every close.
    // Session-scoped — restart gives a fresh teaching window without persistence.
    if (hintShowCountRef.current < MOVED_HINT_MAX_SHOWS) {
      hintShowCountRef.current += 1;
      setShowMovedHint(true);
    }
    const shortcut = isMac() ? "Cmd+Shift+T" : "Ctrl+Shift+T";
    useAnnouncerStore.getState().announce(`Panel closed — press ${shortcut} to restore`);
  }, [trashedTerminals.length]);

  const handleTrashAnimationEnd = useCallback(() => {
    setIsTrashPulsing(false);
  }, []);

  // Safety timeout — under reduced-motion CSS sets `animation: none`, so
  // `animationend` never fires and isTrashPulsing would latch true.
  useEffect(() => {
    if (!isTrashPulsing) return;
    const timer = setTimeout(() => setIsTrashPulsing(false), DURATION_200 + 50);
    return () => clearTimeout(timer);
  }, [isTrashPulsing]);

  // Hold the "Moved to trash" hint for 1s; restart the timer on each new close
  // so back-to-back closes keep showing the hint instead of flickering off.
  useEffect(() => {
    if (!showMovedHint) return;
    const timer = setTimeout(() => setShowMovedHint(false), UI_TRANSIENT_HINT_DWELL_MS);
    return () => clearTimeout(timer);
  }, [showMovedHint, trashedTerminals.length]);

  // Group trash items by groupRestoreId
  const displayItems = useMemo((): TrashDisplayItem[] => {
    const groups = new Map<
      string,
      {
        metadata: TrashedTerminalGroupMetadata | undefined;
        terminals: Array<{ terminal: TerminalInstance; trashedInfo: TrashedTerminal }>;
        earliestExpiry: number;
        latestExpiry: number;
      }
    >();
    const singles: Array<{ terminal: TerminalInstance; trashedInfo: TrashedTerminal }> = [];

    for (const item of trashedTerminals) {
      const { trashedInfo } = item;
      if (trashedInfo.groupRestoreId) {
        const existing = groups.get(trashedInfo.groupRestoreId);
        if (existing) {
          existing.terminals.push(item);
          existing.earliestExpiry = Math.min(existing.earliestExpiry, trashedInfo.expiresAt);
          existing.latestExpiry = Math.max(existing.latestExpiry, trashedInfo.expiresAt);
          if (trashedInfo.groupMetadata) {
            existing.metadata = trashedInfo.groupMetadata;
          }
        } else {
          groups.set(trashedInfo.groupRestoreId, {
            metadata: trashedInfo.groupMetadata,
            terminals: [item],
            earliestExpiry: trashedInfo.expiresAt,
            latestExpiry: trashedInfo.expiresAt,
          });
        }
      } else {
        singles.push(item);
      }
    }

    const items: TrashDisplayItem[] = [];

    // Add grouped items
    for (const [groupRestoreId, group] of groups) {
      // Only show as group if we have metadata and multiple panels
      if (group.metadata && group.terminals.length > 1) {
        items.push({
          type: "group",
          groupRestoreId,
          groupMetadata: group.metadata,
          terminals: group.terminals,
          earliestExpiry: group.earliestExpiry,
          latestExpiry: group.latestExpiry,
          // earliestExpiry drives the displayed countdown; sortKey uses
          // latestExpiry so LIFO order reflects most-recent trash time.
          sortKey: group.latestExpiry,
        });
      } else {
        // Show as individual items if no metadata or single panel
        for (const item of group.terminals) {
          items.push({
            type: "single",
            terminal: item.terminal,
            trashedInfo: item.trashedInfo,
            sortKey: item.trashedInfo.expiresAt,
          });
        }
      }
    }

    // Add single items
    for (const item of singles) {
      items.push({
        type: "single",
        terminal: item.terminal,
        trashedInfo: item.trashedInfo,
        sortKey: item.trashedInfo.expiresAt,
      });
    }

    // LIFO: newest-trashed item first.
    return items.sort((a, b) => b.sortKey - a.sortKey);
  }, [trashedTerminals]);

  if (trashedTerminals.length === 0 && !isPanelDragging) return null;

  const count = trashedTerminals.length;
  const contentId = "trash-container-popover";

  // Ghost pill: visible during drags so users can see a drop target even when trash is empty.
  // Mount-only fade via animate-in; isOver styling cues an armed drop receptacle.
  if (count === 0) {
    return (
      <div ref={setNodeRef} className="shrink-0">
        <Button
          variant="pill"
          size="sm"
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="trash-container-ghost"
          className={cn(
            compact ? "px-1.5 min-w-0" : "px-3",
            "opacity-70 animate-in fade-in",
            isOver &&
              "cursor-copy opacity-100 bg-overlay-soft ring-2 ring-inset ring-border-default"
          )}
        >
          <Trash2 className="w-3.5 h-3.5 text-daintree-text/60" aria-hidden="true" />
          {!compact && <span className="font-medium">Trash (drop to delete)</span>}
        </Button>
      </div>
    );
  }

  // Suppress the hint while the trash popover is open — the user is already
  // looking at the trash, redundant labelling would be noise.
  const hintOpen = showMovedHint && !isOpen;

  return (
    <div ref={setNodeRef} className="shrink-0">
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip open={hintOpen}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="pill"
                size="sm"
                data-testid="trash-container"
                className={cn(
                  compact ? "px-1.5 min-w-0" : "px-3",
                  isOpen && "bg-overlay-emphasis border-border-default",
                  isOver &&
                    isPanelDragging &&
                    "cursor-copy bg-overlay-soft ring-2 ring-inset ring-border-default"
                )}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                aria-controls={contentId}
                aria-label={`Trash: ${count} terminal${count === 1 ? "" : "s"}`}
              >
                <span
                  className={cn("relative", isTrashPulsing && "animate-trash-pulse")}
                  onAnimationEnd={handleTrashAnimationEnd}
                >
                  <Trash2 className="w-3.5 h-3.5 text-daintree-text/60" aria-hidden="true" />
                  {compact && count > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-daintree-text/40 text-[10px] font-bold tabular-nums text-text-inverse">
                      {count > 9 ? "9+" : count}
                    </span>
                  )}
                </span>
                {!compact && <span className="font-medium tabular-nums">Trash ({count})</span>}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" sideOffset={6}>
            Moved to trash
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          id={contentId}
          role="dialog"
          aria-label="Recently closed terminals"
          className="w-80 p-0"
          side="top"
          align="end"
          sideOffset={8}
        >
          <div className="flex flex-col">
            <div className="px-3 py-2 border-b border-divider bg-daintree-bg/50 flex justify-between items-center">
              <span className="text-xs font-medium text-daintree-text/70">Recently closed</span>
              <span className="text-[11px] text-daintree-text/40">Auto-clears</span>
            </div>

            <div className="p-1 flex flex-col gap-1 max-h-[300px] overflow-y-auto">
              {displayItems.map((item) => {
                if (item.type === "group") {
                  const worktreeName = item.groupMetadata.worktreeId
                    ? worktreeMap.get(item.groupMetadata.worktreeId)?.name
                    : undefined;
                  return (
                    <TrashGroupItem
                      key={item.groupRestoreId}
                      groupRestoreId={item.groupRestoreId}
                      groupMetadata={item.groupMetadata}
                      terminals={item.terminals}
                      worktreeName={worktreeName}
                      earliestExpiry={item.earliestExpiry}
                    />
                  );
                } else {
                  const worktreeName = item.terminal.worktreeId
                    ? worktreeMap.get(item.terminal.worktreeId)?.name
                    : undefined;
                  return (
                    <TrashBinItem
                      key={item.terminal.id}
                      terminal={item.terminal}
                      trashedInfo={item.trashedInfo}
                      worktreeName={worktreeName}
                    />
                  );
                }
              })}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
