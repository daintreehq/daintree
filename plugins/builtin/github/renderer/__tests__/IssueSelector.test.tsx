/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IssueSelector } from "../components/IssueSelector";
import type { Issue } from "@shared/types/forge";

const mockListIssues = vi.fn();

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    listIssues: (cwd: unknown, opts: unknown) => mockListIssues({ cwd, ...(opts as object) }),
  },
}));

vi.mock("@/hooks/useDebounce", () => ({
  useDebounce: (value: string) => value,
}));

const mockIssue = (overrides: Partial<Issue> = {}): Issue => ({
  number: 1,
  title: "Test issue",
  body: "",
  state: "open",
  rawState: "OPEN",
  url: "https://github.com/test/repo/issues/1",
  author: { login: "testuser", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 0,
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
  ...overrides,
});

// `InlineStatusBanner` (the load-failure banner) reads the reduced-motion query,
// which jsdom does not implement.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("IssueSelector", () => {
  beforeEach(() => {
    mockListIssues.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const defaultProps = {
    projectPath: "/test/project",
    selectedIssue: null,
    onSelect: vi.fn(),
  };

  it("shows skeleton on initial open when loading and no issues exist", async () => {
    let resolvePromise!: (value: { items: Issue[] }) => void;
    mockListIssues.mockReturnValue(
      new Promise((r) => {
        resolvePromise = r;
      })
    );

    render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    });
    // Skeleton rows are aria-hidden, should be present
    const listbox = screen.getByRole("listbox");
    expect(listbox.querySelectorAll('[aria-hidden="true"] > div').length).toBeGreaterThan(0);

    // Resolve the promise
    await act(async () => resolvePromise({ items: [mockIssue()] }));
    await waitFor(() => {
      expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBeNull();
    });
    expect(screen.getByRole("option", { name: /test issue/i })).toBeDefined();
  });

  it("keeps existing rows visible with palette-results-stale class during refetch", async () => {
    let resolveFirst!: (value: { items: Issue[] }) => void;
    let resolveSecond!: (value: { items: Issue[] }) => void;
    mockListIssues
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        })
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveSecond = r;
        })
      );

    render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    // First fetch completes — rows render
    await act(async () =>
      resolveFirst({ items: [mockIssue({ number: 1, title: "First issue" })] })
    );
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /First issue/i })).toBeDefined();
    });

    // Type to trigger refetch
    const input = screen.getByPlaceholderText("Search issues");
    fireEvent.change(input, { target: { value: "bug" } });

    // Rows should still be visible, now with palette-results-stale
    await waitFor(() => {
      const listbox = screen.getByRole("listbox");
      expect(listbox.className).toContain("palette-results-stale");
      expect(listbox.getAttribute("data-stale")).toBe("true");
      expect(listbox.getAttribute("aria-busy")).toBe("true");
      // Skeleton must NOT be present during refetch (pulse animation absent)
      expect(listbox.querySelector(".animate-pulse-immediate")).toBeNull();
      expect(listbox.querySelector(".animate-pulse-delayed")).toBeNull();
      // Existing rows still visible
      expect(screen.getByRole("option", { name: /First issue/i })).toBeDefined();
    });

    // Second fetch completes — stale class removed
    await act(async () => resolveSecond({ items: [mockIssue({ number: 2, title: "Bug issue" })] }));
    await waitFor(() => {
      const listbox = screen.getByRole("listbox");
      expect(listbox.className).not.toContain("palette-results-stale");
      expect(listbox.getAttribute("data-stale")).toBeNull();
      expect(screen.getByRole("option", { name: /Bug issue/i })).toBeDefined();
    });
  });

  it("prevents stale response from overwriting newer results when visible", async () => {
    let resolveFirst!: (value: { items: Issue[] }) => void;
    let resolveSecond!: (value: { items: Issue[] }) => void;
    mockListIssues
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        })
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveSecond = r;
        })
      );

    render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    // First fetch starts, but don't resolve yet
    await waitFor(() => expect(mockListIssues).toHaveBeenCalledTimes(1));

    // Type to trigger second fetch (first hasn't resolved)
    const input = screen.getByPlaceholderText("Search issues");
    fireEvent.change(input, { target: { value: "x" } });

    // Second fetch is now in-flight. Resolve it first.
    await act(async () => resolveSecond({ items: [mockIssue({ number: 2, title: "Newer" })] }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Newer/i })).toBeDefined();
    });

    // Now resolve stale first fetch — it must NOT overwrite the newer results
    await act(async () => resolveFirst({ items: [mockIssue({ number: 1, title: "Stale" })] }));

    // Results should still be the newer ones
    expect(screen.getByRole("option", { name: /Newer/i })).toBeDefined();
    expect(screen.queryByRole("option", { name: /Stale/i })).toBeNull();
  });

  it("preserves existing rows on refetch failure", async () => {
    let resolveFirst!: (value: { items: Issue[] }) => void;
    let rejectSecond!: (reason: Error) => void;
    mockListIssues
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        })
      )
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectSecond = reject;
        })
      );

    render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await act(async () => resolveFirst({ items: [mockIssue({ number: 1, title: "Survives" })] }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Survives/i })).toBeDefined();
    });

    // Trigger refetch that will fail
    const input = screen.getByPlaceholderText("Search issues");
    fireEvent.change(input, { target: { value: "bug" } });

    await act(async () => rejectSecond(new Error("Network error")));

    // Existing rows preserved, loading ended, stale attributes removed
    await waitFor(() => {
      const listbox = screen.getByRole("listbox");
      expect(listbox.getAttribute("aria-busy")).toBeNull();
      expect(listbox.className).not.toContain("palette-results-stale");
      expect(listbox.getAttribute("data-stale")).toBeNull();
    });
    expect(screen.getByRole("option", { name: /Survives/i })).toBeDefined();
  });

  it("clears issues on close and does not restore stale results on reopen", async () => {
    let resolvePromise!: (value: { items: Issue[] }) => void;
    mockListIssues.mockReturnValue(
      new Promise((r) => {
        resolvePromise = r;
      })
    );

    render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await act(async () => resolvePromise({ items: [mockIssue({ title: "Should not survive" })] }));
    await waitFor(() => {
      expect(screen.getByRole("option")).toBeDefined();
    });

    // Close popover
    fireEvent.click(trigger);

    // Reopen — should start fresh with empty issues (skeleton, then fetch)
    let resolveSecond!: (value: { items: Issue[] }) => void;
    mockListIssues.mockReturnValue(
      new Promise((r) => {
        resolveSecond = r;
      })
    );

    fireEvent.click(trigger);

    // Skeleton should be present (no stale rows)
    await waitFor(() => {
      expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    });
    expect(screen.queryByRole("option", { name: /Should not survive/i })).toBeNull();

    await act(async () => resolveSecond({ items: [mockIssue({ title: "Fresh" })] }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Fresh/i })).toBeDefined();
    });
  });

  it("clears issues when projectPath changes", async () => {
    let resolvePromise!: (value: { items: Issue[] }) => void;
    mockListIssues.mockReturnValue(
      new Promise((r) => {
        resolvePromise = r;
      })
    );

    const { rerender } = render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await act(async () => resolvePromise({ items: [mockIssue({ title: "Repo A issue" })] }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Repo A issue/i })).toBeDefined();
    });

    // Change projectPath — should clear stale issues and refetch
    let resolveSecond!: (value: { items: Issue[] }) => void;
    mockListIssues.mockReturnValue(
      new Promise((r) => {
        resolveSecond = r;
      })
    );

    rerender(<IssueSelector {...defaultProps} projectPath="/test/project-b" />);

    // Old issues cleared, loading state active
    await waitFor(() => {
      expect(screen.queryByRole("option", { name: /Repo A issue/i })).toBeNull();
      expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    });

    await act(async () => resolveSecond({ items: [mockIssue({ title: "Repo B issue" })] }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Repo B issue/i })).toBeDefined();
    });
  });

  it("renders empty state when latest success returns no results", async () => {
    let resolveFirst!: (value: { items: Issue[] }) => void;
    let resolveSecond!: (value: { items: Issue[] }) => void;
    mockListIssues
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        })
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveSecond = r;
        })
      );

    render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await act(async () => resolveFirst({ items: [mockIssue()] }));
    await waitFor(() => {
      expect(screen.getByRole("option")).toBeDefined();
    });

    // Type query that returns empty
    const input = screen.getByPlaceholderText("Search issues");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    await act(async () => resolveSecond({ items: [] }));

    await waitFor(() => {
      expect(screen.getByText('No matches for "nonexistent"')).toBeDefined();
    });
  });

  it("removes stale attributes after fetch resolves", async () => {
    let resolveFirst!: (value: { items: Issue[] }) => void;
    mockListIssues.mockReturnValue(
      new Promise((r) => {
        resolveFirst = r;
      })
    );

    render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    // While loading, skeleton shown with aria-busy
    await waitFor(() => {
      expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    });

    await act(async () => resolveFirst({ items: [mockIssue()] }));

    await waitFor(() => {
      const listbox = screen.getByRole("listbox");
      expect(listbox.getAttribute("aria-busy")).toBeNull();
      expect(listbox.getAttribute("data-stale")).toBeNull();
      expect(listbox.className).not.toContain("palette-results-stale");
    });
  });

  it("renders no-open-issues message when popover opens with no results", async () => {
    let resolvePromise!: (value: { items: Issue[] }) => void;
    mockListIssues.mockReturnValue(
      new Promise((r) => {
        resolvePromise = r;
      })
    );

    render(<IssueSelector {...defaultProps} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    await act(async () => resolvePromise({ items: [] }));

    await waitFor(() => {
      expect(screen.getByText("No open issues")).toBeDefined();
    });
  });
  it("focuses the search field on open, so typing lands in it", async () => {
    mockListIssues.mockResolvedValue({ items: [] });

    render(<IssueSelector {...defaultProps} />);
    fireEvent.click(screen.getByRole("combobox"));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByPlaceholderText("Search issues"));
    });
  });

  it("moves a cursor with the arrow keys and commits the cursor row on Enter", async () => {
    const onSelect = vi.fn();
    mockListIssues.mockResolvedValue({
      items: [mockIssue({ number: 1, title: "First" }), mockIssue({ number: 2, title: "Second" })],
    });

    render(<IssueSelector {...defaultProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    const input = screen.getByPlaceholderText("Search issues");
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    });
    expect(input.getAttribute("aria-activedescendant")).toBe("issue-option-1");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ number: 2 }));
  });

  it("wraps the cursor rather than stopping at the ends", async () => {
    mockListIssues.mockResolvedValue({
      items: [mockIssue({ number: 1 }), mockIssue({ number: 2 }), mockIssue({ number: 3 })],
    });

    render(<IssueSelector {...defaultProps} />);
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

    const input = screen.getByPlaceholderText("Search issues");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")[2]?.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("keeps the clear affordance out of the trigger button", async () => {
    render(
      <TooltipProvider>
        <IssueSelector {...defaultProps} selectedIssue={mockIssue({ number: 7 })} />
      </TooltipProvider>
    );

    const clear = screen.getByRole("button", { name: "Clear the linked issue" });
    expect(screen.getByRole("combobox").contains(clear)).toBe(false);

    fireEvent.click(clear);
    expect(defaultProps.onSelect).toHaveBeenCalledWith(null);
  });
  it("says the load failed instead of claiming the repo has no open issues", async () => {
    let rejectFirst!: (reason: Error) => void;
    mockListIssues.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectFirst = reject;
      })
    );

    render(<IssueSelector {...defaultProps} />);
    fireEvent.click(screen.getByRole("combobox"));

    await act(async () => rejectFirst(new Error("Network error")));

    await waitFor(() => {
      expect(screen.getByText("Couldn't load issues")).toBeDefined();
    });
    expect(screen.queryByText("No open issues")).toBeNull();

    // And Retry actually refetches rather than only clearing the banner.
    let resolveRetry!: (value: { items: Issue[] }) => void;
    mockListIssues.mockReturnValueOnce(
      new Promise((r) => {
        resolveRetry = r;
      })
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await act(async () => resolveRetry({ items: [mockIssue({ title: "Back online" })] }));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Back online/i })).toBeDefined();
    });
    expect(screen.queryByText("Couldn't load issues")).toBeNull();
  });

  it("flags a failed refetch rather than leaving the previous rows looking current", async () => {
    let resolveFirst!: (value: { items: Issue[] }) => void;
    let rejectSecond!: (reason: Error) => void;
    mockListIssues
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        })
      )
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectSecond = reject;
        })
      );

    render(<IssueSelector {...defaultProps} />);
    fireEvent.click(screen.getByRole("combobox"));
    await act(async () => resolveFirst({ items: [mockIssue({ title: "Loaded earlier" })] }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Loaded earlier/i })).toBeDefined()
    );

    fireEvent.change(screen.getByPlaceholderText("Search issues"), { target: { value: "bug" } });
    await act(async () => rejectSecond(new Error("Network error")));

    await waitFor(() => {
      expect(screen.getByText("Couldn't load issues")).toBeDefined();
    });
    // The rows that did load stay — they are real issues — but the panel no
    // longer presents them as the answer to the query just typed.
    expect(screen.getByRole("option", { name: /Loaded earlier/i })).toBeDefined();
  });

  it("rewinds the cursor when a new query replaces the result set", async () => {
    mockListIssues.mockResolvedValueOnce({
      items: [1, 2, 3, 4, 5].map((n) => mockIssue({ number: n, title: `Issue ${n}` })),
    });

    render(<IssueSelector {...defaultProps} />);
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(5));

    const input = screen.getByPlaceholderText("Search issues");
    fireEvent.keyDown(input, { key: "End" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")[4]?.getAttribute("aria-selected")).toBe("true");
    });

    // One match, then the same five back. A cursor that was only clamped rather
    // than rewound would resurface on issue 5 instead of returning to the top.
    mockListIssues.mockResolvedValueOnce({ items: [mockIssue({ number: 9, title: "Only hit" })] });
    fireEvent.change(input, { target: { value: "only" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));

    mockListIssues.mockResolvedValueOnce({
      items: [1, 2, 3, 4, 5].map((n) => mockIssue({ number: n, title: `Issue ${n}` })),
    });
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(5));

    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("leaves a modified Enter to the dialog's submit shortcut", async () => {
    const onSelect = vi.fn();
    mockListIssues.mockResolvedValue({ items: [mockIssue({ number: 1 })] });

    render(<IssueSelector {...defaultProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));

    fireEvent.keyDown(screen.getByPlaceholderText("Search issues"), {
      key: "Enter",
      metaKey: true,
    });

    expect(onSelect).not.toHaveBeenCalled();
  });
});
