/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { GitHubIssue } from "@shared/types/github";
import type { WorktreeState } from "@/types";
import { IssuePickerDialog } from "../IssuePickerDialog";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const { listIssuesMock } = vi.hoisted(() => ({
  listIssuesMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  githubClient: {
    listIssues: listIssuesMock,
  },
}));

vi.mock("@/components/ui/TruncatedTooltip", () => ({
  TruncatedTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useTruncationDetection", () => ({
  useTruncationDetection: () => ({ ref: () => {}, isTruncated: false }),
}));

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div data-testid="issue-picker-dialog">{children}</div> : null;
  Dialog.Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>;
  Dialog.CloseButton = () => <button type="button">close</button>;
  Dialog.Footer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { AppDialog: Dialog };
});

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  listIssuesMock.mockReset();
});

const worktree = { path: "/repo" } as WorktreeState;

function renderDialog() {
  return render(
    <IssuePickerDialog
      isOpen
      onClose={() => {}}
      worktree={worktree}
      onAttach={() => {}}
      onDetach={() => {}}
    />
  );
}

describe("IssuePickerDialog empty states", () => {
  it("renders zero-data EmptyState when no issues and no query", async () => {
    listIssuesMock.mockResolvedValue({ items: [] });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("No issues found");
    });
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.hasAttribute("aria-describedby")).toBe(false);
  });

  it("trims whitespace-only search before querying the API and shows zero-data copy", async () => {
    listIssuesMock.mockResolvedValue({ items: [] });
    renderDialog();
    await waitFor(() => screen.getByRole("status"));

    fireEvent.change(screen.getByPlaceholderText("Search issues by title or number..."), {
      target: { value: "   " },
    });

    await waitFor(
      () => {
        expect(listIssuesMock.mock.calls.some((call) => call[0]?.search === undefined)).toBe(true);
      },
      { timeout: 2000 }
    );
    expect(screen.getByRole("status").textContent).toContain("No issues found");
  });

  it("renders filtered-empty EmptyState with interpolated query", async () => {
    listIssuesMock.mockResolvedValue({ items: [] });
    renderDialog();
    await waitFor(() => screen.getByRole("status"));

    fireEvent.change(screen.getByPlaceholderText("Search issues by title or number..."), {
      target: { value: "foobar" },
    });

    await waitFor(
      () => {
        expect(screen.getByRole("status").textContent).toContain('No matches for "foobar"');
      },
      { timeout: 2000 }
    );
  });

  it("keeps the error state as a non-EmptyState banner", async () => {
    listIssuesMock.mockRejectedValue(new Error("boom"));
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText(/boom|Failed to load issues/)).toBeTruthy();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

function makeIssue(number: number, title: string): GitHubIssue {
  return {
    number,
    title,
    url: `https://example.test/${number}`,
    state: "OPEN",
    updatedAt: "2026-01-01T00:00:00Z",
    author: { login: "tester", avatarUrl: "" },
    assignees: [],
    commentCount: 0,
  };
}

describe("IssuePickerDialog stale behavior", () => {
  it("dims the listbox and marks it aria-busy during an in-flight refetch", async () => {
    vi.useFakeTimers();
    try {
      const issueA = makeIssue(1, "Issue A");
      const issueB = makeIssue(2, "Issue B");

      let resolveSlow: ((value: { items: GitHubIssue[] }) => void) | undefined;
      const slowPromise = new Promise<{ items: GitHubIssue[] }>((r) => {
        resolveSlow = r;
      });

      listIssuesMock
        .mockResolvedValueOnce({ items: [issueA] })
        .mockResolvedValueOnce({ items: [issueA] })
        .mockReturnValueOnce(slowPromise);

      renderDialog();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(screen.getByText("Issue A")).toBeTruthy();

      fireEvent.change(screen.getByPlaceholderText("Search issues by title or number..."), {
        target: { value: "x" },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      const listbox = screen.getByRole("listbox");
      expect(listbox.classList.contains("surface-stale")).toBe(true);
      expect(listbox.getAttribute("data-stale")).toBe("true");
      expect(listbox.getAttribute("aria-busy")).toBe("true");

      await act(async () => {
        resolveSlow?.({ items: [issueB] });
        await vi.runAllTimersAsync();
      });

      const finalListbox = screen.getByRole("listbox");
      expect(finalListbox.classList.contains("surface-stale")).toBe(false);
      expect(finalListbox.hasAttribute("data-stale")).toBe(false);
      expect(finalListbox.hasAttribute("aria-busy")).toBe(false);
      expect(screen.getByText("Issue B")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a stale response when a newer fetch already committed", async () => {
    vi.useFakeTimers();
    try {
      const initial = makeIssue(1, "Initial");
      const issueX = makeIssue(2, "Issue X");
      const issueY = makeIssue(3, "Issue Y");

      let resolveX: ((value: { items: GitHubIssue[] }) => void) | undefined;
      const xPromise = new Promise<{ items: GitHubIssue[] }>((r) => {
        resolveX = r;
      });

      listIssuesMock
        .mockResolvedValueOnce({ items: [initial] })
        .mockResolvedValueOnce({ items: [initial] })
        .mockReturnValueOnce(xPromise)
        .mockResolvedValueOnce({ items: [issueY] });

      renderDialog();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(screen.getByText("Initial")).toBeTruthy();

      fireEvent.change(screen.getByPlaceholderText("Search issues by title or number..."), {
        target: { value: "x" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      fireEvent.change(screen.getByPlaceholderText("Search issues by title or number..."), {
        target: { value: "y" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(screen.getByText("Issue Y")).toBeTruthy();
      expect(screen.queryByText("Issue X")).toBeNull();

      await act(async () => {
        resolveX?.({ items: [issueX] });
        await vi.runAllTimersAsync();
      });

      expect(screen.queryByText("Issue X")).toBeNull();
      expect(screen.getByText("Issue Y")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the empty-state title to the committed query, not the live input", async () => {
    vi.useFakeTimers();
    try {
      listIssuesMock.mockResolvedValue({ items: [] });

      renderDialog();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(screen.getByRole("status").textContent).toContain("No issues found");

      fireEvent.change(screen.getByPlaceholderText("Search issues by title or number..."), {
        target: { value: "foo" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(screen.getByRole("status").textContent).toContain('No matches for "foo"');

      fireEvent.change(screen.getByPlaceholderText("Search issues by title or number..."), {
        target: { value: "foobar" },
      });

      expect(screen.getByRole("status").textContent).toContain('No matches for "foo"');
      expect(screen.getByRole("status").textContent).not.toContain("foobar");
    } finally {
      vi.useRealTimers();
    }
  });
});
