// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    get: vi.fn(),
    ensureSearchAddon: vi.fn(),
    pinHistory: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TerminalSearchBar } from "../TerminalSearchBar";
import { createTerminalPaintPlane } from "@/services/TerminalInstanceService";
import { useTerminalSearchHistoryStore } from "@/store/terminalSearchHistoryStore";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

const terminalInstanceService = createTerminalPaintPlane();

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

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});

describe("TerminalSearchBar", () => {
  const unpinHistory = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    unpinHistory.mockClear();
    vi.mocked(terminalInstanceService.pinHistory).mockClear().mockReturnValue(unpinHistory);
    vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation(async (id) => {
      return terminalInstanceService.get(id)?.searchAddon ?? null;
    });
    useTerminalSearchHistoryStore.setState({
      searches: [],
      caseSensitive: false,
      regexEnabled: false,
      wholeWord: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useTerminalSearchHistoryStore.setState({
      searches: [],
      caseSensitive: false,
      regexEnabled: false,
      wholeWord: false,
    });
  });

  function renderSearchBar() {
    return render(<TerminalSearchBar terminalId="test-terminal" onClose={vi.fn()} />);
  }

  it("keeps the terminal's history resident while the bar is open (#14220)", () => {
    const { unmount } = renderSearchBar();
    expect(terminalInstanceService.pinHistory).toHaveBeenCalledWith("test-terminal");
    expect(unpinHistory).not.toHaveBeenCalled();

    unmount();
    expect(unpinHistory).toHaveBeenCalledTimes(1);
  });

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
    const input = screen.getByPlaceholderText("Find in terminal…");

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
    const input = screen.getByPlaceholderText("Find in terminal…");

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
    const input = screen.getByPlaceholderText("Find in terminal…");

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
    const input = screen.getByPlaceholderText("Find in terminal…");

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

  it("offers stepping only while there is something to step to", async () => {
    const mock = createMockManaged(false);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const next = screen.getByLabelText("Next match") as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    const input = screen.getByPlaceholderText("Find in terminal…");
    await act(() => {
      fireEvent.change(input, { target: { value: "nonexistent" } });
    });
    // While the query is still settling, stepping runs the search.
    expect((screen.getByLabelText("Next match") as HTMLButtonElement).disabled).toBe(false);
    await act(() => {
      vi.advanceTimersByTime(150);
    });
    // A search that found nothing leaves nothing to step through.
    expect((screen.getByLabelText("Next match") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Previous match") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets Enter press a focused option rather than running the search", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal…");
    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });
    mock.searchAddon.findNext.mockClear();

    const toggle = screen.getByLabelText("Match whole word");
    await act(async () => {
      fireEvent.keyDown(toggle, { key: "Enter" });
    });
    expect(mock.searchAddon.findNext).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(mock.searchAddon.findNext).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter to an IME composition in progress", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal…");
    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });
    mock.searchAddon.findNext.mockClear();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    });
    expect(mock.searchAddon.findNext).not.toHaveBeenCalled();
  });

  it('announces "No matches" when search finds nothing', async () => {
    const mock = createMockManaged(false);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal…");

    await act(() => {
      fireEvent.change(input, { target: { value: "nonexistent" } });
    });

    await act(() => {
      vi.advanceTimersByTime(150);
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("No matches");
  });

  describe("when the search addon cannot load", () => {
    async function typeQuery(value: string, regex = false) {
      renderSearchBar();
      const input = screen.getByPlaceholderText("Find in terminal…");
      if (regex) {
        await act(() => {
          fireEvent.click(screen.getByLabelText("Use regular expression"));
        });
      }
      await act(() => {
        fireEvent.change(input, { target: { value } });
      });
      await act(() => {
        vi.advanceTimersByTime(150);
      });
    }

    it("reports a rejected load as unavailable, not as no matches or an invalid regex", async () => {
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockRejectedValue(
        new Error("chunk failed to load")
      );

      await typeQuery("hello", true);

      const liveRegion = screen.getByRole("status");
      expect(liveRegion.textContent).toContain("Search failed");
      expect(liveRegion.textContent).not.toContain("No matches");
      expect(liveRegion.textContent).not.toContain("Invalid regex");
      expect(
        screen.getByPlaceholderText("Find in terminal…").getAttribute("aria-invalid")
      ).not.toBe("true");
    });

    it("reports a missing addon as unavailable", async () => {
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockResolvedValue(null);

      await typeQuery("hello");

      expect(screen.getByRole("status").textContent).toContain("Search failed");
    });

    it("keeps stepping available, explains the failure, and retries into a working search with counts", async () => {
      const mock = createMockManaged(true);
      // xterm reports the result from inside the search, so a retry that
      // subscribes after searching would lose this first count.
      mock.searchAddon.findNext.mockImplementation(() => {
        mock._fireResults({ resultIndex: 0, resultCount: 3 });
        return true;
      });
      let loadWorks = false;
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation(async () => {
        if (!loadWorks) throw new Error("chunk failed to load");
        return mock.searchAddon as never;
      });

      await typeQuery("hello");
      const failed = screen.getByRole("status").textContent ?? "";
      expect(failed).toContain("Search failed");
      expect(failed).toContain("Press Enter to try again");
      const input = screen.getByPlaceholderText("Find in terminal…");
      const noteId = input.getAttribute("aria-describedby");
      expect(noteId).toBeTruthy();
      expect(document.getElementById(noteId!)?.textContent).toContain("Press Enter to try again");

      loadWorks = true;
      const next = screen.getByLabelText("Next match");
      expect(next.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        fireEvent.click(next);
      });

      expect(mock.searchAddon.findNext).toHaveBeenCalledWith("hello", expect.anything());
      expect(screen.getByRole("status").textContent).toBe("1 of 3");
      expect(input.getAttribute("aria-describedby")).toBeNull();
    });

    it("does not let a late load failure overwrite a newer invalid pattern", async () => {
      let rejectLoad!: (error: Error) => void;
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectLoad = reject;
          })
      );

      await typeQuery("hello", true);
      await act(() => {
        fireEvent.change(screen.getByPlaceholderText("Find in terminal…"), {
          target: { value: "[" },
        });
      });
      await act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(screen.getByRole("status").textContent).toBe("Invalid regex");

      await act(async () => rejectLoad(new Error("chunk failed to load")));

      expect(screen.getByRole("status").textContent).toBe("Invalid regex");
    });

    it("does not let a late load failure announce itself over a query still being typed", async () => {
      let rejectLoad!: (error: Error) => void;
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectLoad = reject;
          })
      );

      await typeQuery("hello");
      await act(() => {
        fireEvent.change(screen.getByPlaceholderText("Find in terminal…"), {
          target: { value: "world" },
        });
      });
      await act(async () => rejectLoad(new Error("chunk failed to load")));

      expect(screen.getByRole("status").textContent).toBe("");
    });

    it("does not let a late load failure resurface after the field is cleared", async () => {
      let rejectLoad!: (error: Error) => void;
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectLoad = reject;
          })
      );

      await typeQuery("hello");
      await act(() => {
        fireEvent.change(screen.getByPlaceholderText("Find in terminal…"), {
          target: { value: "" },
        });
      });
      await act(async () => rejectLoad(new Error("chunk failed to load")));
      await act(() => {
        fireEvent.change(screen.getByPlaceholderText("Find in terminal…"), {
          target: { value: "h" },
        });
      });

      expect(screen.getByRole("status").textContent).toBe("");
    });

    it("still reports a pattern the engine rejects as an invalid regex", async () => {
      const mock = createMockManaged(true);
      mock.searchAddon.findNext.mockImplementation(() => {
        throw new Error("Invalid regular expression: /a(/: Unterminated group");
      });
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      await typeQuery("a", true);

      expect(screen.getByRole("status").textContent).toBe("Invalid regex");
    });
  });

  it('announces "Invalid regex" for invalid regex patterns', async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal…");

    const regexButton = screen.getByLabelText("Use regular expression");
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
    const input = screen.getByPlaceholderText("Find in terminal…");

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

  it("combines regex and wholeWord in findNext options", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal…");

    await act(() => {
      fireEvent.click(screen.getByLabelText("Use regular expression"));
    });
    await act(() => {
      fireEvent.click(screen.getByLabelText("Match whole word"));
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

  it("marks the input invalid and surfaces the regex engine's reason", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal…") as HTMLInputElement;

    await act(() => {
      fireEvent.click(screen.getByLabelText("Use regular expression"));
    });
    await act(() => {
      fireEvent.change(input, { target: { value: "[invalid" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");
    // Tooltip mock renders content inline; require the engine's own reason so
    // a regression that swallows validation.error and shows only the generic
    // fallback fails the test, without the pattern and flags it repeats.
    const renderedHtml = document.body.textContent ?? "";
    expect(renderedHtml).toMatch(/Unterminated character class/);
    expect(renderedHtml).not.toMatch(/Invalid regular expression: \//);
  });

  it("does not let a pending debounce overwrite an immediate toggle search", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal…");

    // User types — schedules the 150ms debounce
    await act(() => {
      fireEvent.change(input, { target: { value: "foo" } });
    });
    // Before the debounce fires, click whole-word — should cancel the
    // pending literal search and run an immediate {wholeWord: true} search.
    await act(() => {
      fireEvent.click(screen.getByLabelText("Match whole word"));
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
    const input = screen.getByPlaceholderText("Find in terminal…") as HTMLInputElement;

    await act(() => {
      fireEvent.click(screen.getByLabelText("Use regular expression"));
    });
    await act(() => {
      fireEvent.change(input, { target: { value: "[invalid" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");

    await act(() => {
      fireEvent.click(screen.getByLabelText("Use regular expression"));
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
      const input = screen.getByPlaceholderText("Find in terminal…") as HTMLInputElement;
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
      const input = screen.getByPlaceholderText("Find in terminal…") as HTMLInputElement;

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
      const input = screen.getByPlaceholderText("Find in terminal…") as HTMLInputElement;

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
      const input = screen.getByPlaceholderText("Find in terminal…");

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
      const input = screen.getByPlaceholderText("Find in terminal…");
      await act(() => {
        fireEvent.change(input, { target: { value: "world" } });
      });

      await act(() => {
        fireEvent.click(screen.getByLabelText("Close find bar"));
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
      const input = screen.getByPlaceholderText("Find in terminal…");
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
      const input = screen.getByPlaceholderText("Find in terminal…");

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
      const input = screen.getByPlaceholderText("Find in terminal…");

      await act(() => {
        fireEvent.change(input, { target: { value: "   " } });
      });
      await act(() => {
        fireEvent.click(screen.getByLabelText("Close find bar"));
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
        fireEvent.click(screen.getByLabelText("Match case"));
      });
      expect(useTerminalSearchHistoryStore.getState().caseSensitive).toBe(true);
      unmount();

      renderSearchBar();
      const toggle = screen.getByLabelText("Match case");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    });

    it("persists regex toggle state across mounts", async () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      const { unmount } = renderSearchBar();
      await act(() => {
        fireEvent.click(screen.getByLabelText("Use regular expression"));
      });
      expect(useTerminalSearchHistoryStore.getState().regexEnabled).toBe(true);
      unmount();

      renderSearchBar();
      const toggle = screen.getByLabelText("Use regular expression");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    });

    it("persists whole-word toggle state across mounts", async () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      const { unmount } = renderSearchBar();
      await act(() => {
        fireEvent.click(screen.getByLabelText("Match whole word"));
      });
      expect(useTerminalSearchHistoryStore.getState().wholeWord).toBe(true);
      unmount();

      renderSearchBar();
      const toggle = screen.getByLabelText("Match whole word");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    });

    it.each([
      ["Match case", "caseSensitive"],
      ["Use regular expression", "regexEnabled"],
      ["Match whole word", "wholeWord"],
    ] as const)(
      "%s keeps the toggles another bar changed while this one was open",
      async (label, key) => {
        const mock = createMockManaged(true);
        vi.mocked(terminalInstanceService.get).mockReturnValue(
          mock as unknown as ReturnType<typeof terminalInstanceService.get>
        );

        renderSearchBar();
        act(() => {
          useTerminalSearchHistoryStore.setState({
            caseSensitive: true,
            regexEnabled: true,
            wholeWord: true,
            [key]: false,
          });
        });
        await act(() => {
          fireEvent.click(screen.getByLabelText(label));
        });

        expect(useTerminalSearchHistoryStore.getState()).toMatchObject({
          caseSensitive: true,
          regexEnabled: true,
          wholeWord: true,
        });
      }
    );

    it("turning whole word off persists and searches without it", async () => {
      useTerminalSearchHistoryStore.setState({ searches: ["recent"], wholeWord: true });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      const { unmount } = renderSearchBar();
      await act(async () => Promise.resolve());
      await act(() => {
        fireEvent.click(screen.getByLabelText("Match whole word"));
      });

      expect(useTerminalSearchHistoryStore.getState().wholeWord).toBe(false);
      expect(screen.getByLabelText("Match whole word").getAttribute("aria-pressed")).toBe("false");
      const lastCall = mock.searchAddon.findNext.mock.calls.at(-1) as unknown[];
      expect(lastCall[0]).toBe("recent");
      expect(lastCall[1]).not.toHaveProperty("wholeWord", true);
      unmount();

      renderSearchBar();
      expect(screen.getByLabelText("Match whole word").getAttribute("aria-pressed")).toBe("false");
    });

    it("searches the restored query with the persisted whole-word toggle", async () => {
      useTerminalSearchHistoryStore.setState({ searches: ["recent"], wholeWord: true });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );

      renderSearchBar();
      await act(async () => Promise.resolve());

      expect(mock.searchAddon.findNext).toHaveBeenCalledWith(
        "recent",
        expect.objectContaining({ wholeWord: true })
      );
    });

    it("opens a bar over a given terminal with the whole-word toggle another pane set", async () => {
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );
      const { unmount } = renderSearchBar();
      await act(() => {
        fireEvent.click(screen.getByLabelText("Match whole word"));
      });
      unmount();

      const own = createMockManaged(true);
      render(
        <TerminalSearchBar
          search={{
            ensureSearchAddon: async () => own.searchAddon as never,
            getSearchAddon: () => own.searchAddon as never,
          }}
          onClose={vi.fn()}
        />
      );
      const toggle = screen.getByLabelText("Match whole word");
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    });

    it("runs one search and one store write per toggle click under StrictMode", async () => {
      useTerminalSearchHistoryStore.setState({ searches: ["recent"] });
      const mock = createMockManaged(true);
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        mock as unknown as ReturnType<typeof terminalInstanceService.get>
      );
      render(
        <StrictMode>
          <TerminalSearchBar terminalId="test-terminal" onClose={vi.fn()} />
        </StrictMode>
      );
      await act(async () => Promise.resolve());
      mock.searchAddon.findNext.mockClear();
      const writes = vi.fn();
      const unsubscribe = useTerminalSearchHistoryStore.subscribe(writes);

      for (const label of ["Match case", "Use regular expression", "Match whole word"]) {
        await act(() => {
          fireEvent.click(screen.getByLabelText(label));
        });
      }
      unsubscribe();

      expect(mock.searchAddon.findNext).toHaveBeenCalledTimes(3);
      expect(writes).toHaveBeenCalledTimes(3);
      const lastCall = mock.searchAddon.findNext.mock.calls.at(-1) as unknown[];
      expect(lastCall[1]).toMatchObject({
        caseSensitive: true,
        regex: true,
        wholeWord: true,
      });
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
      const input = screen.getByPlaceholderText("Find in terminal…") as HTMLInputElement;

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
      const input = screen.getByPlaceholderText("Find in terminal…") as HTMLInputElement;

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

  it("searches the terminal it is given rather than one the grid holds (#15332)", async () => {
    const mock = createMockManaged(true);
    const target = {
      ensureSearchAddon: vi.fn(async () => mock.searchAddon as never),
      getSearchAddon: vi.fn(() => mock.searchAddon as never),
    };
    vi.mocked(terminalInstanceService.ensureSearchAddon).mockClear();
    const view = render(<TerminalSearchBar search={target} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("Find in terminal…");
    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(mock.searchAddon.findNext).toHaveBeenCalledWith("hello", expect.anything());
    expect(terminalInstanceService.ensureSearchAddon).not.toHaveBeenCalled();
    expect(terminalInstanceService.pinHistory).not.toHaveBeenCalled();

    const next = createMockManaged(true);
    const { rerender } = view;
    rerender(
      <TerminalSearchBar
        search={{
          ensureSearchAddon: async () => next.searchAddon as never,
          getSearchAddon: () => next.searchAddon as never,
        }}
        onClose={vi.fn()}
      />
    );
    await act(async () => {});
    expect(next.searchAddon.findNext).toHaveBeenCalledWith("hello", expect.anything());

    rerender(<TerminalSearchBar search={target} onClose={vi.fn()} />);
    await act(() => {
      fireEvent.change(input, { target: { value: "" } });
    });
    expect(mock.searchAddon.clearDecorations).toHaveBeenCalled();
    expect(mock._resultsListeners).toHaveLength(1);
    cleanup();
    expect(mock._resultsListeners).toHaveLength(0);
  });

  describe("leaving a terminal (#16878)", () => {
    function mockTerminals() {
      const managed = { a: createMockManaged(true), b: createMockManaged(true) };
      vi.mocked(terminalInstanceService.get).mockImplementation(
        (id) =>
          managed[id as keyof typeof managed] as unknown as ReturnType<
            typeof terminalInstanceService.get
          >
      );
      return managed;
    }

    async function searchFor(term: string) {
      const input = screen.getByPlaceholderText("Find in terminal…");
      await act(() => {
        fireEvent.change(input, { target: { value: term } });
      });
      await act(() => {
        vi.advanceTimersByTime(150);
      });
    }

    it("clears the terminal it leaves, not the one it moves to", async () => {
      const managed = mockTerminals();
      const view = render(<TerminalSearchBar terminalId="a" onClose={vi.fn()} />);
      await searchFor("hello");
      expect(managed.a.searchAddon.findNext).toHaveBeenCalledWith("hello", expect.anything());
      managed.a.searchAddon.clearDecorations.mockClear();

      view.rerender(<TerminalSearchBar terminalId="b" onClose={vi.fn()} />);
      await act(async () => {});

      expect(managed.a.searchAddon.clearDecorations).toHaveBeenCalled();
      expect(managed.b.searchAddon.findNext).toHaveBeenCalledWith("hello", expect.anything());
      expect(managed.b.searchAddon.clearDecorations).not.toHaveBeenCalled();
    });

    it("clears its own highlights when it unmounts without a close", async () => {
      const managed = mockTerminals();
      const view = render(<TerminalSearchBar terminalId="a" onClose={vi.fn()} />);
      await searchFor("hello");
      managed.a.searchAddon.clearDecorations.mockClear();

      view.unmount();

      expect(managed.a.searchAddon.clearDecorations).toHaveBeenCalled();
      expect(managed.b.searchAddon.clearDecorations).not.toHaveBeenCalled();
    });

    type LoadedAddon = Awaited<ReturnType<typeof terminalInstanceService.ensureSearchAddon>>;

    // One load for "a", shared by everything that asks for it, as the service
    // shares it; "b" loads at once.
    function deferLoadOnA(managed: ReturnType<typeof mockTerminals>) {
      let settle!: { resolve: (addon: LoadedAddon) => void; reject: (error: Error) => void };
      const loadOnA = new Promise<LoadedAddon>((resolve, reject) => {
        settle = { resolve, reject };
      });
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation((id) =>
        id === "a" ? loadOnA : Promise.resolve(managed.b.searchAddon as unknown as LoadedAddon)
      );
      return settle;
    }

    async function leaveAWithASearchLoading(managed: ReturnType<typeof mockTerminals>) {
      const view = render(<TerminalSearchBar terminalId="a" onClose={vi.fn()} />);
      await searchFor("hello");
      view.rerender(<TerminalSearchBar terminalId="b" onClose={vi.fn()} />);
      await act(async () => {});
      expect(managed.b.searchAddon.findNext).toHaveBeenCalledWith("hello", expect.anything());
      managed.a.searchAddon.clearDecorations.mockClear();
    }

    it("drops a search whose addon loads after the bar has left that terminal", async () => {
      const managed = mockTerminals();
      const loadOnA = deferLoadOnA(managed);
      await leaveAWithASearchLoading(managed);

      await act(async () => loadOnA.resolve(managed.a.searchAddon as unknown as LoadedAddon));

      expect(managed.a.searchAddon.findNext).not.toHaveBeenCalled();
    });

    it("keeps a late failure on the terminal it left out of the next one's results", async () => {
      const managed = mockTerminals();
      const loadOnA = deferLoadOnA(managed);
      await leaveAWithASearchLoading(managed);

      await act(async () => loadOnA.reject(new Error("addon failed to load")));

      expect(screen.queryByText("No matches")).toBeNull();
      expect(screen.getByRole("status").textContent).not.toContain("Search failed");
      expect(managed.a.searchAddon.clearDecorations).not.toHaveBeenCalled();
    });
  });

  describe("a search still loading its addon (#17485)", () => {
    type LoadedAddon = Awaited<ReturnType<typeof terminalInstanceService.ensureSearchAddon>>;

    // One shared load, as the service shares it, opened on a remembered term
    // so the mount search is already waiting on it. As in the service, the
    // terminal holds no addon until the load succeeds.
    function openOnRememberedTerm(
      term: string,
      { strict = false, ...toggles }: { regexEnabled?: boolean; strict?: boolean } = {}
    ) {
      useTerminalSearchHistoryStore.setState({ searches: [term], ...toggles });
      const mock = createMockManaged(true);
      const managed: { searchAddon: typeof mock.searchAddon | null } = { searchAddon: null };
      vi.mocked(terminalInstanceService.get).mockReturnValue(
        managed as unknown as ReturnType<typeof terminalInstanceService.get>
      );
      let settle!: { resolve: () => void; reject: (error: Error) => void };
      const load = new Promise<LoadedAddon>((resolve, reject) => {
        settle = {
          resolve: () => {
            managed.searchAddon = mock.searchAddon;
            resolve(mock.searchAddon as unknown as LoadedAddon);
          },
          reject,
        };
      });
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation(() => load);
      const bar = <TerminalSearchBar terminalId="test-terminal" onClose={vi.fn()} />;
      const view = render(strict ? <StrictMode>{bar}</StrictMode> : bar);
      return { mock, settle, view, input: screen.getByPlaceholderText("Find in terminal…") };
    }

    it("draws nothing for a remembered term cleared before the addon loads", async () => {
      const { mock, settle, input } = openOnRememberedTerm("hello");

      await act(() => {
        fireEvent.change(input, { target: { value: "" } });
      });
      await act(async () => settle.resolve());

      expect(mock.searchAddon.findNext).not.toHaveBeenCalled();
    });

    it("keeps a late load failure of a cleared search out of the next query's status", async () => {
      const { settle, input } = openOnRememberedTerm("hello");

      await act(() => {
        fireEvent.change(input, { target: { value: "" } });
      });
      await act(async () => settle.reject(new Error("addon failed to load")));
      // An empty field shows no status at all; the next query, still in its
      // debounce, is where a stale failure would surface.
      await act(() => {
        fireEvent.change(input, { target: { value: "world" } });
      });

      expect(screen.getByRole("status").textContent).toBe("");
    });

    it("draws nothing for a term that became an invalid regex before the addon loads", async () => {
      const { mock, settle, input } = openOnRememberedTerm("abc", { regexEnabled: true });

      await act(() => {
        fireEvent.change(input, { target: { value: "abc[" } });
      });
      await act(() => {
        vi.advanceTimersByTime(150);
      });
      await act(async () => settle.resolve());

      expect(mock.searchAddon.findNext).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toBe("Invalid regex");
    });

    it("draws nothing for a remembered literal the regex toggle rejects before the addon loads", async () => {
      const { mock, settle } = openOnRememberedTerm("abc[");

      await act(() => {
        fireEvent.click(screen.getByLabelText("Use regular expression"));
      });
      expect(screen.getByRole("status").textContent).toBe("Invalid regex");
      await act(async () => settle.resolve());

      expect(mock.searchAddon.findNext).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toBe("Invalid regex");
    });

    it("reports a failed load for the query still in the field", async () => {
      const { settle } = openOnRememberedTerm("hello");

      await act(async () => settle.reject(new Error("addon failed to load")));

      expect(screen.getByRole("status").textContent).toContain("Search failed");
    });

    it("drops the old query once the field changes, even before the new search runs", async () => {
      const { mock, settle, input } = openOnRememberedTerm("hello");

      await act(() => {
        fireEvent.change(input, { target: { value: "help" } });
      });
      await act(async () => settle.resolve());
      expect(mock.searchAddon.findNext).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(mock.searchAddon.findNext).toHaveBeenCalledTimes(1);
      expect(mock.searchAddon.findNext).toHaveBeenCalledWith("help", expect.anything());
    });

    it("draws only the newest of two searches waiting on the same load", async () => {
      const { mock, settle, input } = openOnRememberedTerm("hello");

      await act(() => {
        fireEvent.change(input, { target: { value: "help" } });
      });
      await act(() => {
        vi.advanceTimersByTime(150);
      });
      await act(async () => settle.resolve());

      expect(mock.searchAddon.findNext).toHaveBeenCalledTimes(1);
      expect(mock.searchAddon.findNext).toHaveBeenCalledWith("help", expect.anything());
    });

    it("runs only the latest step pressed while the addon loads", async () => {
      const { mock, settle, input } = openOnRememberedTerm("hello");

      await act(() => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await act(() => {
        fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      });
      await act(async () => settle.resolve());

      expect(mock.searchAddon.findNext).not.toHaveBeenCalled();
      expect(mock.searchAddon.findPrevious).toHaveBeenCalledTimes(1);
      expect(mock.searchAddon.findPrevious).toHaveBeenCalledWith("hello", expect.anything());
    });

    it("searches the remembered term once under StrictMode", async () => {
      const { mock, settle } = openOnRememberedTerm("hello", { strict: true });

      await act(async () => settle.resolve());

      expect(mock.searchAddon.findNext).toHaveBeenCalledTimes(1);
      expect(mock.searchAddon.findNext).toHaveBeenCalledWith("hello", expect.anything());
    });

    it("drops a search still loading when the bar unmounts without a close", async () => {
      const { mock, settle, view } = openOnRememberedTerm("hello");

      view.unmount();
      await act(async () => settle.resolve());

      expect(mock.searchAddon.findNext).not.toHaveBeenCalled();
    });

    it("shows nothing from the last terminal while a replacement's addon loads", async () => {
      const a = createMockManaged(false);
      const b = createMockManaged(true);
      const managedB: { searchAddon: typeof b.searchAddon | null } = { searchAddon: null };
      let resolveB!: () => void;
      const loadOnB = new Promise<LoadedAddon>((resolve) => {
        resolveB = () => {
          managedB.searchAddon = b.searchAddon;
          resolve(b.searchAddon as unknown as LoadedAddon);
        };
      });
      vi.mocked(terminalInstanceService.get).mockImplementation(
        (id) =>
          (id === "a" ? a : managedB) as unknown as ReturnType<typeof terminalInstanceService.get>
      );
      vi.mocked(terminalInstanceService.ensureSearchAddon).mockImplementation((id) =>
        id === "a" ? Promise.resolve(a.searchAddon as unknown as LoadedAddon) : loadOnB
      );
      const view = render(<TerminalSearchBar terminalId="a" onClose={vi.fn()} />);
      await act(() => {
        fireEvent.change(screen.getByPlaceholderText("Find in terminal…"), {
          target: { value: "hello" },
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(screen.getByRole("status").textContent).toBe("No matches");

      view.rerender(<TerminalSearchBar terminalId="b" onClose={vi.fn()} />);
      await act(async () => {});
      expect(screen.getByRole("status").textContent).toBe("");

      await act(async () => resolveB());
      expect(b.searchAddon.findNext).toHaveBeenCalledWith("hello", expect.anything());
      expect(screen.getByRole("status").textContent).toBe("Found");
    });
  });

  it("keeps the last count and highlights up while the next query debounces", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );
    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal…");
    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    await act(() => {
      mock._fireResults({ resultIndex: 0, resultCount: 3 });
    });
    mock.searchAddon.clearDecorations.mockClear();

    await act(() => {
      fireEvent.change(input, { target: { value: "help" } });
    });

    expect(screen.getByRole("status").textContent).toBe("1 of 3");
    expect(mock.searchAddon.clearDecorations).not.toHaveBeenCalled();
    expect(mock.searchAddon.findNext).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(mock.searchAddon.findNext).toHaveBeenCalledTimes(2);
    expect(mock.searchAddon.findNext).toHaveBeenLastCalledWith("help", expect.anything());
  });

  it("keeps a typed query queued when ArrowDown has no newer history to recall", async () => {
    useTerminalSearchHistoryStore.setState({ searches: ["alpha"] });
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );
    renderSearchBar();
    await act(async () => {});
    const input = screen.getByPlaceholderText("Find in terminal…");

    await act(() => {
      fireEvent.change(input, { target: { value: "beta" } });
    });
    await act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    expect(mock.searchAddon.findNext).not.toHaveBeenCalledWith("beta", expect.anything());
    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    expect(mock.searchAddon.findNext).toHaveBeenLastCalledWith("beta", expect.anything());
  });
});
