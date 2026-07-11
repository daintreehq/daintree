import { describe, expect, it } from "vitest";
import { getMaximizedGroupFocusTarget } from "../contentGridFocus";
import type { PtyPanelData } from "@shared/types/panel";

function createTerminal(id: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/project",
    cols: 80,
    rows: 24,
    location: "grid",
  } as PtyPanelData;
}

describe("getMaximizedGroupFocusTarget", () => {
  const groupPanels = [createTerminal("term-1"), createTerminal("term-2")];

  it("keeps the current focus when it is still in the maximized group", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: "term-2",
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "term-1",
      openDockPopoverId: null,
    });

    expect(nextFocus).toBe("term-2");
  });

  it("falls back to the active tab when persisted focus is stale", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: "stale-panel",
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "term-2",
      openDockPopoverId: null,
    });

    expect(nextFocus).toBe("term-2");
  });

  it("falls back to the first panel when active tab is unavailable", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: null,
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "missing-panel",
      openDockPopoverId: null,
    });

    expect(nextFocus).toBe("term-1");
  });

  it("enforces no target while the focused terminal's dock popover is open", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: "dock-1",
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "term-2",
      openDockPopoverId: "dock-1",
    });

    expect(nextFocus).toBeNull();
  });

  it("returns focus to the group once the dock popover closes", () => {
    const args = {
      focusedId: "dock-1",
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "term-2",
    };

    expect(getMaximizedGroupFocusTarget({ ...args, openDockPopoverId: "dock-1" })).toBeNull();
    // `closeDockTerminal` clears only `activeDockTerminalId`, leaving focus on
    // the closed dock terminal — enforcement resumes and reclaims the group.
    expect(getMaximizedGroupFocusTarget({ ...args, openDockPopoverId: null })).toBe("term-2");
  });

  it("still rescues stale focus while an unrelated dock popover is open", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: "stale-panel",
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "term-2",
      openDockPopoverId: "dock-1",
    });

    expect(nextFocus).toBe("term-2");
  });

  it("rescues absent focus rather than reading it as an open dock popover", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: null,
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "term-2",
      openDockPopoverId: null,
    });

    expect(nextFocus).toBe("term-2");
  });
});
