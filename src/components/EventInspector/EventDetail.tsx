import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useEventStore, type EventRecord, type EventFilterOptions } from "@/store/eventStore";
import { Copy, Check, ChevronDown, ChevronRight, Filter, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface EventDetailProps {
  event: EventRecord | null;
  className?: string;
}

interface ContextPillProps {
  label: string;
  value: string | number;
  filterKey: keyof EventFilterOptions;
  currentFilters: EventFilterOptions;
  onToggle: (key: keyof EventFilterOptions, value: string | number) => void;
}

function ContextPill({ label, value, filterKey, currentFilters, onToggle }: ContextPillProps) {
  const strValue = String(value);
  const isActive = currentFilters[filterKey] === value;

  return (
    <div className="grid grid-cols-[100px_1fr] gap-2 items-center">
      <span className="text-muted-foreground">{label}:</span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggle(filterKey, value);
              }}
              className={cn(
                "group flex items-center gap-2 px-2 py-1 rounded text-xs font-mono text-left w-fit transition-all max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
                  : "hover:bg-muted border border-transparent hover:border-border text-foreground"
              )}
              aria-pressed={isActive}
            >
              <span className="truncate">{strValue}</span>
              {isActive ? (
                <X className="w-3 h-3 flex-shrink-0 opacity-70" />
              ) : (
                <Filter className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-30" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isActive ? "Click to clear filter" : `Filter by ${label}`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function EventDetail({ event, className }: EventDetailProps) {
  const filters = useEventStore((state) => state.filters);
  const setFilters = useEventStore((state) => state.setFilters);
  const [copied, setCopied] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["payload"]));
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleContextToggle = (key: keyof EventFilterOptions, value: string | number) => {
    const newValue = filters[key] === value ? undefined : value;
    setFilters({ [key]: newValue });
  };

  useEffect(() => {
    setCopied(false);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
  }, [event]);

  if (!event) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-sm text-muted-foreground h-full",
          className
        )}
      >
        <p>Select an event to view details</p>
      </div>
    );
  }

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const copyPayload = async () => {
    try {
      const payloadStr = JSON.stringify(event.payload, null, 2);
      await navigator.clipboard.writeText(payloadStr);
      setCopied(true);

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      console.error("Failed to copy payload:", err);
    }
  };

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toISOString();
  };

  const getTimeSince = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 1000) return `${diff}ms ago`;
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  };

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      <div className="flex-shrink-0 p-4 border-b">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0 space-y-1">
            <h3 className="font-mono text-sm font-semibold truncate">{event.type}</h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{formatTimestamp(event.timestamp)}</span>
              <span>•</span>
              <span>{getTimeSince(event.timestamp)}</span>
              <span>•</span>
              <span className="capitalize">{event.source}</span>
            </div>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={copyPayload}
                  className="flex-shrink-0 p-2 hover:bg-muted rounded transition-colors"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-500" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy payload</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="flex-shrink-0 border-b">
        <button
          onClick={() => toggleSection("metadata")}
          className="w-full px-4 py-2 flex items-center gap-2 hover:bg-muted/50 transition-colors"
        >
          {expandedSections.has("metadata") ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <span className="text-sm font-medium">Metadata</span>
        </button>
        {expandedSections.has("metadata") && (
          <div className="px-4 pb-3 space-y-2 text-sm">
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <span className="text-muted-foreground">Event ID:</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-mono text-xs truncate">{event.id}</span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{event.id}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <span className="text-muted-foreground">Type:</span>
              <span className="font-mono text-xs">{event.type}</span>
            </div>
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <span className="text-muted-foreground">Source:</span>
              <span className="font-mono text-xs capitalize">{event.source}</span>
            </div>
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <span className="text-muted-foreground">Timestamp:</span>
              <span className="font-mono text-xs">{event.timestamp}</span>
            </div>
            {event.payload?.traceId && (
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <span className="text-muted-foreground">Trace ID:</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono text-xs truncate">{event.payload.traceId}</span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{event.payload.traceId}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col border-b">
        <button
          onClick={() => toggleSection("payload")}
          className="flex-shrink-0 px-4 py-2 flex items-center gap-2 hover:bg-muted/50 transition-colors"
        >
          {expandedSections.has("payload") ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <span className="text-sm font-medium">Payload</span>
        </button>
        {expandedSections.has("payload") && (
          <div className="flex-1 overflow-auto px-4 pb-3">
            <pre className="text-xs font-mono bg-muted/50 p-3 rounded overflow-x-auto">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {event.payload &&
        (event.payload.worktreeId ||
          event.payload.agentId ||
          event.payload.taskId ||
          event.payload.runId ||
          event.payload.terminalId ||
          event.payload.issueNumber ||
          event.payload.prNumber) && (
          <div className="flex-shrink-0">
            <button
              onClick={() => toggleSection("context")}
              className="w-full px-4 py-2 flex items-center gap-2 hover:bg-muted/50 transition-colors"
            >
              {expandedSections.has("context") ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span className="text-sm font-medium">Context</span>
            </button>
            {expandedSections.has("context") && (
              <div className="px-4 pb-3 space-y-1.5 text-sm">
                {event.payload.worktreeId !== undefined && (
                  <ContextPill
                    label="Worktree"
                    value={event.payload.worktreeId}
                    filterKey="worktreeId"
                    currentFilters={filters}
                    onToggle={handleContextToggle}
                  />
                )}
                {event.payload.agentId !== undefined && (
                  <ContextPill
                    label="Agent"
                    value={event.payload.agentId}
                    filterKey="agentId"
                    currentFilters={filters}
                    onToggle={handleContextToggle}
                  />
                )}
                {event.payload.taskId !== undefined && (
                  <ContextPill
                    label="Task"
                    value={event.payload.taskId}
                    filterKey="taskId"
                    currentFilters={filters}
                    onToggle={handleContextToggle}
                  />
                )}
                {event.payload.runId !== undefined && (
                  <ContextPill
                    label="Run"
                    value={event.payload.runId}
                    filterKey="runId"
                    currentFilters={filters}
                    onToggle={handleContextToggle}
                  />
                )}
                {event.payload.terminalId !== undefined && (
                  <ContextPill
                    label="Terminal"
                    value={event.payload.terminalId}
                    filterKey="terminalId"
                    currentFilters={filters}
                    onToggle={handleContextToggle}
                  />
                )}
                {event.payload.issueNumber !== undefined && (
                  <ContextPill
                    label="Issue #"
                    value={event.payload.issueNumber}
                    filterKey="issueNumber"
                    currentFilters={filters}
                    onToggle={handleContextToggle}
                  />
                )}
                {event.payload.prNumber !== undefined && (
                  <ContextPill
                    label="PR #"
                    value={event.payload.prNumber}
                    filterKey="prNumber"
                    currentFilters={filters}
                    onToggle={handleContextToggle}
                  />
                )}
              </div>
            )}
          </div>
        )}
    </div>
  );
}
