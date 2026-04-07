import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { PanelPersistence } from "../panelPersistence";
import type { TerminalInstance, TerminalSnapshot } from "@/types";

initBuiltInPanelKinds();

const createMockTerminal = (overrides: Partial<TerminalInstance> = {}): TerminalInstance => ({
  id: "test-1",
  type: "terminal",
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
  openDialog: vi.fn().mockResolvedValue(null),
  onSwitch: vi.fn().mockReturnValue(() => {}),
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  detectRunners: vi.fn().mockResolvedValue([]),
  close: vi.fn().mockResolvedValue({ success: true }),
  reopen: vi.fn().mockResolvedValue({}),
  getStats: vi.fn().mockResolvedValue({}),
  getBulkStats: vi.fn().mockResolvedValue({}),
  initGit: vi.fn().mockResolvedValue(undefined),
  initGitGuided: vi.fn().mockResolvedValue({ success: true, completedSteps: [] }),
  onInitGitProgress: vi.fn().mockReturnValue(() => {}),
  getRecipes: vi.fn().mockResolvedValue([]),
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
        ])
      );

      const savedTerminals = client.setTerminals.mock.calls[0][1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(2);
      expect(savedTerminals).not.toContainEqual(expect.objectContaining({ id: "trash-1" }));
    });

    it("excludes smoke test terminals by default", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const normalTerminal = createMockTerminal({ id: "grid-1" });
      const smokeTerminal = createMockTerminal({ id: "smoke-test-terminal-1" });

      persistence.save([normalTerminal, smokeTerminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0][1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals[0]).toEqual(expect.objectContaining({ id: "grid-1" }));
    });

    it("transforms terminals with default transform", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal({
        id: "test-1",
        kind: "agent",
        type: "claude",
        agentId: "claude",
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

      expect(client.setTerminals).toHaveBeenCalledWith(projectId, [
        {
          id: "test-1",
          kind: "agent",
          type: "claude",
          agentId: "claude",
          title: "Claude",
          cwd: "/test",
          worktreeId: "wt-1",
          location: "grid",
          command: "claude --model sonnet-4",
          agentState: "working",
          lastStateChange: 1700000000000,
        },
      ]);
    });

    it("excludes transient detectedProcessId from persisted snapshots", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal({
        id: "test-detected-process",
        detectedProcessId: "npm",
      });

      persistence.save([terminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0][1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals[0]).not.toHaveProperty("detectedProcessId");
    });

    it("applies custom filter function", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, {
        debounceMs: 100,
        filter: (t) => t.type === "claude",
      });

      const shellTerminal = createMockTerminal({ id: "shell-1", type: "terminal" });
      const claudeTerminal = createMockTerminal({ id: "claude-1", type: "claude" });

      persistence.save([shellTerminal, claudeTerminal], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0][1] as TerminalSnapshot[];
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

      expect(client.setTerminals).toHaveBeenCalledWith(projectId, [
        expect.objectContaining({
          id: "test-1",
          title: "Custom",
          cwd: "/custom/path",
        }),
      ]);
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

      expect(client.setTerminals).toHaveBeenCalledWith("from-option", expect.any(Array));
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
        expect.arrayContaining([expect.objectContaining({ title: "Two" })])
      );
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

      expect(client.setTerminals).toHaveBeenCalledWith(projectId, [
        expect.objectContaining({
          id: "browser-1",
          kind: "browser",
          browserUrl: "https://localhost:3000",
        }),
      ]);
    });
  });

  describe("notes panels", () => {
    it("preserves notes metadata for notes panels", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const notesPanel = createMockTerminal({
        id: "notes-1",
        kind: "notes",
        title: "My Notes",
        notePath: "/notes/test.md",
        noteId: "note-uuid",
        scope: "project",
        createdAt: 1234567890,
        location: "grid",
      });

      persistence.save([notesPanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setTerminals).toHaveBeenCalledWith(projectId, [
        expect.objectContaining({
          id: "notes-1",
          kind: "notes",
          notePath: "/notes/test.md",
          noteId: "note-uuid",
          scope: "project",
          createdAt: 1234567890,
        }),
      ]);
    });
  });

  describe("extension state", () => {
    it("persists extensionState for extension panels through snapshot round-trip", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const extensionPanel = createMockTerminal({
        id: "ext-1",
        kind: "my-plugin",
        title: "My Plugin",
        extensionState: { activeTab: "overview", zoom: 1.5 },
        location: "grid",
      });

      persistence.save([extensionPanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0][1] as TerminalSnapshot[];
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals[0]).toEqual(
        expect.objectContaining({
          id: "ext-1",
          kind: "my-plugin",
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

      const savedTerminals = client.setTerminals.mock.calls[0][1] as TerminalSnapshot[];
      expect(savedTerminals[0]).not.toHaveProperty("extensionState");
    });

    it("persists extensionState for PTY panels", async () => {
      const client = createMockProjectClient();
      const persistence = new PanelPersistence(client, { debounceMs: 100 });

      const ptyPanel = createMockTerminal({
        id: "pty-ext",
        kind: "terminal",
        type: "terminal",
        cwd: "/test",
        extensionState: { config: true },
      });

      persistence.save([ptyPanel], projectId);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = client.setTerminals.mock.calls[0][1] as TerminalSnapshot[];
      expect(savedTerminals[0]).toEqual(
        expect.objectContaining({
          id: "pty-ext",
          extensionState: { config: true },
        })
      );
    });
  });

  describe("unregistered extension kind", () => {
    it("produces base-only snapshot without crashing for unknown kinds", async () => {
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

      const saved = client.setTerminals.mock.calls[0][1] as TerminalSnapshot[];
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

      expect(client.setTerminals).toHaveBeenCalledWith(projectId, [
        expect.objectContaining({
          id: "dev-preview-1",
          kind: "dev-preview",
          browserUrl: "http://localhost:5173",
          command: "npm run dev",
          devPreviewConsoleOpen: true,
        }),
      ]);

      const saved = client.setTerminals.mock.calls[0][1][0] as Record<string, unknown>;
      expect(saved.devServerStatus).toBeUndefined();
      expect(saved.devServerUrl).toBeUndefined();
      expect(saved.devServerError).toBeUndefined();
      expect(saved.devServerTerminalId).toBeUndefined();
    });
  });
});
