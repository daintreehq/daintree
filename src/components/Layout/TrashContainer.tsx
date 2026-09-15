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
import { TRASH_TTL_SECONDS, useTrashCountdown, type TrashRemovalRequest } from "./trashCountdown";
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
  /**
   * Called when the last entry expires while the keyboard was inside this
   * surface. Both the popover and the trigger unmount at that moment, so there
   * is no destination left in here to hand focus to — only the dock that owns
   * the row this control sits in.
   */
  onFocusHandoff?: () => void;
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

export function TrashContainer({
  trashedTerminals,
  compact = false,
  onFocusHandoff,
}: TrashContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isTrashPulsing, setIsTrashPulsing] = useState(false);
  const [showMovedHint, setShowMovedHint] = useState(false);
  const [emptyTrashConfirmOpen, setEmptyTrashConfirmOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<TrashRemovalRequest | null>(null);
  const [isScrollable, setIsScrollable] = useState(false);
  const prevLengthRef = useRef(trashedTerminals.length);
  const hintShowCountRef = useRef(0);
  const isExecutingRef = useRef(false);
  const { worktreeMap } = useWorktrees();
  const emptyTrash = usePanelStore((s) => s.emptyTrash);
  const removePanel = usePanelStore((s) => s.removePanel);
  // Only show the ghost pill for panel drags — worktree-card sort drags also flip
  // isDragging but cannot drop on trash, and a phantom drop target is misleading.
  const isDragging = useIsDragging();
  const isWorktreeSortDragging = useIsWorktreeSortDragging();
  const isPanelDragging = isDragging && !isWorktreeSortDragging;
  const { setNodeRef, isOver } = useDroppable({ id: TRASH_DROPPABLE_ID });

  // What was in the trash last render, and when each entry was due. The
  // container is the only place that sees an entry leave, and the deadline it
  // left with is what says whether it expired or the user acted on it.
  const prevEntriesRef = useRef(new Map<string, number>());

  // Ids the user has just confirmed away, so their departure is not mistaken
  // for an expiry. The confirm is the feedback for those; an announcement on
  // top would be a second one.
  const confirmedRemovalsRef = useRef(new Set<string>());

  // Expiry is the one departure nobody asked for, and it is the one that has to
  // be said out loud — a restore and a manual removal are each their own
  // feedback, and a falling count cannot tell the three apart. Proximity to the
  // deadline is not the discriminator either: a rescue with 600ms to spare
  // would be announced as a permanent loss, which is the worst possible thing
  // to say to someone who just saved their work.
  useEffect(() => {
    const next = new Map(trashedTerminals.map((t) => [t.terminal.id, t.trashedInfo.expiresAt]));
    const previous = prevEntriesRef.current;
    prevEntriesRef.current = next;

    // Read, don't subscribe: this component already re-renders on every trash
    // change, and watching the whole panel registry would wake it on every
    // unrelated one.
    const panels = usePanelStore.getState().panelsById;
    const confirmed = confirmedRemovalsRef.current;

    const now = Date.now();
    let expired = 0;
    for (const [id, expiresAt] of previous) {
      if (next.has(id)) continue;
      if (confirmed.delete(id)) continue; // the user removed it, and saw it happen
      if (panels[id]) continue; // still a panel, so it was restored, not destroyed
      // And it has to have actually run out. Proximity alone is not enough —
      // a rescue with 600ms to spare clears the first two tests and would
      // otherwise be announced as a permanent loss — but nor is absence: a pane
      // that left well short of its deadline went some other way.
      if (expiresAt - now > 1000) continue;
      expired += 1;
    }
    if (expired === 0) return;
    useAnnouncerStore
      .getState()
      .announce(
        expired === 1
          ? "A closed panel expired and was removed permanently"
          : `${expired} closed panels expired and were removed permanently`
      );
  }, [trashedTerminals]);

  // Which row owns focus, so a row expiring under the keyboard has somewhere to
  // hand it to. Radix declines auto-focus on this popover, so without this a
  // focused Restore button unmounting drops focus on document.body — exactly
  // when the remaining opportunities are shortest.
  const focusedRowRef = useRef<{ id: string; index: number } | null>(null);

  // Whether the keyboard is anywhere in this control at all. The row ref only
  // knows about rows, so opening from the pill and tabbing no further than
  // Empty trash would leave it null — and the handoff below would then skip
  // someone who is very much standing here.
  const hasFocusRef = useRef(false);
  const noteFocusEntered = useCallback(() => {
    hasFocusRef.current = true;
  }, []);

  // Removing a trashed pane ends it for good, and Restore is the inverse of
  // *closing* a pane, not of destroying one — so this is a D1 action and takes
  // a confirm. The dialog is owned here rather than by the row because the
  // popover is anchored to the toolbar and paints over anything opened beneath
  // it; the popover steps aside, which it cannot do while hosting the dialog.
  const requestRemoval = useCallback((request: TrashRemovalRequest) => {
    setIsOpen(false);
    setPendingRemoval(request);
  }, []);

  // Reopen where they were: the popover only closed to get out of the dialog's
  // way, and a cancelled removal that also loses your place is two losses.
  const closeRemoval = useCallback(() => {
    setPendingRemoval(null);
    setIsOpen(true);
  }, []);

  const handleListFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    hasFocusRef.current = true;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
    const list = event.currentTarget;
    if (!row) {
      focusedRowRef.current = null;
      return;
    }
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-row-id]"));
    focusedRowRef.current = { id: row.dataset.rowId ?? "", index: rows.indexOf(row) };
  }, []);

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

  // A confirm for a panel that has since expired is asking about something that
  // no longer exists, and it sits over the rows that are still recoverable.
  useEffect(() => {
    if (!pendingRemoval) return;
    const alive = new Set(trashedTerminals.map((t) => t.terminal.id));
    if (pendingRemoval.ids.some((id) => alive.has(id))) return;
    closeRemoval();
  }, [pendingRemoval, trashedTerminals, closeRemoval]);

  // The last row going takes the whole control with it, so the handoff has to
  // leave the component. Fires once per emptying, and only if focus actually
  // ended up on the body — a restore moves it somewhere real on purpose.
  const handedOffRef = useRef(false);
  useEffect(() => {
    if (trashedTerminals.length > 0) {
      handedOffRef.current = false;
      return;
    }
    if (!hasFocusRef.current || handedOffRef.current) return;
    focusedRowRef.current = null;
    hasFocusRef.current = false;
    handedOffRef.current = true;
    if (document.activeElement && document.activeElement !== document.body) return;
    onFocusHandoff?.();
  }, [trashedTerminals.length, onFocusHandoff]);

  // Hand focus on when the row holding it disappears. Only when focus actually
  // fell on the body: a restore moves focus deliberately, and stealing it back
  // would fight the user.
  useEffect(() => {
    const focused = focusedRowRef.current;
    const list = listNodeRef.current;
    if (!isOpen || !focused || !list) return;
    if (list.querySelector(`[data-row-id="${CSS.escape(focused.id)}"]`)) return;

    focusedRowRef.current = null;
    // Anywhere real, not just anywhere in the list: focus may have moved on
    // purpose to the header's Empty trash button, or out to the pane a restore
    // just brought back, and pulling it into a surviving row fights the user.
    const active = document.activeElement;
    if (active && active !== document.body) return;

    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-row-id]"));
    // The row that slid into the vacated position, else the last one left.
    const heir = rows[Math.min(focused.index, rows.length - 1)];
    heir?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, [isOpen, trashedTerminals]);

  const earliestExpiry = useMemo(() => {
    let earliest = Infinity;
    for (const { trashedInfo } of trashedTerminals) {
      if (trashedInfo.expiresAt < earliest) earliest = trashedInfo.expiresAt;
    }
    return earliest;
  }, [trashedTerminals]);

  // Ticks only while the footer is actually on screen. A closed popover, or an
  // open one whose list fits, has nothing to count for.
  const nextExpiry = useTrashCountdown(
    Number.isFinite(earliestExpiry) ? earliestExpiry : 0,
    isOpen && isScrollable
  );
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
    <div ref={setNodeRef} onFocusCapture={noteFocusEntered} className="shrink-0">
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
          onFocusCapture={noteFocusEntered}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col">
            <div className="px-3 py-2 border-b border-divider bg-surface-canvas/50 flex justify-between items-start gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-text-secondary">Recently closed</span>
                {/* The list is a twenty-second undo buffer, not storage. Saying
                    so once in the header is what stops the trash-can framing
                    promising a durability the surface does not have — the
                    per-row deadline alone never explains the rule. */}
                <span className="text-3xs text-text-secondary">
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
              onFocusCapture={handleListFocus}
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
                      onRequestRemove={requestRemoval}
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
                      onRequestRemove={requestRemoval}
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
          isOpen={pendingRemoval !== null}
          onClose={closeRemoval}
          title={`Remove ${pendingRemoval?.label ?? ""}?`}
          description={
            (pendingRemoval?.ids.length ?? 0) === 1
              ? `${pendingRemoval?.label ?? "This panel"} will be permanently removed.`
              : `${pendingRemoval?.ids.length ?? 0} panels will be permanently removed.`
          }
          variant="destructive"
          hasPreview={(pendingRemoval?.panelTitles.length ?? 0) > 0}
          confirmLabel={(pendingRemoval?.ids.length ?? 0) === 1 ? "Remove panel" : "Remove panels"}
          onConfirm={() => {
            for (const id of pendingRemoval?.ids ?? []) {
              confirmedRemovalsRef.current.add(id);
              removePanel(id);
            }
            closeRemoval();
          }}
        >
          {(pendingRemoval?.panelTitles.length ?? 0) > 0 && (
            <div className="max-h-40 overflow-y-auto">
              <ul className="space-y-0.5 text-xs text-text-secondary">
                {(pendingRemoval?.panelTitles ?? []).map((title, i) => (
                  <li key={i} className="truncate">
                    {title}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ConfirmDialog>

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
