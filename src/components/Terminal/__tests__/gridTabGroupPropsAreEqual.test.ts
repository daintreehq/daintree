import { describe, it, expect } from "vitest";
import { gridTabGroupPropsAreEqual, type GridTabGroupProps } from "../GridTabGroup";
import type { TerminalInstance } from "@/store";
import type { TabGroup } from "@/types";

const baseGroup: TabGroup = {
  id: "g-1",
  location: "grid",
  worktreeId: "wt-1",
  activeTabId: "t-1",
  panelIds: ["t-1", "t-2"],
};

const basePanel: TerminalInstance = {
  id: "t-1",
  title: "Terminal 1",
  location: "grid",
  kind: "terminal",
} as TerminalInstance;

const basePanel2: TerminalInstance = {
  id: "t-2",
  title: "Terminal 2",
  location: "grid",
  kind: "terminal",
} as TerminalInstance;

function baseProps(overrides: Partial<GridTabGroupProps> = {}): GridTabGroupProps {
  return {
    group: baseGroup,
    panels: [basePanel, basePanel2],
    focusedId: "t-1",
    gridPanelCount: 4,
    gridCols: 2,
    isMaximized: false,
    ...overrides,
  };
}

describe("gridTabGroupPropsAreEqual", () => {
  it("returns true when all props are identical references", () => {
    const p = baseProps();
    expect(gridTabGroupPropsAreEqual(p, p)).toBe(true);
  });

  it("returns true when panels array is a new reference with same elements", () => {
    const panels = [basePanel, basePanel2];
    const prev = baseProps({ panels: [...panels] });
    const next = baseProps({ panels: [...panels] });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns true when panel is a new reference with same fields", () => {
    const prev = baseProps({ panels: [{ ...basePanel } as TerminalInstance, basePanel2] });
    const next = baseProps({ panels: [{ ...basePanel } as TerminalInstance, basePanel2] });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when panel agentState changes", () => {
    const prev = baseProps({ panels: [basePanel, basePanel2] });
    const next = baseProps({
      panels: [{ ...basePanel, agentState: "working" } as TerminalInstance, basePanel2],
    });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when panel title changes", () => {
    const prev = baseProps({ panels: [basePanel, basePanel2] });
    const next = baseProps({
      panels: [{ ...basePanel, title: "Changed" } as TerminalInstance, basePanel2],
    });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when focusedId changes", () => {
    const prev = baseProps({ focusedId: "t-1" });
    const next = baseProps({ focusedId: "t-2" });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when gridCols changes", () => {
    const prev = baseProps({ gridCols: 2 });
    const next = baseProps({ gridCols: 3 });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when gridPanelCount changes", () => {
    const prev = baseProps({ gridPanelCount: 4 });
    const next = baseProps({ gridPanelCount: 3 });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when isMaximized changes", () => {
    const prev = baseProps({ isMaximized: false });
    const next = baseProps({ isMaximized: true });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when panels count changes", () => {
    const prev = baseProps({ panels: [basePanel, basePanel2] });
    const next = baseProps({ panels: [basePanel] });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when group.panelIds order changes", () => {
    const prev = baseProps({ group: { ...baseGroup, panelIds: ["t-1", "t-2"] } });
    const next = baseProps({ group: { ...baseGroup, panelIds: ["t-2", "t-1"] } });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when group.panelIds length changes", () => {
    const prev = baseProps({ group: { ...baseGroup, panelIds: ["t-1", "t-2"] } });
    const next = baseProps({ group: { ...baseGroup, panelIds: ["t-1"] } });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns true when group.activeTabId changes (subscribed via store)", () => {
    const prev = baseProps({ group: { ...baseGroup, activeTabId: "t-1" } });
    const next = baseProps({ group: { ...baseGroup, activeTabId: "t-2" } });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when group.location changes", () => {
    const prev = baseProps({ group: { ...baseGroup, location: "grid" } });
    const next = baseProps({ group: { ...baseGroup, location: "dock" } });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns true when group is same reference", () => {
    const group = { ...baseGroup };
    const prev = baseProps({ group });
    const next = baseProps({ group });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when panel cwd changes", () => {
    const prev = baseProps({ panels: [basePanel, basePanel2] });
    const next = baseProps({
      panels: [{ ...basePanel, cwd: "/new/path" } as TerminalInstance, basePanel2],
    });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when panel activityHeadline changes", () => {
    const prev = baseProps({ panels: [basePanel, basePanel2] });
    const next = baseProps({
      panels: [{ ...basePanel, activityHeadline: "Running tests" } as TerminalInstance, basePanel2],
    });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when panel browserUrl changes", () => {
    const prev = baseProps({ panels: [basePanel, basePanel2] });
    const next = baseProps({
      panels: [
        { ...basePanel, browserUrl: "http://localhost:8080" } as TerminalInstance,
        basePanel2,
      ],
    });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when group.worktreeId changes", () => {
    const prev = baseProps({ group: { ...baseGroup, worktreeId: "wt-1" } });
    const next = baseProps({ group: { ...baseGroup, worktreeId: "wt-2" } });
    expect(gridTabGroupPropsAreEqual(prev, next)).toBe(false);
  });
});
