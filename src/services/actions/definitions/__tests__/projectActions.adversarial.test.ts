import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { Project } from "@shared/types";

const projectClientMock = vi.hoisted(() => ({
  openDialog: vi.fn(),
  getAll: vi.fn(),
  getCurrent: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  detectRunners: vi.fn(),
  getStats: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const projectSettingsStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const projectMruMock = vi.hoisted(() => ({
  getMruProjects: vi.fn<(projects: readonly Project[]) => Project[]>(() => []),
}));

vi.mock("@/clients", () => ({ projectClient: projectClientMock }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: projectSettingsStoreMock,
}));
vi.mock("@shared/utils/projectMru", () => projectMruMock);
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { registerProjectActions } from "../projectActions";

function setupActions(): {
  run: (id: string, args?: unknown, ctx?: Record<string, unknown>) => Promise<unknown>;
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    onOpenProjectSwitcherPalette: vi.fn(),
    onConfirmCloseActiveProject: vi.fn(),
  } as unknown as ActionCallbacks;
  registerProjectActions(actions, callbacks);
  return {
    run: async (id, args, ctx) => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      const def = factory() as AnyActionDefinition;
      return def.run(args, (ctx ?? {}) as never);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(projectClientMock)) fn.mockResolvedValue(undefined);
  projectStoreMock.getState.mockReturnValue({ currentProject: null, projects: [] });
  projectSettingsStoreMock.getState.mockReturnValue({
    projectId: null,
    setSettings: vi.fn(),
  });
  projectMruMock.getMruProjects.mockReturnValue([]);
});

describe("projectActions adversarial", () => {
  describe("MRU cycle fallbacks", () => {
    function mockMruState(currentProject: { id: string } | null = { id: "p-current" }) {
      const switchProject = vi.fn().mockResolvedValue(undefined);
      const reopenProject = vi.fn().mockResolvedValue(undefined);
      const projects: Project[] = [
        { id: "p-current", path: "/p-current", name: "Current", emoji: "tree", lastOpened: 500 },
        { id: "p-recent", path: "/p-recent", name: "Recent", emoji: "leaf", lastOpened: 400 },
        { id: "p-older", path: "/p-older", name: "Older", emoji: "branch", lastOpened: 300 },
      ];

      projectStoreMock.getState.mockReturnValue({
        currentProject,
        projects,
        switchProject,
        reopenProject,
      });
      projectMruMock.getMruProjects.mockReturnValue(projects);

      return { switchProject, reopenProject };
    }

    it("project.mruCycleOlder switches to the most recent other project", async () => {
      const { switchProject, reopenProject } = mockMruState();

      const { run } = setupActions();
      await run("project.mruCycleOlder");

      expect(switchProject).toHaveBeenCalledWith("p-recent");
      expect(reopenProject).not.toHaveBeenCalled();
    });

    it("project.mruCycleNewer switches to the oldest other project", async () => {
      const { switchProject, reopenProject } = mockMruState();

      const { run } = setupActions();
      await run("project.mruCycleNewer");

      expect(switchProject).toHaveBeenCalledWith("p-older");
      expect(reopenProject).not.toHaveBeenCalled();
    });

    it("project.mruCycleOlder returns to the MRU head when a scratch cleared the current project", async () => {
      const { switchProject } = mockMruState(null);

      const { run } = setupActions();
      await run("project.mruCycleOlder");

      expect(switchProject).toHaveBeenCalledWith("p-current");
    });

    it("project.mruCycleNewer wraps to the MRU tail when a scratch cleared the current project", async () => {
      const { switchProject } = mockMruState(null);

      const { run } = setupActions();
      await run("project.mruCycleNewer");

      expect(switchProject).toHaveBeenCalledWith("p-older");
    });
  });

  describe("project.getSettings", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const { run } = setupActions();
      await run("project.getSettings", undefined, { projectId: "proj-active" });
      expect(projectClientMock.getSettings).toHaveBeenCalledWith("proj-active");
    });

    it("prefers explicit projectId over ctx", async () => {
      const { run } = setupActions();
      await run("project.getSettings", { projectId: "proj-explicit" }, { projectId: "proj-ctx" });
      expect(projectClientMock.getSettings).toHaveBeenCalledWith("proj-explicit");
    });

    it("throws when projectId is omitted and no active project in ctx", async () => {
      const { run } = setupActions();
      await expect(run("project.getSettings", undefined)).rejects.toThrow("No active project");
    });
  });

  describe("project.detectRunners", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const { run } = setupActions();
      await run("project.detectRunners", undefined, { projectId: "proj-active" });
      expect(projectClientMock.detectRunners).toHaveBeenCalledWith("proj-active");
    });

    it("throws when no projectId and no ctx", async () => {
      const { run } = setupActions();
      await expect(run("project.detectRunners", undefined)).rejects.toThrow("No active project");
    });
  });

  describe("project.getStats", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const { run } = setupActions();
      await run("project.getStats", undefined, { projectId: "proj-active" });
      expect(projectClientMock.getStats).toHaveBeenCalledWith("proj-active");
    });

    it("preserves explicit projectId over ctx", async () => {
      const { run } = setupActions();
      await run("project.getStats", { projectId: "explicit" }, { projectId: "ctx" });
      expect(projectClientMock.getStats).toHaveBeenCalledWith("explicit");
    });

    it("throws and skips client call when no projectId and no ctx", async () => {
      const { run } = setupActions();
      await expect(run("project.getStats", undefined)).rejects.toThrow("No active project");
      expect(projectClientMock.getStats).not.toHaveBeenCalled();
    });
  });

  describe("project.saveSettings", () => {
    it("writes through to the active project settings store after saving", async () => {
      const setSettings = vi.fn();
      projectClientMock.getSettings.mockResolvedValueOnce({
        runCommands: [],
        devServerCommand: "",
      });
      projectStoreMock.getState.mockReturnValue({
        currentProject: { id: "proj-active" },
        projects: [],
      });
      projectSettingsStoreMock.getState.mockReturnValue({
        projectId: "proj-active",
        setSettings,
      });

      const { run } = setupActions();
      await run("project.saveSettings", {
        projectId: "proj-active",
        settings: {
          devServerCommand: "npm run dev",
          daintreeMcpTier: "all",
        },
      });

      expect(projectClientMock.saveSettings).toHaveBeenCalledWith("proj-active", {
        runCommands: [],
        devServerCommand: "npm run dev",
      });
      expect(setSettings).toHaveBeenCalledWith({
        runCommands: [],
        devServerCommand: "npm run dev",
      });
    });

    it("does not mutate the store when saving an inactive project", async () => {
      const setSettings = vi.fn();
      projectClientMock.getSettings.mockResolvedValueOnce({ runCommands: [] });
      projectStoreMock.getState.mockReturnValue({
        currentProject: { id: "proj-active" },
        projects: [],
      });
      projectSettingsStoreMock.getState.mockReturnValue({
        projectId: "proj-active",
        setSettings,
      });

      const { run } = setupActions();
      await run("project.saveSettings", {
        projectId: "proj-other",
        settings: { devServerCommand: "npm run dev" },
      });

      expect(setSettings).not.toHaveBeenCalled();
    });
  });
});
