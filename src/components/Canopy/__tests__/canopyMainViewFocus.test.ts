import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { mainViewFocusedAgentId } from "../canopyMainViewFocus";

function agent(id: string, panel: Record<string, unknown> = {}) {
  return {
    id,
    kind: "terminal",
    location: "grid",
    worktreeId: "wt-1",
    detectedAgentId: "claude",
    ...panel,
  };
}

function seed(panels: ReturnType<typeof agent>[], focusedId: string | null, extra = {}) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((panel) => [panel.id, panel])) as never,
    focusedId,
    ...extra,
  });
}

describe("mainViewFocusedAgentId", () => {
  beforeEach(() => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
  });

  afterEach(() => {
    usePanelStore.setState({
      panelsById: {} as never,
      focusedId: null,
      tabGroups: new Map(),
      maximizedId: null,
      maximizeTarget: null,
      activeDockTerminalId: null,
    });
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
  });

  it("names the focused agent terminal on screen in the grid", () => {
    seed([agent("a")], "a");
    expect(mainViewFocusedAgentId()).toBe("a");
  });

  it("names nothing for no focus, a plain terminal, or a pane that isn't a terminal", () => {
    seed([agent("a")], null);
    expect(mainViewFocusedAgentId()).toBeNull();
    seed([agent("a", { detectedAgentId: undefined })], "a");
    expect(mainViewFocusedAgentId()).toBeNull();
    seed([agent("a", { kind: "browser" })], "a");
    expect(mainViewFocusedAgentId()).toBeNull();
    seed([], "gone");
    expect(mainViewFocusedAgentId()).toBeNull();
  });

  it("names nothing for an agent the main view doesn't show", () => {
    seed([agent("a", { worktreeId: "wt-2" })], "a");
    expect(mainViewFocusedAgentId()).toBeNull();
    seed([agent("a", { location: "trash" })], "a");
    expect(mainViewFocusedAgentId()).toBeNull();
    seed([agent("a", { location: "background" })], "a");
    expect(mainViewFocusedAgentId()).toBeNull();
  });

  it("names a group's tab only while it is the one on screen", () => {
    const group = { id: "g", location: "grid", worktreeId: "wt-1", panelIds: ["a", "b"] };
    seed([agent("a"), agent("b")], "a", {
      tabGroups: new Map([["g", { ...group, activeTabId: "b" }]]),
    });
    expect(mainViewFocusedAgentId()).toBeNull();
    // A stale active tab yields to the first member, as the grid draws it.
    usePanelStore.setState({ tabGroups: new Map([["g", { ...group, activeTabId: "left" }]]) });
    expect(mainViewFocusedAgentId()).toBe("a");
  });

  it("names nothing behind a maximized pane, and the maximized pane itself", () => {
    seed([agent("a"), agent("b")], "a", {
      maximizedId: "b",
      maximizeTarget: { type: "panel", id: "b" },
    });
    expect(mainViewFocusedAgentId()).toBeNull();
    usePanelStore.setState({ focusedId: "b" });
    expect(mainViewFocusedAgentId()).toBe("b");
  });

  it("names a docked agent only while its popover is open", () => {
    seed([agent("a", { location: "dock" })], "a");
    expect(mainViewFocusedAgentId()).toBeNull();
    usePanelStore.setState({ activeDockTerminalId: "a" });
    expect(mainViewFocusedAgentId()).toBe("a");
  });
});
