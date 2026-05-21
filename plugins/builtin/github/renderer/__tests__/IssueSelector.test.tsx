/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { IssueSelector } from "../components/IssueSelector";
import type { GitHubIssue } from "@shared/types/github";

const mockListIssues = vi.fn();

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    listIssues: (opts: unknown) => mockListIssues(opts),
  },
}));

vi.mock("@/hooks/useDebounce", () => ({
  useDebounce: (value: string) => value,
}));

const mockIssue = (overrides: Partial<GitHubIssue> = {}): GitHubIssue => ({
  number: 1,
  title: "Test issue",
  state: "OPEN",
  url: "https://github.com/test/repo/issues/1",
  updatedAt: "2025-01-01T00:00:00Z",
  author: { login: "testuser", avatarUrl: "" },
  commentCount: 0,
  assignees: [],
  ...overrides,
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
    let resolvePromise!: (value: { items: GitHubIssue[] }) => void;
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
    let resolveFirst!: (value: { items: GitHubIssue[] }) => void;
    let resolveSecond!: (value: { items: GitHubIssue[] }) => void;
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
    const input = screen.getByPlaceholderText("Search issues...");
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
    let resolveFirst!: (value: { items: GitHubIssue[] }) => void;
    let resolveSecond!: (value: { items: GitHubIssue[] }) => void;
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
    const input = screen.getByPlaceholderText("Search issues...");
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
    let resolveFirst!: (value: { items: GitHubIssue[] }) => void;
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
    const input = screen.getByPlaceholderText("Search issues...");
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
    let resolvePromise!: (value: { items: GitHubIssue[] }) => void;
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
    let resolveSecond!: (value: { items: GitHubIssue[] }) => void;
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
    let resolvePromise!: (value: { items: GitHubIssue[] }) => void;
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
    let resolveSecond!: (value: { items: GitHubIssue[] }) => void;
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
    let resolveFirst!: (value: { items: GitHubIssue[] }) => void;
    let resolveSecond!: (value: { items: GitHubIssue[] }) => void;
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
    const input = screen.getByPlaceholderText("Search issues...");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    await act(async () => resolveSecond({ items: [] }));

    await waitFor(() => {
      expect(screen.getByText("No issues found")).toBeDefined();
    });
  });

  it("removes stale attributes after fetch resolves", async () => {
    let resolveFirst!: (value: { items: GitHubIssue[] }) => void;
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
    let resolvePromise!: (value: { items: GitHubIssue[] }) => void;
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
});
