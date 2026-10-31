import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const projectStoreMock = vi.hoisted(() => ({
  getProjectSettings: vi.fn(async (): Promise<Record<string, unknown>> => ({ runCommands: [] })),
  saveProjectSettings: vi.fn(async () => {}),
  getProjectById: vi.fn(() => ({ id: "p1", path: "/repo" })),
  writeInRepoSettings: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, dialog: {} }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  broadcastToRenderer: vi.fn(),
}));

import { registerProjectSettingsHandlers } from "../projectCrud/settings.js";
import { CHANNELS } from "../../channels.js";
import {
  clearForgeProviderRegistry,
  registerForgeProviders,
} from "../../../services/forgeProviderRegistry.js";

function save(settings: Record<string, unknown>): Promise<unknown> {
  const handler = ipcHandlers.get(CHANNELS.PROJECT_SAVE_SETTINGS);
  if (typeof handler !== "function") throw new Error("handler not registered");
  return Promise.resolve(
    Reflect.apply(handler, undefined, [{ sender: {} }, { projectId: "p1", settings }])
  );
}

describe("project:save-settings with an installed plugin's provider (#15583)", () => {
  let cleanup: () => void;
  const updateForgeSettings = vi.fn(async () => {});

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    clearForgeProviderRegistry();
    registerForgeProviders(
      "daintree.github",
      [{ id: "github", name: "GitHub", matches: ["github.com"] }],
      { builtin: true }
    );
    registerForgeProviders(
      "acme.gitea",
      [{ id: "gitea", name: "Gitea", matches: ["gitea.example.com"] }],
      { builtin: false }
    );
    registerForgeProviders(
      "acme.tracker",
      [{ id: "tracker", name: "Tracker", matches: [], roles: ["issues"] }],
      { builtin: false }
    );
    projectStoreMock.getProjectSettings.mockResolvedValue({ runCommands: [] });
    cleanup = registerProjectSettingsHandlers({
      worktreeService: { updateForgeSettings } as never,
    });
  });

  afterEach(() => {
    cleanup();
    clearForgeProviderRegistry();
  });

  it.each([
    ["forgeProviderOverride", "acme.gitea.gitea", "Gitea"],
    ["issueProviderOverride", "acme.tracker.tracker", "Tracker"],
  ])("refuses a newly picked %s before writing anything", async (key, id, name) => {
    await expect(save({ runCommands: [], [key]: id })).rejects.toThrow(
      `Forge provider "${name}" can't run`
    );
    expect(projectStoreMock.saveProjectSettings).not.toHaveBeenCalled();
    expect(updateForgeSettings).not.toHaveBeenCalled();
  });

  it("still saves unrelated changes while a stored override names one", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      forgeProviderOverride: "acme.gitea.gitea",
    });

    await save({
      runCommands: [],
      forgeProviderOverride: "acme.gitea.gitea",
      forgeRemote: "upstream",
    });

    expect(projectStoreMock.saveProjectSettings).toHaveBeenCalledTimes(1);
  });

  it("lets a stored one be cleared", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      issueProviderOverride: "acme.tracker.tracker",
    });

    await save({ runCommands: [], issueProviderOverride: null });

    expect(projectStoreMock.saveProjectSettings).toHaveBeenCalledTimes(1);
  });

  it("still accepts a built-in provider", async () => {
    await save({ runCommands: [], forgeProviderOverride: "daintree.github.github" });

    expect(projectStoreMock.saveProjectSettings).toHaveBeenCalledTimes(1);
    expect(updateForgeSettings).toHaveBeenCalledWith("/repo");
  });
});
