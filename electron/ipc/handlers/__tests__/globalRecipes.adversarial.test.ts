import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const projectStoreMock = vi.hoisted(() => ({
  getGlobalRecipes: vi.fn(() => []),
  addGlobalRecipe: vi.fn(),
  updateGlobalRecipe: vi.fn(),
  deleteGlobalRecipe: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import { registerGlobalRecipesHandlers } from "../globalRecipes.js";
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

const validRecipe = () => ({
  id: "r1",
  name: "My Recipe",
  terminals: [],
  createdAt: 1000,
});

describe("globalRecipes IPC adversarial", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    cleanup = registerGlobalRecipesHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("addRecipe rejects non-finite createdAt (NaN)", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_ADD_RECIPE)(fakeEvent(), {
        recipe: { ...validRecipe(), createdAt: Number.NaN },
      })
    ).rejects.toThrow(/createdAt/);
    expect(projectStoreMock.addGlobalRecipe).not.toHaveBeenCalled();
  });

  it("addRecipe rejects non-finite createdAt (Infinity)", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_ADD_RECIPE)(fakeEvent(), {
        recipe: { ...validRecipe(), createdAt: Number.POSITIVE_INFINITY },
      })
    ).rejects.toThrow(/createdAt/);
  });

  it("addRecipe rejects whitespace-only name", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_ADD_RECIPE)(fakeEvent(), {
        recipe: { ...validRecipe(), name: "   " },
      })
    ).rejects.toThrow(/required fields|name/i);
    expect(projectStoreMock.addGlobalRecipe).not.toHaveBeenCalled();
  });

  it("addRecipe rejects whitespace-only id", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_ADD_RECIPE)(fakeEvent(), {
        recipe: { ...validRecipe(), id: "  \t " },
      })
    ).rejects.toThrow(/required fields|id/i);
    expect(projectStoreMock.addGlobalRecipe).not.toHaveBeenCalled();
  });

  it("addRecipe rejects projectId on global recipe", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_ADD_RECIPE)(fakeEvent(), {
        recipe: { ...validRecipe(), projectId: "p1" },
      })
    ).rejects.toThrow(/projectId/);
  });

  it("addRecipe rejects worktreeId on global recipe", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_ADD_RECIPE)(fakeEvent(), {
        recipe: { ...validRecipe(), worktreeId: "wt-1" },
      })
    ).rejects.toThrow(/worktreeId/);
  });

  it("addRecipe accepts a well-formed recipe and forwards it to the project store", async () => {
    const recipe = validRecipe();
    await getHandler(CHANNELS.GLOBAL_ADD_RECIPE)(fakeEvent(), { recipe });
    expect(projectStoreMock.addGlobalRecipe).toHaveBeenCalledWith(recipe);
  });

  it("updateRecipe rejects patches that attempt to rewrite immutable fields", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_UPDATE_RECIPE)(fakeEvent(), {
        recipeId: "r1",
        updates: { id: "new-id" } as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/immutable|id/i);
    expect(projectStoreMock.updateGlobalRecipe).not.toHaveBeenCalled();
  });

  it("updateRecipe rejects patches with projectId", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_UPDATE_RECIPE)(fakeEvent(), {
        recipeId: "r1",
        updates: { projectId: "p1" } as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/immutable|projectId/i);
    expect(projectStoreMock.updateGlobalRecipe).not.toHaveBeenCalled();
  });

  it("updateRecipe rejects patches with createdAt", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_UPDATE_RECIPE)(fakeEvent(), {
        recipeId: "r1",
        updates: { createdAt: 999 } as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/immutable|createdAt/i);
  });

  it("updateRecipe rejects non-array terminals", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_UPDATE_RECIPE)(fakeEvent(), {
        recipeId: "r1",
        updates: { terminals: "oops" } as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/terminals/i);
    expect(projectStoreMock.updateGlobalRecipe).not.toHaveBeenCalled();
  });

  it("updateRecipe forwards a clean rename patch", async () => {
    await getHandler(CHANNELS.GLOBAL_UPDATE_RECIPE)(fakeEvent(), {
      recipeId: "r1",
      updates: { name: "New Name" },
    });
    expect(projectStoreMock.updateGlobalRecipe).toHaveBeenCalledWith("r1", { name: "New Name" });
  });

  it("deleteRecipe rejects empty recipeId", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_DELETE_RECIPE)(fakeEvent(), { recipeId: "" })
    ).rejects.toThrow(/Invalid recipe ID/);
    expect(projectStoreMock.deleteGlobalRecipe).not.toHaveBeenCalled();
  });

  it("deleteRecipe rejects non-string recipeId", async () => {
    await expect(
      getHandler(CHANNELS.GLOBAL_DELETE_RECIPE)(fakeEvent(), { recipeId: 42 as unknown as string })
    ).rejects.toThrow(/Invalid recipe ID/);
  });

  it("cleanup removes all four handlers", () => {
    expect(ipcHandlers.size).toBe(4);
    cleanup();
    expect(ipcHandlers.size).toBe(0);
  });
});
