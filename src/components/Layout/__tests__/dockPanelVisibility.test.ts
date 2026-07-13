import { describe, expect, it } from "vitest";
import { isDockPanelRendered, type DockPanelScope } from "../dockPanelVisibility";
import type { PtyPanelData, ReviewPanelData } from "@shared/types/panel";

function createDockPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/project",
    cols: 80,
    rows: 24,
    location: "dock",
    worktreeId: "wt-a",
    ...overrides,
  } as PtyPanelData;
}

function createScope(overrides: Partial<DockPanelScope> = {}): DockPanelScope {
  return {
    // The store keeps trash as a Map; `has` is all the predicate needs.
    trashedTerminals: new Map<string, unknown>(),
    helpTerminalId: null,
    activeWorktreeId: "wt-a",
    ...overrides,
  };
}

describe("isDockPanelRendered", () => {
  it("renders a docked panel belonging to the active worktree", () => {
    expect(isDockPanelRendered(createDockPanel("dock-1"), createScope())).toBe(true);
  });

  it("renders a global panel regardless of the active worktree", () => {
    const panel = createDockPanel("dock-1", { worktreeId: undefined });

    expect(isDockPanelRendered(panel, createScope({ activeWorktreeId: "wt-b" }))).toBe(true);
  });

  // #11065 — the dock filters other worktrees' panels out, but the offscreen
  // watchdog keeps `activeDockTerminalId` pointing at them so the popover can
  // reopen on the way back. Reading that stale pointer as a live popover strands
  // focus outside the maximized group.
  it("does not render a panel owned by a different worktree", () => {
    const panel = createDockPanel("dock-1", { worktreeId: "wt-a" });

    expect(isDockPanelRendered(panel, createScope({ activeWorktreeId: "wt-b" }))).toBe(false);
  });

  // Layout undo can restore a panel's location and the dock pointer without
  // lifting it out of the trash, so the trash check has to be part of "rendered".
  it("does not render a trashed panel", () => {
    const scope = createScope({ trashedTerminals: new Map([["dock-1", {}]]) });

    expect(isDockPanelRendered(createDockPanel("dock-1"), scope)).toBe(false);
  });

  it("does not render the help panel, which owns its own surface", () => {
    const scope = createScope({ helpTerminalId: "dock-1" });

    expect(isDockPanelRendered(createDockPanel("dock-1"), scope)).toBe(false);
  });

  it("does not render a panel that has moved back to the grid", () => {
    const panel = createDockPanel("dock-1", { location: "grid" });

    expect(isDockPanelRendered(panel, createScope())).toBe(false);
  });

  it("does not render a panel that no longer exists", () => {
    expect(isDockPanelRendered(undefined, createScope())).toBe(false);
  });

  it("does not render a panel kind the dock cannot host", () => {
    const panel: ReviewPanelData = {
      id: "dock-1",
      kind: "review",
      title: "Review",
      location: "dock",
      worktreeId: "wt-a",
    };

    expect(isDockPanelRendered(panel, createScope())).toBe(false);
  });
});
