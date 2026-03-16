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

function createMockManaged(findNextResult = true) {
  return {
    searchAddon: {
      findNext: vi.fn(() => findNextResult),
      findPrevious: vi.fn(() => findNextResult),
      clearDecorations: vi.fn(),
    },
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
    renderSearchBar();
    const liveRegion = screen.getByRole("status");
    expect(liveRegion.getAttribute("aria-live")).toBe("polite");
    expect(liveRegion.getAttribute("aria-atomic")).toBe("true");
    expect(liveRegion.textContent).toBe("");
  });

  it('announces "Found" when search finds a match', async () => {
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
    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    // Enable regex mode
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

  it("clears announcement when search term is cleared", async () => {
    const mock = createMockManaged(true);
    vi.mocked(terminalInstanceService.get).mockReturnValue(
      mock as unknown as ReturnType<typeof terminalInstanceService.get>
    );

    renderSearchBar();
    const input = screen.getByPlaceholderText("Find in terminal");

    // Type to trigger search
    await act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await act(() => {
      vi.advanceTimersByTime(150);
    });

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("Found");

    // Clear the input
    await act(() => {
      fireEvent.change(input, { target: { value: "" } });
    });

    expect(liveRegion.textContent).toBe("");
  });
});
