// @vitest-environment jsdom
import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { ReEntrySummary } from "../ReEntrySummary";
import type { ReEntrySummaryState, WorktreeRow } from "@/hooks/useReEntrySummary";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: vi.fn(),
}));

vi.stubGlobal(
  "requestAnimationFrame",
  (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
);
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

function makeEntry(overrides: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    id: "e1",
    type: "info",
    message: "test",
    timestamp: 1,
    seenAsToast: false,
    summarized: false,
    countable: true,
    archivedAt: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    worktreeId: "wt-1",
    worktreeName: "feature-test",
    worstType: "error" as NotificationHistoryEntry["type"],
    highlightTitle: "Build failed",
    entryCount: 2,
    ...overrides,
  };
}

function makeState(overrides: Partial<ReEntrySummaryState> = {}): ReEntrySummaryState {
  return {
    visible: true,
    entries: [],
    rows: [],
    overflowCount: 0,
    dismiss: vi.fn(),
    ...overrides,
  };
}

describe("ReEntrySummary", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    vi.mocked(getCurrentViewStoreOrNull).mockReturnValue({
      getState: () => ({
        worktrees: new Map([
          [
            "wt-1",
            {
              id: "wt-1",
              path: "/tmp/wt-1",
              name: "feature-test",
              isCurrent: false,
              worktreeId: "wt-1",
            },
          ],
          [
            "wt-2",
            {
              id: "wt-2",
              path: "/tmp/wt-2",
              name: "feature-other",
              isCurrent: false,
              worktreeId: "wt-2",
            },
          ],
          [
            "wt-42",
            {
              id: "wt-42",
              path: "/tmp/wt-42",
              name: "fix-bug",
              isCurrent: false,
              worktreeId: "wt-42",
            },
          ],
        ]),
      }),
    } as ReturnType<typeof getCurrentViewStoreOrNull>);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when state.visible is false", () => {
    const { container } = render(<ReEntrySummary state={makeState({ visible: false })} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders worktree rows with severity icon, name, and title", () => {
    const state = makeState({
      rows: [
        makeRow({
          worktreeId: "wt-1",
          worktreeName: "feature-foo",
          worstType: "error",
          highlightTitle: "Build failed",
        }),
        makeRow({
          worktreeId: "wt-2",
          worktreeName: "feature-bar",
          worstType: "warning",
          highlightTitle: "Tests flaky",
        }),
      ],
    });
    render(<ReEntrySummary state={state} />);
    expect(screen.getByText("While you were away")).toBeTruthy();
    expect(screen.getByText("feature-foo")).toBeTruthy();
    expect(screen.getByText("Build failed")).toBeTruthy();
    expect(screen.getByText("feature-bar")).toBeTruthy();
    expect(screen.getByText("Tests flaky")).toBeTruthy();
  });

  it("has role=status", () => {
    render(
      <ReEntrySummary
        state={makeState({
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("dismiss button calls dismiss", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    fireEvent.click(screen.getByLabelText("Dismiss summary"));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("Open Notifications button calls openNotificationCenter", async () => {
    const { useUIStore } = await import("@/store/uiStore");
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });

    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    fireEvent.click(screen.getByText("Open Notifications"));
    expect(openSpy).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("clicking a worktree row calls selectWorktree and dismiss", async () => {
    const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
    const selectSpy = vi.fn();
    useWorktreeSelectionStore.setState({ selectWorktree: selectSpy });

    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worktreeId: "wt-42", worktreeName: "fix-bug" })],
        })}
      />
    );
    fireEvent.click(screen.getByText("fix-bug"));
    expect(selectSpy).toHaveBeenCalledWith("wt-42");
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("renders +N more overflow row when overflowCount > 0", () => {
    const state = makeState({
      rows: [
        makeRow({ worktreeId: "wt-1", worktreeName: "a" }),
        makeRow({ worktreeId: "wt-2", worktreeName: "b" }),
        makeRow({ worktreeId: "wt-3", worktreeName: "c" }),
      ],
      overflowCount: 2,
    });
    render(<ReEntrySummary state={state} />);
    expect(screen.getByText("+2 more")).toBeTruthy();
  });

  it("overflow row opens notification center", async () => {
    const { useUIStore } = await import("@/store/uiStore");
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });

    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow()],
          overflowCount: 3,
        })}
      />
    );
    fireEvent.click(screen.getByText("+3 more"));
    expect(openSpy).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("auto-dismisses after 8 seconds", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    expect(dismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("pauses auto-dismiss on mouse enter and resumes on mouse leave", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    const card = screen.getByRole("status");

    fireEvent.mouseEnter(card);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(dismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(card);
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("pin button toggles aria-pressed and prevents auto-dismiss", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );

    const pinButton = screen.getByLabelText("Pin summary");
    expect(pinButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(pinButton);
    expect(pinButton.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("unpin resumes auto-dismiss behavior", () => {
    const dismiss = vi.fn();
    render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );

    const pinButton = screen.getByLabelText("Pin summary");
    fireEvent.click(pinButton);
    expect(pinButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(pinButton);
    expect(pinButton.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("resets pin state when summary goes invisible then reappears", () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ReEntrySummary
        state={makeState({
          visible: true,
          dismiss,
          rows: [makeRow({ worktreeId: "wt-1", highlightTitle: "First" })],
        })}
      />
    );

    fireEvent.click(screen.getByLabelText("Pin summary"));
    expect(screen.getByLabelText("Unpin summary").getAttribute("aria-pressed")).toBe("true");

    rerender(
      <ReEntrySummary
        state={makeState({
          visible: false,
          dismiss,
          rows: [],
        })}
      />
    );

    rerender(
      <ReEntrySummary
        state={makeState({
          visible: true,
          dismiss,
          rows: [makeRow({ worktreeId: "wt-2", highlightTitle: "Second" })],
        })}
      />
    );

    expect(screen.getByLabelText("Pin summary").getAttribute("aria-pressed")).toBe("false");
  });

  it("restarts auto-dismiss timer when rows change but entryCount stays the same", () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ReEntrySummary
        state={makeState({
          dismiss,
          entries: [makeEntry({ id: "a", message: "x" })],
          rows: [makeRow({ worktreeId: "wt-1", highlightTitle: "First" })],
        })}
      />
    );

    act(() => {
      vi.advanceTimersByTime(7000);
    });

    rerender(
      <ReEntrySummary
        state={makeState({
          dismiss,
          entries: [makeEntry({ id: "b", message: "y" })],
          rows: [makeRow({ worktreeId: "wt-2", highlightTitle: "Second" })],
        })}
      />
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not steal focus", () => {
    render(
      <ReEntrySummary
        state={makeState({
          rows: [makeRow({ worstType: "success", highlightTitle: "Done" })],
        })}
      />
    );
    const card = screen.getByRole("status");
    expect(document.activeElement).not.toBe(card);
  });
});
