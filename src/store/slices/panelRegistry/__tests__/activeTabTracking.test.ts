/**
 * Tests for unified active tab tracking (#3605)
 *
 * Issue: activeTabByGroup (focus slice) duplicated TabGroup.activeTabId (registry).
 * Solution: Eliminated activeTabByGroup — TabGroup.activeTabId is the single source of truth.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TabGroup } from "@/types";

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
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

describe("unified active tab tracking", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    await reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("setActiveTab", () => {
    it("should update TabGroup.activeTabId (single source of truth)", async () => {
      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2", "term-3"],
        activeTabId: "term-1",
        location: "grid",
      };

      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-2": {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-3": {
            id: "term-3",
            type: "terminal",
            title: "Shell 3",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1", "term-2", "term-3"],
        tabGroups: new Map([["group-1", group]]),
      });

      const { setActiveTab } = usePanelStore.getState();
      setActiveTab("group-1", "term-2");

      const state = usePanelStore.getState();

      // TabGroup.activeTabId is the single source of truth
      const updatedGroup = state.tabGroups.get("group-1");
      expect(updatedGroup?.activeTabId).toBe("term-2");
    });

    it("should be a no-op for virtual groups (single panel, no explicit TabGroup)", () => {
      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1"],
        tabGroups: new Map(),
      });

      const { setActiveTab } = usePanelStore.getState();
      setActiveTab("term-1", "term-1");

      const state = usePanelStore.getState();

      // No explicit TabGroup should be created
      expect(state.tabGroups.size).toBe(0);
    });

    it("should not update if panel is not in the group", async () => {
      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-2": {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-3": {
            id: "term-3",
            type: "terminal",
            title: "Shell 3",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1", "term-2", "term-3"],
        tabGroups: new Map([["group-1", group]]),
      });

      const { setActiveTab } = usePanelStore.getState();
      setActiveTab("group-1", "term-3");

      const state = usePanelStore.getState();

      // TabGroup.activeTabId unchanged
      const updatedGroup = state.tabGroups.get("group-1");
      expect(updatedGroup?.activeTabId).toBe("term-1");
    });

    it("should be a no-op when setting the same active tab", () => {
      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-2": {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1", "term-2"],
        tabGroups: new Map([["group-1", group]]),
      });

      const tabGroupsBefore = usePanelStore.getState().tabGroups;
      usePanelStore.getState().setActiveTab("group-1", "term-1");
      // Map reference should be unchanged (no unnecessary re-renders)
      expect(usePanelStore.getState().tabGroups).toBe(tabGroupsBefore);
    });

    it("should be a no-op for nonexistent group ID", () => {
      usePanelStore.setState({
        panelsById: {},
        panelIds: [],
        tabGroups: new Map(),
      });

      const tabGroupsBefore = usePanelStore.getState().tabGroups;
      usePanelStore.getState().setActiveTab("nonexistent", "term-1");
      expect(usePanelStore.getState().tabGroups).toBe(tabGroupsBefore);
    });
  });

  describe("getActiveTabId", () => {
    it("should return activeTabId for explicit groups", () => {
      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-2",
        location: "grid",
      };

      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-2": {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1", "term-2"],
        tabGroups: new Map([["group-1", group]]),
      });

      const { getActiveTabId } = usePanelStore.getState();
      expect(getActiveTabId("group-1")).toBe("term-2");
    });

    it("should return panelId for virtual groups (ungrouped standalone panels)", () => {
      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1"],
        tabGroups: new Map(),
      });

      const { getActiveTabId } = usePanelStore.getState();
      expect(getActiveTabId("term-1")).toBe("term-1");
    });

    it("should return null for non-existent groups", () => {
      usePanelStore.setState({
        panelsById: {},
        panelIds: [],
        tabGroups: new Map(),
      });

      const { getActiveTabId } = usePanelStore.getState();
      expect(getActiveTabId("nonexistent")).toBeNull();
    });

    it("should return null when panelId belongs to an explicit group", () => {
      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-2": {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1", "term-2"],
        tabGroups: new Map([["group-1", group]]),
      });

      const { getActiveTabId } = usePanelStore.getState();
      // Panel ID is not a group ID — it belongs to an explicit group
      expect(getActiveTabId("term-1")).toBeNull();
    });

    it("should exclude background panels from virtual group resolution", () => {
      usePanelStore.setState({
        panelsById: {
          "term-bg": {
            id: "term-bg",
            type: "terminal",
            title: "Background",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "background",
          },
        },
        panelIds: ["term-bg"],
        tabGroups: new Map(),
      });

      const { getActiveTabId } = usePanelStore.getState();
      expect(getActiveTabId("term-bg")).toBeNull();
    });
  });

  describe("hydrateTabGroups", () => {
    it("should restore activeTabId from persisted TabGroup state", () => {
      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-2": {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-3": {
            id: "term-3",
            type: "terminal",
            title: "Shell 3",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "dock",
          },
          "term-4": {
            id: "term-4",
            type: "terminal",
            title: "Shell 4",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "dock",
          },
        },
        panelIds: ["term-1", "term-2", "term-3", "term-4"],
        tabGroups: new Map(),
      });

      const tabGroupsToHydrate: TabGroup[] = [
        {
          id: "group-grid",
          panelIds: ["term-1", "term-2"],
          activeTabId: "term-2",
          location: "grid",
        },
        {
          id: "group-dock",
          panelIds: ["term-3", "term-4"],
          activeTabId: "term-4",
          location: "dock",
        },
      ];

      const { hydrateTabGroups } = usePanelStore.getState();
      hydrateTabGroups(tabGroupsToHydrate);

      const state = usePanelStore.getState();

      // TabGroups should be hydrated with correct activeTabId
      expect(state.tabGroups.get("group-grid")?.activeTabId).toBe("term-2");
      expect(state.tabGroups.get("group-dock")?.activeTabId).toBe("term-4");

      // getActiveTabId should read from registry
      expect(state.getActiveTabId("group-grid")).toBe("term-2");
      expect(state.getActiveTabId("group-dock")).toBe("term-4");
    });

    it("should handle empty tab groups array", () => {
      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1"],
        tabGroups: new Map([
          [
            "old-group",
            {
              id: "old-group",
              panelIds: ["term-1"],
              activeTabId: "term-1",
              location: "grid",
            },
          ],
        ]),
      });

      const { hydrateTabGroups } = usePanelStore.getState();
      hydrateTabGroups([]);

      const state = usePanelStore.getState();
      expect(state.tabGroups.size).toBe(0);
    });
  });

  describe("end-to-end persistence simulation", () => {
    it("should maintain active tab through setActiveTab → persist → hydrate cycle", () => {
      // Step 1: Set up initial state with a group
      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-2": {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1", "term-2"],
        tabGroups: new Map([
          [
            "group-1",
            {
              id: "group-1",
              panelIds: ["term-1", "term-2"],
              activeTabId: "term-1",
              location: "grid",
            },
          ],
        ]),
      });

      // Step 2: User switches to tab 2
      const { setActiveTab } = usePanelStore.getState();
      setActiveTab("group-1", "term-2");

      // Step 3: Capture what would be persisted (TabGroup.activeTabId)
      const persistedGroup = usePanelStore.getState().tabGroups.get("group-1");
      expect(persistedGroup?.activeTabId).toBe("term-2");

      // Step 4: Simulate app restart - clear in-memory state
      usePanelStore.setState({
        panelsById: {
          "term-1": {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          "term-2": {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        },
        panelIds: ["term-1", "term-2"],
        tabGroups: new Map(),
      });

      // Step 5: Hydrate from "persisted" state
      const { hydrateTabGroups: hydrateAfterRestart } = usePanelStore.getState();
      hydrateAfterRestart([persistedGroup!]);

      // Step 6: Verify active tab is restored from single source of truth
      const finalState = usePanelStore.getState();
      expect(finalState.tabGroups.get("group-1")?.activeTabId).toBe("term-2");
      expect(finalState.getActiveTabId("group-1")).toBe("term-2");
    });
  });

  describe("no duplicate state", () => {
    it("should not have activeTabByGroup property on the store", () => {
      const state = usePanelStore.getState();
      expect("activeTabByGroup" in state).toBe(false);
    });
  });
});
