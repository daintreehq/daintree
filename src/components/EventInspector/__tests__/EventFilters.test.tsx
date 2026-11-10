// @vitest-environment jsdom
import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventFilters } from "../EventFilters";
import type { EventFilterOptions, EventRecord } from "@/store/eventStore";

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
    onClear: vi.fn(),
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

describe("EventFilters context filters and Clear filters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderBar(filters: EventFilterOptions, resetSignal = 0) {
    const onFiltersChange = vi.fn();
    const onClear = vi.fn();
    const props = { events: [] as EventRecord[], onFiltersChange, onClear };
    const view = render(<EventFilters {...props} filters={filters} resetSignal={resetSignal} />);
    const rerenderWith = (nextFilters: EventFilterOptions, nextReset: number) =>
      view.rerender(<EventFilters {...props} filters={nextFilters} resetSignal={nextReset} />);
    return { onFiltersChange, onClear, rerenderWith };
  }

  it("shows a value set from Context in the bar, pressed, without the Context section", () => {
    renderBar({ agentId: "claude-7f3a2c91", issueNumber: 482 });

    const agent = screen.getByRole("button", { name: "Agent: claude-7f3a2c91" });
    expect(agent.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Issue: #482" })).toBeTruthy();
  });

  it("names a worktree by its folder and describes it by its full path", () => {
    renderBar({ worktreeId: "/Users/dev/app-worktrees/feature-oauth" });

    const token = screen.getByRole("button", { name: "Worktree: feature-oauth" });
    expect(token.getAttribute("aria-description")).toBe("/Users/dev/app-worktrees/feature-oauth");
  });

  it("clears only the pressed context value and hands focus to the next token", () => {
    const { onFiltersChange } = renderBar({ worktreeId: "/w/feature", agentId: "claude-1" });
    const worktree = screen.getByRole("button", { name: "Worktree: feature" });
    const agent = screen.getByRole("button", { name: "Agent: claude-1" });

    worktree.focus();
    fireEvent.click(worktree);

    expect(onFiltersChange).toHaveBeenCalledWith({ worktreeId: undefined, agentId: "claude-1" });
    expect(document.activeElement).toBe(agent);
  });

  it("offers Clear filters for a context value alone, and not when nothing is applied", () => {
    const { rerenderWith } = renderBar({ runId: "run-1" });
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();

    rerenderWith({}, 0);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("Clear filters drops a search draft typed just before it and keeps focus in search", () => {
    vi.useFakeTimers();
    const { onFiltersChange, onClear } = renderBar({ agentId: "claude-1" });
    const search = screen.getByRole("searchbox", { name: "Search events" }) as HTMLInputElement;

    fireEvent.change(search, { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(onFiltersChange).not.toHaveBeenCalledWith(expect.objectContaining({ search: "draft" }));
  });

  it("a clear from outside the bar drops a pending search draft too", () => {
    vi.useFakeTimers();
    const filters = {};
    const { onFiltersChange, rerenderWith } = renderBar(filters, 0);
    const search = screen.getByRole("searchbox", { name: "Search events" }) as HTMLInputElement;

    fireEvent.change(search, { target: { value: "draft" } });
    rerenderWith(filters, 1);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(search.value).toBe("");
    expect(onFiltersChange).not.toHaveBeenCalledWith(expect.objectContaining({ search: "draft" }));
  });
});
