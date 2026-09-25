import { useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { cn } from "@/lib/utils";
import type { EventRecord, EventCategory } from "@/store/eventStore";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { EVENT_CATEGORY_STYLES } from "@/config/categoryColors";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";

interface EventTimelineProps {
  events: EventRecord[];
  selectedId: string | null;
  onSelectEvent: (id: string) => void;
  autoScroll?: boolean;
  onAutoScrollChange?: (autoScroll: boolean) => void;
  /** Events before filtering — tells "nothing captured" apart from "nothing matches". */
  totalCount?: number;
  onClearFilters?: () => void;
  className?: string;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

const CATEGORY_DOT: Record<EventCategory, string> = {
  system: "bg-cat-blue",
  agent: "bg-cat-green",
  server: "bg-cat-orange",
  file: "bg-cat-pink",
  ui: "bg-cat-indigo",
  watcher: "bg-cat-cyan",
  artifact: "bg-cat-rose",
};

function getPayloadSummary(event: EventRecord): string {
  const { payload } = event;
  if (!payload || typeof payload !== "object") return "";

  const parts: string[] = [];
  // Whole ids: the row truncates with an ellipsis, and a hard cut mid-id reads
  // as a different, shorter id.
  if (payload.worktreeId) parts.push(`worktree: ${String(payload.worktreeId)}`);
  if (payload.agentId) parts.push(`agent: ${String(payload.agentId)}`);
  if (payload.runId) parts.push(`run: ${String(payload.runId)}`);
  if (payload.terminalId) parts.push(`terminal: ${String(payload.terminalId)}`);

  return parts.length > 0 ? parts.join(" • ") : "";
}

interface EventRowProps {
  event: EventRecord;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function EventRow({ event, isSelected, onSelect }: EventRowProps) {
  const category = EVENT_CATEGORY_STYLES[event.category];
  const summary = getPayloadSummary(event);
  const handleClick = useCallback(() => onSelect(event.id), [onSelect, event.id]);

  return (
    <button
      type="button"
      onClick={handleClick}
      // A list-detail row, not a listbox option: `aria-current` for AT and
      // `data-selected` for the shared selected-row treatment (fill + rail).
      aria-current={isSelected ? "true" : undefined}
      data-selected={isSelected ? "true" : undefined}
      className={cn(
        PALETTE_ROW_CLASS,
        "flex w-full items-center gap-2 px-3 py-1 text-left text-xs",
        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        !isSelected && "hover:bg-overlay-subtle"
      )}
    >
      <span className="flex w-16 shrink-0 items-center gap-1.5 text-2xs text-text-secondary">
        <span
          aria-hidden="true"
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            CATEGORY_DOT[event.category] ?? "bg-text-secondary"
          )}
        />
        {category?.label ?? event.category}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-text-secondary">
        {formatTimestamp(event.timestamp)}
      </span>
      <span className="shrink-0 truncate font-mono text-text-primary">{event.type}</span>
      {summary ? (
        <span className="min-w-0 truncate font-mono text-text-secondary">{summary}</span>
      ) : null}
    </button>
  );
}

export function EventTimeline({
  events,
  selectedId,
  onSelectEvent,
  autoScroll = true,
  onAutoScrollChange,
  totalCount,
  onClearFilters,
  className,
}: EventTimelineProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const pauseBoundaryTsRef = useRef<number | undefined>(undefined);

  // Ignore the "not at bottom" Virtuoso reports during its first layout, before
  // the initial scroll to the tail lands — it isn't the user scrolling away.
  const reachedBottomRef = useRef(false);
  // The list unmounts while nothing matches; a remount lays out afresh.
  const listMounted = events.length > 0;
  useEffect(() => {
    if (!listMounted) reachedBottomRef.current = false;
  }, [listMounted]);
  const handleAtBottomChange = useCallback(
    (bottom: boolean) => {
      if (bottom) reachedBottomRef.current = true;
      else if (!reachedBottomRef.current) return;
      setAtBottom(bottom);
      if (bottom) {
        setNewCount(0);
        pauseBoundaryTsRef.current = undefined;
      } else {
        pauseBoundaryTsRef.current = events[events.length - 1]?.timestamp;
        if (autoScroll) onAutoScrollChange?.(false);
      }
    },
    [autoScroll, onAutoScrollChange, events]
  );

  useEffect(() => {
    if (atBottom) return;
    const boundaryTs = pauseBoundaryTsRef.current;
    if (boundaryTs === undefined) {
      setNewCount(0);
      return;
    }
    let count = 0;
    for (const event of events) {
      if (event.timestamp > boundaryTs) count++;
    }
    setNewCount(count);
  }, [events, atBottom]);

  const scrollToBottom = useCallback(() => {
    onAutoScrollChange?.(true);
    setNewCount(0);
    pauseBoundaryTsRef.current = undefined;
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [onAutoScrollChange]);

  if (events.length === 0) {
    const filteredOut = (totalCount ?? 0) > 0;
    return (
      <div className={cn("flex flex-1 items-center justify-center", className)}>
        {filteredOut ? (
          <EmptyState
            variant="filtered-empty"
            scale="sidebar"
            title="No events match filters"
            action={
              onClearFilters ? (
                <Button variant="subtle" size="xs" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState variant="zero-data" scale="sidebar" title="No events captured yet" />
        )}
      </div>
    );
  }

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <Virtuoso
        ref={virtuosoRef}
        data={events}
        computeItemKey={(_index, event) => event.id}
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        followOutput={
          autoScroll
            ? (isAtBottom) => (isAtBottom ? (prefersReducedMotion() ? "auto" : "smooth") : false)
            : false
        }
        atBottomStateChange={handleAtBottomChange}
        itemContent={(_index, event) => (
          <EventRow event={event} isSelected={event.id === selectedId} onSelect={onSelectEvent} />
        )}
        role="log"
        aria-label="Event timeline"
        aria-live="off"
        className="absolute inset-0"
      />

      {!atBottom && events.length > 0 && (
        <Button
          variant="pill"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 tabular-nums shadow-[var(--theme-shadow-floating)]"
          onClick={scrollToBottom}
          aria-label={newCount > 0 ? `${newCount} new, resume tail` : undefined}
        >
          <ArrowDown />
          {newCount > 0 ? `${newCount} new` : "Jump to latest"}
        </Button>
      )}
    </div>
  );
}
