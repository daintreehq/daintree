// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useReEntrySummary } from "../useReEntrySummary";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

function addEntry(
  overrides: Partial<{
    type: "success" | "error" | "info" | "warning";
    message: string;
    seenAsToast: boolean;
    context: { worktreeId?: string };
  }> = {}
) {
  useNotificationHistoryStore.getState().addEntry({
    type: overrides.type ?? "success",
    message: overrides.message ?? "Test",
    seenAsToast: overrides.seenAsToast,
    ...(overrides.context ? { context: overrides.context } : {}),
  });
}

function simulateBlurFocusCycle(blurDurationMs: number) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;

  act(() => {
    window.dispatchEvent(new Event("blur"));
  });

  now += blurDurationMs;

  act(() => {
    window.dispatchEvent(new Event("focus"));
  });

  Date.now = realNow;
}

describe("useReEntrySummary", () => {
  let hasFocusSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    hasFocusSpy.mockRestore();
  });

  it("returns not visible by default", () => {
    const { result } = renderHook(() => useReEntrySummary());
    expect(result.current.visible).toBe(false);
    expect(result.current.entries).toHaveLength(0);
  });

  it("shows summary on focus after 3+ seconds blur with unseen entries", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    addEntry({ type: "error", message: "Build failed" });
    addEntry({ type: "success", message: "Agent done" });

    const realNow = Date.now;
    const later = realNow() + 5000;
    Date.now = () => later;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.counts.error).toBe(1);
    expect(result.current.counts.success).toBe(1);
  });

  it("does not show summary when blur is less than 3 seconds", () => {
    const { result } = renderHook(() => useReEntrySummary());

    simulateBlurFocusCycle(1000);

    expect(result.current.visible).toBe(false);
  });

  it("does not show summary when no unseen entries exist", () => {
    const { result } = renderHook(() => useReEntrySummary());

    addEntry({ type: "success", message: "Seen", seenAsToast: true });

    simulateBlurFocusCycle(5000);

    expect(result.current.visible).toBe(false);
  });

  it("excludes already-summarized entries on subsequent focus", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "First batch" });

    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;

    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(1);

    act(() => {
      result.current.dismiss();
    });

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    now += 5000;
    addEntry({ type: "error", message: "Second batch" });

    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].message).toBe("Second batch");
  });

  it("calls markSummarized on the store", () => {
    renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "Test" });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries[0].summarized).toBe(true);
  });

  it("does not trigger when document.hasFocus() returns false", () => {
    hasFocusSpy.mockReturnValue(false);
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "Test" });

    simulateBlurFocusCycle(5000);

    expect(result.current.visible).toBe(false);
  });

  it("computes singleWorktreeId when all entries share one worktree", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "A", context: { worktreeId: "wt-1" } });
    addEntry({ type: "error", message: "B", context: { worktreeId: "wt-1" } });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.singleWorktreeId).toBe("wt-1");
  });

  it("returns null singleWorktreeId when entries span multiple worktrees", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "A", context: { worktreeId: "wt-1" } });
    addEntry({ type: "error", message: "B", context: { worktreeId: "wt-2" } });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.singleWorktreeId).toBeNull();
  });

  it("dismiss hides the summary", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "Test" });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.visible).toBe(false);
  });

  it("only includes entries created during the blur period", () => {
    const realNow = Date.now;
    let now = 10000;
    Date.now = () => now;

    const { result } = renderHook(() => useReEntrySummary());

    addEntry({ type: "info", message: "Old low-priority" });

    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    now += 1000;
    addEntry({ type: "error", message: "During blur" });

    now += 4000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].message).toBe("During blur");
  });
});
