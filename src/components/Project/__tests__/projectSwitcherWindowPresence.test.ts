import { describe, it, expect } from "vitest";
import { getNewWindowMenuLabel, getProjectSwitcherEnterHint } from "../ProjectSwitcherPalette";
import type {
  ProjectSwitcherProjectRow,
  ProjectSwitcherScratchRow,
} from "@/hooks/useProjectSwitcherPalette";

function projectRow(overrides: Partial<ProjectSwitcherProjectRow> = {}): ProjectSwitcherProjectRow {
  return {
    kind: "project",
    id: "p1",
    name: "Project",
    path: "/repo/p1",
    emoji: "🌲",
    lastOpened: 0,
    frecencyScore: 3,
    status: "background",
    isActive: false,
    isBackground: true,
    isMissing: false,
    isPinned: false,
    processCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    displayPath: "p1",
    section: "other",
    ...overrides,
  };
}

const scratchRow: ProjectSwitcherScratchRow = {
  kind: "scratch",
  id: "s1",
  name: "Scratch",
  path: "/scratch/s1",
  createdAt: 0,
  lastOpened: 0,
  isActive: false,
  processCount: 0,
  activeAgentCount: 0,
  waitingAgentCount: 0,
  blockedAgentCount: 0,
  completedAgentCount: 0,
  unacknowledgedCompletedAgentCount: 0,
  snoozedAgentCount: 0,
};

describe("getNewWindowMenuLabel (#12597)", () => {
  it("offers a new window for a project nobody holds", () => {
    expect(getNewWindowMenuLabel(projectRow())).toBe("Open in new window");
  });

  it("says where the item goes for a project another window owns", () => {
    // Under #12596 a new-window request for it brings the owner forward.
    for (const state of ["foreground", "activating", "cached"] as const) {
      expect(getNewWindowMenuLabel(projectRow({ openInOtherWindow: state }))).toBe("Go to window");
    }
  });

  it("offers nothing for a project this window already holds", () => {
    // The request would switch here — which clicking the row already does.
    expect(getNewWindowMenuLabel(projectRow({ isOpenInThisWindow: true }))).toBeNull();
  });

  it("keeps the current and missing rows' existing guards", () => {
    expect(getNewWindowMenuLabel(projectRow({ isActive: true }))).toBeNull();
    expect(getNewWindowMenuLabel(projectRow({ isMissing: true }))).toBeNull();
    expect(
      getNewWindowMenuLabel(projectRow({ isMissing: true, openInOtherWindow: "foreground" }))
    ).toBeNull();
  });
});

describe("getProjectSwitcherEnterHint (#12597)", () => {
  it("names nothing with nothing highlighted", () => {
    expect(getProjectSwitcherEnterHint(undefined, false, true)).toBeNull();
    expect(getProjectSwitcherEnterHint(undefined, true, true)).toBeNull();
  });

  it("keeps Switch and New window for a project nobody holds", () => {
    expect(getProjectSwitcherEnterHint(projectRow(), false, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    expect(getProjectSwitcherEnterHint(projectRow(), true, true)).toEqual({
      keys: "⌘↵",
      label: "New window",
    });
  });

  it("says Go to window on either key for a project another window owns", () => {
    const row = projectRow({ openInOtherWindow: "cached" });
    expect(getProjectSwitcherEnterHint(row, false, true)).toEqual({
      keys: "↵",
      label: "Go to window",
    });
    expect(getProjectSwitcherEnterHint(row, true, true)).toEqual({
      keys: "⌘↵",
      label: "Go to window",
    });
  });

  it("says Switch on either key for a project this window already holds", () => {
    const row = projectRow({ isOpenInThisWindow: true });
    expect(getProjectSwitcherEnterHint(row, true, true)).toEqual({ keys: "↵", label: "Switch" });
  });

  it("never promises a new window the keypress can't open", () => {
    // Each of these falls through to the plain switch in the keyboard handler.
    expect(getProjectSwitcherEnterHint(projectRow(), true, false)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    expect(getProjectSwitcherEnterHint(projectRow({ isActive: true }), true, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    expect(getProjectSwitcherEnterHint(projectRow({ isMissing: true }), true, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    expect(getProjectSwitcherEnterHint(scratchRow, true, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
  });

  it("never marks the current row as elsewhere, whatever presence says", () => {
    const row = projectRow({ isActive: true, openInOtherWindow: "foreground" });
    expect(getProjectSwitcherEnterHint(row, false, true)).toEqual({ keys: "↵", label: "Switch" });
  });

  it("keeps ↵ for an owned row when there is no new-window handler", () => {
    const row = projectRow({ openInOtherWindow: "foreground" });
    expect(getProjectSwitcherEnterHint(row, true, false)).toEqual({
      keys: "↵",
      label: "Go to window",
    });
  });
});
