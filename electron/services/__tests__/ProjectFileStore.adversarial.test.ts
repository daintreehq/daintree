import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));

const fsSyncMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
}));

const utilsMock = vi.hoisted(() => ({
  resilientRename: vi.fn(),
  resilientAtomicWriteFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));
vi.mock("fs", () => ({ ...fsSyncMock }));
vi.mock("../../utils/fs.js", () => utilsMock);

import { ProjectFileStore } from "../ProjectFileStore.js";

const VALID_ID = "a".repeat(64);
const INVALID_ID_TRAVERSAL = "../../../etc/passwd";
const CONFIG_DIR = path.normalize("/tmp/daintree-projects");
const EXPECTED_STATE_DIR = path.join(CONFIG_DIR, VALID_ID);
const EXPECTED_RECIPES_FILE = path.join(EXPECTED_STATE_DIR, "recipes.json");

describe("ProjectFileStore adversarial", () => {
  let store: ProjectFileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ProjectFileStore(CONFIG_DIR);
    utilsMock.resilientAtomicWriteFile.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockResolvedValue(undefined);
    fsMock.mkdir.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("saveRecipes with an invalid projectId blocks all filesystem I/O", async () => {
    await expect(store.saveRecipes(INVALID_ID_TRAVERSAL, [])).rejects.toThrow(/Invalid project ID/);

    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("getRecipes with an invalid projectId returns [] without reading", async () => {
    const result = await store.getRecipes(INVALID_ID_TRAVERSAL);
    expect(result).toEqual([]);
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it("corrupted JSON is quarantined by renaming to .corrupted and returns []", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue("{ not valid json");

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      EXPECTED_RECIPES_FILE,
      expect.stringMatching(/^\/tmp\/daintree-projects\/a{64}\/recipes\.json\.corrupted\.\d+$/)
    );
  });

  it("non-array JSON is tolerated — returns [] without quarantining (recoverable state preserved)", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(JSON.stringify({ notAnArray: true }));

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it("malformed recipe entries are filtered out — only structurally valid entries survive", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "r1", name: "valid", terminals: [] },
        null,
        "string",
        { id: "r2" }, // missing name/terminals
        { id: "r3", name: "no terminals array" },
        { id: "r4", name: "valid again", terminals: [{ title: "t" }] },
      ])
    );

    const result = await store.getRecipes(VALID_ID);

    expect(result.map((r) => r.id)).toEqual(["r1", "r4"]);
  });

  it("ENOENT on first write triggers mkdir + retry and eventually succeeds", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    utilsMock.resilientAtomicWriteFile
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce(undefined);

    await store.saveRecipes(VALID_ID, []);

    expect(fsMock.mkdir).toHaveBeenCalledWith(EXPECTED_STATE_DIR, { recursive: true });
    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(2);
  });

  it("non-ENOENT write errors are re-thrown without a mkdir retry", async () => {
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    utilsMock.resilientAtomicWriteFile.mockRejectedValue(eacces);

    await expect(store.saveRecipes(VALID_ID, [])).rejects.toThrow("EACCES");

    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(1);
  });

  it("updateRecipe on a missing recipe id throws and does not write", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(JSON.stringify([]));

    await expect(store.updateRecipe(VALID_ID, "missing", { name: "x" })).rejects.toThrow(
      /not found/
    );
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("getRecipes returns [] when the recipes file doesn't exist (no readFile attempt)", async () => {
    fsSyncMock.existsSync.mockReturnValue(false);

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("quarantine rename failure does not throw — getRecipes still returns []", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue("{ not valid json");
    utilsMock.resilientRename.mockRejectedValueOnce(new Error("EBUSY"));

    const result = await store.getRecipes(VALID_ID);
    expect(result).toEqual([]);
  });

  it("deleteRecipe filters the target out and writes the remaining recipes", async () => {
    fsSyncMock.existsSync.mockReturnValue(true);
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "keep", name: "k", terminals: [] },
        { id: "drop", name: "d", terminals: [] },
      ])
    );

    await store.deleteRecipe(VALID_ID, "drop");

    const write = utilsMock.resilientAtomicWriteFile.mock.calls[0];
    expect(write[0]).toBe(EXPECTED_RECIPES_FILE);
    const payload = JSON.parse(write[1] as string);
    expect(payload.map((r: { id: string }) => r.id)).toEqual(["keep"]);
  });
});
