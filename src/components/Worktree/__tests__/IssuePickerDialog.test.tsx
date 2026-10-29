/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { Issue } from "@shared/types/forge";
import type { WorktreeState } from "@/types";
import { IssuePickerDialog } from "../IssuePickerDialog";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";

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
  type Action = { label: string; onClick: () => void };
  Dialog.Footer = ({
    hint,
    leadingAction,
    secondaryAction,
  }: {
    hint?: React.ReactNode;
    leadingAction?: Action;
    secondaryAction?: Action;
  }) => (
    <div data-testid="footer">
      {leadingAction && (
        <button type="button" onClick={leadingAction.onClick}>
          {leadingAction.label}
        </button>
      )}
      {hint}
      {secondaryAction && (
        <button type="button" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </button>
      )}
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
const PLACEHOLDER = "Search issues by title or number…";

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

  it("returns focus to the search when a focused Retry recovers", async () => {
    listIssuesMock.mockRejectedValueOnce(new Error("boom"));
    listIssuesMock.mockResolvedValue({ items: [makeIssue(7, "Recovered issue")] });
    renderDialog();

    const retry = await screen.findByRole("button", { name: "Retry" });
    // The search takes focus a beat after opening. Let that land first, so the
    // only thing that can put focus back on it below is the Retry handoff.
    await waitFor(() => expect(document.activeElement).toBe(input()));
    retry.focus();
    fireEvent.click(retry);

    await waitFor(() => screen.getByText("Recovered issue", VISIBLE));
    // The handoff runs in an effect after the commit that removes Retry, which
    // can trail the recovered row's appearance.
    await waitFor(() => expect(document.activeElement).toBe(input()));
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

  it("wraps the arrows at the ends and jumps with Home and End, leaving modified keys to the field", async () => {
    listIssuesMock.mockResolvedValue({
      items: [makeIssue(1, "One"), makeIssue(2, "Two"), makeIssue(3, "Three")],
    });
    renderDialog();
    await waitFor(() => screen.getByText("Three", VISIBLE));

    const combobox = screen.getByRole("combobox");
    const active = () =>
      document.getElementById(combobox.getAttribute("aria-activedescendant") ?? "")?.textContent;

    expect(active()).toContain("One");
    fireEvent.keyDown(combobox, { key: "ArrowUp" });
    expect(active()).toContain("Three");
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    expect(active()).toContain("One");
    fireEvent.keyDown(combobox, { key: "End" });
    expect(active()).toContain("Three");
    fireEvent.keyDown(combobox, { key: "Home" });
    expect(active()).toContain("One");

    // Shift+End selects the query text; the cursor stays put.
    expect(fireEvent.keyDown(combobox, { key: "End", shiftKey: true })).toBe(true);
    expect(active()).toContain("One");
  });

  it("leaves the navigation keys to the field while the loading skeleton shows", async () => {
    vi.useFakeTimers();
    try {
      listIssuesMock.mockResolvedValue({ items: [makeIssue(1, "One"), makeIssue(2, "Two")] });
      renderDialog();
      // Loaded, but still inside the skeleton's minimum dwell: no list on screen.
      await flush();
      expect(listIssuesMock).toHaveBeenCalled();
      expect(screen.queryByRole("listbox")).toBeNull();

      expect(fireEvent.keyDown(input(), { key: "End" })).toBe(true);
      expect(fireEvent.keyDown(input(), { key: "ArrowDown" })).toBe(true);

      await flush(FIRST_PAINT_MS);
      expect(screen.getByRole("listbox")).toBeTruthy();
      expect(fireEvent.keyDown(input(), { key: "End" })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves the cursor to the row the pointer is over, so only one row is highlighted", async () => {
    listIssuesMock.mockResolvedValue({ items: [makeIssue(1, "One"), makeIssue(2, "Two")] });
    renderDialog();
    await waitFor(() => screen.getByText("Two", VISIBLE));

    const [, second] = screen.getAllByRole("option");
    fireEvent.pointerMove(second!);
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

  it("offers the Enter hint only when there is an issue Enter can link", async () => {
    listIssuesMock.mockResolvedValueOnce({ items: [] });
    listIssuesMock.mockResolvedValue({ items: [makeIssue(1, "One")] });
    renderDialog();
    await waitFor(() => screen.getByText("No open issues", VISIBLE));
    expect(screen.getByTestId("footer").textContent).not.toContain("to link");

    fireEvent.click(screen.getByRole("button", { name: "Show all issues" }));
    await waitFor(() => screen.getByText("One", VISIBLE));
    expect(screen.getByTestId("footer").textContent).toContain("to link");
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

describe("IssuePickerDialog paging", () => {
  const pageOf = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => makeIssue(from + i, `Issue ${from + i}`));

  function deferred() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function activeOptionText(): string | null | undefined {
    const id = input().getAttribute("aria-activedescendant");
    return id ? document.getElementById(id)?.textContent : null;
  }

  it("never announces one page as the whole set, and offers the rest", async () => {
    listIssuesMock.mockResolvedValue({
      items: pageOf(1, 20),
      hasMore: true,
      nextCursor: "page-2",
      totalCount: 200,
    });
    const { container } = renderDialog();
    await waitFor(() => screen.getByText("Issue 20", VISIBLE));

    expect(liveStatus(container)).toBe("Showing 20 of 200 open issues");
    expect(screen.getByRole("option", { name: "Load more" })).toBeTruthy();
  });

  it.each([
    ["no total", undefined],
    ["a total no larger than what is shown", 2],
  ])("says more are available when the forge reports %s", async (_label, totalCount) => {
    listIssuesMock.mockResolvedValue({
      items: pageOf(1, 2),
      hasMore: true,
      nextCursor: "page-2",
      totalCount,
    });
    const { container } = renderDialog();
    await waitFor(() =>
      expect(liveStatus(container)).toBe("Showing 2 open issues, more available")
    );
  });

  it("offers no Load more once the forge says the set is complete", async () => {
    listIssuesMock.mockResolvedValue({
      items: pageOf(1, 2),
      hasMore: false,
      nextCursor: null,
      totalCount: 2,
    });
    const { container } = renderDialog();
    await waitFor(() => expect(liveStatus(container)).toBe("2 open issues"));
    expect(screen.queryByRole("option", { name: "Load more" })).toBeNull();
  });

  it("reaches Load more from the keyboard and lands the cursor on the first new issue", async () => {
    listIssuesMock
      .mockResolvedValueOnce({
        items: pageOf(1, 2),
        hasMore: true,
        nextCursor: "page-2",
        totalCount: 4,
      })
      .mockResolvedValueOnce({
        // Issue 2 moved between fetches and comes back on the next page.
        items: [makeIssue(2, "Issue 2"), ...pageOf(3, 2)],
        hasMore: false,
        nextCursor: null,
        totalCount: 4,
      });
    const { container } = renderDialog();
    await waitFor(() => screen.getByText("Issue 2", VISIBLE));
    expect(liveStatus(container)).toBe("Showing 2 of 4 open issues");

    const combobox = input();
    fireEvent.keyDown(combobox, { key: "End" });
    const loadMore = screen.getByRole("option", { name: "Load more" });
    expect(combobox.getAttribute("aria-activedescendant")).toBe(loadMore.id);
    expect(loadMore.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("footer").textContent).toContain("to load more");

    fireEvent.keyDown(combobox, { key: "Enter" });
    await waitFor(() => screen.getByText("Issue 4", VISIBLE));

    expect(listIssuesMock.mock.calls[1]?.[1]).toEqual({
      search: undefined,
      state: "open",
      cursor: "page-2",
    });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Issue 1"),
      expect.stringContaining("Issue 2"),
      expect.stringContaining("Issue 3"),
      expect.stringContaining("Issue 4"),
    ]);
    expect(liveStatus(container)).toBe("4 open issues");
    expect(activeOptionText()).toContain("Issue 3");
  });

  it("follows each page's cursor, dedups within a page, and keeps the last total it was told", async () => {
    listIssuesMock
      .mockResolvedValueOnce({
        items: pageOf(1, 2),
        hasMore: true,
        nextCursor: "c2",
        totalCount: 6,
      })
      .mockResolvedValueOnce({
        items: [makeIssue(3, "Issue 3"), makeIssue(3, "Issue 3"), makeIssue(4, "Issue 4")],
        hasMore: true,
        nextCursor: "c3",
        totalCount: 8,
      })
      .mockResolvedValueOnce({ items: pageOf(5, 2), hasMore: true, nextCursor: "c4" })
      .mockResolvedValueOnce({ items: pageOf(7, 1), hasMore: false, nextCursor: null });
    const { container } = renderDialog();
    await waitFor(() => screen.getByText("Issue 2", VISIBLE));
    expect(liveStatus(container)).toBe("Showing 2 of 6 open issues");

    const loadMore = () => screen.getByRole("option", { name: "Load more" });
    fireEvent.click(loadMore());
    await waitFor(() => expect(liveStatus(container)).toBe("Showing 4 of 8 open issues"));
    fireEvent.click(loadMore());
    await waitFor(() => expect(liveStatus(container)).toBe("Showing 6 of 8 open issues"));
    fireEvent.click(loadMore());
    await waitFor(() => expect(liveStatus(container)).toBe("7 open issues"));

    expect(listIssuesMock.mock.calls.slice(1).map((call) => call[1]?.cursor)).toEqual([
      "c2",
      "c3",
      "c4",
    ]);
    expect(screen.getAllByRole("option")).toHaveLength(7);
  });

  it("continues the committed search and filter", async () => {
    vi.useFakeTimers();
    try {
      listIssuesMock.mockResolvedValue({
        items: pageOf(1, 2),
        hasMore: true,
        nextCursor: "page-2",
      });
      renderDialog();
      await flush(FIRST_PAINT_MS);
      fireEvent.change(input(), { target: { value: "crash" } });
      await flush(300);
      fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
      await flush();

      const callsBefore = listIssuesMock.mock.calls.length;
      fireEvent.click(screen.getByRole("option", { name: "Load more" }));
      await flush();
      expect(listIssuesMock.mock.calls.slice(callsBefore).map((call) => call[1])).toEqual([
        { search: "crash", state: "closed", cursor: "page-2" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts one request however many times Load more is pressed", async () => {
    listIssuesMock.mockResolvedValueOnce({
      items: pageOf(1, 2),
      hasMore: true,
      nextCursor: "page-2",
    });
    listIssuesMock.mockReturnValueOnce(new Promise(() => {}));
    renderDialog();
    await waitFor(() => screen.getByText("Issue 2", VISIBLE));

    const loadMore = screen.getByRole("option", { name: "Load more" });
    fireEvent.keyDown(input(), { key: "End" });
    // In one batch, so no render lands between the presses: only the
    // synchronous guard stands between them and a second request.
    act(() => {
      loadMore.click();
      loadMore.click();
      fireEvent.keyDown(input(), { key: "Enter" });
    });

    await waitFor(() => expect(loadMore.getAttribute("aria-disabled")).toBe("true"));
    expect(listIssuesMock).toHaveBeenCalledTimes(2);
    // Enter does nothing while the page is in flight, so nothing claims it does.
    expect(screen.getByTestId("footer").textContent).not.toContain("to load more");
  });

  it("holds the loading copy back until the wait is long enough to need it", async () => {
    vi.useFakeTimers();
    try {
      const page = deferred();
      listIssuesMock
        .mockResolvedValueOnce({ items: pageOf(1, 2), hasMore: true, nextCursor: "page-2" })
        .mockReturnValueOnce(page.promise);
      renderDialog();
      await flush(FIRST_PAINT_MS);

      const loadMore = screen.getByRole("option", { name: "Load more" });
      fireEvent.click(loadMore);
      await flush(UI_DOHERTY_THRESHOLD - 50);
      expect(loadMore.textContent).toBe("Load more");
      await flush(100);
      expect(loadMore.textContent).toContain("Loading…");
      await flush(UI_STILL_WORKING_MS);
      expect(loadMore.textContent).toContain("Still working…");

      await act(async () => {
        page.resolve({ items: pageOf(3, 1), hasMore: true, nextCursor: "page-3" });
        await vi.runAllTimersAsync();
      });
      expect(screen.getByRole("option", { name: "Load more" }).textContent).toBe("Load more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves the cursor onto Load more under the pointer without taking focus from the search", async () => {
    listIssuesMock.mockResolvedValue({ items: pageOf(1, 2), hasMore: true, nextCursor: "page-2" });
    renderDialog();
    await waitFor(() => screen.getByText("Issue 2", VISIBLE));

    const loadMore = screen.getByRole("option", { name: "Load more" });
    fireEvent.pointerMove(loadMore);
    expect(input().getAttribute("aria-activedescendant")).toBe(loadMore.id);
    expect(screen.getAllByRole("option").filter((o) => o.ariaSelected === "true")).toEqual([
      loadMore,
    ]);
    // A cancelled mousedown is what keeps focus, and the arrow keys, in the search.
    expect(fireEvent.mouseDown(loadMore)).toBe(false);
  });

  it("keeps the rows when a page fails, and retries the same page from the same row", async () => {
    listIssuesMock
      .mockResolvedValueOnce({ items: pageOf(1, 2), hasMore: true, nextCursor: "page-2" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ items: pageOf(3, 1), hasMore: true, nextCursor: "page-3" });
    const { container } = renderDialog();
    await waitFor(() => screen.getByText("Issue 2", VISIBLE));

    fireEvent.click(screen.getByRole("option", { name: "Load more" }));
    const retry = await screen.findByRole("option", { name: /Couldn't load more issues.*Retry/ });
    expect(liveStatus(container)).toBe("Couldn't load more issues");
    expect(screen.getByText("Issue 1", VISIBLE)).toBeTruthy();
    expect(screen.getByText("Issue 2", VISIBLE)).toBeTruthy();
    fireEvent.keyDown(input(), { key: "End" });
    expect(screen.getByTestId("footer").textContent).toContain("to retry");

    fireEvent.click(retry);
    await waitFor(() => screen.getByText("Issue 3", VISIBLE));
    expect(listIssuesMock.mock.calls[2]?.[1]).toEqual(listIssuesMock.mock.calls[1]?.[1]);
    expect(listIssuesMock.mock.calls[2]?.[1]?.cursor).toBe("page-2");
    expect(liveStatus(container)).toBe("Showing 3 open issues, more available");
    expect(screen.getByRole("option", { name: "Load more" })).toBeTruthy();
  });

  it("keeps a valid cursor when the last page brings nothing new", async () => {
    const onAttach = vi.fn();
    listIssuesMock
      .mockResolvedValueOnce({ items: pageOf(1, 2), hasMore: true, nextCursor: "page-2" })
      .mockResolvedValueOnce({
        items: [makeIssue(2, "Issue 2")],
        hasMore: false,
        nextCursor: null,
      });
    renderDialog({ onAttach });
    await waitFor(() => screen.getByText("Issue 2", VISIBLE));

    fireEvent.keyDown(input(), { key: "End" });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("option", { name: "Load more" })).toBeNull());

    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(activeOptionText()).toContain("Issue 2");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ number: 2 }));
  });

  it("keeps the scroll position when a page is appended", async () => {
    const page = deferred();
    listIssuesMock
      .mockResolvedValueOnce({ items: pageOf(1, 2), hasMore: true, nextCursor: "page-2" })
      .mockReturnValueOnce(page.promise);
    renderDialog();
    await waitFor(() => screen.getByText("Issue 2", VISIBLE));

    const scroller = screen.getByRole("listbox").parentElement!;
    scroller.scrollTop = 120;
    fireEvent.click(screen.getByRole("option", { name: "Load more" }));
    await act(async () => {
      page.resolve({ items: pageOf(3, 2), hasMore: false, nextCursor: null });
    });
    await waitFor(() => screen.getByText("Issue 4", VISIBLE));
    expect(scroller.scrollTop).toBe(120);
  });

  it("stops promising Load more once a new query makes the rows stale", async () => {
    vi.useFakeTimers();
    try {
      listIssuesMock.mockResolvedValue({
        items: pageOf(1, 2),
        hasMore: true,
        nextCursor: "page-2",
      });
      renderDialog();
      await flush(FIRST_PAINT_MS);

      fireEvent.keyDown(input(), { key: "End" });
      expect(screen.getByTestId("footer").textContent).toContain("to load more");

      // Enter now re-runs the search rather than loading the old set's next page.
      fireEvent.change(input(), { target: { value: "crash" } });
      expect(screen.getByTestId("footer").textContent).not.toContain("to load more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a page that lands while a new query is still debouncing", async () => {
    vi.useFakeTimers();
    try {
      const page = deferred();
      listIssuesMock
        .mockResolvedValueOnce({ items: pageOf(1, 2), hasMore: true, nextCursor: "page-2" })
        .mockReturnValueOnce(page.promise)
        .mockResolvedValueOnce({
          items: [makeIssue(50, "Searched issue")],
          hasMore: false,
          nextCursor: null,
        });
      renderDialog();
      await flush(FIRST_PAINT_MS);

      fireEvent.click(screen.getByRole("option", { name: "Load more" }));
      fireEvent.change(input(), { target: { value: "searched" } });
      // The keystroke alone, before its fetch starts, retires the old set.
      await act(async () => {
        page.resolve({ items: pageOf(3, 2), hasMore: false, nextCursor: null });
      });
      expect(screen.queryByText("Issue 3", VISIBLE)).toBeNull();
      expect(screen.getByTestId("footer").textContent).not.toContain("to load more");

      await flush(300);
      expect(screen.getByText("Searched issue", VISIBLE)).toBeTruthy();
      expect(screen.getAllByRole("option")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
