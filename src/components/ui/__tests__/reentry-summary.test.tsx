// @vitest-environment jsdom
import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { ReEntrySummary } from "../ReEntrySummary";
import type { ReEntrySummaryState } from "@/hooks/useReEntrySummary";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

vi.stubGlobal(
  "requestAnimationFrame",
  (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
);
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

function makeEntry(
  overrides: Partial<NotificationHistoryEntry> = {}
): NotificationHistoryEntry {
  return {
    id: crypto.randomUUID(),
    type: "success",
    message: "Test",
    timestamp: Date.now(),
    seenAsToast: false,
    summarized: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<ReEntrySummaryState> = {}): ReEntrySummaryState {
  return {
    visible: true,
    entries: [],
    counts: { warning: 0, error: 0, success: 0, info: 0 },
    singleWorktreeId: null,
    dismiss: vi.fn(),
    ...overrides,
  };
}

describe("ReEntrySummary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when state.visible is false", () => {
    const { container } = render(<ReEntrySummary state={makeState({ visible: false })} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders with correct counts for mixed entry types", () => {
    const state = makeState({
      counts: { warning: 1, error: 2, success: 3, info: 0 },
    });
    render(<ReEntrySummary state={state} />);
    expect(screen.getByText("While you were away")).toBeInTheDocument();
    expect(screen.getByText("2 failed")).toBeInTheDocument();
    expect(screen.getByText("1 waiting for input")).toBeInTheDocument();
    expect(screen.getByText("3 completed")).toBeInTheDocument();
  });

  it("has role=status", () => {
    render(<ReEntrySummary state={makeState({ counts: { warning: 0, error: 0, success: 1, info: 0 } })} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("dismiss button calls dismiss", () => {
    const dismiss = vi.fn();
    render(<ReEntrySummary state={makeState({ dismiss, counts: { warning: 0, error: 0, success: 1, info: 0 } })} />);
    fireEvent.click(screen.getByLabelText("Dismiss summary"));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("Open Notifications button calls openNotificationCenter", async () => {
    const { useUIStore } = await import("@/store/uiStore");
    const openSpy = vi.fn();
    useUIStore.setState({ openNotificationCenter: openSpy });

    const dismiss = vi.fn();
    render(<ReEntrySummary state={makeState({ dismiss, counts: { warning: 0, error: 0, success: 1, info: 0 } })} />);
    fireEvent.click(screen.getByText("Open Notifications"));
    expect(openSpy).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("Go to Worktree button appears only when singleWorktreeId is set", () => {
    const { rerender } = render(
      <ReEntrySummary state={makeState({ singleWorktreeId: null, counts: { warning: 0, error: 0, success: 1, info: 0 } })} />
    );
    expect(screen.queryByText("Go to Worktree")).not.toBeInTheDocument();

    rerender(
      <ReEntrySummary state={makeState({ singleWorktreeId: "wt-1", counts: { warning: 0, error: 0, success: 1, info: 0 } })} />
    );
    expect(screen.getByText("Go to Worktree")).toBeInTheDocument();
  });

  it("auto-dismisses after 8 seconds", () => {
    const dismiss = vi.fn();
    render(<ReEntrySummary state={makeState({ dismiss, counts: { warning: 0, error: 0, success: 1, info: 0 } })} />);
    expect(dismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("pauses auto-dismiss on mouse enter and resumes on mouse leave", () => {
    const dismiss = vi.fn();
    render(<ReEntrySummary state={makeState({ dismiss, counts: { warning: 0, error: 0, success: 1, info: 0 } })} />);
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

  it("shows info count with correct pluralization", () => {
    render(<ReEntrySummary state={makeState({ counts: { warning: 0, error: 0, success: 0, info: 1 } })} />);
    expect(screen.getByText("1 update")).toBeInTheDocument();
  });

  it("shows plural info count", () => {
    render(<ReEntrySummary state={makeState({ counts: { warning: 0, error: 0, success: 0, info: 3 } })} />);
    expect(screen.getByText("3 updates")).toBeInTheDocument();
  });

  it("does not contain autoFocus", () => {
    render(<ReEntrySummary state={makeState({ counts: { warning: 0, error: 0, success: 1, info: 0 } })} />);
    const card = screen.getByRole("status");
    expect(card).not.toHaveFocus();
  });
});
