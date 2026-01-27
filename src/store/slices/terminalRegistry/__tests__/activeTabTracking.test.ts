/**
 * Tests for unified active tab tracking (#1857)
 *
 * Issue: activeTabByGroup (focus slice) and TabGroup.activeTabId (registry) were out of sync.
 * Solution: setActiveTab updates both, and hydrateTabGroups seeds activeTabByGroup from TabGroup.
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
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
      activeTabByGroup: new Map(),
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("setActiveTab", () => {
    it("should update both activeTabByGroup and TabGroup.activeTabId", async () => {
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
        activeTabByGroup: new Map([["group-1", "term-1"]]),
      });

      const { setActiveTab } = useTerminalStore.getState();
      setActiveTab("group-1", "term-2");

      const state = useTerminalStore.getState();

      // Check activeTabByGroup (focus slice)
      expect(state.activeTabByGroup.get("group-1")).toBe("term-2");

      // Check TabGroup.activeTabId (registry - persisted)
      const updatedGroup = state.tabGroups.get("group-1");
      expect(updatedGroup?.activeTabId).toBe("term-2");
    });

    it("should handle virtual groups (single panel, no explicit TabGroup)", () => {
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
        activeTabByGroup: new Map(),
      });

      const { setActiveTab } = useTerminalStore.getState();
      // Virtual group uses panel ID as group ID
      setActiveTab("term-1", "term-1");

      const state = useTerminalStore.getState();

      // activeTabByGroup should still be updated for virtual groups
      expect(state.activeTabByGroup.get("term-1")).toBe("term-1");

      // No explicit TabGroup exists
      expect(state.tabGroups.size).toBe(0);
    });

    it("should not update either state if panel is not in the group", async () => {
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
        activeTabByGroup: new Map([["group-1", "term-1"]]),
      });

      const { setActiveTab } = useTerminalStore.getState();
      // term-3 is not in group-1 - should be ignored to prevent split-brain
      setActiveTab("group-1", "term-3");

      const state = useTerminalStore.getState();

      // activeTabByGroup should NOT be updated (prevents split-brain state)
      expect(state.activeTabByGroup.get("group-1")).toBe("term-1");

      // TabGroup.activeTabId also unchanged
      const updatedGroup = state.tabGroups.get("group-1");
      expect(updatedGroup?.activeTabId).toBe("term-1");
    });
  });

  describe("hydrateTabGroups", () => {
    it("should seed activeTabByGroup from TabGroup.activeTabId", () => {
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
        activeTabByGroup: new Map(), // Start empty
      });

      const tabGroupsToHydrate: TabGroup[] = [
        {
          id: "group-grid",
          panelIds: ["term-1", "term-2"],
          activeTabId: "term-2", // Second tab is active
          location: "grid",
        },
        {
          id: "group-dock",
          panelIds: ["term-3", "term-4"],
          activeTabId: "term-4", // Second tab is active
          location: "dock",
        },
      ];

      const { hydrateTabGroups } = useTerminalStore.getState();
      hydrateTabGroups(tabGroupsToHydrate);

      const state = useTerminalStore.getState();

      // activeTabByGroup should be seeded from TabGroup.activeTabId
      expect(state.activeTabByGroup.get("group-grid")).toBe("term-2");
      expect(state.activeTabByGroup.get("group-dock")).toBe("term-4");

      // TabGroups should be hydrated
      expect(state.tabGroups.get("group-grid")?.activeTabId).toBe("term-2");
      expect(state.tabGroups.get("group-dock")?.activeTabId).toBe("term-4");
    });

    it("should clear stale activeTabByGroup entries on hydration", () => {
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
        // Stale entry from previous session
        activeTabByGroup: new Map([
          ["old-group", "old-term"],
          ["group-1", "term-1"],
        ]),
      });

      const tabGroupsToHydrate: TabGroup[] = [
        {
          id: "group-1",
          panelIds: ["term-1", "term-2"],
          activeTabId: "term-2",
          location: "grid",
        },
      ];

      const { hydrateTabGroups } = useTerminalStore.getState();
      hydrateTabGroups(tabGroupsToHydrate);

      const state = useTerminalStore.getState();

      // Old stale entry should be cleared
      expect(state.activeTabByGroup.has("old-group")).toBe(false);

      // New entry from hydration should be present
      expect(state.activeTabByGroup.get("group-1")).toBe("term-2");
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
        activeTabByGroup: new Map([["old-group", "term-1"]]),
      });

      const { hydrateTabGroups } = useTerminalStore.getState();
      hydrateTabGroups([]);

      const state = useTerminalStore.getState();

      // All entries should be cleared
      expect(state.activeTabByGroup.size).toBe(0);
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
        activeTabByGroup: new Map([["group-1", "term-1"]]),
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
        activeTabByGroup: new Map(), // Empty after restart
      });

      // Step 5: Hydrate from "persisted" state
      const { hydrateTabGroups: hydrateAfterRestart } = useTerminalStore.getState();
      hydrateAfterRestart([persistedGroup!]);

      // Step 6: Verify active tab is restored
      const finalState = useTerminalStore.getState();
      expect(finalState.activeTabByGroup.get("group-1")).toBe("term-2");
      expect(finalState.tabGroups.get("group-1")?.activeTabId).toBe("term-2");
    });
  });
});
