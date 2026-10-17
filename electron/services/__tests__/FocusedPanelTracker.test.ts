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

  it("follows the view holding native focus, not the newest report", () => {
    let focused = 11;
    const tracker = new FocusedPanelTracker({ isFocused: (id) => id === focused });
    tracker.setFocusedWindow(W1);
    tracker.report(10, W1, "p1", { kind: "terminal" });
    tracker.report(11, W1, "p2", { kind: "browser" });
    // The view switched away from reports its blur late.
    tracker.report(10, W1, "p1", { kind: null });
    expect(kindOf(tracker)).toBe("browser");

    // A warm switch back to p1: its unchanged report is deduped by the
    // renderer, so only the focus edge tells the tracker.
    tracker.report(10, W1, "p1", { kind: "terminal" });
    focused = 11;
    tracker.refresh();
    expect(kindOf(tracker)).toBe("browser");
    focused = 10;
    tracker.refresh();
    expect(kindOf(tracker)).toBe("terminal");
  });

  it("falls back to the active view while a webview guest holds native focus", () => {
    const tracker = new FocusedPanelTracker({
      isFocused: () => false,
      isActive: (id) => id === 11,
    });
    tracker.setFocusedWindow(W1);
    tracker.report(11, W1, "p2", { kind: "browser" });
    tracker.report(10, W1, "p1", { kind: "diff" });

    expect(kindOf(tracker)).toBe("browser");
  });

  it("attributes the project when composing, so a late registration still counts", () => {
    let project: string | null = null;
    const tracker = new FocusedPanelTracker({ workspaceOf: () => project });
    tracker.setFocusedWindow(W1);
    tracker.report(10, W1, null, { kind: "file" });
    expect(tracker.getCurrent().workspaceId).toBeNull();

    project = "p1";
    tracker.refresh();
    expect(tracker.getCurrent().workspaceId).toBe("p1");
  });

  it("never attributes Portal focus to a project, even from the dock's chrome", () => {
    const tracker = new FocusedPanelTracker();
    tracker.setFocusedWindow(W1);
    tracker.report(10, W1, "p1", { kind: "portal" });

    expect(tracker.getCurrent()).toEqual({
      panel: { kind: "portal", agent: false, worktreeId: null },
      workspaceId: null,
    });
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

  describe("views attached from another machine", () => {
    it("lets the newest screen decide, its 'no panel' included", () => {
      const tracker = new FocusedPanelTracker();
      tracker.reportRemote(-1, "pa", { kind: "terminal" }, true);
      expect(kindOf(tracker)).toBe("terminal");
      // Another Shell's screen focuses its sidebar: nothing, not the first terminal.
      tracker.reportRemote(-2, "pb", { kind: null }, true);
      expect(kindOf(tracker)).toBeNull();
      // This machine's own screen then takes focus with a diff.
      tracker.report(10, W1, "p1", { kind: "diff" });
      tracker.setFocusedWindow(W1);
      expect(tracker.getCurrent().workspaceId).toBe("p1");
      tracker.reportRemote(-1, "pa", { kind: "browser" }, true);
      expect(kindOf(tracker)).toBe("browser");
    });

    it("counts a remote screen only while its Shell says it is focused", () => {
      const tracker = new FocusedPanelTracker();
      tracker.setFocusedWindow(W1);
      tracker.report(10, W1, "p1", { kind: "diff" });
      tracker.reportRemote(-1, "pa", { kind: "terminal" }, true);
      expect(kindOf(tracker)).toBe("terminal");
      tracker.reportRemote(-1, "pa", { kind: "terminal" }, false);
      expect(kindOf(tracker)).toBe("diff");
      tracker.reportRemote(-1, "pa", { kind: "terminal" }, true);
      tracker.removeRemote(-1);
      expect(kindOf(tracker)).toBe("diff");
    });

    it("treats this machine's Portal gaining focus as its newest activity", () => {
      const tracker = new FocusedPanelTracker();
      tracker.setFocusedWindow(W1);
      tracker.reportRemote(-1, "pa", { kind: "terminal" }, true);
      tracker.setPortalFocused(W1, true);
      expect(kindOf(tracker)).toBe("portal");
    });
  });
});
