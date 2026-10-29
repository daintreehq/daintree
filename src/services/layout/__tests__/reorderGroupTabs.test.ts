import { beforeEach, describe, expect, it, vi } from "vitest";

const pushLayoutSnapshot = vi.fn();
const reorderPanelsInGroup = vi.fn();
let tabGroups = new Map<string, { id: string; panelIds: string[] }>();

vi.mock("@/store/layoutUndoStore", () => ({
  useLayoutUndoStore: { getState: () => ({ pushLayoutSnapshot }) },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ tabGroups, reorderPanelsInGroup }) },
}));

import { reorderGroupTabsWithUndo } from "../reorderGroupTabs";

describe("reorderGroupTabsWithUndo", () => {
  beforeEach(() => {
    pushLayoutSnapshot.mockClear();
    reorderPanelsInGroup.mockClear();
    tabGroups = new Map([["g1", { id: "g1", panelIds: ["a", "b", "c"] }]]);
  });

  it("snapshots before applying a changed order", () => {
    const calls: string[] = [];
    pushLayoutSnapshot.mockImplementationOnce(() => calls.push("snapshot"));
    reorderPanelsInGroup.mockImplementationOnce(() => calls.push("reorder"));

    reorderGroupTabsWithUndo("g1", ["b", "a", "c"]);

    expect(calls).toEqual(["snapshot", "reorder"]);
    expect(reorderPanelsInGroup).toHaveBeenCalledWith("g1", ["b", "a", "c"]);
  });

  it("adds nothing when the order is unchanged", () => {
    reorderGroupTabsWithUndo("g1", ["a", "b", "c"]);
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
    expect(reorderPanelsInGroup).not.toHaveBeenCalled();
  });

  it("adds nothing when the panels do not match the group", () => {
    reorderGroupTabsWithUndo("g1", ["a", "b"]);
    reorderGroupTabsWithUndo("g1", ["a", "b", "x"]);
    reorderGroupTabsWithUndo("g1", ["a", "a", "b"]);
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
    expect(reorderPanelsInGroup).not.toHaveBeenCalled();
  });

  it("adds nothing for an unknown group", () => {
    reorderGroupTabsWithUndo("missing", ["a"]);
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
  });
});
