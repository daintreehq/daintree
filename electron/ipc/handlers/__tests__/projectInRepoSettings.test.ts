import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const projectStoreMock = vi.hoisted(() => ({
  getAllProjects: vi.fn(() => []),
  getProjectById: vi.fn(() => undefined as unknown),
  getProjectSettings: vi.fn(async () => ({})),
  getRecipes: vi.fn(async () => [] as Array<{ id: string; name: string }>),
  assertInRepoRecipesForwardCompatible: vi.fn(async () => undefined),
  writeInRepoProjectIdentity: vi.fn(async () => undefined),
  writeInRepoSettings: vi.fn(async () => undefined),
  writeInRepoRecipe: vi.fn(async () => undefined),
  updateProject: vi.fn(async () => ({ id: "p1", inRepoSettings: true })),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, dialog: {} }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import { registerProjectInRepoSettingsHandlers } from "../projectInRepoSettings.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("project:enable-in-repo-settings forward-compatibility pre-flight (#12261)", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    projectStoreMock.getProjectById.mockReturnValue({
      id: "p1",
      name: "Repo",
      path: "/repo",
    } as unknown as undefined);
    projectStoreMock.getProjectSettings.mockResolvedValue({});
    projectStoreMock.getRecipes.mockResolvedValue([
      { id: "r1", name: "Alpha" },
      { id: "r2", name: "Beta" },
    ]);
    projectStoreMock.assertInRepoRecipesForwardCompatible.mockResolvedValue(undefined);
    projectStoreMock.updateProject.mockResolvedValue({ id: "p1", inRepoSettings: true });
    cleanup = registerProjectInRepoSettingsHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  const enable = () =>
    getHandler(CHANNELS.PROJECT_ENABLE_IN_REPO_SETTINGS)(fakeEvent(), "p1") as Promise<unknown>;

  it("pre-flights every recipe destination before enabling", async () => {
    await enable();
    expect(projectStoreMock.assertInRepoRecipesForwardCompatible).toHaveBeenCalledWith("/repo", [
      "Alpha",
      "Beta",
    ]);
    expect(projectStoreMock.writeInRepoRecipe).toHaveBeenCalledTimes(2);
    expect(projectStoreMock.updateProject).toHaveBeenCalledWith("p1", {
      inRepoSettings: true,
      daintreeConfigPresent: true,
    });
  });

  it("writes nothing at all when a destination holds unsupported content", async () => {
    // The whole point of pre-flighting: a half-written batch with the setting
    // flipped on is worse than not enabling.
    const refusal = Object.assign(new Error("would strip"), {
      code: "RECIPE_FORWARD_COMPAT_CONFLICT",
    });
    projectStoreMock.assertInRepoRecipesForwardCompatible.mockRejectedValue(refusal);

    await expect(enable()).rejects.toMatchObject({ code: "RECIPE_FORWARD_COMPAT_CONFLICT" });

    expect(projectStoreMock.writeInRepoProjectIdentity).not.toHaveBeenCalled();
    expect(projectStoreMock.writeInRepoSettings).not.toHaveBeenCalled();
    expect(projectStoreMock.writeInRepoRecipe).not.toHaveBeenCalled();
    expect(projectStoreMock.updateProject).not.toHaveBeenCalled();
  });

  it("runs the pre-flight ahead of the identity and settings writes", async () => {
    const order: string[] = [];
    projectStoreMock.assertInRepoRecipesForwardCompatible.mockImplementation(async () => {
      order.push("preflight");
    });
    projectStoreMock.writeInRepoProjectIdentity.mockImplementation(async () => {
      order.push("identity");
    });
    projectStoreMock.writeInRepoSettings.mockImplementation(async () => {
      order.push("settings");
    });
    projectStoreMock.writeInRepoRecipe.mockImplementation(async () => {
      order.push("recipe");
    });

    await enable();
    expect(order).toEqual(["preflight", "identity", "settings", "recipe", "recipe"]);
  });

  it("still enables a project that has no recipes", async () => {
    projectStoreMock.getRecipes.mockResolvedValue([]);
    await enable();
    expect(projectStoreMock.assertInRepoRecipesForwardCompatible).toHaveBeenCalledWith("/repo", []);
    expect(projectStoreMock.updateProject).toHaveBeenCalled();
  });
});
