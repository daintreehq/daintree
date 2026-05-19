// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { WorktreeSidebarSearchBar } from "../WorktreeSidebarSearchBar";

function resetWorktreeFilterStore() {
  useWorktreeFilterStore.setState({
    query: "",
    orderBy: "created",
    groupByType: false,
    statusFilters: new Set(),
    typeFilters: new Set(),
    prIssueFilters: new Set(),
    sessionFilters: new Set(),
    activityFilters: new Set(),
    alwaysShowActive: true,
    alwaysShowWaiting: true,
    hideMainWorktree: false,
    pinnedWorktrees: [],
    collapsedWorktrees: [],
    manualOrder: [],
    quickStateFilter: "all",
  });
}

function renderBar() {
  return render(<WorktreeSidebarSearchBar />, { wrapper: TooltipProvider });
}

function getInput() {
  return screen.getByRole("textbox", { name: "Search worktrees" }) as HTMLInputElement;
}

function getFilterTrigger() {
  return screen.getByRole("button", { name: "Filter and sort worktrees" });
}

describe("WorktreeSidebarSearchBar", () => {
  beforeEach(() => {
    resetWorktreeFilterStore();
  });

  afterEach(() => {
    resetWorktreeFilterStore();
  });

  it("renders the X clear button with the 'Clear search' aria-label when text is typed", () => {
    renderBar();
    fireEvent.change(getInput(), { target: { value: "foo" } });
    const clearBtn = screen.getByRole("button", { name: "Clear search" });
    expect(clearBtn).toBeTruthy();
  });

  it("does not render the X button when only facets are active (no typed text)", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
    });
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear search/i })).toBeNull();
  });

  it("X button clears only the search query and preserves facets + quick-state", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
      useWorktreeFilterStore.getState().toggleTypeFilter("feature");
      useWorktreeFilterStore.getState().setQuickStateFilter("working");
    });
    fireEvent.change(getInput(), { target: { value: "foo" } });
    // Flush the 200 ms debounce so store.query reflects the typed value.
    act(() => {
      // Force-set the store value directly; the debounce path is exercised
      // implicitly by the input's onChange already updating localQuery.
      useWorktreeFilterStore.getState().setQuery("foo");
    });
    expect(useWorktreeFilterStore.getState().query).toBe("foo");

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    const state = useWorktreeFilterStore.getState();
    expect(state.query).toBe("");
    expect(state.statusFilters.has("active")).toBe(true);
    expect(state.typeFilters.has("feature")).toBe(true);
    expect(state.quickStateFilter).toBe("working");
    expect(getInput().value).toBe("");
  });

  it("Escape with popover open closes the popover, leaves query intact, and keeps focus", () => {
    renderBar();
    fireEvent.change(getInput(), { target: { value: "foo" } });
    act(() => {
      useWorktreeFilterStore.getState().setQuery("foo");
    });
    // Open the filter popover via its trigger.
    fireEvent.click(getFilterTrigger());
    expect(getFilterTrigger().getAttribute("aria-expanded")).toBe("true");

    const input = getInput();
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(getFilterTrigger().getAttribute("aria-expanded")).toBe("false");
    expect(useWorktreeFilterStore.getState().query).toBe("foo");
    expect(input.value).toBe("foo");
    expect(document.activeElement).toBe(input);
  });

  it("Escape with popover closed and text present clears only the text", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
    });
    fireEvent.change(getInput(), { target: { value: "foo" } });
    act(() => {
      useWorktreeFilterStore.getState().setQuery("foo");
    });

    fireEvent.keyDown(getInput(), { key: "Escape" });

    const state = useWorktreeFilterStore.getState();
    expect(state.query).toBe("");
    expect(state.statusFilters.has("active")).toBe(true);
    expect(getInput().value).toBe("");
  });

  it("Escape with no popover, no text, and no facets blurs the input", () => {
    renderBar();
    const input = getInput();
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(document.activeElement).not.toBe(input);
  });

  it("does not show the cross-axis 'Clear all' button when no axes are active", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("does not show 'Clear all' when only the search query is non-default", () => {
    renderBar();
    fireEvent.change(getInput(), { target: { value: "foo" } });
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("does not show 'Clear all' when only facets are non-default", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
      useWorktreeFilterStore.getState().toggleTypeFilter("feature");
    });
    // Two facet toggles count as a single "facet axis"; still one axis overall.
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("does not show 'Clear all' when only quick-state is non-default", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().setQuickStateFilter("working");
    });
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("shows 'Clear all' when query + facets are both active", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
    });
    fireEvent.change(getInput(), { target: { value: "foo" } });
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  it("shows 'Clear all' when query + quick-state are both active", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().setQuickStateFilter("working");
    });
    fireEvent.change(getInput(), { target: { value: "foo" } });
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  it("shows 'Clear all' when facets + quick-state are both active", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
      useWorktreeFilterStore.getState().setQuickStateFilter("waiting");
    });
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  it("X click via keyboard activation keeps focus on the input", () => {
    renderBar();
    fireEvent.change(getInput(), { target: { value: "foo" } });
    act(() => {
      useWorktreeFilterStore.getState().setQuery("foo");
    });
    const clearBtn = screen.getByRole("button", { name: "Clear search" });
    // Simulate keyboard activation: focus the button then click via fireEvent
    // (jsdom fires keydown→keypress→click for Enter, but a direct .click() is
    // a closer model of what tests assert about activation behaviour).
    clearBtn.focus();
    fireEvent.click(clearBtn);
    expect(document.activeElement).toBe(getInput());
  });

  it("whitespace-only query does not count as an active axis for 'Clear all'", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
    });
    fireEvent.change(getInput(), { target: { value: "   " } });
    // Only one real axis is active (facets). The whitespace input should not
    // inflate the count and surface "Clear all".
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("'Clear all' disappears after a partial clear leaves only one axis", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
    });
    fireEvent.change(getInput(), { target: { value: "foo" } });
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
    // The X button only clears query; one axis (facets) remains.
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("stale debounce: external clearAll cancels the pending query write", () => {
    vi.useFakeTimers();
    try {
      renderBar();
      // Seed a facet so hasActiveFilters is true while debounce is pending.
      act(() => {
        useWorktreeFilterStore.getState().toggleStatusFilter("active");
      });
      fireEvent.change(getInput(), { target: { value: "foo" } });
      // Debounce is now scheduled; store.query is still "".
      expect(useWorktreeFilterStore.getState().query).toBe("");
      // External clearAll (e.g., popover footer) fires before the 200 ms elapses.
      act(() => {
        useWorktreeFilterStore.getState().clearAll();
      });
      // Advance past the debounce window.
      act(() => {
        vi.advanceTimersByTime(250);
      });
      // Query must NOT be silently resurrected to "foo".
      expect(useWorktreeFilterStore.getState().query).toBe("");
      // The visible input should mirror the cleared state.
      expect(getInput().value).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stale debounce: X click during pending debounce commits an empty query", () => {
    vi.useFakeTimers();
    try {
      renderBar();
      fireEvent.change(getInput(), { target: { value: "foo" } });
      // Debounce is pending; store.query is still "".
      // Click X immediately — this triggers handleClearSearch which cancels the
      // pending debounce and calls setQuery("").
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(useWorktreeFilterStore.getState().query).toBe("");
      expect(getInput().value).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Clear all' click resets query, facets, and quick-state via clearAll()", () => {
    renderBar();
    act(() => {
      useWorktreeFilterStore.getState().toggleStatusFilter("active");
      useWorktreeFilterStore.getState().toggleTypeFilter("feature");
      useWorktreeFilterStore.getState().setQuickStateFilter("working");
    });
    fireEvent.change(getInput(), { target: { value: "foo" } });
    act(() => {
      useWorktreeFilterStore.getState().setQuery("foo");
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    const state = useWorktreeFilterStore.getState();
    expect(state.query).toBe("");
    expect(state.statusFilters.size).toBe(0);
    expect(state.typeFilters.size).toBe(0);
    expect(state.quickStateFilter).toBe("all");
    expect(getInput().value).toBe("");
  });
});
