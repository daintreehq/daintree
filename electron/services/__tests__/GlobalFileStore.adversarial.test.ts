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
    fsMock.readFile.mockResolvedValue("{ not json");

    const result = await store.getRecipes();

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      RECIPES_FILE,
      expect.stringMatching(
        new RegExp(
          `^${RECIPES_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.corrupted\\.\\d+-[a-z0-9]{6}$`
        )
      )
    );
  });

  it("non-array JSON returns [] and quarantines the file", async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({ wrong: "shape" }));

    const result = await store.getRecipes();

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      RECIPES_FILE,
      expect.stringMatching(
        new RegExp(
          `^${RECIPES_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.corrupted\\.\\d+-[a-z0-9]{6}$`
        )
      )
    );
  });

  it("filters invalid entries but keeps valid ones", async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "r1", name: "valid", terminals: [], createdAt: 1000 },
        null,
        "string",
        { id: "r2", name: "no terminals" },
        { id: 42, name: "wrong id type", terminals: [], createdAt: 1000 },
        { id: "r3", name: "also valid", terminals: [{ type: "terminal" }], createdAt: 2000 },
      ])
    );

    const result = await store.getRecipes();
    expect(result.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
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
    fsMock.readFile.mockResolvedValue("[]");

    await expect(store.updateRecipe("missing", { name: "x" })).rejects.toThrow(/not found/);
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("updateRecipe does not let the patch overwrite id/projectId/createdAt", async () => {
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

  it("getRecipes returns [] when file doesn't exist", async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await store.getRecipes();
    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "bad json"],
    ["non-array JSON", JSON.stringify({ notAnArray: true })],
  ])("quarantine rename failure on %s throws instead of returning []", async (_label, payload) => {
    fsMock.readFile.mockResolvedValue(payload);
    utilsMock.resilientRename.mockRejectedValueOnce(
      Object.assign(new Error("EBUSY"), { code: "EBUSY" })
    );

    await expect(store.getRecipes()).rejects.toThrow(/could not be moved aside/);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(RECIPES_FILE, expect.any(String));
  });

  it("mutators abort without overwriting a file that could not be quarantined", async () => {
    fsMock.readFile.mockResolvedValue("bad json");
    utilsMock.resilientRename.mockRejectedValue(
      Object.assign(new Error("EBUSY"), { code: "EBUSY" })
    );

    await expect(
      store.addRecipe({ id: "r1", name: "test", terminals: [], createdAt: 1000 } as never)
    ).rejects.toThrow(/could not be moved aside/);
    await expect(store.updateRecipe("r1", { name: "x" })).rejects.toThrow(
      /could not be moved aside/
    );
    await expect(store.deleteRecipe("r1")).rejects.toThrow(/could not be moved aside/);
    await expect(store.transformRecipes((recipes) => recipes)).rejects.toThrow(
      /could not be moved aside/
    );
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("a successful quarantine still yields [] and lets the next mutation write", async () => {
    fsMock.readFile
      .mockResolvedValueOnce("bad json")
      .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await store.addRecipe({ id: "r1", name: "test", terminals: [], createdAt: 1000 } as never);

    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
    const write = utilsMock.resilientAtomicWriteFile.mock.calls[0];
    expect(JSON.parse(write[1] as string).map((r: { id: string }) => r.id)).toEqual(["r1"]);
  });

  it("non-ENOENT read errors throw and are NOT quarantined (transient failure != corruption)", async () => {
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    fsMock.readFile.mockRejectedValue(eacces);

    await expect(store.getRecipes()).rejects.toThrow("EACCES");
    // A read I/O error must not move the file aside — the data is still there.
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it("addRecipe does not overwrite the store when the read fails with a transient error", async () => {
    const eio = Object.assign(new Error("EIO"), { code: "EIO" });
    fsMock.readFile.mockRejectedValue(eio);

    await expect(
      store.addRecipe({ id: "r1", name: "test", terminals: [], createdAt: 1000 } as never)
    ).rejects.toThrow("EIO");
    // The mutator aborts rather than saving [justTheNewRecipe] over the store.
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });
});

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

describe("GlobalFileStore recipe reads that quarantine (#13553)", () => {
  let store: GlobalFileStore;

  beforeEach(() => {
    vi.resetAllMocks();
    store = new GlobalFileStore(CONFIG_DIR);
    fsMock.mkdir.mockResolvedValue(undefined);
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a paused quarantining read cannot move aside a recipe saved behind it", async () => {
    const box = installDiskModel();
    box.content = "{ not json";
    const quarantined: string[] = [];
    const releases: Array<() => void> = [];
    // Each rename waits on its own gate, then moves whatever is live at the path.
    utilsMock.resilientRename.mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      if (box.content === null) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      quarantined.push(box.content);
      box.content = null;
    });

    const first = store.getRecipes();
    await flush();
    expect(releases).toHaveLength(1);

    const add = store.addRecipe(recipe("kept"));
    const second = store.getRecipes();
    await flush();
    expect(releases).toHaveLength(1);

    releases[0]();
    await expect(first).resolves.toEqual([]);
    await add;
    expect((await second).map((r) => r.id)).toEqual(["kept"]);

    expect(quarantined).toEqual(["{ not json"]);
    expect((JSON.parse(box.content as string) as TerminalRecipe[]).map((r) => r.id)).toEqual([
      "kept",
    ]);
  });

  it("every mutator over a damaged file completes instead of waiting on itself", async () => {
    const box = installDiskModel();
    box.content = "{ not json";
    utilsMock.resilientRename.mockImplementation(async () => {
      box.content = null;
    });

    await store.addRecipe(recipe("a"));
    await store.updateRecipe("a", { name: "renamed" });
    await store.transformRecipes((recipes) => [...recipes, recipe("b")]);
    await store.deleteRecipe("b");

    expect(await store.getRecipes()).toEqual([{ ...recipe("a"), name: "renamed" }]);
  });
});
