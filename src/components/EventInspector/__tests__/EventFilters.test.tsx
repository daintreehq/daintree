// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventFilters } from "../EventFilters";
import type { EventRecord } from "@/store/eventStore";

describe("EventFilters accessibility", () => {
  const baseProps = {
    events: [] as EventRecord[],
    filters: {} as {
      types?: string[];
      categories?: import("@/store/eventStore").EventCategory[];
      search?: string;
      traceId?: string;
    },
    onFiltersChange: vi.fn(),
  };

  it("renders search input with type='search'", () => {
    render(<EventFilters {...baseProps} />);
    const input = screen.getByRole("searchbox", { name: "Search events" }) as HTMLInputElement;
    expect(input.type).toBe("search");
  });

  it("renders traceId input with type='text' inside the filters popover", async () => {
    render(<EventFilters {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    const input = (await screen.findByLabelText("Trace ID")) as HTMLInputElement;
    expect(input.type).toBe("text");
  });

  it("renders category chips with aria-pressed", () => {
    render(
      <EventFilters
        {...baseProps}
        events={[
          {
            id: "1",
            timestamp: Date.now(),
            type: "agent:test",
            category: "agent",
            payload: {},
            source: "main",
          },
        ]}
        filters={{ categories: ["agent"] }}
      />
    );
    const agentChip = screen.getByText("Agent").closest("button")!;
    expect(agentChip.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders inactive category chips with aria-pressed=false", () => {
    render(<EventFilters {...baseProps} />);
    const systemChip = screen.getByText("System").closest("button")!;
    expect(systemChip.getAttribute("aria-pressed")).toBe("false");
  });

  it("calls onFiltersChange with toggled category on click", () => {
    const onFiltersChange = vi.fn();
    render(<EventFilters {...baseProps} onFiltersChange={onFiltersChange} />);
    fireEvent.click(screen.getByText("System").closest("button")!);
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ categories: ["system"] })
    );
  });
});
