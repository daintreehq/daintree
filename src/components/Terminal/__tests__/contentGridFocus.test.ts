import { describe, expect, it, beforeEach } from "vitest";
import { getMaximizedGroupFocusTarget, enterFocusedPanel } from "../contentGridFocus";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";
import { useMacroFocusStore } from "@/store/macroFocusStore";
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
    // `closeDockTerminal` now hands focus back itself (#11133), but this stays
    // the backstop for focus left on a dock pane by any other route — persisted
    // state, a crash mid-close — so enforcement still reclaims the group.
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

describe("enterFocusedPanel (#11109)", () => {
  beforeEach(() => {
    useMacroFocusStore.setState({ focusedRegion: "grid" });
  });

  it("releases the macro region once a live target takes focus", () => {
    const cleanup = registerPanelFocusHandler("panel-1", () => true);

    expect(enterFocusedPanel("panel-1")).toBe(true);
    expect(useMacroFocusStore.getState().focusedRegion).toBeNull();

    cleanup();
  });

  it("keeps the macro region armed when the panel declines the handoff", () => {
    // A panel whose focus target is not mounted yet declines. Releasing the
    // region here would leave DOM focus on the grid with the arrow keys no
    // longer handled — Enter would silently kill grid navigation.
    const cleanup = registerPanelFocusHandler("panel-1", () => false);

    expect(enterFocusedPanel("panel-1")).toBe(false);
    expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");

    cleanup();
  });

  it("keeps the macro region armed for a panel that never registered", () => {
    expect(enterFocusedPanel("panel-unknown")).toBe(false);
    expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
  });

  it("does nothing when no panel holds focus", () => {
    expect(enterFocusedPanel(null)).toBe(false);
    expect(useMacroFocusStore.getState().focusedRegion).toBe("grid");
  });
});
