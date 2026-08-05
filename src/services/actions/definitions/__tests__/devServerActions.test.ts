import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const projectClientMock = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  getSettings: vi.fn(),
}));
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const getCurrentViewStoreMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({ projectClient: projectClientMock }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/store/createWorktreeStore", () => ({ getCurrentViewStore: getCurrentViewStoreMock }));

import { registerDevServerActions } from "../devServerActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerDevServerActions(actions, callbacks);
  return async (id: string, ctx: Partial<ActionContext> = {}): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(undefined, ctx as ActionContext);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  panelStoreMock.getState.mockReturnValue({ addPanel: vi.fn().mockResolvedValue("dev-1") });
  projectStoreMock.getState.mockReturnValue({
    currentProject: { id: "project-1", path: "/repo" },
  });
  projectClientMock.getCurrent.mockResolvedValue(null);
  projectClientMock.getSettings.mockResolvedValue({ devServerCommand: " npm run dev " });
  getCurrentViewStoreMock.mockReturnValue({
    getState: () => ({ worktrees: new Map() }),
  });
});

describe("devServerActions", () => {
  it("uses the current project path when the action context has no path", async () => {
    const run = setupActions();

    await run("devServer.start", { projectId: "project-1" });

    expect(panelStoreMock.getState().addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dev-preview",
        cwd: "/repo",
        devCommand: "npm run dev",
      })
    );
  });

  it("uses the active worktree path from the view store when context path is missing", async () => {
    getCurrentViewStoreMock.mockReturnValue({
      getState: () => ({
        worktrees: new Map([["wt-1", { id: "wt-1", path: "/repo/worktrees/feature" }]]),
      }),
    });
    const run = setupActions();

    await run("devServer.start", { projectId: "project-1", activeWorktreeId: "wt-1" });

    expect(panelStoreMock.getState().addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/worktrees/feature",
        worktreeId: "wt-1",
      })
    );
  });

  it("falls back to the scratch path when no project is open", async () => {
    projectStoreMock.getState.mockReturnValue({ currentProject: null });
    const run = setupActions();

    await run("devServer.start", { scratchPath: "/scratch/workspace" });

    expect(projectClientMock.getSettings).not.toHaveBeenCalled();
    expect(panelStoreMock.getState().addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dev-preview",
        cwd: "/scratch/workspace",
        devCommand: undefined,
      })
    );
  });

  it("rejects launch when no absolute cwd can be resolved", async () => {
    projectStoreMock.getState.mockReturnValue({
      currentProject: { id: "project-1", path: "relative" },
    });
    const run = setupActions();

    await expect(run("devServer.start", { projectId: "project-1" })).rejects.toThrow(
      "No absolute project path is available for Dev Preview"
    );
  });
});
