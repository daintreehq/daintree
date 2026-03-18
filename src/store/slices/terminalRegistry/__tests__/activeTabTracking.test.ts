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

const { useTerminalStore } = await import("../../../terminalStore");

describe("unified active tab tracking", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    await reset();
    useTerminalStore.setState({
      terminals: [],
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

      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-3",
            type: "terminal",
            title: "Shell 3",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
        tabGroups: new Map([["group-1", group]]),
      });

      const { setActiveTab } = useTerminalStore.getState();
      setActiveTab("group-1", "term-2");

      const state = useTerminalStore.getState();

      // TabGroup.activeTabId is the single source of truth
      const updatedGroup = state.tabGroups.get("group-1");
      expect(updatedGroup?.activeTabId).toBe("term-2");
    });

    it("should be a no-op for virtual groups (single panel, no explicit TabGroup)", () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
        tabGroups: new Map(),
      });

      const { setActiveTab } = useTerminalStore.getState();
      setActiveTab("term-1", "term-1");

      const state = useTerminalStore.getState();

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

      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-3",
            type: "terminal",
            title: "Shell 3",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
        tabGroups: new Map([["group-1", group]]),
      });

      const { setActiveTab } = useTerminalStore.getState();
      setActiveTab("group-1", "term-3");

      const state = useTerminalStore.getState();

      // TabGroup.activeTabId unchanged
      const updatedGroup = state.tabGroups.get("group-1");
      expect(updatedGroup?.activeTabId).toBe("term-1");
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

      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
        tabGroups: new Map([["group-1", group]]),
      });

      const { getActiveTabId } = useTerminalStore.getState();
      expect(getActiveTabId("group-1")).toBe("term-2");
    });

    it("should return panelId for virtual groups (ungrouped standalone panels)", () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
        tabGroups: new Map(),
      });

      const { getActiveTabId } = useTerminalStore.getState();
      expect(getActiveTabId("term-1")).toBe("term-1");
    });

    it("should return null for non-existent groups", () => {
      useTerminalStore.setState({
        terminals: [],
        tabGroups: new Map(),
      });

      const { getActiveTabId } = useTerminalStore.getState();
      expect(getActiveTabId("nonexistent")).toBeNull();
    });
  });

  describe("hydrateTabGroups", () => {
    it("should restore activeTabId from persisted TabGroup state", () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-3",
            type: "terminal",
            title: "Shell 3",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "dock",
          },
          {
            id: "term-4",
            type: "terminal",
            title: "Shell 4",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "dock",
          },
        ],
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

      const { hydrateTabGroups } = useTerminalStore.getState();
      hydrateTabGroups(tabGroupsToHydrate);

      const state = useTerminalStore.getState();

      // TabGroups should be hydrated with correct activeTabId
      expect(state.tabGroups.get("group-grid")?.activeTabId).toBe("term-2");
      expect(state.tabGroups.get("group-dock")?.activeTabId).toBe("term-4");

      // getActiveTabId should read from registry
      expect(state.getActiveTabId("group-grid")).toBe("term-2");
      expect(state.getActiveTabId("group-dock")).toBe("term-4");
    });

    it("should handle empty tab groups array", () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
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

      const { hydrateTabGroups } = useTerminalStore.getState();
      hydrateTabGroups([]);

      const state = useTerminalStore.getState();
      expect(state.tabGroups.size).toBe(0);
    });
  });

  describe("end-to-end persistence simulation", () => {
    it("should maintain active tab through setActiveTab → persist → hydrate cycle", () => {
      // Step 1: Set up initial state with a group
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
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
      const { setActiveTab } = useTerminalStore.getState();
      setActiveTab("group-1", "term-2");

      // Step 3: Capture what would be persisted (TabGroup.activeTabId)
      const persistedGroup = useTerminalStore.getState().tabGroups.get("group-1");
      expect(persistedGroup?.activeTabId).toBe("term-2");

      // Step 4: Simulate app restart - clear in-memory state
      useTerminalStore.setState({
        terminals: [
          {
            id: "term-1",
            type: "terminal",
            title: "Shell 1",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
          {
            id: "term-2",
            type: "terminal",
            title: "Shell 2",
            cwd: "/test",
            cols: 80,
            rows: 24,
            location: "grid",
          },
        ],
        tabGroups: new Map(),
      });

      // Step 5: Hydrate from "persisted" state
      const { hydrateTabGroups: hydrateAfterRestart } = useTerminalStore.getState();
      hydrateAfterRestart([persistedGroup!]);

      // Step 6: Verify active tab is restored from single source of truth
      const finalState = useTerminalStore.getState();
      expect(finalState.tabGroups.get("group-1")?.activeTabId).toBe("term-2");
      expect(finalState.getActiveTabId("group-1")).toBe("term-2");
    });
  });

  describe("no duplicate state", () => {
    it("should not have activeTabByGroup property on the store", () => {
      const state = useTerminalStore.getState();
      expect("activeTabByGroup" in state).toBe(false);
    });
  });
});
