import { useDeferredValue, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useEventStore } from "@/store/eventStore";
import { EventTimeline } from "../EventInspector/EventTimeline";
import { EventDetail } from "../EventInspector/EventDetail";
import { EventFilters } from "../EventInspector/EventFilters";
import { eventInspectorClient } from "@/clients";

export interface EventsContentProps {
  className?: string;
}

export function EventsContent({ className }: EventsContentProps) {
  const {
    events,
    filters,
    selectedEventId,
    autoScroll,
    setAutoScroll,
    addEvents,
    setEvents,
    setFilters,
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
      setSelectedEvent: state.setSelectedEvent,
      getFilteredEvents: state.getFilteredEvents,
    }))
  );

  useEffect(() => {
    eventInspectorClient.subscribe();

    eventInspectorClient
      .getEvents()
      .then((existingEvents) => {
        setEvents(existingEvents);
      })
      .catch((error) => {
        console.error("Failed to load events:", error);
      });

    const unsubscribe = eventInspectorClient.onEventBatch((events) => {
      addEvents(events);
    });

    return () => {
      unsubscribe();
      eventInspectorClient.unsubscribe();
    };
  }, [addEvents, setEvents]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filteredEvents = useMemo(() => getFilteredEvents(), [events, filters, getFilteredEvents]);
  const deferredFilteredEvents = useDeferredValue(filteredEvents);
  const selectedEvent = selectedEventId
    ? events.find((e) => e.id === selectedEventId) || null
    : null;

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <EventFilters
        events={events}
        filters={filters}
        onFiltersChange={(newFilters) => setFilters(newFilters)}
      />

      <div className="flex-1 flex min-h-0">
        <div className="w-1/2 border-r overflow-hidden">
          <EventTimeline
            events={deferredFilteredEvents}
            selectedId={selectedEventId}
            onSelectEvent={setSelectedEvent}
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
          />
        </div>

        <div className="w-1/2 overflow-hidden">
          <EventDetail event={selectedEvent} />
        </div>
      </div>
    </div>
  );
}
