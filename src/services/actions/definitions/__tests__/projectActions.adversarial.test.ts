import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

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

vi.mock("@/clients", () => ({ projectClient: projectClientMock }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/lib/projectMru", () => ({ getMruProjects: vi.fn(() => []) }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { registerProjectActions } from "../projectActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    onOpenProjectSwitcherPalette: vi.fn(),
    onConfirmCloseActiveProject: vi.fn(),
  } as unknown as ActionCallbacks;
  registerProjectActions(actions, callbacks);
  return (id: string) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(projectClientMock)) fn.mockResolvedValue(undefined);
  projectStoreMock.getState.mockReturnValue({ currentProject: null, projects: [] });
});

describe("projectActions adversarial", () => {
  describe("project.getSettings", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const def = setupActions()("project.getSettings");
      await def.run(undefined as never, { projectId: "proj-active" } as never);
      expect(projectClientMock.getSettings).toHaveBeenCalledWith("proj-active");
    });

    it("prefers explicit projectId over ctx", async () => {
      const def = setupActions()("project.getSettings");
      await def.run({ projectId: "proj-explicit" } as never, { projectId: "proj-ctx" } as never);
      expect(projectClientMock.getSettings).toHaveBeenCalledWith("proj-explicit");
    });

    it("throws when projectId is omitted and no active project in ctx", async () => {
      const def = setupActions()("project.getSettings");
      await expect(def.run(undefined as never, {} as never)).rejects.toThrow("No active project");
    });
  });

  describe("project.detectRunners", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const def = setupActions()("project.detectRunners");
      await def.run(undefined as never, { projectId: "proj-active" } as never);
      expect(projectClientMock.detectRunners).toHaveBeenCalledWith("proj-active");
    });

    it("throws when no projectId and no ctx", async () => {
      const def = setupActions()("project.detectRunners");
      await expect(def.run(undefined as never, {} as never)).rejects.toThrow("No active project");
    });
  });

  describe("project.getStats", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const def = setupActions()("project.getStats");
      await def.run(undefined as never, { projectId: "proj-active" } as never);
      expect(projectClientMock.getStats).toHaveBeenCalledWith("proj-active");
    });

    it("preserves explicit projectId over ctx", async () => {
      const def = setupActions()("project.getStats");
      await def.run({ projectId: "explicit" } as never, { projectId: "ctx" } as never);
      expect(projectClientMock.getStats).toHaveBeenCalledWith("explicit");
    });
  });
});
