import { describe, it, expect } from "vitest";
import { gridPanelPropsAreEqual, type GridPanelProps } from "../GridPanel";
import type { TerminalInstance } from "@/store";
import type { TabInfo } from "@/components/Panel/TabButton";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { buildPanelProps } from "@/utils/panelProps";

const noop = () => {};

const baseTerminal: TerminalInstance = {
  id: "t-1",
  title: "Terminal 1",
  location: "grid",
} as TerminalInstance;

const baseTab: TabInfo = {
  id: "t-1",
  title: "Terminal 1",
  chrome: deriveTerminalChrome(),
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
    const next = baseProps({ ambientAgentState: "waiting" });
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

  it("returns false when terminal.kind changes", () => {
    const prev = baseProps({ terminal: { ...baseTerminal, kind: "terminal" } as TerminalInstance });
    const next = baseProps({ terminal: { ...baseTerminal, kind: "browser" } as TerminalInstance });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.launchAgentId changes (identity swap)", () => {
    const prev = baseProps({
      terminal: { ...baseTerminal, kind: "terminal", launchAgentId: undefined } as TerminalInstance,
    });
    const next = baseProps({
      terminal: { ...baseTerminal, kind: "terminal", launchAgentId: "claude" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.cwd changes", () => {
    const prev = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    const next = baseProps({
      terminal: { ...baseTerminal, cwd: "/new/path" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.runtimeStatus changes", () => {
    const prev = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    const next = baseProps({
      terminal: { ...baseTerminal, runtimeStatus: "exited" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.pluginId changes", () => {
    const prev = baseProps({
      terminal: { ...baseTerminal, pluginId: undefined } as TerminalInstance,
    });
    const next = baseProps({
      terminal: { ...baseTerminal, pluginId: "my-plugin" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.detectedProcessId changes", () => {
    const prev = baseProps({ terminal: { ...baseTerminal } as TerminalInstance });
    const next = baseProps({
      terminal: { ...baseTerminal, detectedProcessId: "node" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when isFleetScope toggles", () => {
    const prev = baseProps({ isFleetScope: false });
    const next = baseProps({ isFleetScope: true });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns true when both isFleetScope are undefined", () => {
    const prev = baseProps();
    const next = baseProps();
    expect(gridPanelPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when titleOverride changes", () => {
    const prev = baseProps({ titleOverride: "wt-a — Claude" });
    const next = baseProps({ titleOverride: "wt-b — Claude" });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when titleOverride becomes defined", () => {
    const prev = baseProps({ titleOverride: undefined });
    const next = baseProps({ titleOverride: "wt-a — Claude" });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.exitCode changes", () => {
    const prev = baseProps({
      terminal: { ...baseTerminal, exitCode: undefined } as TerminalInstance,
    });
    const next = baseProps({ terminal: { ...baseTerminal, exitCode: 137 } as TerminalInstance });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.agentPresetColor changes", () => {
    const prev = baseProps({
      terminal: { ...baseTerminal, agentPresetColor: "#ff00ff" } as TerminalInstance,
    });
    const next = baseProps({
      terminal: { ...baseTerminal, agentPresetColor: "#00ffff" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.agentPresetId changes", () => {
    const prev = baseProps({
      terminal: { ...baseTerminal, agentPresetId: "preset-a" } as TerminalInstance,
    });
    const next = baseProps({
      terminal: { ...baseTerminal, agentPresetId: "preset-b" } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.agentLaunchFlags changes reference", () => {
    const prev = baseProps({
      terminal: { ...baseTerminal, agentLaunchFlags: ["--print"] } as TerminalInstance,
    });
    const next = baseProps({
      terminal: {
        ...baseTerminal,
        agentLaunchFlags: ["--print", "--dangerously-skip-permissions"],
      } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.browserHistory changes reference", () => {
    const prev = baseProps({
      terminal: {
        ...baseTerminal,
        browserHistory: { past: [], present: "http://a", future: [] },
      } as TerminalInstance,
    });
    const next = baseProps({
      terminal: {
        ...baseTerminal,
        browserHistory: { past: ["http://a"], present: "http://x", future: [] },
      } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when terminal.browserZoom changes", () => {
    const prev = baseProps({
      terminal: { ...baseTerminal, browserZoom: 1.0 } as TerminalInstance,
    });
    const next = baseProps({
      terminal: { ...baseTerminal, browserZoom: 1.25 } as TerminalInstance,
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when tab presetColor changes", () => {
    const prev = baseProps({ tabs: [{ ...baseTab, presetColor: "#ff00ff" }] });
    const next = baseProps({ tabs: [{ ...baseTab, presetColor: "#00ffff" }] });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when tab isUsingFallback changes", () => {
    const prev = baseProps({ tabs: [{ ...baseTab, isUsingFallback: false }] });
    const next = baseProps({ tabs: [{ ...baseTab, isUsingFallback: true }] });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when tab fallbackTooltip changes", () => {
    const prev = baseProps({ tabs: [{ ...baseTab, fallbackTooltip: undefined }] });
    const next = baseProps({
      tabs: [{ ...baseTab, fallbackTooltip: 'Using fallback "x" — "y" unavailable' }],
    });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when tab hasDangerousFlags changes", () => {
    const prev = baseProps({ tabs: [{ ...baseTab, hasDangerousFlags: false }] });
    const next = baseProps({ tabs: [{ ...baseTab, hasDangerousFlags: true }] });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when tab chrome.hasExited changes (post-exit spinner suppression)", () => {
    // Race: exitCode/runtimeStatus fires before agentState:"exited" arrives.
    // Without hasExited in the descriptor equality, the stale working spinner
    // survives the re-render gate.
    const liveChrome = deriveTerminalChrome({
      kind: "terminal",
      launchAgentId: "claude",
      agentState: "working",
    });
    const exitedChrome = deriveTerminalChrome({
      kind: "terminal",
      launchAgentId: "claude",
      agentState: "working",
      exitCode: 0,
    });
    const prev = baseProps({ tabs: [{ ...baseTab, chrome: liveChrome }] });
    const next = baseProps({ tabs: [{ ...baseTab, chrome: exitedChrome }] });
    expect(gridPanelPropsAreEqual(prev, next)).toBe(false);
  });

  describe("drift coverage", () => {
    // Wraps a terminal in a Proxy that records every property read, then drives
    // buildPanelProps so the Proxy captures the full terminal.* surface
    // (including transitive reads inside deriveTerminalChrome). For each
    // recorded key, mutating it must force the comparator to return false.
    // Fails automatically when buildPanelProps gains a new terminal.* field
    // that the comparator does not check.
    it("catches every terminal.* field buildPanelProps reads", () => {
      const reads = new Set<string>();
      const fixture: TerminalInstance = {
        ...baseTerminal,
        agentState: "idle",
        runtimeStatus: "running",
        agentLaunchFlags: ["--print"],
        browserHistory: { past: [], present: "http://a", future: [] },
        browserZoom: 1.0,
      } as TerminalInstance;

      const proxy = new Proxy(fixture, {
        get(target, prop, receiver) {
          if (typeof prop === "string") reads.add(prop);
          return Reflect.get(target, prop, receiver);
        },
      });

      buildPanelProps({
        terminal: proxy,
        isFocused: false,
        overrides: { onFocus: noop, onClose: noop },
      });

      const observed = [...reads];
      expect(observed.length).toBeGreaterThan(0);

      for (const key of observed) {
        const prev = baseProps({ terminal: fixture });
        const next = baseProps({
          terminal: mutateTerminalField(fixture, key),
        });
        expect(
          gridPanelPropsAreEqual(prev, next),
          `gridPanelPropsAreEqual must return false when terminal.${key} changes`
        ).toBe(false);
      }
    });
  });
});

function mutateTerminalField(terminal: TerminalInstance, key: string): TerminalInstance {
  const current = (terminal as unknown as Record<string, unknown>)[key];
  let mutated: unknown;
  if (typeof current === "string") mutated = `${current}__drift`;
  else if (typeof current === "number") mutated = current + 1;
  else if (typeof current === "boolean") mutated = !current;
  else if (Array.isArray(current)) mutated = [...current, "__drift"];
  else mutated = { __drift: true };
  return { ...terminal, [key]: mutated } as TerminalInstance;
}
