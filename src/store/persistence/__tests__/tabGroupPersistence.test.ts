/**
 * Tests for tab group persistence via saveTabGroups
 * Issue #1861: Ensure only explicit groups (panelIds.length > 1) are persisted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PanelPersistence } from "../panelPersistence";
import type { TabGroup } from "@/types";

const createMockProjectClient = () => ({
  getAll: vi.fn().mockResolvedValue([]),
  getCurrent: vi.fn().mockResolvedValue(null),
  add: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue({}),
  switch: vi.fn().mockResolvedValue({}),
  prefetchHydrate: vi.fn().mockResolvedValue(undefined),
  openDialog: vi.fn().mockResolvedValue(null),
  onSwitch: vi.fn().mockReturnValue(() => {}),
  onWorktreeLoadStatus: vi.fn().mockReturnValue(() => {}),
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  detectRunners: vi.fn().mockResolvedValue([]),
  close: vi.fn().mockResolvedValue({ success: true }),
  freeMemory: vi
    .fn()
    .mockResolvedValue({ terminalsKilled: 0, rendererEvicted: false, workspaceEvicted: false }),
  reopen: vi.fn().mockResolvedValue({}),
  getStats: vi.fn().mockResolvedValue({}),
  getBulkStats: vi.fn().mockResolvedValue({}),
  getNotificationOverrides: vi.fn().mockResolvedValue({}),
  initGit: vi.fn().mockResolvedValue(undefined),
  initGitGuided: vi.fn().mockResolvedValue({ outcome: "success", completedSteps: [] }),
  onInitGitProgress: vi.fn().mockReturnValue(() => {}),
  getRecipes: vi.fn().mockResolvedValue({ recipes: [], collisions: [] }),
  saveRecipes: vi.fn().mockResolvedValue(undefined),
  addRecipe: vi.fn().mockResolvedValue(undefined),
  updateRecipe: vi.fn().mockResolvedValue(undefined),
  deleteRecipe: vi.fn().mockResolvedValue(undefined),
  getTerminals: vi.fn().mockResolvedValue([]),
  setTerminals: vi.fn().mockResolvedValue(undefined),
  getTabGroups: vi.fn().mockResolvedValue([]),
  setTabGroups: vi.fn().mockResolvedValue(undefined),
  getTerminalSizes: vi.fn().mockResolvedValue({}),
  setTerminalSizes: vi.fn().mockResolvedValue(undefined),
  getDraftInputs: vi.fn().mockResolvedValue({}),
  setDraftInputs: vi.fn().mockResolvedValue(undefined),
  readClaudeMd: vi.fn().mockResolvedValue(null),
  writeClaudeMd: vi.fn().mockResolvedValue(undefined),
  createFolder: vi.fn().mockResolvedValue(""),
  enableInRepoSettings: vi.fn().mockResolvedValue({}),
  disableInRepoSettings: vi.fn().mockResolvedValue({}),
  checkMissing: vi.fn().mockResolvedValue([]),
  locate: vi.fn().mockResolvedValue(null),
  cloneRepo: vi.fn().mockResolvedValue({ success: true }),
  onCloneProgress: vi.fn().mockReturnValue(() => {}),
  cancelClone: vi.fn().mockResolvedValue(undefined),
  exportRecipeToFile: vi.fn().mockResolvedValue(true),
  importRecipeFromFile: vi.fn().mockResolvedValue(null),
  getInRepoRecipes: vi.fn().mockResolvedValue([]),
  syncInRepoRecipes: vi.fn().mockResolvedValue(undefined),
  updateInRepoRecipe: vi.fn().mockResolvedValue(undefined),
  deleteInRepoRecipe: vi.fn().mockResolvedValue(undefined),
  getInRepoPresets: vi.fn().mockResolvedValue({}),
});

describe("PanelPersistence.saveTabGroups", () => {
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
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

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

      expect(client.setTabGroups).toHaveBeenCalledWith(
        projectId,
        [explicitGroup],
        expect.any(Array),
        expect.any(Array)
      );
    });

    it("persists multiple explicit groups", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

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
        expect.arrayContaining([group1, group2]),
        expect.any(Array),
        expect.any(Array)
      );
      const savedGroups = client.setTabGroups.mock.calls[0]![1] as TabGroup[];
      expect(savedGroups).toHaveLength(2);
    });

    it("persists empty array when all groups are virtual (single panel)", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

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

      expect(client.setTabGroups).toHaveBeenCalledWith(
        projectId,
        [],
        expect.any(Array),
        expect.any(Array)
      );
    });
  });

  describe("project ID handling", () => {
    it("skips save if no project ID is provided", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

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
      const persistence = new PanelPersistence(client, {
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

      expect(client.setTabGroups).toHaveBeenCalledWith(
        "from-option",
        expect.any(Array),
        expect.any(Array),
        expect.any(Array)
      );
    });
  });

  describe("debouncing", () => {
    it("debounces multiple saves into single persist call", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

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
      expect(client.setTabGroups).toHaveBeenCalledWith(
        projectId,
        [group1],
        expect.any(Array),
        expect.any(Array)
      );
    });

    it("skips redundant tab group persist when payload is unchanged", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      persistence.saveTabGroups(new Map([["group-1", group]]), projectId);
      await vi.advanceTimersByTimeAsync(100);
      expect(client.setTabGroups).toHaveBeenCalledTimes(1);

      persistence.saveTabGroups(new Map([["group-1", { ...group }]]), projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTabGroups).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancel and flush", () => {
    it("cancel prevents pending tab group save", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

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
      const persistence = new PanelPersistence(client, { debounceMs: 500 });

      const group: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
      };

      persistence.saveTabGroups(new Map([["group-1", group]]), projectId);

      expect(client.setTabGroups).not.toHaveBeenCalled();

      persistence.flush();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.setTabGroups).toHaveBeenCalledTimes(1);
    });
  });

  describe("worktree groups", () => {
    it("preserves worktreeId in persisted groups", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const worktreeGroup: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
        worktreeId: "wt-123",
      };

      persistence.saveTabGroups(new Map([["group-1", worktreeGroup]]), projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedGroups = client.setTabGroups.mock.calls[0]![1] as TabGroup[];
      expect(savedGroups[0]!.worktreeId).toBe("wt-123");
    });

    it("preserves undefined worktreeId for global groups", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const globalGroup: TabGroup = {
        id: "group-1",
        panelIds: ["term-1", "term-2"],
        activeTabId: "term-1",
        location: "grid",
        worktreeId: undefined,
      };

      persistence.saveTabGroups(new Map([["group-1", globalGroup]]), projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedGroups = client.setTabGroups.mock.calls[0]![1] as TabGroup[];
      expect(savedGroups[0]!.worktreeId).toBeUndefined();
    });
  });

  describe("layout merge delta (#11350)", () => {
    const g = (id: string, panelIds: string[]): TabGroup => ({
      id,
      panelIds,
      activeTabId: panelIds[0]!,
      location: "grid",
    });

    it("emits a deleted group in removedIds once the baseline is primed", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      persistence.primeTabGroups(projectId, [g("g1", ["a", "b"]), g("g2", ["c", "d"])]);

      // User dissolves g2, leaving only g1.
      persistence.saveTabGroups(new Map([["g1", g("g1", ["a", "b"])]]), projectId);
      await vi.advanceTimersByTimeAsync(100);

      const [, , changedIds, removedIds] = client.setTabGroups.mock.calls[0]!;
      expect(changedIds).toEqual([]);
      expect(removedIds).toEqual(["g2"]);
    });

    it("emits a newly added group in changedIds against a primed baseline", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      persistence.primeTabGroups(projectId, [g("g1", ["a", "b"])]);

      persistence.saveTabGroups(
        new Map([
          ["g1", g("g1", ["a", "b"])],
          ["g2", g("g2", ["c", "d"])],
        ]),
        projectId
      );
      await vi.advanceTimersByTimeAsync(100);

      const [, , changedIds, removedIds] = client.setTabGroups.mock.calls[0]!;
      expect(changedIds).toEqual(["g2"]);
      expect(removedIds).toEqual([]);
    });
  });
});
