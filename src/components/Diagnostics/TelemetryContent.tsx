import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";
import { telemetryPreviewClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import type { SanitizedTelemetryEvent } from "@shared/types";
import { logError } from "@/utils/logger";

export interface TelemetryContentProps {
  className?: string;
}

function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}.${date
    .getMilliseconds()
    .toString()
    .padStart(3, "0")}`;
}

function kindLabel(kind: SanitizedTelemetryEvent["kind"]): string {
  return kind === "sentry" ? "Error report" : "Analytics";
}

function KindLabel({ kind }: { kind: SanitizedTelemetryEvent["kind"] }) {
  return (
    <span className="flex w-24 shrink-0 items-center gap-1.5 text-2xs text-text-secondary">
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          kind === "sentry" ? "bg-status-error" : "bg-status-info"
        )}
      />
      {kindLabel(kind)}
    </span>
  );
}

interface RowProps {
  event: SanitizedTelemetryEvent;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function TelemetryRow({ event, isSelected, onSelect }: RowProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(event.id)}
      aria-current={isSelected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 border-b border-l-2 border-b-divider px-3 py-1.5 text-left transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        isSelected
          ? "border-l-text-primary bg-overlay-medium"
          : "border-l-transparent hover:bg-overlay-subtle"
      )}
    >
      <KindLabel kind={event.kind} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
        {event.label}
      </span>
      <span className="shrink-0 font-mono text-2xs tabular-nums text-text-secondary">
        {formatClockTime(event.timestamp)}
      </span>
    </button>
  );
}

interface DetailProps {
  event: SanitizedTelemetryEvent | null;
}

function TelemetryDetail({ event }: DetailProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [event?.id]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const payloadJson = useMemo(() => {
    if (!event) return "";
    try {
      return JSON.stringify(event.payload, null, 2);
    } catch {
      return "(payload could not be serialised)";
    }
  }, [event]);

  const handleCopy = useCallback(async () => {
    if (!event) return;
    try {
      await navigator.clipboard.writeText(payloadJson);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      logError("Failed to copy telemetry payload", err);
    }
  }, [event, payloadJson]);

  if (!event) {
    return (
      <div className="flex items-center justify-center h-full">
        <EmptyState
          variant="zero-data"
          scale="sidebar"
          title="Select an event to see its payload"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 px-3 py-2 border-b border-divider">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <KindLabel kind={event.kind} />
            </div>
            <p className="font-mono text-xs text-text-primary break-words">{event.label}</p>
            <div className="flex items-center gap-2 text-2xs text-text-secondary font-mono">
              <span>{new Date(event.timestamp).toISOString()}</span>
              <span aria-hidden>•</span>
              <span>ID {event.id.slice(0, 8)}</span>
            </div>
          </div>
          <Button variant="subtle" size="xs" onClick={handleCopy} aria-label="Copy payload JSON">
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy JSON"}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <pre className="text-xs font-mono text-text-primary px-3 py-2 whitespace-pre-wrap break-all select-text">
          {payloadJson}
        </pre>
      </div>
    </div>
  );
}

function TelemetryEmptyState({ active }: { active: boolean }) {
  const handleEnable = useCallback(() => {
    void actionService.dispatch("telemetry.togglePreview", { active: true }, { source: "user" });
  }, []);

  if (!active) {
    return (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        className="py-3"
        title="Telemetry preview is off"
        description="Turn it on to see exactly what Daintree would send, before you decide whether to share anything."
        action={
          <Button variant="subtle" size="xs" onClick={handleEnable}>
            Turn on telemetry preview
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      variant="zero-data"
      scale="canvas"
      className="py-3"
      title="Waiting for the next payload"
      description="Payloads appear here as Daintree records them. Error reports show up only when telemetry is set to Errors Only or Full Usage. Nothing is sent until you opt in."
    />
  );
}

export function TelemetryContent({ className }: TelemetryContentProps) {
  const { active, events, selectedEventId, setActive, appendEvents, setSelectedEvent } =
    useTelemetryPreviewStore(
      useShallow((state) => ({
        active: state.active,
        events: state.events,
        selectedEventId: state.selectedEventId,
        setActive: state.setActive,
        appendEvents: state.appendEvents,
        setSelectedEvent: state.setSelectedEvent,
      }))
    );

  useEffect(() => {
    let disposed = false;
    telemetryPreviewClient.subscribe();
    telemetryPreviewClient
      .getState()
      .then((state) => {
        if (!disposed) setActive(state.active);
      })
      .catch((err) => {
        logError("Failed to read telemetry preview state", err);
      });

    const unsubscribeBatch = telemetryPreviewClient.onEventBatch((incoming) => {
      if (disposed) return;
      appendEvents(incoming);
    });
    const unsubscribeState = telemetryPreviewClient.onStateChanged((state) => {
      if (disposed) return;
      setActive(state.active);
    });

    return () => {
      disposed = true;
      unsubscribeBatch();
      unsubscribeState();
      telemetryPreviewClient.unsubscribe();
    };
  }, [appendEvents, setActive]);

  const deferredEvents = useDeferredValue(events);
  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return null;
    return events.find((e) => e.id === selectedEventId) ?? null;
  }, [events, selectedEventId]);

  if (events.length === 0) {
    return (
      <div className={cn("h-full flex items-center justify-center", className)}>
        <TelemetryEmptyState active={active} />
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0", className)}>
      <div className="w-1/2 border-r border-divider overflow-y-auto">
        {deferredEvents
          .slice()
          .reverse()
          .map((event) => (
            <TelemetryRow
              key={event.id}
              event={event}
              isSelected={event.id === selectedEventId}
              onSelect={setSelectedEvent}
            />
          ))}
      </div>
      <div className="w-1/2 overflow-hidden">
        <TelemetryDetail event={selectedEvent} />
      </div>
    </div>
  );
}
