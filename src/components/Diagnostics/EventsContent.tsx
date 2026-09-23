import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useEventStore } from "@/store/eventStore";
import { EventTimeline } from "../EventInspector/EventTimeline";
import { EventDetail } from "../EventInspector/EventDetail";
import { EventFilters } from "../EventInspector/EventFilters";
import { eventInspectorClient } from "@/clients";
import { logError } from "@/utils/logger";
import { DiagnosticsNotice } from "./DiagnosticsNotice";
import { ListSkeleton } from "./ListSkeleton";

export interface EventsContentProps {
  className?: string;
}

export function EventsContent({ className }: EventsContentProps) {
  // React Compiler can't see that getFilteredEvents() reads via Zustand's
  // get(), so it can over-cache the useMemo below — which then keeps
  // useDeferredValue stuck at the initial empty array even after `events`
  // grows. Opt out of compiler memoization for this component.
  "use no memo";

  const {
    events,
    filters,
    selectedEventId,
    autoScroll,
    setAutoScroll,
    addEvents,
    setEvents,
    setFilters,
    clearFilters,
    setSelectedEvent,
    getFilteredEvents,
  } = useEventStore(
    useShallow((state) => ({
      events: state.events,
      filters: state.filters,
      selectedEventId: state.selectedEventId,
      autoScroll: state.autoScroll,
      setAutoScroll: state.setAutoScroll,
      addEvents: state.addEvents,
      setEvents: state.setEvents,
      setFilters: state.setFilters,
      clearFilters: state.clearFilters,
      setSelectedEvent: state.setSelectedEvent,
      getFilteredEvents: state.getFilteredEvents,
    }))
  );

  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let disposed = false;

    eventInspectorClient.subscribe();
    setLoadState("loading");

    eventInspectorClient
      .getEvents()
      .then((existingEvents) => {
        if (disposed) return;
        setLoadState("loaded");
        setEvents(existingEvents);
      })
      .catch((error) => {
        logError("Failed to load events", error);
        if (!disposed) setLoadState("failed");
      });

    const unsubscribe = eventInspectorClient.onEventBatch((events) => {
      if (disposed) return;
      addEvents(events);
    });

    return () => {
      disposed = true;
      unsubscribe();
      eventInspectorClient.unsubscribe();
    };
  }, [addEvents, setEvents, reloadKey]);

  const filteredEvents = useMemo(() => {
    void events;
    void filters;
    return getFilteredEvents();
  }, [events, filters, getFilteredEvents]);
  const deferredFilteredEvents = useDeferredValue(filteredEvents);
  const selectedEvent = selectedEventId
    ? events.find((e) => e.id === selectedEventId) || null
    : null;

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <EventFilters events={events} filters={filters} onFiltersChange={setFilters} />

      {loadState === "failed" && events.length === 0 ? (
        <div className="p-3">
          <DiagnosticsNotice
            kind="failed"
            title="Couldn't read captured events"
            description="New events still appear here as they happen."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      ) : (
        <>
          {loadState === "failed" ? (
            <DiagnosticsNotice
              kind="failed"
              className="mx-3 mt-2"
              title="Couldn't read earlier events"
              description="Only events since the dock opened are shown."
              onRetry={() => setReloadKey((k) => k + 1)}
            />
          ) : null}
          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 w-1/2 flex-col border-r border-divider">
              {loadState === "loading" && events.length === 0 ? (
                <ListSkeleton label="Loading events" />
              ) : (
                <EventTimeline
                  events={deferredFilteredEvents}
                  totalCount={events.length}
                  onClearFilters={clearFilters}
                  selectedId={selectedEventId}
                  onSelectEvent={setSelectedEvent}
                  autoScroll={autoScroll}
                  onAutoScrollChange={setAutoScroll}
                />
              )}
            </div>

            <div className="flex min-h-0 w-1/2 flex-col">
              <EventDetail event={selectedEvent} hasEvents={events.length > 0} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
