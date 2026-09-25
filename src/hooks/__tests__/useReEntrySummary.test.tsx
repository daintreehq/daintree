// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useReEntrySummary } from "../useReEntrySummary";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: vi.fn(),
}));

function addEntry(
  overrides: Partial<{
    type: "success" | "error" | "info" | "warning";
    message: string;
    title: string;
    seenAsToast: boolean;
    context: { worktreeId?: string };
  }> = {}
) {
  useNotificationHistoryStore.getState().addEntry({
    type: overrides.type ?? "success",
    message: overrides.message ?? "Test",
    title: overrides.title,
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

  beforeEach(async () => {
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    vi.mocked(getCurrentViewStoreOrNull).mockReturnValue(null);
  });

  afterEach(() => {
    hasFocusSpy.mockRestore();
  });

  it("returns not visible by default", () => {
    const { result } = renderHook(() => useReEntrySummary());
    expect(result.current.visible).toBe(false);
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.rows).toHaveLength(0);
  });

  it("shows summary on focus after 3+ seconds blur with unseen entries", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    addEntry({
      type: "error",
      message: "Build failed",
      context: { worktreeId: "wt-1" },
    });
    addEntry({
      type: "success",
      message: "Agent done",
      context: { worktreeId: "wt-2" },
    });

    const realNow = Date.now;
    const later = realNow() + 5000;
    Date.now = () => later;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.rows[0]!.worstType).toBe("error");
    expect(result.current.rows[1]!.worstType).toBe("success");
  });

  it("does not show summary when blur is less than 3 seconds", () => {
    const { result } = renderHook(() => useReEntrySummary());

    simulateBlurFocusCycle(1000);

    expect(result.current.visible).toBe(false);
  });

  it("does not show summary when no unseen entries exist", () => {
    const { result } = renderHook(() => useReEntrySummary());

    addEntry({
      type: "success",
      message: "Seen",
      seenAsToast: true,
      context: { worktreeId: "wt-1" },
    });

    simulateBlurFocusCycle(5000);

    expect(result.current.visible).toBe(false);
  });

  it("excludes already-summarized entries on subsequent focus", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "First batch",
      context: { worktreeId: "wt-1" },
    });

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
    addEntry({
      type: "error",
      message: "Second batch",
      context: { worktreeId: "wt-1" },
    });

    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]!.message).toBe("Second batch");
  });

  it("calls markSummarized on the store", () => {
    renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Test",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    const storeEntries = useNotificationHistoryStore.getState().entries;
    expect(storeEntries[0]!.summarized).toBe(true);
  });

  it("does not trigger when document.hasFocus() returns false", () => {
    hasFocusSpy.mockReturnValue(false);
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Test",
      context: { worktreeId: "wt-1" },
    });

    simulateBlurFocusCycle(5000);

    expect(result.current.visible).toBe(false);
  });

  it("dismiss hides the summary", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Test",
      context: { worktreeId: "wt-1" },
    });

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

  it("groups entries by worktreeId and picks worst severity and highlight title", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "info",
      message: "Info message",
      title: "Info Title",
      context: { worktreeId: "wt-1" },
    });
    addEntry({
      type: "error",
      message: "Error message",
      title: "Error Title",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]!.worktreeId).toBe("wt-1");
    expect(result.current.rows[0]!.worstType).toBe("error");
    expect(result.current.rows[0]!.highlightTitle).toBe("Error Title");
    expect(result.current.rows[0]!.entryCount).toBe(2);
  });

  it("falls back to message when title is undefined", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "warning",
      message: "Warning fallback",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.highlightTitle).toBe("Warning fallback");
  });

  it("sorts rows by severity, then entry count, then worktree name", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "info",
      message: "A",
      context: { worktreeId: "wt-info" },
    });
    addEntry({
      type: "error",
      message: "B",
      context: { worktreeId: "wt-error" },
    });
    addEntry({
      type: "warning",
      message: "C",
      context: { worktreeId: "wt-warn" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.worstType).toBe("error");
    expect(result.current.rows[1]!.worstType).toBe("warning");
    expect(result.current.rows[2]!.worstType).toBe("info");
  });

  it("caps rows at 3 and sets overflowCount", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    for (let i = 0; i < 5; i++) {
      addEntry({
        type: "info",
        message: `Entry ${i}`,
        context: { worktreeId: `wt-${i}` },
      });
    }

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows).toHaveLength(3);
    expect(result.current.overflowCount).toBe(2);
  });

  it("resolves worktree name from current view store", async () => {
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
              name: "feature-xyz",
              isCurrent: false,
              worktreeId: "wt-1",
            },
          ],
        ]),
      }),
    } as ReturnType<typeof getCurrentViewStoreOrNull>);

    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Done",
      context: { worktreeId: "wt-1" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.worktreeName).toBe("feature-xyz");
  });

  it("names an unresolved worktree by the last segment of its path, not a prefix of it", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({
      type: "success",
      message: "Done",
      context: { worktreeId: "/Users/dev/Projects/atlas-api-worktrees/feature-rate-limits" },
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    // A worktree id is its path: its first twelve characters are the user's
    // home directory, the same for every worktree; its last segment is which.
    expect(result.current.rows[0]!.worktreeName).toBe("feature-rate-limits");
  });

  it("falls back to the path's last segment when the worktree name is empty", async () => {
    const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    vi.mocked(getCurrentViewStoreOrNull).mockReturnValue({
      getState: () => ({
        worktrees: new Map([
          [
            "/tmp/work/wt-one",
            {
              id: "/tmp/work/wt-one",
              path: "/tmp/work/wt-one",
              name: "",
              isCurrent: false,
              worktreeId: "/tmp/work/wt-one",
            },
          ],
        ]),
      }),
    } as ReturnType<typeof getCurrentViewStoreOrNull>);

    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "Done", context: { worktreeId: "/tmp/work/wt-one" } });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.worktreeName).toBe("wt-one");
  });

  it("sorts by name as tiebreaker when severity and count are equal", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "info", message: "Z", context: { worktreeId: "wt-zeta" } });
    addEntry({ type: "info", message: "A", context: { worktreeId: "wt-alpha" } });
    addEntry({ type: "info", message: "B", context: { worktreeId: "wt-beta" } });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.rows[0]!.worktreeId).toBe("wt-alpha");
    expect(result.current.rows[1]!.worktreeId).toBe("wt-beta");
    expect(result.current.rows[2]!.worktreeId).toBe("wt-zeta");
  });

  it("marks entries as summarized even when card is suppressed (no worktreeId)", () => {
    renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "No worktree" });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    const storeEntries = useNotificationHistoryStore.getState().entries;
    expect(storeEntries[0]!.summarized).toBe(true);
  });

  it("suppresses card when all entries lack worktreeId", () => {
    const { result } = renderHook(() => useReEntrySummary());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    addEntry({ type: "success", message: "No worktree" });

    const realNow = Date.now;
    Date.now = () => realNow() + 5000;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(false);
  });

  it("only includes entries created during the blur period", () => {
    const realNow = Date.now;
    let now = 10000;
    Date.now = () => now;

    const { result } = renderHook(() => useReEntrySummary());

    addEntry({
      type: "info",
      message: "Old low-priority",
      context: { worktreeId: "wt-old" },
    });

    now += 5000;
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    now += 1000;
    addEntry({
      type: "error",
      message: "During blur",
      context: { worktreeId: "wt-new" },
    });

    now += 4000;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    Date.now = realNow;

    expect(result.current.visible).toBe(true);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]!.message).toBe("During blur");
  });
});
