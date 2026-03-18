import { describe, it, expect } from "vitest";
import { gridPanelPropsAreEqual, type GridPanelProps } from "../GridPanel";
import type { TerminalInstance } from "@/store";
import type { TabInfo } from "@/components/Panel/TabButton";

const noop = () => {};

const baseTerminal: TerminalInstance = {
  id: "t-1",
  title: "Terminal 1",
  location: "grid",
} as TerminalInstance;

const baseTab: TabInfo = {
  id: "t-1",
  title: "Terminal 1",
  type: undefined,
  agentId: undefined,
  detectedProcessId: undefined,
  kind: "terminal",
  agentState: undefined,
  isActive: true,
};

function baseProps(overrides: Partial<GridPanelProps> = {}): GridPanelProps {
  return {
    terminal: baseTerminal,
    isFocused: false,
    isMaximized: false,
    gridPanelCount: 4,
    gridCols: 2,
    ambientAgentState: undefined,
    tabs: [baseTab],
    groupId: "g-1",
    onTabClick: noop,
    onTabClose: noop,
    onTabRename: noop,
    onAddTab: noop,
    onTabReorder: noop,
    ...overrides,
  };
}

describe("gridPanelPropsAreEqual", () => {
  it("returns true when all props are identical references", () => {
    const p = baseProps();
    expect(gridPanelPropsAreEqual(p, p)).toBe(true);
  });

  it("returns true when terminal is a new reference with same fields", () => {
    const prev = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    const next = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when terminal.title changes", () => {
    const prev = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    const next = baseProps({
      terminal: { ...baseTerminal, title: "Changed" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.agentState changes", () => {
    const prev = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    const next = baseProps({
      terminal: { ...baseTerminal, agentState: "working" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.activityHeadline changes", () => {
    const prev = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    const next = baseProps({
      terminal: {
        ...baseTerminal,
        activityHeadline: "Running tests",
      } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.error changes", () => {
    const prev = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    const next = baseProps({
      terminal: { ...baseTerminal, error: "Something failed" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns true when callback props change reference (skipped)", () => {
    const prev = baseProps({ onTabClick: () => {}, onAddTab: () => {} });
    const next = baseProps({ onTabClick: () => {}, onAddTab: () => {} });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when isFocused changes", () => {
    const prev = baseProps({ isFocused: false });
    const next = baseProps({ isFocused: true });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when isMaximized changes", () => {
    const prev = baseProps({ isMaximized: false });
    const next = baseProps({ isMaximized: true });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when gridPanelCount changes", () => {
    const prev = baseProps({ gridPanelCount: 4 });
    const next = baseProps({ gridPanelCount: 3 });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when gridCols changes", () => {
    const prev = baseProps({ gridCols: 2 });
    const next = baseProps({ gridCols: 3 });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when ambientAgentState changes", () => {
    const prev = baseProps({ ambientAgentState: undefined });
    const next = baseProps({ ambientAgentState: "blocked" });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when groupId changes", () => {
    const prev = baseProps({ groupId: "g-1" });
    const next = baseProps({ groupId: "g-2" });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when tabs length changes", () => {
    const prev = baseProps({ tabs: [baseTab] });
    const next = baseProps({ tabs: [baseTab, { ...baseTab, id: "t-2" }] });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when tab isActive changes", () => {
    const prev = baseProps({ tabs: [{ ...baseTab, isActive: true }] });
    const next = baseProps({ tabs: [{ ...baseTab, isActive: false }] });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when one tabs is undefined and other is defined", () => {
    const prev = baseProps({ tabs: undefined });
    const next = baseProps({ tabs: [baseTab] });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns true when both tabs are undefined", () => {
    const prev = baseProps({ tabs: undefined });
    const next = baseProps({ tabs: undefined });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns true when tabs are same reference", () => {
    const tabs = [baseTab];
    const prev = baseProps({ tabs });
    const next = baseProps({ tabs });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(true);
  });
});
