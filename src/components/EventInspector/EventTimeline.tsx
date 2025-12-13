import { useRef, useCallback, useState } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { cn } from "@/lib/utils";
import type { EventRecord, EventCategory } from "@/store/eventStore";
import { Circle } from "lucide-react";
import { Button } from "@/components/ui/button";

const CATEGORY_STYLES: Record<EventCategory, { label: string; color: string }> = {
  system: { label: "SYS", color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  agent: { label: "AGT", color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
  task: { label: "TSK", color: "bg-green-500/20 text-green-400 border-green-500/30" },
  server: { label: "SRV", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  file: { label: "FIL", color: "bg-pink-500/20 text-pink-400 border-pink-500/30" },
  ui: { label: "UI", color: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30" },
  watcher: { label: "WCH", color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" },
  artifact: { label: "ART", color: "bg-rose-500/20 text-rose-400 border-rose-500/30" },
};

interface EventTimelineProps {
  events: EventRecord[];
  selectedId: string | null;
  onSelectEvent: (id: string) => void;
  autoScroll?: boolean;
  onAutoScrollChange?: (autoScroll: boolean) => void;
  className?: string;
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

  const handleAtBottomChange = useCallback(
    (bottom: boolean) => {
      setAtBottom(bottom);
      if (!bottom && autoScroll) {
        onAutoScrollChange?.(false);
      }
    },
    [autoScroll, onAutoScrollChange]
  );

  const scrollToBottom = useCallback(() => {
    onAutoScrollChange?.(true);
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      behavior: "smooth",
    });
  }, [onAutoScrollChange]);

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const seconds = date.getSeconds().toString().padStart(2, "0");
    const ms = date.getMilliseconds().toString().padStart(3, "0");
    return `${hours}:${minutes}:${seconds}.${ms}`;
  };

  const getCategoryStyle = (category: EventCategory) => {
    return (
      CATEGORY_STYLES[category] || {
        label: "???",
        color: "bg-canopy-border/20 text-canopy-text/60 border-canopy-border/30",
      }
    );
  };

  const getPayloadSummary = (event: EventRecord): string => {
    const { payload } = event;
    if (!payload || typeof payload !== "object") return "";

    // Extract relevant IDs for display
    const parts: string[] = [];
    if (payload.worktreeId) parts.push(`worktree: ${String(payload.worktreeId).substring(0, 8)}`);
    if (payload.agentId) parts.push(`agent: ${String(payload.agentId).substring(0, 8)}`);
    if (payload.taskId) parts.push(`task: ${String(payload.taskId).substring(0, 8)}`);
    if (payload.runId) parts.push(`run: ${String(payload.runId).substring(0, 8)}`);
    if (payload.terminalId) parts.push(`terminal: ${String(payload.terminalId).substring(0, 8)}`);

    return parts.length > 0 ? parts.join(" • ") : "";
  };

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

  const renderEvent = (_index: number, event: EventRecord) => {
    const categoryStyle = getCategoryStyle(event.category);
    const isSelected = event.id === selectedId;
    const summary = getPayloadSummary(event);

    return (
      <button
        key={event.id}
        onClick={() => onSelectEvent(event.id)}
        className={cn(
          "w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors",
          "border-l-2 border-transparent",
          isSelected && "bg-muted border-l-primary"
        )}
      >
        <div className="flex items-start gap-2">
          <span
            className={cn(
              "flex-shrink-0 inline-flex items-center justify-center w-8 px-1 py-0.5 rounded text-[11px] font-medium border",
              categoryStyle.color
            )}
            title={event.category}
          >
            {categoryStyle.label}
          </span>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {formatTimestamp(event.timestamp)}
              </span>
              <span className="text-xs font-mono text-foreground truncate">{event.type}</span>
            </div>
            {summary && (
              <p className="text-xs text-muted-foreground font-mono truncate">{summary}</p>
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className={cn("flex-1 relative", className)}>
      <Virtuoso
        ref={virtuosoRef}
        data={events}
        followOutput={autoScroll ? "smooth" : false}
        atBottomStateChange={handleAtBottomChange}
        itemContent={renderEvent}
        className="h-full"
      />

      {!atBottom && events.length > 0 && (
        <Button
          variant="info"
          size="sm"
          className="absolute bottom-4 right-4 rounded-full shadow-lg"
          onClick={scrollToBottom}
        >
          Scroll to bottom
        </Button>
      )}
    </div>
  );
}
