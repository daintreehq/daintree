/**
 * Tests for tab group persistence via saveTabGroups
 * Issue #1861: Ensure only explicit groups (panelIds.length > 1) are persisted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalPersistence } from "../terminalPersistence";
import type { TabGroup } from "@/types";

const createMockProjectClient = () => ({
  getAll: vi.fn().mockResolvedValue([]),
  getCurrent: vi.fn().mockResolvedValue(null),
  add: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue({}),
  switch: vi.fn().mockResolvedValue({}),
  openDialog: vi.fn().mockResolvedValue(null),
  onSwitch: vi.fn().mockReturnValue(() => {}),
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  detectRunners: vi.fn().mockResolvedValue([]),
  close: vi.fn().mockResolvedValue({ success: true }),
  reopen: vi.fn().mockResolvedValue({}),
  getStats: vi.fn().mockResolvedValue({}),
  initGit: vi.fn().mockResolvedValue(undefined),
  getRecipes: vi.fn().mockResolvedValue([]),
  saveRecipes: vi.fn().mockResolvedValue(undefined),
  addRecipe: vi.fn().mockResolvedValue(undefined),
  updateRecipe: vi.fn().mockResolvedValue(undefined),
  deleteRecipe: vi.fn().mockResolvedValue(undefined),
  getTerminals: vi.fn().mockResolvedValue([]),
  setTerminals: vi.fn().mockResolvedValue(undefined),
  getTabGroups: vi.fn().mockResolvedValue([]),
  setTabGroups: vi.fn().mockResolvedValue(undefined),
});

describe("TerminalPersistence.saveTabGroups", () => {
  const projectId = "test-project-id";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("explicit group filtering", () => {
    it("only persists groups with panelIds.length > 1", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const explicitGroup: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      const singlePanelGroup: TabGroup = {
        id: "group-2",
        panelIds: ["term-3"],
        activeTabId: "term-3",
        location: "grid",
      };

      const emptyGroup: TabGroup = {
        id: "group-3",
        panelIds: [],
        activeTabId: "",
        location: "grid",
      };

      const tabGroups = new Map<string, TabGroup>([
        ["group-1", explicitGroup],
        ["group-2", singlePanelGroup],
        ["group-3", emptyGroup],
      ]);

      persistence.saveTabGroups(tabGroups, projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTabGroups).toHaveBeenCalledWith(projectId, [explicitGroup]);
    });

    it("persists multiple explicit groups", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const group1: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      const group2: TabGroup = {
        id: "group-2",
        panelIds: ["term-3", "term-4", "term-5"],
        activeTabId: "term-4",
        location: "dock",
      };

      const tabGroups = new Map<string, TabGroup>([
        ["group-1", group1],
        ["group-2", group2],
      ]);

      persistence.saveTabGroups(tabGroups, projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTabGroups).toHaveBeenCalledWith(
        projectId,
        expect.arrayContaining([group1, group2])
      );
      const savedGroups = client.setTabGroups.mock.calls[0][1] as TabGroup[];
      expect(savedGroups).toHaveLength(2);
    });

    it("persists empty array when all groups are virtual (single panel)", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const singlePanelGroup1: TabGroup = {
        id: "group-1",
        panelIds: ["term-1"],
        activeTabId: "term-1",
        location: "grid",
      };

      const singlePanelGroup2: TabGroup = {
        id: "group-2",
        panelIds: ["term-2"],
        activeTabId: "term-2",
        location: "dock",
      };

      const tabGroups = new Map<string, TabGroup>([
        ["group-1", singlePanelGroup1],
        ["group-2", singlePanelGroup2],
      ]);

      persistence.saveTabGroups(tabGroups, projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTabGroups).toHaveBeenCalledWith(projectId, []);
    });
  });

  describe("project ID handling", () => {
    it("skips save if no project ID is provided", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      persistence.saveTabGroups(new Map([["group-1", group]])); // No project ID

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTabGroups).not.toHaveBeenCalled();
    });

    it("uses getProjectId option if projectId not passed directly", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, {
        debounceMs: 100,
        getProjectId: () => "from-option",
      });

      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      persistence.saveTabGroups(new Map([["group-1", group]])); // No project ID passed directly

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTabGroups).toHaveBeenCalledWith("from-option", expect.any(Array));
    });
  });

  describe("debouncing", () => {
    it("debounces multiple saves into single persist call", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const group1: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      const group2: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2", "term-3"],
        activeTabId: "term-2",
        location: "grid",
      };

      persistence.saveTabGroups(new Map([["group-1", group1]]), projectId);
      persistence.saveTabGroups(new Map([["group-1", group2]]), projectId);
      persistence.saveTabGroups(new Map([["group-1", group1]]), projectId);

      expect(client.setTabGroups).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTabGroups).toHaveBeenCalledTimes(1);
      expect(client.setTabGroups).toHaveBeenCalledWith(projectId, [group1]);
    });
  });

  describe("cancel and flush", () => {
    it("cancel prevents pending tab group save", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      persistence.saveTabGroups(new Map([["group-1", group]]), projectId);
      persistence.cancel();

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTabGroups).not.toHaveBeenCalled();
    });

    it("flush immediately executes pending tab group save", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 500 });

      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      persistence.saveTabGroups(new Map([["group-1", group]]), projectId);

      expect(client.setTabGroups).not.toHaveBeenCalled();

      persistence.flush();
      await vi.runAllTicks();

      expect(client.setTabGroups).toHaveBeenCalledTimes(1);
    });
  });

  describe("worktree groups", () => {
    it("preserves worktreeId in persisted groups", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const worktreeGroup: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
        worktreeId: "wt-123",
      };

      persistence.saveTabGroups(new Map([["group-1", worktreeGroup]]), projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedGroups = client.setTabGroups.mock.calls[0][1] as TabGroup[];
      expect(savedGroups[0].worktreeId).toBe("wt-123");
    });

    it("preserves undefined worktreeId for global groups", async () => {
      const client = createMockProjectClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const globalGroup: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
        worktreeId: undefined,
      };

      persistence.saveTabGroups(new Map([["group-1", globalGroup]]), projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedGroups = client.setTabGroups.mock.calls[0][1] as TabGroup[];
      expect(savedGroups[0].worktreeId).toBeUndefined();
    });
  });
});
