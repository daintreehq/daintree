// @vitest-environment jsdom
/**
 * Tests for restoring a trashed DOCK panel reopening the dock popover (#9938).
 *
 * The panelStore wrappers `restoreTerminal` / `restoreTrashedGroup` used to
 * hardcode `activeDockTerminalId: null` while setting `focusedId` to the
 * restored panel. When the panel was originally docked it landed back in the
 * dock but the popover stayed closed, so focus pointed at an invisible panel
 * and focus-relative shortcuts silently targeted it. The wrappers now derive
 * `activeDockTerminalId` from the restored panel's `location`, and guard the
 * no-op case (id absent after the registry call) so focus is never moved onto
 * a panel that doesn't exist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TabGroup } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

type MockTerminal = Partial<PtyPanelData> & { id: string };

function setTerminals(terminals: MockTerminal[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])) as Record<string, PtyPanelData>,
    panelIds: terminals.map((t) => t.id),
  });
}

function makeTerm(id: string, location: "grid" | "dock" = "grid"): MockTerminal {
  return { id, title: `Shell ${id}`, cwd: "/test", cols: 80, rows: 24, location };
}

describe("restore trashed dock focus (#9938)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      activeDockTerminalId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("opens the dock popover when a docked terminal is restored", () => {
    setTerminals([makeTerm("term-1", "dock")]);

    usePanelStore.getState().trashPanel("term-1");
    expect(usePanelStore.getState().panelsById["term-1"]?.location).toBe("trash");

    usePanelStore.getState().restoreTerminal("term-1");

    const state = usePanelStore.getState();
    expect(state.panelsById["term-1"]?.location).toBe("dock");
    expect(state.focusedId).toBe("term-1");
    // The restored panel is back in the dock — the popover must point at it so
    // focus and the visible panel agree.
    expect(state.activeDockTerminalId).toBe("term-1");
    expect(state.activeDockTerminalId).toBe(state.focusedId);
  });

  it("leaves the dock closed when a grid terminal is restored", () => {
    setTerminals([makeTerm("term-1", "grid")]);

    usePanelStore.getState().trashPanel("term-1");
    usePanelStore.getState().restoreTerminal("term-1");

    const state = usePanelStore.getState();
    expect(state.panelsById["term-1"]?.location).toBe("grid");
    expect(state.focusedId).toBe("term-1");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("does not dismiss an unrelated open dock when a grid terminal is restored", () => {
    setTerminals([makeTerm("term-1", "grid"), makeTerm("other-dock", "dock")]);
    usePanelStore.setState({ activeDockTerminalId: "other-dock", focusedId: "other-dock" });

    usePanelStore.getState().trashPanel("term-1");
    usePanelStore.getState().restoreTerminal("term-1");

    const state = usePanelStore.getState();
    // Restoring a grid terminal moves focus but must not close a dock session
    // belonging to a different panel.
    expect(state.focusedId).toBe("term-1");
    expect(state.activeDockTerminalId).toBe("other-dock");
  });

  it("does not move focus when restoring a missing terminal (no-op)", () => {
    setTerminals([makeTerm("visible-dock", "dock")]);
    usePanelStore.setState({ focusedId: "visible-dock", activeDockTerminalId: "visible-dock" });

    usePanelStore.getState().restoreTerminal("ghost");

    const state = usePanelStore.getState();
    // The no-op restore must not retarget focus or close the open dock panel.
    expect(state.focusedId).toBe("visible-dock");
    expect(state.activeDockTerminalId).toBe("visible-dock");
  });

  it("opens the dock popover on the active tab when a docked group is restored", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
      location: "dock",
    };
    setTerminals([
      makeTerm("term-1", "dock"),
      makeTerm("term-2", "dock"),
      makeTerm("term-3", "dock"),
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");
    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-1")!.groupRestoreId!;

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    expect(state.panelsById["term-2"]?.location).toBe("dock");
    // Focus and the dock popover both land on the originally-active tab.
    expect(state.focusedId).toBe("term-2");
    expect(state.activeDockTerminalId).toBe("term-2");
  });

  it("falls back to a surviving member when the preferred tab was pruned", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-1",
      location: "dock",
    };
    setTerminals([
      makeTerm("term-1", "dock"),
      makeTerm("term-2", "dock"),
      makeTerm("term-3", "dock"),
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");
    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-2")!.groupRestoreId!;

    // Simulate the preferred active tab being garbage-collected from panelsById
    // during the trash window while its trash metadata lingers.
    usePanelStore.setState((state) => {
      const panelsById = { ...state.panelsById };
      delete panelsById["term-1"];
      return { panelsById, panelIds: state.panelIds.filter((id) => id !== "term-1") };
    });

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    // Focus and the dock popover land on a surviving member rather than being
    // stranded because the preferred tab is gone.
    expect(state.focusedId).toBe("term-2");
    expect(state.activeDockTerminalId).toBe("term-2");
  });

  it("leaves the dock closed when a grid group is restored", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2"],
      activeTabId: "term-1",
      location: "grid",
    };
    setTerminals([makeTerm("term-1", "grid"), makeTerm("term-2", "grid")]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");
    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-1")!.groupRestoreId!;

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    expect(state.focusedId).toBe("term-1");
    expect(state.activeDockTerminalId).toBeNull();
  });
});
