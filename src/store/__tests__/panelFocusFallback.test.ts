/**
 * Where the keyboard lands when the pane holding it stops being visible.
 *
 * The dock popover is the case that motivated this (#11133): closing it used to
 * leave `focusedId` on the dismissed pane, which then kept eating keystrokes
 * from inside an aria-hidden parking container.
 */
import { describe, it, expect } from "vitest";
import { isVisibleGridPanel, pickDockCloseFocusId } from "../panelFocusFallback";

type Panel = Parameters<typeof isVisibleGridPanel>[0];

function panel(id: string, overrides: Partial<Panel> = {}): Panel {
  return { id, worktreeId: "wt-1", location: "grid", ...overrides } as Panel;
}

describe("isVisibleGridPanel", () => {
  it("accepts a grid panel in the active worktree", () => {
    expect(isVisibleGridPanel(panel("a"), "wt-1")).toBe(true);
  });

  it("accepts a legacy panel that carries no location", () => {
    expect(isVisibleGridPanel(panel("a", { location: undefined }), "wt-1")).toBe(true);
  });

  it.each(["dock", "trash", "background", "overlay"] as const)(
    "rejects a %s panel — the user cannot see it",
    (location) => {
      expect(isVisibleGridPanel(panel("a", { location }), "wt-1")).toBe(false);
    }
  );

  it("rejects a grid panel belonging to another worktree", () => {
    expect(isVisibleGridPanel(panel("a", { worktreeId: "wt-2" }), "wt-1")).toBe(false);
  });

  it("matches an unassigned panel against an unassigned worktree", () => {
    expect(isVisibleGridPanel(panel("a", { worktreeId: undefined }), null)).toBe(true);
    expect(isVisibleGridPanel(panel("a", { worktreeId: undefined }), "wt-1")).toBe(false);
  });
});

describe("pickDockCloseFocusId", () => {
  it("hands the keyboard back to the pane the user came from", () => {
    const id = pickDockCloseFocusId({
      panels: [panel("grid-1"), panel("grid-2"), panel("dock-1", { location: "dock" })],
      activeWorktreeId: "wt-1",
      previousFocusedId: "grid-2",
    });

    expect(id).toBe("grid-2");
  });

  it("falls back to the first visible grid pane when the previous one is gone", () => {
    const id = pickDockCloseFocusId({
      panels: [panel("grid-1"), panel("grid-2")],
      activeWorktreeId: "wt-1",
      previousFocusedId: "removed",
    });

    expect(id).toBe("grid-1");
  });

  it("never hands focus back to a pane that is itself hidden", () => {
    // A previous focus pointing at another dock pane, or at a pane in a
    // worktree the user has since left, is not a place the keyboard can go.
    const id = pickDockCloseFocusId({
      panels: [
        panel("dock-2", { location: "dock" }),
        panel("other-wt", { worktreeId: "wt-9" }),
        panel("grid-1"),
      ],
      activeWorktreeId: "wt-1",
      previousFocusedId: "dock-2",
    });

    expect(id).toBe("grid-1");
  });

  it("returns null when the active worktree has no visible grid pane", () => {
    const id = pickDockCloseFocusId({
      panels: [panel("dock-1", { location: "dock" }), panel("other-wt", { worktreeId: "wt-9" })],
      activeWorktreeId: "wt-1",
      previousFocusedId: "dock-1",
    });

    expect(id).toBeNull();
  });
});
