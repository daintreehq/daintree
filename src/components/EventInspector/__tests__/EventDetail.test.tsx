// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EventDetail } from "../EventDetail";
import type { EventRecord } from "@/store/eventStore";

const event = {
  id: "e1",
  timestamp: 1,
  type: "test:event",
  category: "system",
  payload: { a: 1 },
  source: "main",
} as unknown as EventRecord;

describe("EventDetail", () => {
  it("renders the sidebar empty state when no event is selected", () => {
    render(<EventDetail event={null} />);
    expect(screen.getByText("Select an event to see its payload")).toBeTruthy();
  });

  it("names the nothing-to-inspect and no-match cases", () => {
    const { rerender } = render(<EventDetail event={null} hasEvents={false} />);
    expect(screen.getByText("Nothing to inspect yet")).toBeTruthy();
    rerender(<EventDetail event={null} hasMatches={false} />);
    expect(screen.getByText("No matching event to inspect")).toBeTruthy();
  });

  it("rotates a secondary-ink chevron and insets the focus ring on section buttons", () => {
    render(<EventDetail event={event} />);
    const button = screen.getByRole("button", { name: "Metadata" });
    const chevron = button.querySelector("[data-animated-chevron]")!;
    expect(chevron.getAttribute("class")).toContain("text-text-secondary");
    expect(chevron.getAttribute("class")).not.toContain("rotate-90");
    expect(button.getAttribute("class")).toContain("focus-visible:-outline-offset-2");
    fireEvent.click(button);
    expect(button.querySelector("[data-animated-chevron]")!.getAttribute("class")).toContain(
      "rotate-90"
    );
  });
});
