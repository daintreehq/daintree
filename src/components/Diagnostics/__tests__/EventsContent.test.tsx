// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { EventRecord } from "@shared/types";
import { EventsContent } from "../EventsContent";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

const mockSetEvents = vi.fn();
const mockAddEvents = vi.fn();

vi.mock("@/store/eventStore", () => ({
  useEventStore: (selector: (state: unknown) => unknown) => {
    const state = {
      events: [] as EventRecord[],
      filters: {},
      selectedEventId: null,
      autoScroll: true,
      setAutoScroll: vi.fn(),
      addEvents: mockAddEvents,
      setEvents: mockSetEvents,
      setFilters: vi.fn(),
      setSelectedEvent: vi.fn(),
      getFilteredEvents: () => [] as EventRecord[],
    };
    return selector(state);
  },
}));

const mockGetEvents = vi.fn();
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockOnEventBatch = vi.fn();

vi.mock("@/clients", () => ({
  eventInspectorClient: {
    getEvents: () => mockGetEvents(),
    subscribe: () => mockSubscribe(),
    unsubscribe: () => mockUnsubscribe(),
    onEventBatch: (cb: (events: EventRecord[]) => void) => mockOnEventBatch(cb),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function stubGlobals() {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
}

describe("EventsContent — disposed guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let unsubCallback: (() => void) | null = null;
    mockOnEventBatch.mockImplementation((_cb: (events: EventRecord[]) => void) => {
      // hold the callback but don't fire it
      unsubCallback = () => {};
      return unsubCallback;
    });
    mockGetEvents.mockResolvedValue([
      { id: "1", timestamp: 1, type: "test", category: "agent", payload: {}, source: "main" },
    ]);
    mockSubscribe.mockReturnValue(undefined);
    mockUnsubscribe.mockReturnValue(undefined);
    stubGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does NOT call setEvents when getEvents() resolves after unmount", async () => {
    const { unmount } = render(<EventsContent />);

    unmount();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSetEvents).not.toHaveBeenCalled();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("calls setEvents when getEvents() resolves while mounted", async () => {
    render(<EventsContent />);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSetEvents).toHaveBeenCalledTimes(1);
  });

  it("does NOT call addEvents when onEventBatch fires after cleanup", async () => {
    let batchCallback: ((events: EventRecord[]) => void) | null = null;
    mockOnEventBatch.mockImplementation((cb: (events: EventRecord[]) => void) => {
      batchCallback = cb;
      return () => {};
    });

    const { unmount } = render(<EventsContent />);

    unmount();

    batchCallback!([
      { id: "2", timestamp: 2, type: "test", category: "agent", payload: {}, source: "main" },
    ]);

    expect(mockAddEvents).not.toHaveBeenCalled();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("calls addEvents when onEventBatch fires after the snapshot has loaded", async () => {
    let batchCallback: ((events: EventRecord[]) => void) | null = null;
    mockOnEventBatch.mockImplementation((cb: (events: EventRecord[]) => void) => {
      batchCallback = cb;
      return () => {};
    });

    render(<EventsContent />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    batchCallback!([
      { id: "2", timestamp: 2, type: "test", category: "agent", payload: {}, source: "main" },
    ]);

    expect(mockAddEvents).toHaveBeenCalledTimes(1);
  });

  it("keeps a batch that lands before the snapshot instead of letting the snapshot drop it", async () => {
    let batchCallback: ((events: EventRecord[]) => void) | null = null;
    mockOnEventBatch.mockImplementation((cb: (events: EventRecord[]) => void) => {
      batchCallback = cb;
      return () => {};
    });

    render(<EventsContent />);
    batchCallback!([
      { id: "2", timestamp: 2, type: "test", category: "agent", payload: {}, source: "main" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSetEvents).toHaveBeenCalledTimes(1);
    const hydrated = mockSetEvents.mock.calls[0]![0] as EventRecord[];
    expect(hydrated.map((e) => e.id)).toEqual(["1", "2"]);
  });
});
