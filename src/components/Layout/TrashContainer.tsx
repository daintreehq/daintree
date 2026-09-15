import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Trash2 } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
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
import { usePanelStore } from "@/store";
import { TRASH_TTL_SECONDS, useTrashCountdown } from "./trashCountdown";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";
import { TrashBinItem } from "./TrashBinItem";
import { TrashGroupItem } from "./TrashGroupItem";

const MOVED_HINT_MAX_SHOWS = 3;

interface TrashContainerProps {
  trashedTerminals: Array<{
    terminal: PanelInstance;
    trashedInfo: TrashedTerminal;
  }>;
  compact?: boolean;
}

interface GroupedTrashItem {
  type: "single";
  terminal: PanelInstance;
  trashedInfo: TrashedTerminal;
  sortKey: number;
}

interface GroupedTrashGroup {
  type: "group";
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: Array<{
    terminal: PanelInstance;
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
  const [emptyTrashConfirmOpen, setEmptyTrashConfirmOpen] = useState(false);
  const [isScrollable, setIsScrollable] = useState(false);
  const prevLengthRef = useRef(trashedTerminals.length);
  const hintShowCountRef = useRef(0);
  const isExecutingRef = useRef(false);
  const { worktreeMap } = useWorktrees();
  const emptyTrash = usePanelStore((s) => s.emptyTrash);
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
    // The window is the whole point of the announcement: "press this to
    // restore" without it invites someone to come back to a pane that is gone.
    useAnnouncerStore
      .getState()
      .announce(`Panel closed — press ${shortcut} to restore within ${TRASH_TTL_SECONDS} seconds`);
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
        terminals: Array<{ terminal: PanelInstance; trashedInfo: TrashedTerminal }>;
        earliestExpiry: number;
        latestExpiry: number;
      }
    >();
    const singles: Array<{ terminal: PanelInstance; trashedInfo: TrashedTerminal }> = [];

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

  // The footer only earns its space when rows are actually out of sight, so the
  // question is whether the list overflows, not how many items it holds — a
  // count threshold would guess wrong the moment a row grows a second line.
  //
  // Measured from a callback ref rather than an effect alone: Radix mounts the
  // popover's content in a later commit than this component's effects run, so
  // an effect reading the node finds null, records "not scrollable", and never
  // looks again.
  const listNodeRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const measureOverflow = useCallback(() => {
    const node = listNodeRef.current;
    setIsScrollable(!!node && node.scrollHeight > node.clientHeight + 1);
  }, []);

  const listRef = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      listNodeRef.current = node;
      measureOverflow();
      if (!node || typeof ResizeObserver === "undefined") return;
      // The rows are what change height — a late-loading font, a title that
      // wraps — while the capped container sits at its ceiling and never
      // resizes at all.
      const observer = new ResizeObserver(measureOverflow);
      observer.observe(node);
      observerRef.current = observer;
    },
    [measureOverflow]
  );

  // A row expiring out of the list does not resize the capped container, so the
  // observer alone would never notice the overflow ending.
  useEffect(() => {
    if (!isOpen) {
      setIsScrollable(false);
      return;
    }
    measureOverflow();
  }, [isOpen, measureOverflow, trashedTerminals.length]);

  const earliestExpiry = useMemo(() => {
    let earliest = Infinity;
    for (const { trashedInfo } of trashedTerminals) {
      if (trashedInfo.expiresAt < earliest) earliest = trashedInfo.expiresAt;
    }
    return earliest;
  }, [trashedTerminals]);

  // Ticks only while the footer is on screen; an unopened popover holds no timer.
  const nextExpiry = useTrashCountdown(Number.isFinite(earliestExpiry) ? earliestExpiry : 0);
  const nextExpirySeconds = nextExpiry.seconds;

  const trashPreviewTitles = useMemo(() => {
    const titles: string[] = [];
    for (const item of trashedTerminals) {
      const panel = item.terminal;
      const lastObservedTitle = isPtyPanel(panel) ? panel.lastObservedTitle : undefined;
      const title = panel.title || lastObservedTitle;
      titles.push(title || "Untitled");
    }
    return titles;
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
                aria-label={`Trash: ${count} terminal${count === 1 ? "" : "s"}, removed for good ${TRASH_TTL_SECONDS} seconds after closing`}
              >
                <span
                  className={cn("relative", isTrashPulsing && "animate-trash-pulse")}
                  onAnimationEnd={handleTrashAnimationEnd}
                >
                  <Trash2 className="w-3.5 h-3.5 text-daintree-text/60" aria-hidden="true" />
                  {compact && count > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-text-secondary text-3xs font-bold tabular-nums text-text-inverse">
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
          className="w-96 p-0"
          side="top"
          align="end"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => {
            if (emptyTrashConfirmOpen) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (emptyTrashConfirmOpen) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (emptyTrashConfirmOpen) e.preventDefault();
          }}
        >
          <div className="flex flex-col">
            <div className="px-3 py-2 border-b border-divider bg-overlay-subtle flex justify-between items-start gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-text-secondary">Recently closed</span>
                {/* The list is a twenty-second undo buffer, not storage. Saying
                    so once in the header is what stops the trash-can framing
                    promising a durability the surface does not have — the
                    per-row deadline alone never explains the rule. */}
                <span className="text-3xs text-text-muted">
                  Gone for good {TRASH_TTL_SECONDS}s after closing
                </span>
              </div>
              <Button
                variant="ghost-danger"
                size="sm"
                className="shrink-0 text-2xs h-auto py-0.5 px-1.5"
                onClick={() => {
                  // Hand the surface over to the confirm rather than stacking
                  // on top of it: this popover is anchored to the toolbar and
                  // paints above the dialog, where it was clipping the confirm
                  // button of the very action it launched.
                  setIsOpen(false);
                  setEmptyTrashConfirmOpen(true);
                }}
                data-testid="empty-trash-button"
              >
                Empty trash
              </Button>
            </div>

            <div
              ref={listRef}
              // The rows carry `shrink-0`: a flex column compresses its
              // children to fit before it will scroll, which squashed the
              // metadata line under the row's own TTL meter and left
              // scrollHeight === clientHeight, so the overflow footer below
              // never knew there was anything out of sight.
              className="p-1 flex flex-col gap-1 max-h-[300px] overflow-y-auto"
            >
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

            {/* LIFO puts the freshest pane on top, which is the one most likely
                to be wanted back — but it also means the rows nearest their
                deadline are the ones that fall below the fold. Name what is
                down there and when it goes, rather than reordering the list
                out from under the pointer. */}
            {isScrollable && (
              <div
                data-testid="trash-overflow-footer"
                className="flex items-center justify-between gap-2 border-t border-divider px-3 py-1.5 text-3xs text-text-secondary"
              >
                <span className="tabular-nums">{count} closed</span>
                <span className="tabular-nums">Next gone in {nextExpirySeconds}s</span>
              </div>
            )}
          </div>
        </PopoverContent>

        <ConfirmDialog
          isOpen={emptyTrashConfirmOpen}
          onClose={() => {
            setEmptyTrashConfirmOpen(false);
            isExecutingRef.current = false;
          }}
          title="Empty trash?"
          description={`${trashedTerminals.length} panel${trashedTerminals.length === 1 ? "" : "s"} will be permanently removed.`}
          variant="destructive"
          // Scrollable list of the panels being destroyed — a dialog, not an
          // alertdialog, which APG reserves for a brief message read whole.
          hasPreview={trashedTerminals.length > 0}
          confirmLabel="Empty trash"
          onConfirm={() => {
            if (isExecutingRef.current) return;
            isExecutingRef.current = true;
            const ids = trashedTerminals.map((t) => t.terminal.id);
            emptyTrash(ids);
            setEmptyTrashConfirmOpen(false);
            setIsOpen(false);
            isExecutingRef.current = false;
          }}
        >
          <div className="max-h-40 overflow-y-auto">
            <ul className="space-y-0.5 text-xs text-text-secondary">
              {trashPreviewTitles.map((title, i) => (
                <li key={i} className="truncate">
                  {title}
                </li>
              ))}
            </ul>
          </div>
        </ConfirmDialog>
      </Popover>
    </div>
  );
}
