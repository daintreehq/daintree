import { afterEach, describe, expect, it } from "vitest";
import { useEventStore, type EventRecord } from "../eventStore";

function makeEvent(id: string, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    type: "agent:state-changed",
    category: "agent",
    payload: {},
    source: "main",
    ...overrides,
  };
}

describe("eventStore", () => {
  afterEach(() => {
    useEventStore.getState().reset();
  });

  it("deduplicates duplicate IDs within addEvents batch", () => {
    useEventStore.getState().addEvents([makeEvent("1"), makeEvent("1"), makeEvent("2")]);

    const ids = useEventStore.getState().events.map((event) => event.id);
    expect(ids).toEqual(["1", "2"]);
  });

  it("clamps setEvents to the max buffer size", () => {
    const oversized = Array.from({ length: 1005 }, (_, index) => makeEvent(`evt-${index + 1}`));
    useEventStore.getState().setEvents(oversized);

    const events = useEventStore.getState().events;
    expect(events).toHaveLength(1000);
    expect(events[0]?.id).toBe("evt-6");
    expect(events[events.length - 1]?.id).toBe("evt-1005");
  });
});
