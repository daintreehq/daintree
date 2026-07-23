import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));

const utilsMock = vi.hoisted(() => ({
  resilientRename: vi.fn(),
  resilientAtomicWriteFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));
vi.mock("../../utils/fs.js", () => utilsMock);

import { GlobalFileStore } from "../GlobalFileStore.js";
import type { TerminalRecipe } from "../../types/index.js";

const CONFIG_DIR = path.normalize("/tmp/daintree-global");
const RECIPES_FILE = path.join(CONFIG_DIR, "recipes.json");

function recipe(id: string): TerminalRecipe {
  return { id, name: id, terminals: [], createdAt: 1000 } as TerminalRecipe;
}

/**
 * Model the single global recipes.json. `readFile` returns the last-written
 * bare array (ENOENT when absent); `resilientAtomicWriteFile` records it. The
 * optional per-write delay widens the read→write window so an unserialized
 * implementation would lose one of two concurrent updates.
 */
function installDiskModel(writeDelayMs = 0): { content: string | null } {
  const box: { content: string | null } = { content: null };
  fsMock.readFile.mockImplementation(async () => {
    if (box.content === null) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return box.content;
  });
  utilsMock.resilientAtomicWriteFile.mockImplementation(async (_filePath: string, data: string) => {
    if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
    box.content = data;
  });
  return box;
}

describe("GlobalFileStore write serialization", () => {
  let store: GlobalFileStore;

  beforeEach(() => {
    vi.resetAllMocks();
    store = new GlobalFileStore(CONFIG_DIR);
    fsMock.mkdir.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("serializes two concurrent addRecipe calls so neither update is lost", async () => {
    installDiskModel(5);

    await Promise.all([store.addRecipe(recipe("g1")), store.addRecipe(recipe("g2"))]);

    const result = await store.getRecipes();
    expect(result.map((r) => r.id).sort()).toEqual(["g1", "g2"]);
  });

  it("serializes many concurrent adds — every global recipe survives", async () => {
    installDiskModel(2);

    const ids = Array.from({ length: 8 }, (_, i) => `g${i}`);
    await Promise.all(ids.map((id) => store.addRecipe(recipe(id))));

    const result = await store.getRecipes();
    expect(result.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it("a failing update rejects its own caller but does not poison later updates", async () => {
    installDiskModel(2);
    await store.addRecipe(recipe("g1"));

    const failing = store.updateRecipe("missing", { name: "x" });
    const following = store.addRecipe(recipe("g2"));

    await expect(failing).rejects.toThrow(/not found/);
    await expect(following).resolves.toBeUndefined();

    const result = await store.getRecipes();
    expect(result.map((r) => r.id).sort()).toEqual(["g1", "g2"]);
  });

  it("interleaved add / update / delete apply in enqueue order", async () => {
    installDiskModel(2);

    await Promise.all([
      store.addRecipe(recipe("keep")),
      store.addRecipe(recipe("drop")),
      store.updateRecipe("keep", { name: "renamed" }),
      store.deleteRecipe("drop"),
    ]);

    const result = await store.getRecipes();
    expect(result.map((r) => r.id)).toEqual(["keep"]);
    expect(result[0]!.name).toBe("renamed");
  });

  it("bulk saveRecipes is serialized in the queue — an add enqueued behind it sees its result", async () => {
    installDiskModel(3);

    const savePromise = store.saveRecipes([recipe("base")]);
    const addPromise = store.addRecipe(recipe("added"));
    await Promise.all([savePromise, addPromise]);

    expect((await store.getRecipes()).map((r) => r.id)).toEqual(["base", "added"]);
  });

  it("bulk saveRecipes performs no read of its own (pure blind overwrite)", async () => {
    installDiskModel(2);
    await store.addRecipe(recipe("pre"));
    fsMock.readFile.mockClear();

    await store.saveRecipes([recipe("only")]);

    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenLastCalledWith(
      RECIPES_FILE,
      expect.any(String),
      "utf-8"
    );
    expect((await store.getRecipes()).map((r) => r.id)).toEqual(["only"]);
  });

  it("a failed WRITE rejects its own caller but the store recovers from the last durable snapshot", async () => {
    const box = installDiskModel();
    await store.addRecipe(recipe("g1"));

    const realWrite = utilsMock.resilientAtomicWriteFile.getMockImplementation()!;
    let failNext = true;
    utilsMock.resilientAtomicWriteFile.mockImplementation(
      async (filePath: string, data: string) => {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return realWrite(filePath, data);
      }
    );
    void box;

    const failing = store.updateRecipe("g1", { name: "renamed" });
    const following = store.addRecipe(recipe("g2"));

    await expect(failing).rejects.toThrow("EACCES");
    await expect(following).resolves.toBeUndefined();

    const result = await store.getRecipes();
    expect(result.map((r) => r.id).sort()).toEqual(["g1", "g2"]);
    expect(result.find((r) => r.id === "g1")?.name).toBe("g1");
  });
});
