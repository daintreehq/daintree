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
import type { TerminalRecipe } from "../../types/index.js";

const VALID_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);
const CONFIG_DIR = path.normalize("/tmp/daintree-projects");

function recipeFilePath(projectId: string): string {
  return path.join(CONFIG_DIR, projectId, "recipes.json");
}

function recipe(id: string): TerminalRecipe {
  return { id, name: id, terminals: [], createdAt: 1000 } as TerminalRecipe;
}

/**
 * Model recipes.json on disk keyed by file path. `readFile` returns the
 * last-written envelope (ENOENT when absent); `resilientAtomicWriteFile`
 * records it. An optional per-write delay widens the read→write window so that
 * an *unserialized* implementation would lose one of two concurrent updates —
 * making these tests fail loudly if the queue is ever removed.
 */
function installDiskModel(writeDelayMs = 0): Map<string, string> {
  const disk = new Map<string, string>();
  fsMock.readFile.mockImplementation(async (filePath: string) => {
    const content = disk.get(filePath);
    if (content === undefined) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return content;
  });
  utilsMock.resilientAtomicWriteFile.mockImplementation(async (filePath: string, data: string) => {
    if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
    disk.set(filePath, data);
  });
  return disk;
}

describe("ProjectFileStore write serialization", () => {
  let store: ProjectFileStore;

  beforeEach(() => {
    vi.resetAllMocks();
    store = new ProjectFileStore(CONFIG_DIR);
    fsMock.mkdir.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockResolvedValue(undefined);
    fsSyncMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("serializes two concurrent addRecipe calls so neither update is lost", async () => {
    installDiskModel(5);

    await Promise.all([
      store.addRecipe(VALID_ID, recipe("r1")),
      store.addRecipe(VALID_ID, recipe("r2")),
    ]);

    const result = await store.getRecipes(VALID_ID);
    expect(result.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("serializes many concurrent adds — every recipe survives the chain", async () => {
    installDiskModel(2);

    const ids = Array.from({ length: 8 }, (_, i) => `r${i}`);
    await Promise.all(ids.map((id) => store.addRecipe(VALID_ID, recipe(id))));

    const result = await store.getRecipes(VALID_ID);
    expect(result.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it("a failing update rejects its own caller but does not poison later updates", async () => {
    installDiskModel(2);
    await store.addRecipe(VALID_ID, recipe("r1"));

    // updateRecipe on a missing id throws inside its queued turn; a mutation
    // enqueued right behind it must still commit.
    const failing = store.updateRecipe(VALID_ID, "missing", { name: "x" });
    const following = store.addRecipe(VALID_ID, recipe("r2"));

    await expect(failing).rejects.toThrow(/not found/);
    await expect(following).resolves.toBeUndefined();

    const result = await store.getRecipes(VALID_ID);
    expect(result.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("interleaved add / update / delete on one project apply in enqueue order", async () => {
    installDiskModel(2);

    await Promise.all([
      store.addRecipe(VALID_ID, recipe("keep")),
      store.addRecipe(VALID_ID, recipe("drop")),
      store.updateRecipe(VALID_ID, "keep", { name: "renamed" }),
      store.deleteRecipe(VALID_ID, "drop"),
    ]);

    const result = await store.getRecipes(VALID_ID);
    expect(result.map((r) => r.id)).toEqual(["keep"]);
    expect(result[0]!.name).toBe("renamed");
  });

  it("a stalled project queue does not block a different project's queue", async () => {
    const disk = installDiskModel();

    // Gate the first write for VALID_ID until we release it; OTHER_ID must be
    // free to complete meanwhile (proves per-projectId keying, not one global
    // lock).
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gatedPath = recipeFilePath(VALID_ID);
    utilsMock.resilientAtomicWriteFile.mockImplementation(
      async (filePath: string, data: string) => {
        if (filePath === gatedPath) await aGate;
        disk.set(filePath, data);
      }
    );

    const aPromise = store.addRecipe(VALID_ID, recipe("a1"));
    const bPromise = store.addRecipe(OTHER_ID, recipe("b1"));

    // B resolves while A is still gated.
    await expect(bPromise).resolves.toBeUndefined();
    expect((await store.getRecipes(OTHER_ID)).map((r) => r.id)).toEqual(["b1"]);

    releaseA();
    await aPromise;
    expect((await store.getRecipes(VALID_ID)).map((r) => r.id)).toEqual(["a1"]);
  });

  it("bulk saveRecipes is serialized in the queue — an add enqueued behind it sees its result", async () => {
    installDiskModel(3);

    // Enqueue a blind replacement, then an add. Serialized in order, the add
    // reads the just-saved list and appends to it → [base, added]. If
    // saveRecipes bypassed the queue, the two would interleave on the widened
    // write window and one would be lost (final would be [base] or [added]).
    const savePromise = store.saveRecipes(VALID_ID, [recipe("base")]);
    const addPromise = store.addRecipe(VALID_ID, recipe("added"));
    await Promise.all([savePromise, addPromise]);

    expect((await store.getRecipes(VALID_ID)).map((r) => r.id)).toEqual(["base", "added"]);
  });

  it("bulk saveRecipes performs no read of its own (pure blind overwrite)", async () => {
    installDiskModel(2);
    await store.addRecipe(VALID_ID, recipe("pre"));
    fsMock.readFile.mockClear();

    await store.saveRecipes(VALID_ID, [recipe("only")]);

    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect((await store.getRecipes(VALID_ID)).map((r) => r.id)).toEqual(["only"]);
  });

  it("a failed WRITE rejects its own caller but the store recovers from the last durable snapshot", async () => {
    const disk = installDiskModel();
    await store.addRecipe(VALID_ID, recipe("r1"));

    // Fail exactly the next write (the update); later writes go through.
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

    const failing = store.updateRecipe(VALID_ID, "r1", { name: "renamed" });
    const following = store.addRecipe(VALID_ID, recipe("r2"));

    await expect(failing).rejects.toThrow("EACCES");
    await expect(following).resolves.toBeUndefined();

    const result = await store.getRecipes(VALID_ID);
    expect(result.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    // The rejected rename never persisted; r1 kept its original name.
    expect(result.find((r) => r.id === "r1")?.name).toBe("r1");
  });

  it("cleanup uses an identity guard: a completed op keeps a newer tail, and the map empties on drain", async () => {
    const disk = installDiskModel();
    const queues = (store as unknown as { recipesWriteQueues: Map<string, Promise<unknown>> })
      .recipesWriteQueues;

    // Gate op1's write so op2 enqueues behind it — the map tail becomes op2.
    let release1: () => void = () => {};
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    let firstWrite = true;
    utilsMock.resilientAtomicWriteFile.mockImplementation(
      async (filePath: string, data: string) => {
        if (firstWrite) {
          firstWrite = false;
          await gate1;
        }
        disk.set(filePath, data);
      }
    );

    const p1 = store.addRecipe(VALID_ID, recipe("r1"));
    const p2 = store.addRecipe(VALID_ID, recipe("r2"));
    const tailAfterTwo = queues.get(VALID_ID);
    expect(tailAfterTwo).toBeDefined();

    release1();
    await p1;
    // op1's cleanup ran but the map still points at op2's tail: the
    // `map.get(key) === next` guard prevented op1 from dropping op2's entry.
    expect(queues.get(VALID_ID)).toBe(tailAfterTwo);

    await p2;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Fully drained → entry removed (no per-project map leak).
    expect(queues.has(VALID_ID)).toBe(false);
    expect((await store.getRecipes(VALID_ID)).map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });
});
