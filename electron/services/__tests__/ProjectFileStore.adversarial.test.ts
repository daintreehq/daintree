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

import { ProjectFileStore, RECIPES_SCHEMA_VERSION } from "../ProjectFileStore.js";
import { applyCopyTreeRun } from "../copyTreeHistoryLog.js";
import { encodeCopyTreeHistoryFile } from "../copyTreeHistoryCodec.js";
import { COPY_TREE_HISTORY_SCHEMA_VERSION } from "../../../shared/types/ipc/copyTreeHistory.js";
import type {
  CopyTreeHistoryAppendInput,
  CopyTreeHistoryRecord,
} from "../../../shared/types/ipc/copyTreeHistory.js";
import type { TerminalRecipe } from "../../types/index.js";

const VALID_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);
const INVALID_ID_TRAVERSAL = "../../../etc/passwd";
const CONFIG_DIR = path.normalize("/tmp/daintree-projects");
const EXPECTED_STATE_DIR = path.join(CONFIG_DIR, VALID_ID);
const EXPECTED_RECIPES_FILE = path.join(EXPECTED_STATE_DIR, "recipes.json");

function quarantineRegex(basePath: string, suffix: string): RegExp {
  const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}${suffix}$`);
}

function quarantineSuffixRegex(basePath: string, suffix: string): RegExp {
  const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}${suffix}\\d+$`);
}

function recipeFilePath(projectId: string): string {
  return path.join(CONFIG_DIR, projectId, "recipes.json");
}

function recipe(id: string): TerminalRecipe {
  return { id, name: id, terminals: [], createdAt: 1000 } as TerminalRecipe;
}

function historyFilePath(projectId: string): string {
  return path.join(CONFIG_DIR, projectId, "copy-tree-history.json");
}

/**
 * Model recipes.json / copy-tree-history.json on disk keyed by file path.
 * `readFile` returns the last-written envelope (ENOENT when absent);
 * `resilientAtomicWriteFile` records it. An optional per-write delay widens the
 * read→write window so that an *unserialized* implementation would lose one of
 * two concurrent updates — making these tests fail loudly if a per-project
 * queue is ever removed.
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

/**
 * Drive the REAL production coordinator. Ids and timestamps are minted inside
 * it, so the assertions below key off content rather than a supplied id — a
 * test-owned reimplementation of the fold would stay green if the production
 * one stopped queueing its read.
 */
function append(
  store: ProjectFileStore,
  projectId: string,
  overrides: Partial<CopyTreeHistoryAppendInput> = {}
): Promise<CopyTreeHistoryRecord[]> {
  return store.appendCopyTreeRun(projectId, {
    options: {},
    source: "toolbar",
    worktreeId: "wt-1",
    stats: { fileCount: 1 },
    ...overrides,
  });
}

function readDisk(disk: Map<string, string>, projectId: string): CopyTreeHistoryRecord[] {
  const raw = disk.get(historyFilePath(projectId));
  expect(raw).toBeDefined();
  return (JSON.parse(raw as string) as { records: CopyTreeHistoryRecord[] }).records;
}

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
    fsMock.readFile.mockResolvedValue("{ not valid json");

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      EXPECTED_RECIPES_FILE,
      expect.stringMatching(quarantineSuffixRegex(EXPECTED_RECIPES_FILE, "\\.corrupted\\."))
    );
  });

  it("non-array, non-envelope JSON is quarantined and returns []", async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({ notAnArray: true }));

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      EXPECTED_RECIPES_FILE,
      expect.stringMatching(quarantineSuffixRegex(EXPECTED_RECIPES_FILE, "\\.corrupted\\."))
    );
  });

  it("malformed recipe entries are filtered out — only structurally valid entries survive", async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "r1", name: "valid", terminals: [], createdAt: 1000 },
        null,
        "string",
        { id: "r2" }, // missing name/terminals/createdAt
        { id: "r3", name: "no terminals array" },
        { id: "r4", name: "valid again", terminals: [{ type: "terminal" }], createdAt: 1000 },
      ])
    );

    const result = await store.getRecipes(VALID_ID);

    expect(result.map((r) => r.id)).toEqual(["r1", "r4"]);
  });

  it("filters out recipes with deeply malformed terminal entries", async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "r1", name: "valid", terminals: [{ type: "terminal" }], createdAt: 1 },
        {
          id: "r2",
          name: "command is number",
          terminals: [{ type: "terminal", command: 123 }],
          createdAt: 2,
        },
        {
          id: "r3",
          name: "env is not a record",
          terminals: [{ type: "terminal", env: ["array", "not", "record"] }],
          createdAt: 3,
        },
        {
          id: "r4",
          name: "invalid exitBehavior",
          terminals: [{ type: "terminal", exitBehavior: "destroy" }],
          createdAt: 4,
        },
        { id: "r5", name: "also valid", terminals: [], createdAt: 5 },
      ])
    );

    const result = await store.getRecipes(VALID_ID);

    expect(result.map((r) => r.id)).toEqual(["r1", "r5"]);
  });

  it("filters out recipes with missing terminal type", async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "r1", name: "valid", terminals: [{ type: "terminal" }], createdAt: 1 },
        { id: "r2", name: "no terminal type", terminals: [{ title: "T" }], createdAt: 2 },
      ])
    );

    const result = await store.getRecipes(VALID_ID);

    expect(result.map((r) => r.id)).toEqual(["r1"]);
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
    fsMock.readFile.mockResolvedValue(JSON.stringify([]));

    await expect(store.updateRecipe(VALID_ID, "missing", { name: "x" })).rejects.toThrow(
      /not found/
    );
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  describe.each([
    ["malformed JSON", "{ not valid json"],
    ["future-version envelope", JSON.stringify({ _schemaVersion: 999, recipes: [] })],
    ["envelope without a recipes array", JSON.stringify({ _schemaVersion: 1, recipes: "nope" })],
    ["non-array, non-envelope root", JSON.stringify({ notAnArray: true })],
  ])("quarantine rename failure on %s", (_label, payload) => {
    beforeEach(() => {
      fsMock.readFile.mockResolvedValue(payload);
      utilsMock.resilientRename.mockRejectedValue(
        Object.assign(new Error("EBUSY"), { code: "EBUSY" })
      );
    });

    it("getRecipes throws instead of reporting an empty list", async () => {
      await expect(store.getRecipes(VALID_ID)).rejects.toThrow(/could not be moved aside/);
    });

    it("addRecipe aborts without overwriting the unpreserved file", async () => {
      await expect(
        store.addRecipe(VALID_ID, {
          id: "r1",
          name: "new",
          terminals: [],
          createdAt: 1000,
        } as TerminalRecipe)
      ).rejects.toThrow(/could not be moved aside/);
      expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
    });

    it("updateRecipe and deleteRecipe abort without writing", async () => {
      await expect(store.updateRecipe(VALID_ID, "r1", { name: "x" })).rejects.toThrow(
        /could not be moved aside/
      );
      await expect(store.deleteRecipe(VALID_ID, "r1")).rejects.toThrow(/could not be moved aside/);
      expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
    });
  });

  it("a mutation rejected by a failed quarantine does not block a later retry", async () => {
    fsMock.readFile.mockResolvedValue("{ not valid json");
    utilsMock.resilientRename.mockRejectedValueOnce(
      Object.assign(new Error("EBUSY"), { code: "EBUSY" })
    );
    const recipe = { id: "r1", name: "new", terminals: [], createdAt: 1000 } as TerminalRecipe;

    await expect(store.addRecipe(VALID_ID, recipe)).rejects.toThrow(/could not be moved aside/);
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();

    await store.addRecipe(VALID_ID, recipe);

    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(2);
    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(1);
  });

  it("a successful quarantine still yields [] and lets the next mutation write", async () => {
    fsMock.readFile
      .mockResolvedValueOnce("{ not valid json")
      .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await store.addRecipe(VALID_ID, {
      id: "r1",
      name: "new",
      terminals: [],
      createdAt: 1000,
    } as TerminalRecipe);

    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
    const write = utilsMock.resilientAtomicWriteFile.mock.calls[0];
    expect(JSON.parse(write[1] as string).recipes.map((r: { id: string }) => r.id)).toEqual(["r1"]);
  });

  it("deleteRecipe filters the target out and writes the remaining recipes in envelope format", async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "keep", name: "k", terminals: [], createdAt: 1000 },
        { id: "drop", name: "d", terminals: [], createdAt: 1000 },
      ])
    );

    await store.deleteRecipe(VALID_ID, "drop");

    const write = utilsMock.resilientAtomicWriteFile.mock.calls[0];
    expect(write[0]).toBe(EXPECTED_RECIPES_FILE);
    const payload = JSON.parse(write[1] as string);
    expect(payload._schemaVersion).toBe(RECIPES_SCHEMA_VERSION);
    expect(payload.recipes.map((r: { id: string }) => r.id)).toEqual(["keep"]);
  });

  it("malformed envelope (recipes is not an array) is quarantined", async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({ _schemaVersion: 1, recipes: "not-an-array" })
    );

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      EXPECTED_RECIPES_FILE,
      expect.stringMatching(quarantineSuffixRegex(EXPECTED_RECIPES_FILE, "\\.corrupted\\."))
    );
  });

  it("future-version envelope is quarantined to .future-v{N}", async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({ _schemaVersion: 999, recipes: [] }));

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      EXPECTED_RECIPES_FILE,
      expect.stringMatching(quarantineRegex(EXPECTED_RECIPES_FILE, "\\.future-v999"))
    );
  });

  it("future-version quarantine uses timestamp suffix when destination exists", async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({ _schemaVersion: 999, recipes: [] }));
    fsSyncMock.existsSync.mockImplementation((p: string) => (p as string).endsWith(".future-v999"));

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).toHaveBeenCalledWith(
      EXPECTED_RECIPES_FILE,
      expect.stringMatching(quarantineSuffixRegex(EXPECTED_RECIPES_FILE, "\\.future-v999\\."))
    );
  });

  it("envelope with non-integer _schemaVersion is coerced to 0 and read normally", async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({
        _schemaVersion: "not-a-number",
        recipes: [{ id: "r1", name: "still valid", terminals: [], createdAt: 1000 }],
      })
    );

    const result = await store.getRecipes(VALID_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("r1");
  });

  it("round-trip: legacy bare array → read → save → read envelope", async () => {
    // First read: legacy bare array
    fsMock.readFile.mockResolvedValueOnce(
      JSON.stringify([{ id: "r1", name: "legacy", terminals: [], createdAt: 1000 }])
    );
    const recipes = await store.getRecipes(VALID_ID);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.id).toBe("r1");

    // Save: should write envelope
    await store.saveRecipes(VALID_ID, recipes);
    const write = utilsMock.resilientAtomicWriteFile.mock.calls[0];
    const writtenPayload = JSON.parse(write[1] as string);
    expect(writtenPayload._schemaVersion).toBe(RECIPES_SCHEMA_VERSION);
    expect(writtenPayload.recipes).toHaveLength(1);

    // Second read: envelope comes back for the read
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify(writtenPayload));
    const recipes2 = await store.getRecipes(VALID_ID);
    expect(recipes2).toHaveLength(1);
    expect(recipes2[0]!.id).toBe("r1");
  });

  it("ENOENT on readFile does not quarantine (file genuinely absent)", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    fsMock.readFile.mockRejectedValue(enoent);
    fsSyncMock.existsSync.mockReturnValue(false);

    const result = await store.getRecipes(VALID_ID);

    expect(result).toEqual([]);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it("non-ENOENT read errors throw (so mutators don't destroy data)", async () => {
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    fsMock.readFile.mockRejectedValue(eacces);

    await expect(store.getRecipes(VALID_ID)).rejects.toThrow("EACCES");
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it("deleteRecipe does not write when getRecipes fails with non-ENOENT", async () => {
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    fsMock.readFile.mockRejectedValue(eacces);

    await expect(store.deleteRecipe(VALID_ID, "any")).rejects.toThrow("EACCES");
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });
});

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
    installDiskModel();
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

describe("ProjectFileStore copy-tree history", () => {
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

  it("treats a project with no history file as an empty history", async () => {
    installDiskModel();
    await expect(store.getCopyTreeHistory(VALID_ID)).resolves.toEqual([]);
  });

  it("returns an empty history for an id that cannot own a state directory", async () => {
    installDiskModel();
    await expect(store.getCopyTreeHistory("../../../etc/passwd")).resolves.toEqual([]);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("propagates a read failure that is not a missing file", async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await expect(store.getCopyTreeHistory(VALID_ID)).rejects.toThrow("EACCES");
  });

  it("serializes two concurrent appends of different options so neither is lost", async () => {
    const disk = installDiskModel(5);

    await Promise.all([
      append(store, VALID_ID, { options: { modified: true } }),
      append(store, VALID_ID, { options: { changed: "develop" } }),
    ]);

    const records = readDisk(disk, VALID_ID);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.name).sort()).toEqual(["Changed since develop", "Modified files"]);
  });

  it("collapses two concurrent appends of identical options into one bumped entry", async () => {
    const disk = installDiskModel(5);

    await Promise.all([append(store, VALID_ID), append(store, VALID_ID)]);

    const records = readDisk(disk, VALID_ID);
    expect(records).toHaveLength(1);
    // Without serialization the second write would overwrite a snapshot read
    // before the first landed, leaving runCount at 1.
    expect(records[0].runCount).toBe(2);
  });

  it("keeps different projects independent", async () => {
    const disk = installDiskModel(5);

    await Promise.all([
      append(store, VALID_ID, { worktreeId: "wt-a" }),
      append(store, OTHER_ID, { worktreeId: "wt-b" }),
    ]);

    expect(readDisk(disk, VALID_ID).map((r) => r.worktreeId)).toEqual(["wt-a"]);
    expect(readDisk(disk, OTHER_ID).map((r) => r.worktreeId)).toEqual(["wt-b"]);
  });

  it("does not make one project wait behind another project's in-flight write", async () => {
    // A single global queue would satisfy the isolation test above. This one
    // fails unless the queues are genuinely keyed per project.
    installDiskModel();
    let releaseA: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    utilsMock.resilientAtomicWriteFile.mockImplementation(async (filePath: string) => {
      if (filePath === historyFilePath(VALID_ID)) await blocked;
    });

    const slow = append(store, VALID_ID);
    await expect(append(store, OTHER_ID)).resolves.toHaveLength(1);

    releaseA();
    await slow;
  });

  it("does not let a failed update poison the next one in the chain", async () => {
    const disk = installDiskModel(5);

    const failing = store.enqueueCopyTreeHistoryUpdate(VALID_ID, () => {
      throw new Error("updater blew up");
    });
    const following = append(store, VALID_ID, { worktreeId: "wt-after" });

    await expect(failing).rejects.toThrow("updater blew up");
    await expect(following).resolves.toHaveLength(1);
    expect(readDisk(disk, VALID_ID).map((r) => r.worktreeId)).toEqual(["wt-after"]);
  });

  it("skips the write when the updater returns null", async () => {
    installDiskModel();
    await store.enqueueCopyTreeHistoryUpdate(VALID_ID, () => null);
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("creates the state directory when the first write finds it missing", async () => {
    const disk = new Map<string, string>();
    fsMock.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    let firstAttempt = true;
    utilsMock.resilientAtomicWriteFile.mockImplementation(
      async (filePath: string, data: string) => {
        if (firstAttempt) {
          firstAttempt = false;
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        disk.set(filePath, data);
      }
    );

    await append(store, VALID_ID);

    expect(fsMock.mkdir).toHaveBeenCalledWith(path.join(CONFIG_DIR, VALID_ID), { recursive: true });
    expect(readDisk(disk, VALID_ID)).toHaveLength(1);
  });

  it("quarantines a damaged file by renaming it, never by deleting it", async () => {
    const disk = installDiskModel();
    const damaged = "{ not json";
    disk.set(historyFilePath(VALID_ID), damaged);
    // Model the rename so the assertion is about where the BYTES ended up, not
    // merely that a rename was requested.
    utilsMock.resilientRename.mockImplementation(async (from: string, to: string) => {
      const content = disk.get(from);
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      disk.delete(from);
      disk.set(to, content);
    });

    await expect(store.getCopyTreeHistory(VALID_ID)).resolves.toEqual([]);

    const [from, to] = utilsMock.resilientRename.mock.calls[0] as [string, string];
    expect(from).toBe(historyFilePath(VALID_ID));
    expect(to.startsWith(`${historyFilePath(VALID_ID)}.corrupted.`)).toBe(true);
    expect(disk.get(to)).toBe(damaged);
    expect(disk.has(historyFilePath(VALID_ID))).toBe(false);
  });

  it("quarantines an unreadable file exactly once when a read and an append race it", async () => {
    // Both see the damage; whichever renames second would hit ENOENT and fail,
    // losing a completed run. Serializing the quarantine-capable read is what
    // makes only one of them attempt it.
    const disk = installDiskModel();
    disk.set(historyFilePath(VALID_ID), "{ not json");
    utilsMock.resilientRename.mockImplementation(async (from: string, to: string) => {
      const content = disk.get(from);
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      disk.delete(from);
      disk.set(to, content);
    });

    const [, appended] = await Promise.all([
      store.getCopyTreeHistory(VALID_ID),
      append(store, VALID_ID, { worktreeId: "wt-raced" }),
    ]);

    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
    expect(readDisk(disk, VALID_ID).map((r) => r.worktreeId)).toEqual(["wt-raced"]);
  });

  it("quarantines a newer app's file under a name that records its version", async () => {
    installDiskModel();
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({ _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION + 5, records: [] })
    );

    await expect(store.getCopyTreeHistory(VALID_ID)).resolves.toEqual([]);

    const [, to] = utilsMock.resilientRename.mock.calls[0] as [string, string];
    expect(to).toBe(`${historyFilePath(VALID_ID)}.future-v${COPY_TREE_HISTORY_SCHEMA_VERSION + 5}`);
  });

  it("does not clobber an existing quarantine file of the same name", async () => {
    installDiskModel();
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({ _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION + 1, records: [] })
    );
    fsSyncMock.existsSync.mockReturnValue(true);

    await store.getCopyTreeHistory(VALID_ID);

    const [, to] = utilsMock.resilientRename.mock.calls[0] as [string, string];
    expect(to).toMatch(new RegExp(`\\.future-v${COPY_TREE_HISTORY_SCHEMA_VERSION + 1}\\.\\d+$`));
  });

  it("refuses to write over a damaged file whose quarantine failed", async () => {
    // The dangerous case: if the rename fails and the read still reports an
    // empty history, the next append writes a fresh file straight over data
    // that was never preserved.
    installDiskModel();
    fsMock.readFile.mockResolvedValue("{ not json");
    utilsMock.resilientRename.mockRejectedValue(new Error("EPERM"));

    await expect(append(store, VALID_ID)).rejects.toThrow("EPERM");
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("writes the versioned envelope, not a bare array", async () => {
    const disk = installDiskModel();
    await append(store, VALID_ID);

    const parsed = JSON.parse(disk.get(historyFilePath(VALID_ID)) as string) as {
      _schemaVersion: number;
      records: unknown[];
    };
    expect(parsed._schemaVersion).toBe(COPY_TREE_HISTORY_SCHEMA_VERSION);
    expect(Array.isArray(parsed.records)).toBe(true);
  });

  it("round-trips a history written by the encoder", async () => {
    const disk = installDiskModel();
    const records = applyCopyTreeRun(
      [],
      { options: { filter: "src/**" }, source: "mcp", worktreeId: "wt-9", stats: { fileCount: 2 } },
      { id: "seeded", now: 5_000 }
    );
    disk.set(historyFilePath(VALID_ID), encodeCopyTreeHistoryFile(records));

    await expect(store.getCopyTreeHistory(VALID_ID)).resolves.toEqual(records);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });
});

describe("ProjectFileStore recipe reads that quarantine (#13553)", () => {
  let store: ProjectFileStore;

  beforeEach(() => {
    vi.resetAllMocks();
    store = new ProjectFileStore(CONFIG_DIR);
    fsMock.mkdir.mockResolvedValue(undefined);
    fsSyncMock.existsSync.mockReturnValue(false);
  });

  /**
   * Each rename waits on its own gate and then moves whatever currently sits
   * at the source path, so a reader released late renames the live file.
   */
  function gateRenames(disk: Map<string, string>) {
    const releases: Array<() => void> = [];
    utilsMock.resilientRename.mockImplementation(async (from: string, to: string) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      const content = disk.get(from);
      if (content === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      disk.delete(from);
      disk.set(to, content);
    });
    return releases;
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a paused quarantining read cannot move aside a recipe saved behind it", async () => {
    const disk = installDiskModel();
    const filePath = recipeFilePath(VALID_ID);
    disk.set(filePath, "{ not json");
    const releases = gateRenames(disk);

    const first = store.getRecipes(VALID_ID);
    await flush();
    expect(releases).toHaveLength(1);

    const add = store.addRecipe(VALID_ID, recipe("kept"));
    const second = store.getRecipes(VALID_ID);
    await flush();
    // The add and the second read wait for the first read's turn instead of
    // reading the damaged file and starting a quarantine of their own.
    expect(releases).toHaveLength(1);

    releases[0]();
    await expect(first).resolves.toEqual([]);
    await add;
    expect((await second).map((r) => r.id)).toEqual(["kept"]);

    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(disk.get(filePath) as string) as { recipes: TerminalRecipe[] };
    expect(saved.recipes.map((r) => r.id)).toEqual(["kept"]);
  });

  it("a paused quarantining read cannot move aside a blind save queued behind it", async () => {
    const disk = installDiskModel();
    const filePath = recipeFilePath(VALID_ID);
    disk.set(filePath, "{ not json");
    const releases = gateRenames(disk);

    const first = store.getRecipes(VALID_ID);
    await flush();
    const save = store.saveRecipes(VALID_ID, [recipe("saved")]);
    await flush();
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();

    releases[0]();
    await first;
    await save;

    const quarantined = [...disk.entries()].filter(([p]) => p.startsWith(`${filePath}.corrupted.`));
    expect(quarantined.map(([, content]) => content)).toEqual(["{ not json"]);
    expect((await store.getRecipes(VALID_ID)).map((r) => r.id)).toEqual(["saved"]);
  });

  it("a paused read for one project does not hold up another project's read", async () => {
    const disk = installDiskModel();
    disk.set(recipeFilePath(VALID_ID), "{ not json");
    disk.set(
      recipeFilePath(OTHER_ID),
      JSON.stringify({ _schemaVersion: RECIPES_SCHEMA_VERSION, recipes: [recipe("other")] })
    );
    const releases = gateRenames(disk);

    const blocked = store.getRecipes(VALID_ID);
    await flush();

    expect((await store.getRecipes(OTHER_ID)).map((r) => r.id)).toEqual(["other"]);

    releases[0]();
    await expect(blocked).resolves.toEqual([]);
  });

  it("mutators over a damaged file quarantine it without waiting on themselves", async () => {
    const disk = installDiskModel();
    disk.set(recipeFilePath(VALID_ID), "{ not json");
    utilsMock.resilientRename.mockImplementation(async (from: string, to: string) => {
      disk.set(to, disk.get(from) as string);
      disk.delete(from);
    });

    await store.addRecipe(VALID_ID, recipe("a"));
    await store.updateRecipe(VALID_ID, "a", { name: "renamed" });
    await store.addRecipe(VALID_ID, recipe("b"));
    await store.deleteRecipe(VALID_ID, "b");

    expect(await store.getRecipes(VALID_ID)).toEqual([{ ...recipe("a"), name: "renamed" }]);
  });
});
