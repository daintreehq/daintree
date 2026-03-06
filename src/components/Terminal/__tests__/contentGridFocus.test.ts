import { describe, expect, it } from "vitest";
import { getMaximizedGroupFocusTarget } from "../contentGridFocus";
import type { TerminalInstance } from "@/store";

function createTerminal(id: string): TerminalInstance {
  return {
    id,
    type: "terminal",
    title: id,
    cwd: "/project",
    cols: 80,
    rows: 24,
    location: "grid",
  };
}

describe("getMaximizedGroupFocusTarget", () => {
  const groupPanels = [createTerminal("term-1"), createTerminal("term-2")];

  it("keeps the current focus when it is still in the maximized group", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: "term-2",
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "term-1",
    });

    expect(nextFocus).toBe("term-2");
  });

  it("falls back to the active tab when persisted focus is stale", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: "stale-panel",
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "term-2",
    });

    expect(nextFocus).toBe("term-2");
  });

  it("falls back to the first panel when active tab is unavailable", () => {
    const nextFocus = getMaximizedGroupFocusTarget({
      focusedId: null,
      groupId: "group-1",
      groupPanels,
      getActiveTabId: () => "missing-panel",
    });

    expect(nextFocus).toBe("term-1");
  });
});
