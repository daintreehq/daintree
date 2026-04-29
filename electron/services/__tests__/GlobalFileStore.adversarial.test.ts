import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));

const fsSyncMock = vi.hoisted(() => ({ existsSync: vi.fn() }));

const utilsMock = vi.hoisted(() => ({
  resilientRename: vi.fn(),
  resilientAtomicWriteFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));
vi.mock("fs", () => ({ ...fsSyncMock }));
vi.mock("../../utils/fs.js", () => utilsMock);

import { GlobalFileStore } from "../GlobalFileStore.js";

const CONFIG_DIR = path.normalize("/tmp/daintree-global");
const RECIPES_FILE = path.join(CONFIG_DIR, "recipes.json");

describe("GlobalFileStore adversarial", () => {
  let store: GlobalFileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new GlobalFileStore(CONFIG_DIR);
    fsMock.mkdir.mockResolvedValue(undefined);
    utilsMock.resilientAtomicWriteFile.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("corrupted JSON returns [] and quarantines the file", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue("{ not json");

    const result = await store.getRecipes();

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      RECIPES_FILE,
      expect.stringMatching(/^\/tmp\/daintree-global\/recipes\.json\.corrupted\.\d+$/)
    );
  });

  it("non-array JSON returns [] without quarantining", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(JSON.stringify({ wrong: "shape" }));

    const result = await store.getRecipes();

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it("filters invalid entries but keeps valid ones", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "r1", name: "valid", terminals: [] },
        null,
        "string",
        { id: "r2", name: "no terminals" },
        { id: 42, name: "wrong id type", terminals: [] },
        { id: "r3", name: "also valid", terminals: [{ title: "t" }] },
      ])
    );

    const result = await store.getRecipes();
    expect(result.map((r) => r.id)).toEqual(["r1", "r3"]);
  });

  it("saveRecipes ENOENT triggers mkdir + retry", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    utilsMock.resilientAtomicWriteFile
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce(undefined);

    await store.saveRecipes([]);

    expect(fsMock.mkdir).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(2);
  });

  it("saveRecipes non-ENOENT re-throws without mkdir", async () => {
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    utilsMock.resilientAtomicWriteFile.mockRejectedValue(eacces);

    await expect(store.saveRecipes([])).rejects.toThrow("EACCES");
    expect(fsMock.mkdir).not.toHaveBeenCalled();
  });

  it("updateRecipe on missing id throws and does not write", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue("[]");

    await expect(store.updateRecipe("missing", { name: "x" })).rejects.toThrow(/not found/);
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("updateRecipe does not let the patch overwrite id/projectId/createdAt", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        {
          id: "r1",
          name: "orig",
          terminals: [],
          createdAt: 1000,
        },
      ])
    );

    await store.updateRecipe("r1", {
      name: "new",
      // Cast through unknown to bypass the compile-time Omit; simulates a
      // caller bypassing TypeScript (e.g., untyped bridge or JSON payload).
      id: "rewritten",
      projectId: "injected",
      createdAt: 9999,
    } as unknown as Parameters<typeof store.updateRecipe>[1]);

    const payload = JSON.parse(
      utilsMock.resilientAtomicWriteFile.mock.calls[0][1] as string
    ) as Array<Record<string, unknown>>;
    expect(payload[0].id).toBe("r1");
    expect(payload[0].createdAt).toBe(1000);
    expect(payload[0].projectId).toBeUndefined();
    expect(payload[0].name).toBe("new");
  });

  it("deleteRecipe removes only the matching entry", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "keep", name: "k", terminals: [] },
        { id: "drop", name: "d", terminals: [] },
      ])
    );

    await store.deleteRecipe("drop");

    const payload = JSON.parse(
      utilsMock.resilientAtomicWriteFile.mock.calls[0][1] as string
    ) as Array<{ id: string }>;
    expect(payload.map((r) => r.id)).toEqual(["keep"]);
  });

  it("getRecipes returns [] when file doesn't exist (no readFile attempt)", async () => {
    fsSyncMock.existsSync.mockReturnValue(false);
    const result = await store.getRecipes();
    expect(result).toEqual([]);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("quarantine rename failure is soft — getRecipes still returns []", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue("bad json");
    utilsMock.resilientRename.mockRejectedValueOnce(new Error("EBUSY"));

    const result = await store.getRecipes();
    expect(result).toEqual([]);
  });

  it("addRecipe loads + appends + saves without mutating the loaded array for caller", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(JSON.stringify([]));

    await store.addRecipe({
      id: "r-new",
      name: "new",
      terminals: [],
      createdAt: 1,
    } as never);

    const payload = JSON.parse(
      utilsMock.resilientAtomicWriteFile.mock.calls[0][1] as string
    ) as Array<{ id: string }>;
    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe("r-new");
  });
});
