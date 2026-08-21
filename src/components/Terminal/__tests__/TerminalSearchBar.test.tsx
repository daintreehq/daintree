// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: vi.fn(),
    ensureSearchAddon: vi.fn(),
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TerminalSearchBar } from "../TerminalSearchBar";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useTerminalSearchHistoryStore } from "@/store/terminalSearchHistoryStore";

type ResultsListener = (event: { resultIndex: number; resultCount: number }) => void;

function createMockManaged(findNextResult = true) {
  const resultsListeners: ResultsListener[] = [];
  return {
    searchAddon: {
      findNext: vi.fn(() => findNextResult),
      findPrevious: vi.fn(() => findNextResult),
      clearDecorations: vi.fn(),
      onDidChangeResults: vi.fn((listener: ResultsListener) => {
        resultsListeners.push(listener);
        return {
          dispose: vi.fn(() => {
            const idx = resultsListeners.indexOf(listener);
            if (idx >= 0) resultsListeners.splice(idx, 1);
          }),
        };
      }),
    },
    _fireResults(event: { resultIndex: number; resultCount: number }) {
      for (const listener of resultsListeners) listener(event);
    },
    _resultsListeners: resultsListeners,
  };
}

describe("TerminalSearchBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation(async (id) => {
      return terminalInstanceService.get(id)?.searchAddon ?? null;
    });
    useTerminalSearchHistoryStore.setState({
      searches: [],
      caseSensitive: false,
      regexEnabled: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useTerminalSearchHistoryStore.setState({
      searches: [],
      caseSensitive: false,
      regexEnabled: false,
    });
  });

  function renderSearchBar() {
    return render(<TerminalSearchBar terminalId="test-terminal" onClose={vi.fn()} />);
  }

  it("renders the sr-only live region on initial mount with correct attributes", () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const liveRegion = screen.getByRole("status");
    expect(liveRegion.getAttribute("aria-live")).toBe("polite");
    expect(liveRegion.getAttribute("aria-atomic")).toBe("true");
    expect(liveRegion.textContent).toBe("");
  });

  it('announces "Found" when search finds a match but no count event has arrived', async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });

    await act(() => {
      vi.advanceTimersByTime(150);
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("Found");
  });

  it("renders the counter when onDidChangeResults reports an active match", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    await act(() => {
      mock._fireResults({ resultIndex: 0, resultCount: 42 });
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("1 of 42");
  });

  it("renders count-only when highlight limit is exceeded (resultIndex -1)", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    await act(() => {
      mock._fireResults({ resultIndex: -1, resultCount: 1000 });
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("1000+ matches");
  });

  it("shows 1000+ in the counter when capped at the highlight limit", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    await act(() => {
      mock._fireResults({ resultIndex: 5, resultCount: 1000 });
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("6 of 1000+");
  });

  it('announces "No matches" when search finds nothing', async () => {
    const mock = createMockManaged(false);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    await act(() => {
      fireEvent.change(input, { target: { value: "nonexistent" } });
    });

    await act(() => {
      vi.advanceTimersByTime(150);
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("No matches");
  });

  it('announces "Invalid regex" for invalid regex patterns', async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    const regexButton = screen.getByLabelText("Toggle regex mode");
    await act(() => {
      fireEvent.click(regexButton);
    });

    await act(() => {
      fireEvent.change(input, { target: { value: "[invalid" } });
    });

    await act(() => {
      vi.advanceTimersByTime(150);
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("Invalid regex");
  });

  it("clears announcement and counter when search term is cleared", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });
    await act(() => {
      mock._fireResults({ resultIndex: 0, resultCount: 3 });
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("1 of 3");

    await act(() => {
      fireEvent.change(input, { target: { value: "" } });
    });

    expect(liveRegion.textContent).toBe("");
  });

  it("renders the whole-word toggle initially unpressed", () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const button = screen.getByLabelText("Toggle whole word");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("passes wholeWord: true to findNext when the toggle is on", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    const wholeWordButton = screen.getByLabelText("Toggle whole word");
    await act(() => {
      fireEvent.click(wholeWordButton);
    });

    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(mock.searchAddon.findNext).toHaveBeenCalled();
    const lastCall = mock.searchAddon.findNext.mock.calls.at(-1) as unknown[];
    expect(lastCall[1]).toMatchObject({ wholeWord: true });
  });

  it("combines regex and wholeWord in findNext options", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    await act(() => {
      fireEvent.click(screen.getByLabelText("Toggle regex mode"));
    });
    await act(() => {
      fireEvent.click(screen.getByLabelText("Toggle whole word"));
    });

    await act(() => {
      fireEvent.change(input, { target: { value: "foo" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(mock.searchAddon.findNext).toHaveBeenCalled();
    const lastCall = mock.searchAddon.findNext.mock.calls.at(-1) as unknown[];
    expect(lastCall[1]).toMatchObject({ regex: true, wholeWord: true });
  });

  it("marks the input invalid and surfaces the verbatim regex engine error", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal") as HTMLInputElement;

    await act(() => {
      fireEvent.click(screen.getByLabelText("Toggle regex mode"));
    });
    await act(() => {
      fireEvent.change(input, { target: { value: "[invalid" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");
    // Tooltip mock renders content inline; require the engine-native message
    // so a regression that swallows validation.error and shows only the
    // generic fallback fails the test.
    const renderedHtml = document.body.textContent ?? "";
    expect(renderedHtml).toMatch(/Invalid regular expression/);
  });

  it("does not let a pending debounce overwrite an immediate toggle search", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    // User types — schedules the 150ms debounce
    await act(() => {
      fireEvent.change(input, { target: { value: "foo" } });
    });
    // Before the debounce fires, click whole-word — should cancel the
    // pending literal search and run an immediate {wholeWord: true} search.
    await act(() => {
      fireEvent.click(screen.getByLabelText("Toggle whole word"));
    });
    // Advance past the (now-cancelled) debounce horizon.
    await act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(mock.searchAddon.findNext).toHaveBeenCalledTimes(1);
    const onlyCall = mock.searchAddon.findNext.mock.calls[0] as unknown[];
    expect(onlyCall[1]).toMatchObject({ wholeWord: true });
  });

  it("clears the regex error state when the regex toggle is turned off", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal") as HTMLInputElement;

    await act(() => {
      fireEvent.click(screen.getByLabelText("Toggle regex mode"));
    });
    await act(() => {
      fireEvent.change(input, { target: { value: "[invalid" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");

    await act(() => {
      fireEvent.click(screen.getByLabelText("Toggle regex mode"));
    });

    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("disposes the onDidChangeResults subscription on unmount", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    const { unmount } = renderSearchBar();
    await act(async () => Promise.resolve());
    expect(mock._resultsListeners.length).toBe(1);

    unmount();
    expect(mock._resultsListeners.length).toBe(0);
  });

  describe("history recall", () => {
    it("pre-populates the input with the most recent search on reopen", () => {
      useTerminalSearchHistoryStore.setState({
        searches: ["recent", "older"],
        caseSensitive: false,
        regexEnabled: false,
      });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      const input = screen.getByPlaceholderText("Find in terminal") as HTMLInputElement;
      expect(input.value).toBe("recent");
    });

    it("fires the search on mount when pre-populated from history", async () => {
      useTerminalSearchHistoryStore.setState({
        searches: ["recent"],
        caseSensitive: false,
        regexEnabled: false,
      });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      await act(async () => Promise.resolve());
      expect(mock.searchAddon.findNext).toHaveBeenCalledWith("recent", expect.any(Object));
    });

    it("does not fire a search on mount when history is empty", () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      expect(mock.searchAddon.findNext).not.toHaveBeenCalled();
    });

    it("ArrowUp recalls older entries; ArrowDown restores the draft", async () => {
      useTerminalSearchHistoryStore.setState({
        searches: ["second", "first"],
        caseSensitive: false,
        regexEnabled: false,
      });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      const input = screen.getByPlaceholderText("Find in terminal") as HTMLInputElement;

      // Replace pre-populated term with a draft.
      await act(() => {
        fireEvent.change(input, { target: { value: "draft" } });
      });
      expect(input.value).toBe("draft");

      // ArrowUp → most recent ("second").
      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowUp" });
      });
      expect(input.value).toBe("second");

      // ArrowUp → older ("first").
      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowUp" });
      });
      expect(input.value).toBe("first");

      // ArrowUp at oldest entry → stays on "first".
      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowUp" });
      });
      expect(input.value).toBe("first");

      // ArrowDown → back to "second".
      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
      });
      expect(input.value).toBe("second");

      // ArrowDown → restores the stashed draft.
      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
      });
      expect(input.value).toBe("draft");
    });

    it("ArrowUp with empty history does nothing", async () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      const input = screen.getByPlaceholderText("Find in terminal") as HTMLInputElement;

      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowUp" });
      });
      expect(input.value).toBe("");
    });

    it("Enter commits the current term to history", async () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      const input = screen.getByPlaceholderText("Find in terminal");

      await act(() => {
        fireEvent.change(input, { target: { value: "hello" } });
      });
      await act(() => {
        fireEvent.keyDown(input, { key: "Enter" });
      });

      expect(useTerminalSearchHistoryStore.getState().searches).toEqual(["hello"]);
    });

    it("close button commits the current term to history", async () => {
      const onClose = vi.fn();
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      render(<TerminalSearchBar terminalId="test-terminal" onClose={onClose} />);
      const input = screen.getByPlaceholderText("Find in terminal");
      await act(() => {
        fireEvent.change(input, { target: { value: "world" } });
      });

      await act(() => {
        fireEvent.click(screen.getByLabelText("Close search"));
      });

      expect(useTerminalSearchHistoryStore.getState().searches).toEqual(["world"]);
      expect(onClose).toHaveBeenCalled();
    });

    it("Escape commits the current term to history", async () => {
      const onClose = vi.fn();
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      render(<TerminalSearchBar terminalId="test-terminal" onClose={onClose} />);
      const input = screen.getByPlaceholderText("Find in terminal");
      await act(() => {
        fireEvent.change(input, { target: { value: "needle" } });
      });

      await act(() => {
        fireEvent.keyDown(input, { key: "Escape" });
      });

      expect(useTerminalSearchHistoryStore.getState().searches).toEqual(["needle"]);
      expect(onClose).toHaveBeenCalled();
    });

    it("deduplicates repeated terms; most recent moves to front", async () => {
      useTerminalSearchHistoryStore.setState({
        searches: ["alpha", "beta"],
        caseSensitive: false,
        regexEnabled: false,
      });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      const input = screen.getByPlaceholderText("Find in terminal");

      await act(() => {
        fireEvent.change(input, { target: { value: "beta" } });
      });
      await act(() => {
        fireEvent.keyDown(input, { key: "Enter" });
      });

      expect(useTerminalSearchHistoryStore.getState().searches).toEqual(["beta", "alpha"]);
    });

    it("does not commit empty or whitespace terms to history", async () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      render(<TerminalSearchBar terminalId="test-terminal" onClose={vi.fn()} />);
      const input = screen.getByPlaceholderText("Find in terminal");

      await act(() => {
        fireEvent.change(input, { target: { value: "   " } });
      });
      await act(() => {
        fireEvent.click(screen.getByLabelText("Close search"));
      });

      expect(useTerminalSearchHistoryStore.getState().searches).toEqual([]);
    });

    it("persists case-sensitive toggle state across mounts", async () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      const { unmount } = renderSearchBar();
      await act(() => {
        fireEvent.click(screen.getByLabelText("Toggle case sensitivity"));
      });
      expect(useTerminalSearchHistoryStore.getState().caseSensitive).toBe(true);
      unmount();

      renderSearchBar();
      const toggle = screen.getByLabelText("Toggle case sensitivity");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    });

    it("persists regex toggle state across mounts", async () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      const { unmount } = renderSearchBar();
      await act(() => {
        fireEvent.click(screen.getByLabelText("Toggle regex mode"));
      });
      expect(useTerminalSearchHistoryStore.getState().regexEnabled).toBe(true);
      unmount();

      renderSearchBar();
      const toggle = screen.getByLabelText("Toggle regex mode");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    });

    it("typing exits history-navigation mode (subsequent ArrowDown does not restore draft)", async () => {
      useTerminalSearchHistoryStore.setState({
        searches: ["second", "first"],
        caseSensitive: false,
        regexEnabled: false,
      });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      const input = screen.getByPlaceholderText("Find in terminal") as HTMLInputElement;

      // ArrowUp into history.
      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowUp" });
      });
      expect(input.value).toBe("second");

      // Type something — this resets the history index.
      await act(() => {
        fireEvent.change(input, { target: { value: "typed" } });
      });
      expect(input.value).toBe("typed");

      // ArrowDown should be a no-op now (index is back at -1).
      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
      });
      expect(input.value).toBe("typed");
    });

    it("ignores ArrowUp when a modifier key is pressed", async () => {
      useTerminalSearchHistoryStore.setState({
        searches: ["history"],
        caseSensitive: false,
        regexEnabled: false,
      });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      const input = screen.getByPlaceholderText("Find in terminal") as HTMLInputElement;

      // Replace pre-populated term so we can detect navigation.
      await act(() => {
        fireEvent.change(input, { target: { value: "draft" } });
      });

      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowUp", metaKey: true });
      });
      expect(input.value).toBe("draft");

      await act(() => {
        fireEvent.keyDown(input, { key: "ArrowUp", altKey: true });
      });
      expect(input.value).toBe("draft");
    });
  });
});
