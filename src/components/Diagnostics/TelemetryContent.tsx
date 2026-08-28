import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Copy, ShieldCheck } from "lucide-react";
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
  return kind === "sentry" ? "Sentry" : "Analytics";
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
      className={cn(
        "w-full text-left px-3 py-2 border-b border-daintree-border/40 transition-colors",
        "hover:bg-tint/5 focus-visible:outline-hidden focus-visible:bg-tint/10",
        isSelected && "bg-daintree-accent/10"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "px-1.5 py-0.5 rounded text-3xs font-mono uppercase tracking-wide shrink-0",
            event.kind === "sentry"
              ? "bg-status-error/15 text-status-error"
              : "bg-status-info/15 text-status-info"
          )}
        >
          {kindLabel(event.kind)}
        </span>
        <span className="font-mono text-xs text-text-primary truncate flex-1">{event.label}</span>
        <span className="text-3xs text-text-secondary font-mono tabular-nums shrink-0">
          {formatClockTime(event.timestamp)}
        </span>
      </div>
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
          title="Select an event to view its payload"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-shrink-0 p-3 border-b border-daintree-border/60">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "px-1.5 py-0.5 rounded text-3xs font-mono uppercase tracking-wide",
                  event.kind === "sentry"
                    ? "bg-status-error/15 text-status-error"
                    : "bg-status-info/15 text-status-info"
                )}
              >
                {kindLabel(event.kind)}
              </span>
              <span className="font-mono text-sm text-text-primary truncate">{event.label}</span>
            </div>
            <div className="flex items-center gap-2 text-2xs text-text-secondary font-mono">
              <span>{new Date(event.timestamp).toISOString()}</span>
              <span aria-hidden>•</span>
              <span>ID {event.id.slice(0, 8)}</span>
            </div>
          </div>
          <Button variant="subtle" size="xs" onClick={handleCopy} aria-label="Copy payload JSON">
            {copied ? (
              <>
                <Check className="w-3 h-3 mr-1 text-status-success" /> Copied
              </>
            ) : (
              <>
                <Copy className="w-3 h-3 mr-1" /> Copy JSON
              </>
            )}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <pre className="text-xs font-mono bg-muted/30 p-3 whitespace-pre-wrap break-all select-text">
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
        title="Telemetry preview is off"
        icon={<ShieldCheck />}
        description="Turn it on to mirror the sanitised payloads Daintree would transmit — inspect them before deciding whether to enable telemetry."
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
      title="No events captured yet"
      description="Perform an action that emits an analytics event (e.g. finishing onboarding) to see its sanitised payload here. Crash reports only appear in preview once telemetry is set to Errors Only or Full Usage. Nothing is transmitted until you opt in."
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
      <div className="w-1/2 border-r border-daintree-border/60 overflow-y-auto">
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
