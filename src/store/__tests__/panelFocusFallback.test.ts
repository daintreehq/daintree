/**
 * Where the keyboard lands when the pane holding it stops being visible.
 *
 * The dock popover is the case that motivated this (#11133): closing it used to
 * leave `focusedId` on the dismissed pane, which then kept eating keystrokes
 * from inside an aria-hidden parking container.
 */
import { describe, it, expect } from "vitest";
import {
  isVisibleGridPanel,
  isRenderedGridPanel,
  pickDockCloseFocusId,
  type GetPanelGroupInfo,
} from "../panelFocusFallback";

type Panel = Parameters<typeof isVisibleGridPanel>[0];

function panel(id: string, overrides: Partial<Panel> = {}): Panel {
  return { id, worktreeId: "wt-1", location: "grid", ...overrides } as Panel;
}

const ungrouped: GetPanelGroupInfo = () => undefined;

const baseOptions = {
  activeWorktreeId: "wt-1",
  maximizedId: null,
  maximizeTarget: null,
  getPanelGroupInfo: ungrouped,
};

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

/**
 * Grid membership is necessary but not sufficient — a background tab and a pane
 * behind a maximized one both still read as `location: "grid"`, and focusing
 * either one recreates #11133 from the other end.
 */
describe("isRenderedGridPanel", () => {
  it("accepts an ordinary grid pane with nothing maximized", () => {
    expect(isRenderedGridPanel(panel("a"), baseOptions)).toBe(true);
  });

  it("rejects a background tab of a grid tab group", () => {
    const grouped: GetPanelGroupInfo = () => ({ groupId: "g-1", activeTabId: "b" });

    expect(isRenderedGridPanel(panel("a"), { ...baseOptions, getPanelGroupInfo: grouped })).toBe(
      false
    );
    expect(isRenderedGridPanel(panel("b"), { ...baseOptions, getPanelGroupInfo: grouped })).toBe(
      true
    );
  });

  it("rejects every pane except the maximized one", () => {
    const maximized = {
      ...baseOptions,
      maximizedId: "b",
      maximizeTarget: { type: "panel", id: "b" } as const,
    };

    expect(isRenderedGridPanel(panel("a"), maximized)).toBe(false);
    expect(isRenderedGridPanel(panel("b"), maximized)).toBe(true);
  });

  it("follows maximizedId, not maximizeTarget, when the two disagree", () => {
    // ContentGrid renders the pane named by `maximizedId`. Layout undo restores
    // that half without the target, so a predicate keyed on the target would
    // reject the pane actually on screen and elect the hidden one instead.
    const desynced = {
      ...baseOptions,
      maximizedId: "b",
      maximizeTarget: { type: "panel", id: "a" } as const,
    };

    expect(isRenderedGridPanel(panel("b"), desynced)).toBe(true);
    expect(isRenderedGridPanel(panel("a"), desynced)).toBe(false);
  });

  it("does not filter at all when only one half of the maximize pair is set", () => {
    // ContentGrid maximizes only when both are set; anything else is a normal grid.
    const halfSet = { ...baseOptions, maximizedId: "b", maximizeTarget: null };

    expect(isRenderedGridPanel(panel("a"), halfSet)).toBe(true);
    expect(isRenderedGridPanel(panel("b"), halfSet)).toBe(true);
  });

  it("accepts the active tab of a maximized group and nothing else", () => {
    const getPanelGroupInfo: GetPanelGroupInfo = (id) =>
      id === "a" || id === "b" ? { groupId: "g-1", activeTabId: "b" } : undefined;
    const maximized = {
      ...baseOptions,
      getPanelGroupInfo,
      maximizedId: "b",
      maximizeTarget: { type: "group", id: "g-1" } as const,
    };

    expect(isRenderedGridPanel(panel("b"), maximized)).toBe(true);
    expect(isRenderedGridPanel(panel("a"), maximized)).toBe(false);
    expect(isRenderedGridPanel(panel("outside"), maximized)).toBe(false);
  });
});

describe("pickDockCloseFocusId", () => {
  it("hands the keyboard back to the pane the user came from", () => {
    const id = pickDockCloseFocusId({
      ...baseOptions,
      panels: [panel("grid-1"), panel("grid-2"), panel("dock-1", { location: "dock" })],
      previousFocusedId: "grid-2",
    });

    expect(id).toBe("grid-2");
  });

  it("falls back to the first rendered grid pane when the previous one is gone", () => {
    const id = pickDockCloseFocusId({
      ...baseOptions,
      panels: [panel("grid-1"), panel("grid-2")],
      previousFocusedId: "removed",
    });

    expect(id).toBe("grid-1");
  });

  it("never hands focus back to a pane that is itself hidden", () => {
    // A previous focus pointing at another dock pane, or at a pane in a worktree
    // the user has since left, is not a place the keyboard can go.
    const id = pickDockCloseFocusId({
      ...baseOptions,
      panels: [
        panel("dock-2", { location: "dock" }),
        panel("other-wt", { worktreeId: "wt-9" }),
        panel("grid-1"),
      ],
      previousFocusedId: "dock-2",
    });

    expect(id).toBe("grid-1");
  });

  it("prefers the maximized pane over an earlier pane hidden behind it", () => {
    const id = pickDockCloseFocusId({
      ...baseOptions,
      maximizedId: "grid-2",
      maximizeTarget: { type: "panel", id: "grid-2" },
      panels: [panel("grid-1"), panel("grid-2")],
      previousFocusedId: null,
    });

    expect(id).toBe("grid-2");
  });

  it("returns null when the active worktree has no rendered grid pane", () => {
    const id = pickDockCloseFocusId({
      ...baseOptions,
      panels: [panel("dock-1", { location: "dock" }), panel("other-wt", { worktreeId: "wt-9" })],
      previousFocusedId: "dock-1",
    });

    expect(id).toBeNull();
  });
});
