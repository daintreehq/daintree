// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: vi.fn(),
  },
}));

import { TerminalSearchBar } from "../TerminalSearchBar";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("disposes the onDidChangeResults subscription on unmount", () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    const { unmount } = renderSearchBar();
    expect(mock._resultsListeners.length).toBe(1);

    unmount();
    expect(mock._resultsListeners.length).toBe(0);
  });
});
