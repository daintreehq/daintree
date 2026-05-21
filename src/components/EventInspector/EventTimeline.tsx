import { useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { cn } from "@/lib/utils";
import type { EventRecord, EventCategory } from "@/store/eventStore";
import { Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EVENT_CATEGORY_STYLES } from "@/config/categoryColors";

interface EventTimelineProps {
  events: EventRecord[];
  selectedId: string | null;
  onSelectEvent: (id: string) => void;
  autoScroll?: boolean;
  onAutoScrollChange?: (autoScroll: boolean) => void;
  className?: string;
}

interface CategoryStyle {
  label: string;
  color: string;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

function getCategoryStyle(category: EventCategory): CategoryStyle {
  const style = EVENT_CATEGORY_STYLES[category];
  if (!style) {
    return {
      label: "???",
      color: "bg-daintree-border/20 text-daintree-text/60 border-daintree-border/30",
    };
  }
  return { label: style.shortLabel, color: style.color };
}

function getPayloadSummary(event: EventRecord): string {
  const { payload } = event;
  if (!payload || typeof payload !== "object") return "";

  const parts: string[] = [];
  if (payload.worktreeId) parts.push(`worktree: ${String(payload.worktreeId).substring(0, 8)}`);
  if (payload.agentId) parts.push(`agent: ${String(payload.agentId).substring(0, 8)}`);
  if (payload.runId) parts.push(`run: ${String(payload.runId).substring(0, 8)}`);
  if (payload.terminalId) parts.push(`terminal: ${String(payload.terminalId).substring(0, 8)}`);

  return parts.length > 0 ? parts.join(" • ") : "";
}

interface EventRowProps {
  event: EventRecord;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function EventRow({ event, isSelected, onSelect }: EventRowProps) {
  const categoryStyle = getCategoryStyle(event.category);
  const summary = getPayloadSummary(event);
  const handleClick = useCallback(() => onSelect(event.id), [onSelect, event.id]);

  return (
    <button
      onClick={handleClick}
      className={cn(
        "w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors",
        "border-l-2 border-transparent",
        isSelected && "bg-muted border-l-primary"
      )}
    >
      <div className="flex items-start gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "flex-shrink-0 inline-flex items-center justify-center w-8 px-1 py-0.5 rounded text-[11px] font-medium border",
                categoryStyle.color
              )}
            >
              {categoryStyle.label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{event.category}</TooltipContent>
        </Tooltip>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {formatTimestamp(event.timestamp)}
            </span>
            <span className="text-xs font-mono text-foreground truncate">{event.type}</span>
          </div>
          {summary && <p className="text-xs text-muted-foreground font-mono truncate">{summary}</p>}
        </div>
      </div>
    </button>
  );
}

export function EventTimeline({
  events,
  selectedId,
  onSelectEvent,
  autoScroll = true,
  onAutoScrollChange,
  className,
}: EventTimelineProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const pauseBoundaryTsRef = useRef<number | undefined>(undefined);

  const handleAtBottomChange = useCallback(
    (bottom: boolean) => {
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
      behavior: "smooth",
    });
  }, [onAutoScrollChange]);

  if (events.length === 0) {
    return (
      <div
        className={cn(
          "flex-1 flex items-center justify-center text-sm text-muted-foreground",
          className
        )}
      >
        <div className="text-center space-y-2">
          <Circle className="w-8 h-8 mx-auto opacity-30" />
          <p>No events captured yet</p>
          <p className="text-xs">Events will appear here as they occur</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex-1 relative", className)}>
      <Virtuoso
        ref={virtuosoRef}
        data={events}
        computeItemKey={(_index, event) => event.id}
        followOutput={autoScroll ? "smooth" : false}
        atBottomStateChange={handleAtBottomChange}
        itemContent={(_index, event) => (
          <EventRow event={event} isSelected={event.id === selectedId} onSelect={onSelectEvent} />
        )}
        role="log"
        aria-label="Event timeline"
        aria-live="off"
        className="h-full"
      />

      {!atBottom && events.length > 0 && (
        <Button
          variant="info"
          size="sm"
          className="absolute bottom-4 right-4 rounded-full shadow-[var(--theme-shadow-floating)] tabular-nums"
          onClick={scrollToBottom}
          aria-label={newCount > 0 ? `Resume tail, ${newCount} new` : "Scroll to bottom"}
        >
          {newCount > 0 ? `↓ ${newCount} new` : "Scroll to bottom"}
        </Button>
      )}
    </div>
  );
}
