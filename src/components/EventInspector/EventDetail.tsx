import { useState, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { useEventStore, type EventRecord, type EventFilterOptions } from "@/store/eventStore";
import { Copy, Check, ChevronDown, ChevronRight, Filter, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { logError } from "@/utils/logger";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { sanitizeErrorText } from "@/utils/errorText";

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
      <span className="text-text-secondary">{label}:</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(filterKey, value);
            }}
            className={cn(
              "group flex items-center gap-2 px-2 py-1 rounded-[var(--radius-sm)] text-xs font-mono text-left w-fit transition max-w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
              isActive
                ? "bg-overlay-medium text-text-primary border border-border-strong hover:bg-overlay-strong"
                : "hover:bg-overlay-soft border border-transparent hover:border-border-default text-text-primary"
            )}
            aria-pressed={isActive}
          >
            <span className="truncate">{strValue}</span>
            {isActive ? (
              <X className="w-3 h-3 flex-shrink-0 text-text-secondary" />
            ) : (
              <Filter className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-30" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isActive ? "Click to clear filter" : `Filter by ${label}`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function EventDetail({ event, className }: EventDetailProps) {
  const filters = useEventStore((state) => state.filters);
  const setFilters = useEventStore((state) => state.setFilters);
  const [copied, setCopied] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["payload"]));
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleContextToggle = (key: keyof EventFilterOptions, value: string | number) => {
    const newValue = filters[key] === value ? undefined : value;
    setFilters({ [key]: newValue });
  };

  const formattedPayload = useMemo(
    () => (event ? JSON.stringify(event.payload, null, 2) : ""),
    [event]
  );

  useEffect(() => {
    setCopied(false);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
  }, [event]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  if (!event) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-xs text-text-secondary h-full",
          className
        )}
      >
        <p>Select an event to see its payload</p>
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
      await navigator.clipboard.writeText(sanitizeErrorText(formattedPayload));
      setCopied(true);
      useAnnouncerStore.getState().announce("Payload copied");

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      logError("Failed to copy payload", err);
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
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <div className="flex-shrink-0 px-3 py-2 border-b border-divider">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0 space-y-1">
            <h3 className="font-mono text-xs font-semibold text-text-primary truncate">
              {event.type}
            </h3>
            <div className="flex items-center gap-2 text-2xs text-text-secondary">
              <span className="font-mono">{formatTimestamp(event.timestamp)}</span>
              <span>•</span>
              <span>{getTimeSince(event.timestamp)}</span>
              <span>•</span>
              <span className="capitalize">{event.source}</span>
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={copyPayload}
                aria-label="Copy payload"
                className="flex-shrink-0 p-1.5 text-text-secondary hover:bg-overlay-soft hover:text-text-primary rounded-[var(--radius-md)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-status-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Copy payload</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex-shrink-0 border-b border-divider">
        <button
          onClick={() => toggleSection("metadata")}
          aria-expanded={expandedSections.has("metadata")}
          className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-overlay-subtle transition-colors text-text-primary"
        >
          {expandedSections.has("metadata") ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <span className="text-xs font-medium">Metadata</span>
        </button>
        {expandedSections.has("metadata") && (
          <div className="px-3 pb-2.5 space-y-1.5 text-xs">
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <span className="text-text-secondary">Event ID:</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="font-mono text-xs truncate">{event.id}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{event.id}</TooltipContent>
              </Tooltip>
            </div>
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <span className="text-text-secondary">Type:</span>
              <span className="font-mono text-xs">{event.type}</span>
            </div>
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <span className="text-text-secondary">Source:</span>
              <span className="font-mono text-xs capitalize">{event.source}</span>
            </div>
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <span className="text-text-secondary">Timestamp:</span>
              <span className="font-mono text-xs">{event.timestamp}</span>
            </div>
            {event.payload?.traceId && (
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <span className="text-text-secondary">Trace ID:</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-mono text-xs truncate">{event.payload.traceId}</span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{event.payload.traceId}</TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col border-b border-divider">
        <button
          onClick={() => toggleSection("payload")}
          aria-expanded={expandedSections.has("payload")}
          className="flex-shrink-0 px-3 py-1.5 flex items-center gap-2 hover:bg-overlay-subtle transition-colors text-text-primary"
        >
          {expandedSections.has("payload") ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <span className="text-xs font-medium">Payload</span>
        </button>
        {expandedSections.has("payload") && (
          <div className="flex-1 min-h-0 overflow-auto px-3 pb-2.5">
            <pre className="text-xs font-mono text-text-primary bg-surface-canvas border border-divider p-2.5 rounded-[var(--radius-md)] overflow-x-auto select-text">
              {formattedPayload}
            </pre>
          </div>
        )}
      </div>

      {event.payload &&
        (event.payload.worktreeId ||
          event.payload.agentId ||
          event.payload.runId ||
          event.payload.terminalId ||
          event.payload.issueNumber ||
          event.payload.prNumber) && (
          <div className="flex-shrink-0">
            <button
              onClick={() => toggleSection("context")}
              aria-expanded={expandedSections.has("context")}
              className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-overlay-subtle transition-colors text-text-primary"
            >
              {expandedSections.has("context") ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              <span className="text-xs font-medium">Context</span>
            </button>
            {expandedSections.has("context") && (
              <div className="px-3 pb-2.5 space-y-1.5 text-xs">
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
