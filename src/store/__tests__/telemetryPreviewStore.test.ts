import { describe, it, expect, beforeEach } from "vitest";
import { useTelemetryPreviewStore, TELEMETRY_PREVIEW_MAX_EVENTS } from "../telemetryPreviewStore";
import type { SanitizedTelemetryEvent } from "@shared/types";

function makeEvent(
  id: string,
  overrides: Partial<SanitizedTelemetryEvent> = {}
): SanitizedTelemetryEvent {
  return {
    id,
    kind: "analytics",
    timestamp: 1_700_000_000_000,
    label: `event-${id}`,
    payload: { n: id },
    ...overrides,
  } as SanitizedTelemetryEvent;
}

describe("telemetryPreviewStore", () => {
  beforeEach(() => {
    useTelemetryPreviewStore.getState().reset();
  });

  it("defaults to inactive, empty, and no selection", () => {
    const state = useTelemetryPreviewStore.getState();
    expect(state.active).toBe(false);
    expect(state.events).toEqual([]);
    expect(state.selectedEventId).toBeNull();
  });

  it("toggles active idempotently", () => {
    const { setActive } = useTelemetryPreviewStore.getState();
    setActive(true);
    expect(useTelemetryPreviewStore.getState().active).toBe(true);
    setActive(true);
    expect(useTelemetryPreviewStore.getState().active).toBe(true);
    setActive(false);
    expect(useTelemetryPreviewStore.getState().active).toBe(false);
  });

  it("appends events preserving order", () => {
    const { appendEvents } = useTelemetryPreviewStore.getState();
    appendEvents([makeEvent("a"), makeEvent("b")]);
    appendEvents([makeEvent("c")]);
    const ids = useTelemetryPreviewStore.getState().events.map((e) => e.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("deduplicates by id", () => {
    const { appendEvents } = useTelemetryPreviewStore.getState();
    appendEvents([makeEvent("a"), makeEvent("b")]);
    appendEvents([makeEvent("b"), makeEvent("c")]);
    const ids = useTelemetryPreviewStore.getState().events.map((e) => e.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("caps the ring buffer at TELEMETRY_PREVIEW_MAX_EVENTS retaining newest", () => {
    const { appendEvents } = useTelemetryPreviewStore.getState();
    const batch: SanitizedTelemetryEvent[] = [];
    for (let i = 0; i < TELEMETRY_PREVIEW_MAX_EVENTS + 50; i++) {
      batch.push(makeEvent(String(i)));
    }
    appendEvents(batch);
    const events = useTelemetryPreviewStore.getState().events;
    expect(events).toHaveLength(TELEMETRY_PREVIEW_MAX_EVENTS);
    expect(events[events.length - 1]?.id).toBe(String(TELEMETRY_PREVIEW_MAX_EVENTS + 49));
    expect(events[0]?.id).toBe(String(50));
  });

  it("clears selection when the selected event is evicted by ring-buffer trim", () => {
    const { appendEvents, setSelectedEvent } = useTelemetryPreviewStore.getState();
    appendEvents([makeEvent("early")]);
    setSelectedEvent("early");
    // Push enough events to evict "early" from the 200-event ring.
    const batch: SanitizedTelemetryEvent[] = [];
    for (let i = 0; i < TELEMETRY_PREVIEW_MAX_EVENTS + 5; i++) {
      batch.push(makeEvent(`new-${i}`));
    }
    appendEvents(batch);
    const state = useTelemetryPreviewStore.getState();
    expect(state.events.some((e) => e.id === "early")).toBe(false);
    expect(state.selectedEventId).toBeNull();
  });

  it("keeps selection when the selected event is still visible after trim", () => {
    const { appendEvents, setSelectedEvent } = useTelemetryPreviewStore.getState();
    // Fill up to right before the cap with events we don't care about.
    const fill: SanitizedTelemetryEvent[] = [];
    for (let i = 0; i < TELEMETRY_PREVIEW_MAX_EVENTS - 1; i++) {
      fill.push(makeEvent(`fill-${i}`));
    }
    appendEvents(fill);
    // Add a distinct event and select it.
    appendEvents([makeEvent("keepme")]);
    setSelectedEvent("keepme");
    // Overflow by exactly 3 — "keepme" is near the tail, should survive.
    appendEvents([makeEvent("x1"), makeEvent("x2"), makeEvent("x3")]);
    const state = useTelemetryPreviewStore.getState();
    expect(state.events.some((e) => e.id === "keepme")).toBe(true);
    expect(state.selectedEventId).toBe("keepme");
  });

  it("clearEvents drops events and selection", () => {
    const { appendEvents, setSelectedEvent, clearEvents } = useTelemetryPreviewStore.getState();
    appendEvents([makeEvent("a"), makeEvent("b")]);
    setSelectedEvent("a");
    clearEvents();
    const state = useTelemetryPreviewStore.getState();
    expect(state.events).toEqual([]);
    expect(state.selectedEventId).toBeNull();
  });

  it("no-ops on empty append", () => {
    const { appendEvents } = useTelemetryPreviewStore.getState();
    const prev = useTelemetryPreviewStore.getState().events;
    appendEvents([]);
    expect(useTelemetryPreviewStore.getState().events).toBe(prev);
  });
});
