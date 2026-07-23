import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { PanelPersistence, panelToSnapshot } from "../panelPersistence";
import { setWorktreeGitDirAccessor } from "@/store/storeAccessors";
import type { TerminalInstance, TerminalSnapshot } from "@/types";

initBuiltInPanelKinds();

const createMockTerminal = (overrides: Partial<TerminalInstance> = {}): TerminalInstance => ({
  id: "test-1",
  title: "Test Terminal",
  cwd: "/test/path",
  cols: 80,
  rows: 24,
  location: "grid",
  ...overrides,
});

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
  previewRelocation: vi.fn().mockResolvedValue({}),
  applyRelocation: vi.fn().mockResolvedValue({}),
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

describe("PanelPersistence", () => {
  const projectId = "test-project-id";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("creates instance with default options", () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client);
      expect(persistence).toBeInstanceOf(PanelPersistence);
    });

    it("creates instance with custom options", () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, {
        debounceMs: 1000,
        filter: () => true,
        transform: (t): TerminalSnapshot => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          cwd: t.cwd,
          location: t.location === "trash" ? "grid" : t.location,
        }),
      });
      expect(persistence).toBeInstanceOf(PanelPersistence);
    });
  });

  describe("save", () => {
    it("debounces multiple saves into single persist call", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal();
      persistence.save([terminal], projectId);
      persistence.save([terminal, createMockTerminal({ id: "test-2" })], projectId);
      persistence.save([terminal], projectId);

      expect(client.setTerminals).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledTimes(1);
    });

    it("excludes trashed terminals by default", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const gridTerminal = createMockTerminal({ id: "grid-1", location: "grid" });
      const dockTerminal = createMockTerminal({ id: "dock-1", location: "dock" });
      const trashedTerminal = createMockTerminal({ id: "trash-1", location: "trash" });

      persistence.save([gridTerminal, dockTerminal, trashedTerminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledWith(
        projectId,
        expect.arrayContaining([
          expect.objectContaining({ id: "grid-1" }),
          expect.objectContaining({ id: "dock-1" }),
        ]),
        expect.any(Array),
        expect.any(Array)
      );

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(2);
      expect(savedTerminals).not.toContainEqual(expect.objectContaining({ id: "trash-1" }));
    });

    it("excludes dialog-presented panels by default", async () => {
      // Dialog panels are ephemeral (#11239): filtering them here is what makes
      // "never persisted" and "never restored on restart" true — nothing is
      // written, so there is nothing to rehydrate.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const gridTerminal = createMockTerminal({ id: "grid-1", location: "grid" });
      const dialogPanel = createMockTerminal({
        id: "dialog-1",
        location: "dialog",
        excludeFromPersistence: true,
      });

      persistence.save([gridTerminal, dialogPanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals).not.toContainEqual(expect.objectContaining({ id: "dialog-1" }));
    });

    it("excludes dialog panels that are missing the ephemeral flag", async () => {
      // The location alone has to be disqualifying. Hydration coerces any
      // unrecognized location to "grid", so a dialog snapshot that slipped
      // through would come back as a real grid panel on the next launch.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const unflagged = createMockTerminal({ id: "dialog-1", location: "dialog" });

      persistence.save([createMockTerminal({ id: "grid-1" }), unflagged], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals).not.toContainEqual(expect.objectContaining({ id: "dialog-1" }));
    });

    it("excludes non-PTY panels flagged excludeFromPersistence", async () => {
      // The flag lives on the base panel shape, so a file panel honours it too.
      // A PTY-narrowed read would have silently persisted this one.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const filePanel = {
        id: "file-1",
        kind: "file",
        title: "File",
        location: "grid",
        filePath: "/repo/spec.md",
        excludeFromPersistence: true,
      } as unknown as TerminalInstance;

      persistence.save([createMockTerminal({ id: "grid-1" }), filePanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals).not.toContainEqual(expect.objectContaining({ id: "file-1" }));
    });

    it("excludes smoke test terminals by default", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const normalTerminal = createMockTerminal({ id: "grid-1" });
      const smokeTerminal = createMockTerminal({ id: "smoke-test-terminal-1" });

      persistence.save([normalTerminal, smokeTerminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals[0]).toEqual(expect.objectContaining({ id: "grid-1" }));
    });

    it("transforms terminals with default transform", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal({
        id: "test-1",
        kind: "terminal",
        launchAgentId: "claude",
        title: "Claude",
        cwd: "/test",
        worktreeId: "wt-1",
        location: "grid",
        command: "  claude --model sonnet-4  ",
        agentState: "working",
        lastStateChange: 1700000000000,
        activityHeadline: "Processing",
      });

      persistence.save([terminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledWith(
        projectId,
        [
          {
            id: "test-1",
            kind: "terminal",
            launchAgentId: "claude",
            title: "Claude",
            cwd: "/test",
            worktreeId: "wt-1",
            location: "grid",
            command: "claude --model sonnet-4",
            agentState: "working",
            lastStateChange: 1700000000000,
          },
        ],
        expect.any(Array),
        expect.any(Array)
      );
    });

    it("excludes transient detectedProcessId from persisted snapshots", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal({
        id: "test-detected-process",
        detectedProcessId: "npm",
        runtimeIdentity: {
          kind: "process",
          id: "npm",
          iconId: "npm",
          processId: "npm",
        },
      });

      persistence.save([terminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals[0]).not.toHaveProperty("detectedProcessId");
      expect(savedTerminals[0]).not.toHaveProperty("runtimeIdentity");
    });

    it("applies custom filter function", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, {
        debounceMs: 100,
        filter: (t) => t.launchAgentId === "claude",
      });

      const shellTerminal = createMockTerminal({ id: "shell-1" });
      const claudeTerminal = createMockTerminal({ id: "claude-1", launchAgentId: "claude" });

      persistence.save([shellTerminal, claudeTerminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals[0]).toEqual(expect.objectContaining({ id: "claude-1" }));
    });

    it("applies custom transform function", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, {
        debounceMs: 100,
        transform: (t): TerminalSnapshot => ({
          id: t.id,
          kind: t.kind,
          title: "Custom",
          cwd: t.cwd,
          location: t.location === "trash" ? "grid" : t.location,
        }),
      });

      const terminal = createMockTerminal({
        id: "test-1",
        cwd: "/custom/path",
        title: "Should not appear",
      });

      persistence.save([terminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledWith(
        projectId,
        [
          expect.objectContaining({
            id: "test-1",
            title: "Custom",
            cwd: "/custom/path",
          }),
        ],
        expect.any(Array),
        expect.any(Array)
      );
    });

    it("skips save if no project ID is provided", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal();
      persistence.save([terminal]); // No project ID

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).not.toHaveBeenCalled();
    });

    it("uses getProjectId option if projectId not passed directly", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, {
        debounceMs: 100,
        getProjectId: () => "from-option",
      });

      const terminal = createMockTerminal();
      persistence.save([terminal]); // No project ID passed directly

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledWith(
        "from-option",
        expect.any(Array),
        expect.any(Array),
        expect.any(Array)
      );
    });

    it("skips redundant persist when transformed payload is unchanged", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });
      const terminal = createMockTerminal();

      persistence.save([terminal], projectId);
      await vi.advanceTimersByTimeAsync(100);
      expect(client.setTerminals).toHaveBeenCalledTimes(1);

      persistence.save([createMockTerminal()], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledTimes(1);
    });

    it("persists again when transformed payload changes", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal({ id: "term-1", title: "One" })], projectId);
      await vi.advanceTimersByTimeAsync(100);
      expect(client.setTerminals).toHaveBeenCalledTimes(1);

      persistence.save([createMockTerminal({ id: "term-1", title: "Two" })], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledTimes(2);
      expect(client.setTerminals).toHaveBeenLastCalledWith(
        projectId,
        expect.arrayContaining([expect.objectContaining({ title: "Two" })]),
        expect.any(Array),
        expect.any(Array)
      );
    });
  });

  describe("layout merge delta (#11350)", () => {
    // Mirror how a baseline is actually seeded at hydration: read back from
    // disk (JSON), which drops undefined-valued keys. A strict key-count
    // comparison would then mark an untouched panel changed on the first save.
    const hydratedBaseline = (...terminals: TerminalInstance[]): TerminalSnapshot[] =>
      terminals.map((t) => JSON.parse(JSON.stringify(panelToSnapshot(t))) as TerminalSnapshot);

    it("marks every panel changed when there is no primed baseline", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal({ id: "a" })], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const [, , changedIds, removedIds] = client.setTerminals.mock.calls[0]!;
      expect(changedIds).toEqual(["a"]);
      expect(removedIds).toEqual([]);
    });

    it("emits an empty delta for panels unchanged since a JSON-round-tripped baseline", async () => {
      // Regression for the undefined-vs-missing key mismatch: a baseline read
      // back from disk drops undefined-valued keys, but the delta must still
      // report no change so Main's merge is a no-op and cannot overwrite a
      // sibling's edit.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const a = createMockTerminal({ id: "a" });
      const b = createMockTerminal({ id: "b" });
      persistence.primeProject(projectId, hydratedBaseline(a, b));

      persistence.save([a, b], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const [, , changedIds, removedIds] = client.setTerminals.mock.calls[0]!;
      expect(changedIds).toEqual([]);
      expect(removedIds).toEqual([]);
    });

    it("emits only the newly added panel in changedIds against a hydrated baseline", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const a = createMockTerminal({ id: "a" });
      const b = createMockTerminal({ id: "b" });
      persistence.primeProject(projectId, hydratedBaseline(a, b));

      persistence.save([a, b, createMockTerminal({ id: "c" })], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const [, , changedIds, removedIds] = client.setTerminals.mock.calls[0]!;
      expect(changedIds).toEqual(["c"]);
      expect(removedIds).toEqual([]);
    });

    it("emits a closed panel in removedIds against a hydrated baseline", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const a = createMockTerminal({ id: "a" });
      const b = createMockTerminal({ id: "b" });
      persistence.primeProject(projectId, hydratedBaseline(a, b));

      persistence.save([a], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const [, , changedIds, removedIds] = client.setTerminals.mock.calls[0]!;
      expect(changedIds).toEqual([]);
      expect(removedIds).toEqual(["b"]);
    });

    it("computes an overlapping save's delta against the acknowledged baseline", async () => {
      // Regression: while the first send (add b) is still in flight, a second
      // save (remove b) must diff against the baseline the first write commits
      // ([a, b]), so it emits removedIds:["b"]. If it diffed against the stale
      // [a], it would omit the tombstone and Main would resurrect b.
      const client = createMockProjectClient();
      let resolveFirst: (() => void) | undefined;
      const firstSend = new Promise<void>((resolve) => {
        resolveFirst = () => resolve();
      });
      client.setTerminals.mockReturnValueOnce(firstSend).mockResolvedValue(undefined);

      const persistence = new PanelPersistence(client, { debounceMs: 100 });
      const a = createMockTerminal({ id: "a" });
      const b = createMockTerminal({ id: "b" });
      persistence.primeProject(projectId, hydratedBaseline(a));

      persistence.save([a, b], projectId);
      await vi.advanceTimersByTimeAsync(100);
      expect(client.setTerminals).toHaveBeenCalledTimes(1);

      persistence.save([a], projectId);
      await vi.advanceTimersByTimeAsync(100);
      // Second write is chained behind the in-flight first write.
      expect(client.setTerminals).toHaveBeenCalledTimes(1);

      resolveFirst?.();
      await vi.runAllTimersAsync();

      expect(client.setTerminals).toHaveBeenCalledTimes(2);
      const [, , changedIds, removedIds] = client.setTerminals.mock.calls[1]!;
      expect(changedIds).toEqual([]);
      expect(removedIds).toEqual(["b"]);
    });
  });

  describe("flush", () => {
    it("immediately executes pending save", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 500 });

      const terminal = createMockTerminal();
      persistence.save([terminal], projectId);

      expect(client.setTerminals).not.toHaveBeenCalled();

      persistence.flush();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.setTerminals).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancel", () => {
    it("cancels pending save", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal();
      persistence.save([terminal], projectId);
      persistence.cancel();

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).not.toHaveBeenCalled();
    });
  });

  describe("whenIdle", () => {
    it("resolves immediately when no pending persist", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      await expect(persistence.whenIdle()).resolves.toBeUndefined();
    });

    it("resolves after pending persist completes", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal();
      persistence.save([terminal], projectId);

      // Advance timers to trigger debounced save
      await vi.advanceTimersByTimeAsync(100);

      // Now wait for the persist to complete
      await expect(persistence.whenIdle()).resolves.toBeUndefined();
    });
  });

  describe("browser panels", () => {
    it("preserves browserUrl for browser panels", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const browserPanel = createMockTerminal({
        id: "browser-1",
        kind: "browser",
        title: "Browser",
        browserUrl: "https://localhost:3000",
        location: "grid",
      });

      persistence.save([browserPanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledWith(
        projectId,
        [
          expect.objectContaining({
            id: "browser-1",
            kind: "browser",
            browserUrl: "https://localhost:3000",
          }),
        ],
        expect.any(Array),
        expect.any(Array)
      );
    });
  });

  describe("extension state", () => {
    it("persists extensionState for extension panels through snapshot round-trip", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const extensionPanel = createMockTerminal({
        id: "ext-1",
        kind: "acme.my-plugin.viewer",
        title: "My Plugin",
        extensionState: { activeTab: "overview", zoom: 1.5 },
        location: "grid",
      });

      persistence.save([extensionPanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals[0]).toEqual(
        expect.objectContaining({
          id: "ext-1",
          kind: "acme.my-plugin.viewer",
          extensionState: { activeTab: "overview", zoom: 1.5 },
        })
      );
    });

    it("omits extensionState from snapshot when undefined", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal({ id: "no-ext", kind: "browser" });

      persistence.save([terminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals[0]).not.toHaveProperty("extensionState");
    });

    it("persists extensionState for PTY panels", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const ptyPanel = createMockTerminal({
        id: "pty-ext",
        kind: "terminal",
        cwd: "/test",
        extensionState: { config: true },
      });

      persistence.save([ptyPanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(savedTerminals[0]).toEqual(
        expect.objectContaining({
          id: "pty-ext",
          extensionState: { config: true },
        })
      );
    });

    it("persists pluginId for unregistered extension kind so placeholder can survive restart", () => {
      // Regression test for #5580. When a plugin is disabled, its panel kind is
      // no longer registered — `panelToSnapshot` must still include `pluginId`
      // in the base snapshot so hydration can resurrect the panel as a
      // PluginMissingPanel instead of silently dropping it.
      const panel = createMockTerminal({
        id: "ext-missing",
        kind: "my-plugin.panel",
        title: "Custom",
        location: "grid",
        pluginId: "my-plugin",
      });

      const snapshot = panelToSnapshot(panel);
      expect(snapshot).toEqual(
        expect.objectContaining({
          id: "ext-missing",
          kind: "my-plugin.panel",
          pluginId: "my-plugin",
        })
      );
    });

    it("omits pluginId from snapshot when absent", () => {
      const panel = createMockTerminal({ id: "no-plugin", kind: "browser" });
      const snapshot = panelToSnapshot(panel);
      expect(snapshot).not.toHaveProperty("pluginId");
    });

    it("stamps worktreeGitDir from the worktree store, omitting it when unknown (#11388)", () => {
      // The stable admin-dir handle lets restore survive a `git worktree move`.
      setWorktreeGitDirAccessor((id) =>
        id === "wt-1" ? "/repo/.git/worktrees/wt-1" : undefined
      );
      try {
        const withHandle = panelToSnapshot(
          createMockTerminal({ id: "p1", worktreeId: "wt-1" })
        );
        expect(withHandle.worktreeGitDir).toBe("/repo/.git/worktrees/wt-1");

        // No handle available (unknown / legacy worktree) ⇒ field omitted.
        const noHandle = panelToSnapshot(
          createMockTerminal({ id: "p2", worktreeId: "wt-unknown" })
        );
        expect(noHandle).not.toHaveProperty("worktreeGitDir");
      } finally {
        setWorktreeGitDirAccessor(() => undefined);
      }
    });
  });

  describe("unregistered extension kind", () => {
    it("falls back to base-only when no previous snapshot exists", async () => {
      // First-save scenario: no prior state to preserve, no serializer registered.
      // Base fields (including extensionState) survive; kind-specific fragment is empty.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const panel = createMockTerminal({
        id: "ext-unknown",
        kind: "custom-widget",
        title: "Custom",
        extensionState: { key: "value" },
        location: "grid",
      });

      persistence.save([panel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const saved = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(saved).toHaveLength(1);
      expect(saved[0]).toEqual({
        id: "ext-unknown",
        kind: "custom-widget",
        title: "Custom",
        worktreeId: undefined,
        location: "grid",
        extensionState: { key: "value" },
      });
    });

    it("overwrites base fields from live terminal but preserves kind-specific fragment", () => {
      // Round-trip test for #8960. Base fields (recognized by the compile-time
      // allowlist) must be overwritten by the live terminal, while kind-specific
      // fields from a previous snapshot must survive the save cycle.
      const previous: TerminalSnapshot = {
        id: "ext-roundtrip",
        kind: "custom-widget",
        title: "Stale Title",
        worktreeId: "wt-stale",
        location: "grid",
        browserUrl: "https://example.com",
      };

      const panel = createMockTerminal({
        id: "ext-roundtrip",
        kind: "custom-widget",
        title: "Live Title",
        worktreeId: "wt-live",
        location: "grid",
      });

      const snapshot = panelToSnapshot(panel, previous);

      expect(snapshot.title).toBe("Live Title");
      expect(snapshot.worktreeId).toBe("wt-live");
      expect(snapshot.browserUrl).toBe("https://example.com");
    });

    it("preserves previously-persisted kind-specific fields across save cycles", async () => {
      // Regression test for #5201. A panel whose kind has no registered
      // serializer (extension disabled mid-session, plugin not yet loaded,
      // kind renamed) must retain its kind-specific fields through saves.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const panel = createMockTerminal({
        id: "ext-unknown",
        kind: "custom-widget",
        title: "Custom",
        location: "grid",
      });

      // Prime persistence with a snapshot that includes kind-specific fields,
      // as if hydrated from disk after an app launch where the extension
      // hasn't registered its serializer yet.
      persistence.primeProject(projectId, [
        {
          id: "ext-unknown",
          kind: "custom-widget",
          title: "Custom",
          location: "grid",
          // Kind-specific fields the (now-gone) serializer had written.
          browserUrl: "https://example.com",
          command: "npm run dev",
        },
      ]);

      persistence.save([panel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const saved = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(saved).toHaveLength(1);
      expect(saved[0]).toEqual(
        expect.objectContaining({
          id: "ext-unknown",
          kind: "custom-widget",
          browserUrl: "https://example.com",
          command: "npm run dev",
        })
      );
    });

    it("preserves fields across two successive save cycles", async () => {
      // Save once after priming, then save again — the second save should
      // consult persisted state (not stale previous "base-only" output) and
      // still preserve the kind-specific fields.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const panel = createMockTerminal({
        id: "ext-unknown",
        kind: "custom-widget",
        title: "Custom",
        location: "grid",
      });

      persistence.primeProject(projectId, [
        {
          id: "ext-unknown",
          kind: "custom-widget",
          title: "Custom",
          location: "grid",
          browserUrl: "https://example.com",
        },
      ]);

      persistence.save([panel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      // Trigger a second save with a title change so the snapshot differs
      // from the queued/persisted state and the debounce actually fires.
      persistence.save([createMockTerminal({ ...panel, title: "Custom Renamed" })], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledTimes(2);
      const secondSave = client.setTerminals.mock.calls[1]![1] as TerminalSnapshot[];
      expect(secondSave[0]).toEqual(
        expect.objectContaining({
          id: "ext-unknown",
          title: "Custom Renamed",
          browserUrl: "https://example.com",
        })
      );
    });

    it("does not preserve fields across a kind change for the same id", async () => {
      // Same panel id but a different kind — the previously-persisted
      // fragment belongs to the old kind and must NOT leak into the new kind.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      persistence.primeProject(projectId, [
        {
          id: "ext-unknown",
          kind: "old-kind",
          title: "Custom",
          location: "grid",
          browserUrl: "https://old.example.com",
        },
      ]);

      const panel = createMockTerminal({
        id: "ext-unknown",
        kind: "new-kind",
        title: "Custom",
        location: "grid",
      });

      persistence.save([panel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const saved = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(saved[0]).not.toHaveProperty("browserUrl");
      expect(saved[0]).toEqual(expect.objectContaining({ id: "ext-unknown", kind: "new-kind" }));
    });

    it("bypasses preservation when a custom transform is provided", async () => {
      // Custom `transform` is an external extension point. Preservation logic
      // is tied to the default transform (panelToSnapshot); custom transforms
      // own their own output entirely.
      const client = createMockProjectClient();
      const customTransform = vi.fn((t: TerminalInstance): TerminalSnapshot => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        location: t.location === "trash" ? "grid" : t.location,
      }));
      const persistence = new PanelPersistence(client, {
        debounceMs: 100,
        transform: customTransform,
      });

      persistence.primeProject(projectId, [
        {
          id: "ext-unknown",
          kind: "custom-widget",
          title: "Custom",
          location: "grid",
          browserUrl: "https://example.com",
        },
      ]);

      const panel = createMockTerminal({
        id: "ext-unknown",
        kind: "custom-widget",
        title: "Custom",
        location: "grid",
      });

      persistence.save([panel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(customTransform).toHaveBeenCalledTimes(1);
      const saved = client.setTerminals.mock.calls[0]![1] as TerminalSnapshot[];
      expect(saved[0]).not.toHaveProperty("browserUrl");
    });

    it("primeProject is a no-op when state is already tracked", async () => {
      // If a real save has already run (persisted state exists), a late
      // hydration prime must not clobber live data.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const panel = createMockTerminal({
        id: "ext-unknown",
        kind: "custom-widget",
        title: "First",
        location: "grid",
      });

      persistence.save([panel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      // Late prime with a different snapshot — should be ignored.
      persistence.primeProject(projectId, [
        {
          id: "ext-unknown",
          kind: "custom-widget",
          title: "Stale",
          location: "grid",
          browserUrl: "https://stale.example.com",
        },
      ]);

      persistence.save([createMockTerminal({ ...panel, title: "Second" })], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const secondSave = client.setTerminals.mock.calls[1]![1] as TerminalSnapshot[];
      expect(secondSave[0]).not.toHaveProperty("browserUrl");
      expect(secondSave[0]).toEqual(
        expect.objectContaining({ id: "ext-unknown", title: "Second" })
      );
    });

    it("getPreviousSnapshotMap exposes preserved fragments to external callers", () => {
      // Regression test for the project-switch outgoing-state path. The main
      // process pre-applies outgoing terminals to persisted state, so a
      // synchronous capture during switch must also thread previousSnapshot
      // through panelToSnapshot — not just the debounced save path.
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      persistence.primeProject(projectId, [
        {
          id: "ext-unknown",
          kind: "custom-widget",
          title: "Custom",
          location: "grid",
          browserUrl: "https://example.com",
          command: "npm run dev",
        },
      ]);

      const prevMap = persistence.getPreviousSnapshotMap(projectId);
      expect(prevMap).toBeDefined();
      expect(prevMap?.get("ext-unknown")).toEqual(
        expect.objectContaining({
          browserUrl: "https://example.com",
          command: "npm run dev",
        })
      );

      const panel = createMockTerminal({
        id: "ext-unknown",
        kind: "custom-widget",
        title: "Custom",
        location: "grid",
      });

      const snapshot = panelToSnapshot(panel, prevMap?.get(panel.id));
      expect(snapshot).toEqual(
        expect.objectContaining({
          id: "ext-unknown",
          kind: "custom-widget",
          browserUrl: "https://example.com",
          command: "npm run dev",
        })
      );
    });

    it("getPreviousSnapshotMap returns undefined for unknown projects", () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });
      expect(persistence.getPreviousSnapshotMap("nonexistent")).toBeUndefined();
    });

    it("preserves fragment via queued state when debounce has not flushed", async () => {
      // Covers the queuedTerminalsByProject branch of getPreviousSnapshotMap.
      // Make the first persist hang so queued state stays present while a
      // second save runs; the second save must still see the preserved
      // fragment via queued, not fall back to an empty fragment.
      const client = createMockProjectClient();
      let resolveFirstPersist: (() => void) | undefined;
      const firstPersistPromise = new Promise<void>((resolve) => {
        resolveFirstPersist = resolve;
      });
      client.setTerminals.mockImplementationOnce(() => firstPersistPromise);

      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      persistence.primeProject(projectId, [
        {
          id: "ext-unknown",
          kind: "custom-widget",
          title: "Custom",
          location: "grid",
          browserUrl: "https://example.com",
        },
      ]);

      const panel = createMockTerminal({
        id: "ext-unknown",
        kind: "custom-widget",
        title: "Custom",
        location: "grid",
      });

      persistence.save([panel], projectId);
      await vi.advanceTimersByTimeAsync(100);
      // First persist is still pending; queued has been flushed into the
      // persist promise but queuedTerminalsByProject remains primed.
      expect(client.setTerminals).toHaveBeenCalledTimes(1);

      persistence.save([createMockTerminal({ ...panel, title: "Renamed" })], projectId);
      await vi.advanceTimersByTimeAsync(100);
      // The fragment is captured from queued state synchronously at save() time,
      // but the second write is serialized behind the in-flight first write and
      // is not sent until that resolves (#11350).
      expect(client.setTerminals).toHaveBeenCalledTimes(1);

      resolveFirstPersist?.();
      await persistence.whenIdle();

      expect(client.setTerminals).toHaveBeenCalledTimes(2);
      const secondSave = client.setTerminals.mock.calls[1]![1] as TerminalSnapshot[];
      expect(secondSave[0]).toEqual(
        expect.objectContaining({
          id: "ext-unknown",
          title: "Renamed",
          browserUrl: "https://example.com",
        })
      );
    });
  });

  describe("dev-preview panels", () => {
    it("persists config but not runtime state for dev-preview panels", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const devPreviewPanel = createMockTerminal({
        id: "dev-preview-1",
        kind: "dev-preview",
        title: "Dev Preview",
        browserUrl: "http://localhost:5173",
        devCommand: "npm run dev",
        devServerStatus: "running",
        devServerUrl: "http://localhost:5173",
        devServerError: { type: "unknown", message: "Previous warning" },
        devServerTerminalId: "dev-preview-pty-1",
        devPreviewConsoleOpen: true,
        location: "grid",
      });

      persistence.save([devPreviewPanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledWith(
        projectId,
        [
          expect.objectContaining({
            id: "dev-preview-1",
            kind: "dev-preview",
            browserUrl: "http://localhost:5173",
            command: "npm run dev",
            devPreviewConsoleOpen: true,
          }),
        ],
        expect.any(Array),
        expect.any(Array)
      );

      const saved = client.setTerminals.mock.calls[0]![1][0] as Record<string, unknown>;
      expect(saved.devServerStatus).toBeUndefined();
      expect(saved.devServerUrl).toBeUndefined();
      expect(saved.devServerError).toBeUndefined();
      expect(saved.devServerTerminalId).toBeUndefined();
    });
  });
});
