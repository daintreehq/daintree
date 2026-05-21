// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventTimeline } from "../EventTimeline";
import type { EventRecord } from "@/store/eventStore";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

describe("EventTimeline accessibility", () => {
  const mockEvents: EventRecord[] = [
    {
      id: "1",
      timestamp: Date.now(),
      type: "agent:test",
      category: "agent" as const,
      payload: {},
      source: "main",
    },
    {
      id: "2",
      timestamp: Date.now() + 1000,
      type: "agent:test-2",
      category: "agent" as const,
      payload: { agentId: "abc123" },
      source: "main",
    },
  ];

  it("renders Virtuoso with role='log' and aria-live='off'", () => {
    render(<EventTimeline events={mockEvents} selectedId={null} onSelectEvent={vi.fn()} />);
    const log = screen.getByRole("log", { name: "Event timeline" });
    expect(log).toBeTruthy();
    expect(log.getAttribute("aria-live")).toBe("off");
  });

  it("renders Virtuoso with aria-label='Event timeline'", () => {
    render(<EventTimeline events={mockEvents} selectedId={null} onSelectEvent={vi.fn()} />);
    expect(screen.getByRole("log").getAttribute("aria-label")).toBe("Event timeline");
  });
});
