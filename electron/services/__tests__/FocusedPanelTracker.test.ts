import { describe, expect, it, vi } from "vitest";
import { FocusedPanelTracker } from "../FocusedPanelTracker.js";

const W1 = 1;
const W2 = 2;

function kindOf(tracker: FocusedPanelTracker) {
  return tracker.getCurrent().panel.kind;
}

describe("FocusedPanelTracker", () => {
  it("is null until a window has OS focus", () => {
    const tracker = new FocusedPanelTracker();
    tracker.report(10, W1, "p1", { kind: "terminal" });
    expect(kindOf(tracker)).toBeNull();

    tracker.setFocusedWindow(W1);
    expect(tracker.getCurrent()).toEqual({
      panel: { kind: "terminal", agent: false, worktreeId: null },
      workspaceId: "p1",
    });
  });

  it("goes null on window blur and restores the view's report on refocus", () => {
    const tracker = new FocusedPanelTracker();
    tracker.setFocusedWindow(W1);
    tracker.report(10, W1, "p1", { kind: "diff", worktreeId: "w" });

    tracker.blurWindow(W1);
    expect(kindOf(tracker)).toBeNull();
    tracker.setFocusedWindow(W1);
    expect(kindOf(tracker)).toBe("diff");
  });

  it("ignores a late blur from a window that already lost focus to another", () => {
    const tracker = new FocusedPanelTracker();
    tracker.report(10, W1, "p1", { kind: "diff" });
    tracker.report(20, W2, "p2", { kind: "browser" });
    tracker.setFocusedWindow(W1);
    tracker.setFocusedWindow(W2);
    tracker.blurWindow(W1);

    expect(kindOf(tracker)).toBe("browser");
  });

  it("lets Portal focus override the view's panel until it blurs", () => {
    const tracker = new FocusedPanelTracker();
    tracker.setFocusedWindow(W1);
    tracker.report(10, W1, "p1", { kind: "terminal", worktreeId: "w" });

    tracker.setPortalFocused(W1, true);
    expect(tracker.getCurrent()).toEqual({
      panel: { kind: "portal", agent: false, worktreeId: null },
      workspaceId: null,
    });
    tracker.setPortalFocused(W1, false);
    expect(kindOf(tracker)).toBe("terminal");
  });

  it("takes the newest report among the window's live views", () => {
    let cached = new Set<number>();
    const tracker = new FocusedPanelTracker({ isLiveSender: (id) => !cached.has(id) });
    tracker.setFocusedWindow(W1);
    tracker.report(10, W1, "p1", { kind: "terminal" });
    tracker.report(11, W1, "p2", { kind: "browser" });
    expect(kindOf(tracker)).toBe("browser");

    // The view just switched away from reports its blur late: it is cached.
    cached = new Set([10]);
    tracker.report(10, W1, "p1", { kind: null });
    expect(kindOf(tracker)).toBe("browser");
  });

  it("forgets a destroyed view and a closed window", () => {
    const tracker = new FocusedPanelTracker();
    tracker.setFocusedWindow(W1);
    tracker.report(10, W1, "p1", { kind: "file" });
    tracker.removeSender(10);
    expect(kindOf(tracker)).toBeNull();

    tracker.report(10, W1, "p1", { kind: "file" });
    tracker.setPortalFocused(W1, true);
    tracker.removeWindow(W1);
    tracker.setFocusedWindow(W1);
    expect(kindOf(tracker)).toBeNull();
  });

  it("notifies only on a change, and survives a throwing listener", () => {
    const tracker = new FocusedPanelTracker();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrower = vi.fn(() => {
      throw new Error("boom");
    });
    const listener = vi.fn();
    tracker.subscribe(thrower);
    const unsubscribe = tracker.subscribe(listener);
    tracker.setFocusedWindow(W1);
    tracker.report(10, W1, "p1", { kind: "file" });
    tracker.report(10, W1, "p1", { kind: "file", title: "ignored" });
    unsubscribe();
    tracker.report(10, W1, "p1", { kind: "diff" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(thrower).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
});
