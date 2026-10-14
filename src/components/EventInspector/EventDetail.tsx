import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useEventStore, type EventRecord, type EventFilterOptions } from "@/store/eventStore";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/ui/CopyButton";
import { FilterChip } from "@/components/ui/FilterChip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { sanitizeErrorText } from "@/utils/errorText";

interface EventDetailProps {
  event: EventRecord | null;
  /** False when there is nothing to select yet, so the pane doesn't ask for a selection. */
  hasEvents?: boolean;
  className?: string;
}

interface ContextPillProps {
  label: string;
  /** Lowercase name for the hint: "Filter by {noun}", "Clear {noun} filter". */
  noun: string;
  value: string | number;
  filterKey: keyof EventFilterOptions;
  currentFilters: EventFilterOptions;
  onToggle: (key: keyof EventFilterOptions, value: string | number) => void;
}

function ContextPill({
  label,
  noun,
  value,
  filterKey,
  currentFilters,
  onToggle,
}: ContextPillProps) {
  const strValue = String(value);
  const isActive = currentFilters[filterKey] === value;
  const { ref: labelRef, isTruncated } = useTruncationDetection();

  return (
    <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-2 items-center">
      <span className="text-text-secondary">{label}:</span>
      {/* The plugin kit's chip disclosure: a clipped id shows in full above
          the hint, and the tooltip then stays while it is being read. */}
      <Tooltip autoDismiss={!isTruncated}>
        <TooltipTrigger asChild>
          <FilterChip
            selected={isActive}
            labelRef={labelRef}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(filterKey, value);
            }}
            className="w-fit max-w-full"
          >
            {strValue}
          </FilterChip>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isTruncated ? <div className="font-mono break-all">{strValue}</div> : null}
          <div className={isTruncated ? "text-text-secondary" : undefined}>
            {isActive ? `Clear ${noun} filter` : `Filter by ${noun}`}
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function EventDetail({ event, hasEvents = true, className }: EventDetailProps) {
  const filters = useEventStore((state) => state.filters);
  const setFilters = useEventStore((state) => state.setFilters);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["payload"]));

  const handleContextToggle = (key: keyof EventFilterOptions, value: string | number) => {
    const newValue = filters[key] === value ? undefined : value;
    setFilters({ [key]: newValue });
  };

  const formattedPayload = useMemo(
    () => (event ? JSON.stringify(event.payload, null, 2) : ""),
    [event]
  );

  if (!event) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-xs text-text-secondary h-full",
          className
        )}
      >
        <p>{hasEvents ? "Select an event to see its payload" : "Nothing to inspect yet"}</p>
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

  // Local time, matching the timeline row; the ISO string stays in the tooltip.
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((n) => n.toString().padStart(2, "0"))
      .join(":");
    return `${date.toLocaleDateString()} ${time}.${date.getMilliseconds().toString().padStart(3, "0")}`;
  };

  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <div className="@container/event-header flex-shrink-0 px-3 py-2 border-b border-divider space-y-1">
        <div className="flex items-center justify-between gap-3">
          <TruncatedTooltip
            content={<span className="font-mono break-all">{event.type}</span>}
            side="bottom"
            align="start"
          >
            <h3 className="min-w-0 truncate rounded-[var(--radius-sm)] font-mono text-xs font-semibold text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary">
              {event.type}
            </h3>
          </TruncatedTooltip>
          {/* Keyed by event: identical payloads on two events should not carry
              one's confirmation onto the other. Icon-only once the pane is
              too narrow to spare the label from the event name. */}
          <CopyButton
            key={`${event.id}-label`}
            label="Copy JSON"
            aria-label="Copy payload JSON"
            text={sanitizeErrorText(formattedPayload)}
            announcement="Payload copied"
            className="@max-[360px]/event-header:hidden"
          />
          <CopyButton
            key={`${event.id}-icon`}
            aria-label="Copy payload JSON"
            text={sanitizeErrorText(formattedPayload)}
            announcement="Payload copied"
            className="hidden @max-[360px]/event-header:inline-flex"
          />
        </div>
        {/* Wraps between whole items, never inside one, and with no
            separators to strand at a line end. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-text-secondary">
          <Tooltip autoDismiss={false}>
            <TooltipTrigger asChild>
              <time
                dateTime={new Date(event.timestamp).toISOString()}
                tabIndex={0}
                className="font-mono tabular-nums whitespace-nowrap rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
              >
                {formatTimestamp(event.timestamp)}
              </time>
            </TooltipTrigger>
            <TooltipContent side="bottom">{new Date(event.timestamp).toISOString()}</TooltipContent>
          </Tooltip>
          <TimeAgo timestamp={event.timestamp} className="whitespace-nowrap" />
          <span className="capitalize whitespace-nowrap">{event.source}</span>
        </div>
      </div>

      {/* One scroll container for everything below the header, payload first:
          it's what someone opens an event to read, and at the default dock
          height a separately-scrolling payload box had room for one line. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-divider">
          <button
            onClick={() => toggleSection("payload")}
            aria-expanded={expandedSections.has("payload")}
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-overlay-subtle transition-colors text-text-primary"
          >
            {expandedSections.has("payload") ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            <span className="text-xs font-medium">Payload</span>
          </button>
          {expandedSections.has("payload") && (
            <div className="px-3 pb-2.5">
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
                      noun="worktree"
                      value={event.payload.worktreeId}
                      filterKey="worktreeId"
                      currentFilters={filters}
                      onToggle={handleContextToggle}
                    />
                  )}
                  {event.payload.agentId !== undefined && (
                    <ContextPill
                      label="Agent"
                      noun="agent"
                      value={event.payload.agentId}
                      filterKey="agentId"
                      currentFilters={filters}
                      onToggle={handleContextToggle}
                    />
                  )}
                  {event.payload.runId !== undefined && (
                    <ContextPill
                      label="Run"
                      noun="run"
                      value={event.payload.runId}
                      filterKey="runId"
                      currentFilters={filters}
                      onToggle={handleContextToggle}
                    />
                  )}
                  {event.payload.terminalId !== undefined && (
                    <ContextPill
                      label="Terminal"
                      noun="terminal"
                      value={event.payload.terminalId}
                      filterKey="terminalId"
                      currentFilters={filters}
                      onToggle={handleContextToggle}
                    />
                  )}
                  {event.payload.issueNumber !== undefined && (
                    <ContextPill
                      label="Issue #"
                      noun="issue"
                      value={event.payload.issueNumber}
                      filterKey="issueNumber"
                      currentFilters={filters}
                      onToggle={handleContextToggle}
                    />
                  )}
                  {event.payload.prNumber !== undefined && (
                    <ContextPill
                      label="PR #"
                      noun="PR"
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
        <div className="border-b border-divider">
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
                <TruncatedTooltip
                  content={<span className="font-mono break-all">{event.id}</span>}
                  side="bottom"
                  align="start"
                >
                  <span className="min-w-0 truncate font-mono text-xs rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary">
                    {event.id}
                  </span>
                </TruncatedTooltip>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <span className="text-text-secondary">Type:</span>
                <span className="font-mono text-xs break-all">{event.type}</span>
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
                  <TruncatedTooltip
                    content={<span className="font-mono break-all">{event.payload.traceId}</span>}
                    side="bottom"
                    align="start"
                  >
                    <span className="min-w-0 truncate font-mono text-xs rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary">
                      {event.payload.traceId}
                    </span>
                  </TruncatedTooltip>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
