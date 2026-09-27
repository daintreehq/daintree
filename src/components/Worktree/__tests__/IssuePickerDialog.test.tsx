/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { Issue } from "@shared/types/forge";
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
  forgeClient: {
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
  Dialog.Footer = ({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) => (
    <div data-testid="footer">
      {hint}
      {children}
    </div>
  );
  return { AppDialog: Dialog };
});

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  listIssuesMock.mockReset();
});

const worktree = { path: "/repo" } as WorktreeState;
const PLACEHOLDER = "Search issues by title or number...";

function renderDialog(
  props: Partial<React.ComponentProps<typeof IssuePickerDialog>> = {}
): ReturnType<typeof render> {
  return render(
    <IssuePickerDialog
      isOpen
      onClose={() => {}}
      worktree={worktree}
      onAttach={() => {}}
      onDetach={() => {}}
      {...props}
    />
  );
}

function makeIssue(number: number, title: string, state: Issue["state"] = "open"): Issue {
  return {
    number,
    title,
    body: "",
    url: `https://example.test/${number}`,
    state,
    rawState: state,
    updatedAt: Date.parse("2026-01-01T00:00:00Z"),
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
    author: { login: "tester", avatarUrl: "", rawData: null },
    assignees: [],
    labels: [],
    rawData: null,
  };
}

function input(): HTMLInputElement {
  return screen.getByPlaceholderText(PLACEHOLDER);
}

function liveStatus(container: HTMLElement): string {
  return container.querySelector('[role="status"][aria-live="polite"].sr-only')?.textContent ?? "";
}

/** Visible text only: the sr-only live region repeats the empty-state titles. */
const VISIBLE = { ignore: "script, style, .sr-only" };

/** Past the skeleton's minimum dwell, so the first results are on screen. */
const FIRST_PAINT_MS = 300;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("IssuePickerDialog empty states", () => {
  it("names the empty scope and offers the wider one", async () => {
    listIssuesMock.mockResolvedValue({ items: [] });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("No open issues", VISIBLE)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show all issues" }));
    await waitFor(() => {
      expect(listIssuesMock.mock.calls.some((call) => call[1]?.state === "all")).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText("This repository has no issues yet", VISIBLE)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Show all issues" })).toBeNull();
  });

  it("trims whitespace-only search before querying the API", async () => {
    listIssuesMock.mockResolvedValue({ items: [] });
    renderDialog();
    await waitFor(() => screen.getByText("No open issues", VISIBLE));

    fireEvent.change(input(), { target: { value: "   " } });

    await waitFor(
      () => {
        expect(listIssuesMock.mock.calls.every((call) => call[1]?.search === undefined)).toBe(true);
      },
      { timeout: 2000 }
    );
    expect(screen.getByText("No open issues", VISIBLE)).toBeTruthy();
  });

  it("scopes a no-match title to the filter and widens the search without losing the query", async () => {
    listIssuesMock.mockResolvedValue({ items: [] });
    renderDialog();
    await waitFor(() => screen.getByText("No open issues", VISIBLE));

    fireEvent.change(input(), { target: { value: "foobar" } });
    await waitFor(() => screen.getByText('No open issues match "foobar"', VISIBLE), {
      timeout: 2000,
    });

    fireEvent.click(screen.getByRole("button", { name: "Search all issues" }));
    await waitFor(() => {
      expect(
        listIssuesMock.mock.calls.some(
          (call) => call[1]?.state === "all" && call[1]?.search === "foobar"
        )
      ).toBe(true);
    });
    await waitFor(() => screen.getByText('No issues match "foobar"', VISIBLE));
    expect(input().value).toBe("foobar");
    expect(screen.queryByRole("button", { name: "Search all issues" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
  });
});

describe("IssuePickerDialog error recovery", () => {
  it("offers Retry that re-runs the same query and scope, and recovers", async () => {
    listIssuesMock.mockRejectedValueOnce(new Error("boom"));
    listIssuesMock.mockResolvedValue({ items: [makeIssue(7, "Recovered issue")] });
    const { container } = renderDialog();

    await waitFor(() => screen.getByText("Couldn't load issues", VISIBLE));
    expect(screen.getByText("boom", VISIBLE)).toBeTruthy();
    await waitFor(() => expect(liveStatus(container)).toBe("Couldn't load issues"));

    const callsBefore = listIssuesMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => screen.getByText("Recovered issue", VISIBLE));
    const retryCall = listIssuesMock.mock.calls[callsBefore];
    expect(retryCall?.[1]).toEqual({ search: undefined, state: "open" });
    expect(screen.queryByText("Couldn't load issues", VISIBLE)).toBeNull();
    expect(liveStatus(container)).toBe("1 open issue");
  });
});

describe("IssuePickerDialog keyboard contract", () => {
  it("wires the search field as a combobox over the listbox", async () => {
    listIssuesMock.mockResolvedValue({ items: [makeIssue(1, "One"), makeIssue(2, "Two")] });
    renderDialog();
    await waitFor(() => screen.getByText("Two", VISIBLE));

    const combobox = screen.getByRole("combobox");
    expect(combobox).toBe(input());
    const listbox = screen.getByRole("listbox");
    expect(combobox.getAttribute("aria-controls")).toBe(listbox.id);

    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    const activeId = combobox.getAttribute("aria-activedescendant");
    const active = activeId ? document.getElementById(activeId) : null;
    expect(active?.getAttribute("aria-selected")).toBe("true");
    expect(active?.textContent).toContain("Two");
    const selected = screen.getAllByRole("option").filter((o) => o.ariaSelected === "true");
    expect(selected).toHaveLength(1);
    for (const option of screen.getAllByRole("option")) {
      expect(option.tabIndex).toBe(-1);
    }
  });

  it("moves the cursor to the row the pointer is over, so only one row is highlighted", async () => {
    listIssuesMock.mockResolvedValue({ items: [makeIssue(1, "One"), makeIssue(2, "Two")] });
    renderDialog();
    await waitFor(() => screen.getByText("Two", VISIBLE));

    const [, second] = screen.getAllByRole("option");
    fireEvent.mouseMove(second!);
    const selected = screen.getAllByRole("option").filter((o) => o.ariaSelected === "true");
    expect(selected).toEqual([second]);
  });

  it("does not attach the previous query's result when Enter beats the debounce", async () => {
    vi.useFakeTimers();
    try {
      const onAttach = vi.fn();
      listIssuesMock.mockImplementation(async (_cwd: string, opts: { search?: string }) => ({
        items: opts.search === "42" ? [makeIssue(42, "Forty-two")] : [makeIssue(1, "First")],
      }));
      renderDialog({ onAttach });
      await flush(FIRST_PAINT_MS);
      expect(screen.getByText("First", VISIBLE)).toBeTruthy();

      fireEvent.change(input(), { target: { value: "42" } });
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(onAttach).not.toHaveBeenCalled();
      // The Enter ran the pending query at once rather than waiting out the debounce.
      await flush();
      expect(screen.getByText("Forty-two", VISIBLE)).toBeTruthy();

      fireEvent.keyDown(input(), { key: "Enter" });
      expect(onAttach).toHaveBeenCalledTimes(1);
      expect(onAttach.mock.calls[0]?.[0]?.number).toBe(42);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores Enter while an IME composition is active", async () => {
    const onAttach = vi.fn();
    listIssuesMock.mockResolvedValue({ items: [makeIssue(1, "One")] });
    renderDialog({ onAttach });
    await waitFor(() => screen.getByText("One", VISIBLE));

    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(onAttach).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it("keeps the query when the state filter changes, and fetches the new scope at once", async () => {
    vi.useFakeTimers();
    try {
      listIssuesMock.mockResolvedValue({ items: [makeIssue(1, "One")] });
      renderDialog();
      await flush(FIRST_PAINT_MS);
      fireEvent.change(input(), { target: { value: "crash" } });
      await flush(300);

      const callsBefore = listIssuesMock.mock.calls.length;
      const group = screen.getByRole("radiogroup", { name: "Issue state" });
      const closed = screen.getByRole("radio", { name: "Closed" });
      expect(group.contains(closed)).toBe(true);
      fireEvent.click(closed);
      await flush();

      const scopeCalls = listIssuesMock.mock.calls.slice(callsBefore).map((call) => call[1]);
      expect(scopeCalls).toEqual([{ search: "crash", state: "closed" }]);
      expect(closed.getAttribute("aria-checked")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("IssuePickerDialog linked issue", () => {
  it("names the linked issue in its unlink action and marks it in the list", async () => {
    const onDetach = vi.fn();
    listIssuesMock.mockResolvedValue({ items: [makeIssue(5, "Five"), makeIssue(9, "Nine")] });
    renderDialog({ currentIssueNumber: 9, onDetach });
    await waitFor(() => screen.getByText("Nine", VISIBLE));

    expect(screen.getByRole("heading").textContent).toBe("Change linked issue");
    const linkedRows = screen
      .getAllByRole("option")
      .filter((option) => option.textContent?.includes("Linked"));
    expect(linkedRows.map((row) => row.textContent?.includes("Nine"))).toEqual([true]);

    fireEvent.click(screen.getByRole("button", { name: "Unlink issue #9" }));
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("keeps the unlink action reachable when the list fails to load", async () => {
    listIssuesMock.mockRejectedValue(new Error("offline"));
    renderDialog({ currentIssueNumber: 9 });
    await waitFor(() => screen.getByText("Couldn't load issues", VISIBLE));
    expect(screen.getByRole("button", { name: "Unlink issue #9" })).toBeTruthy();
  });

  it("always offers a way out, linked or not", async () => {
    listIssuesMock.mockResolvedValue({ items: [] });
    renderDialog();
    await waitFor(() => screen.getByText("No open issues", VISIBLE));
    expect(screen.getByTestId("footer").textContent).toContain("Cancel");
    expect(screen.queryByRole("button", { name: /unlink/i })).toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("Attach issue");
  });
});

describe("IssuePickerDialog status announcements", () => {
  it("announces the committed result count and scope", async () => {
    listIssuesMock.mockResolvedValue({
      items: [makeIssue(1, "One", "closed"), makeIssue(2, "Two", "closed")],
    });
    const { container } = renderDialog();
    await waitFor(() => expect(liveStatus(container)).toBe("2 open issues"));
  });
});

describe("IssuePickerDialog stale behavior", () => {
  it("dims the listbox and marks it aria-busy until results answer the current query", async () => {
    vi.useFakeTimers();
    try {
      const issueA = makeIssue(1, "Issue A");
      const issueB = makeIssue(2, "Issue B");

      let resolveSlow: ((value: { items: Issue[] }) => void) | undefined;
      const slowPromise = new Promise<{ items: Issue[] }>((r) => {
        resolveSlow = r;
      });

      listIssuesMock.mockResolvedValueOnce({ items: [issueA] }).mockReturnValueOnce(slowPromise);

      renderDialog();
      await flush(FIRST_PAINT_MS);

      expect(screen.getByText("Issue A", VISIBLE)).toBeTruthy();
      expect(screen.getByRole("listbox").hasAttribute("aria-busy")).toBe(false);

      fireEvent.change(input(), { target: { value: "x" } });
      // Stale from the keystroke, not only once the fetch starts.
      expect(screen.getByRole("listbox").getAttribute("data-stale")).toBe("true");

      await flush(300);

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
      expect(screen.getByText("Issue B", VISIBLE)).toBeTruthy();
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

      let resolveX: ((value: { items: Issue[] }) => void) | undefined;
      const xPromise = new Promise<{ items: Issue[] }>((r) => {
        resolveX = r;
      });

      listIssuesMock
        .mockResolvedValueOnce({ items: [initial] })
        .mockReturnValueOnce(xPromise)
        .mockResolvedValueOnce({ items: [issueY] });

      renderDialog();
      await flush(FIRST_PAINT_MS);
      expect(screen.getByText("Initial", VISIBLE)).toBeTruthy();

      fireEvent.change(input(), { target: { value: "x" } });
      await flush(300);

      fireEvent.change(input(), { target: { value: "y" } });
      await flush(300);

      expect(screen.getByText("Issue Y", VISIBLE)).toBeTruthy();
      expect(screen.queryByText("Issue X", VISIBLE)).toBeNull();

      await act(async () => {
        resolveX?.({ items: [issueX] });
        await vi.runAllTimersAsync();
      });

      expect(screen.queryByText("Issue X", VISIBLE)).toBeNull();
      expect(screen.getByText("Issue Y", VISIBLE)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show prior-session results when the dialog reopens", async () => {
    vi.useFakeTimers();
    try {
      const issueA = makeIssue(1, "Issue A");
      const secondOpenPromise = new Promise<{ items: Issue[] }>(() => {});

      listIssuesMock.mockResolvedValueOnce({ items: [issueA] }).mockReturnValue(secondOpenPromise);

      const { rerender } = renderDialog();
      await flush(FIRST_PAINT_MS);
      expect(screen.getByText("Issue A", VISIBLE)).toBeTruthy();

      const props = {
        onClose: () => {},
        worktree,
        onAttach: () => {},
        onDetach: () => {},
      };
      rerender(<IssuePickerDialog isOpen={false} {...props} />);
      rerender(<IssuePickerDialog isOpen {...props} />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.queryByText("Issue A", VISIBLE)).toBeNull();
      expect(screen.queryByRole("listbox")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a slow response when the user has already typed past it", async () => {
    vi.useFakeTimers();
    try {
      const stale = makeIssue(1, "Stale foo result");

      let resolveFoo: ((value: { items: Issue[] }) => void) | undefined;
      const fooPromise = new Promise<{ items: Issue[] }>((r) => {
        resolveFoo = r;
      });

      listIssuesMock.mockResolvedValueOnce({ items: [] }).mockReturnValueOnce(fooPromise);

      renderDialog();
      await flush(FIRST_PAINT_MS);

      fireEvent.change(input(), { target: { value: "foo" } });
      await flush(300);

      fireEvent.change(input(), { target: { value: "foobar" } });

      await act(async () => {
        resolveFoo?.({ items: [stale] });
        await Promise.resolve();
      });

      expect(screen.queryByText("Stale foo result", VISIBLE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the empty-state title to the committed query, not the live input", async () => {
    vi.useFakeTimers();
    try {
      listIssuesMock.mockResolvedValue({ items: [] });

      renderDialog();
      await flush(FIRST_PAINT_MS);
      expect(screen.getByText("No open issues", VISIBLE)).toBeTruthy();

      fireEvent.change(input(), { target: { value: "foo" } });
      await flush(300);
      expect(screen.getByText('No open issues match "foo"', VISIBLE)).toBeTruthy();

      fireEvent.change(input(), { target: { value: "foobar" } });

      expect(screen.getByText('No open issues match "foo"', VISIBLE)).toBeTruthy();
      expect(screen.queryByText('No open issues match "foobar"', VISIBLE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
