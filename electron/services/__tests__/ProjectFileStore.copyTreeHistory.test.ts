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
import { applyCopyTreeRun } from "../copyTreeHistoryLog.js";
import { encodeCopyTreeHistoryFile } from "../copyTreeHistoryCodec.js";
import { COPY_TREE_HISTORY_SCHEMA_VERSION } from "../../../shared/types/ipc/copyTreeHistory.js";
import type {
  CopyTreeHistoryAppendInput,
  CopyTreeHistoryRecord,
} from "../../../shared/types/ipc/copyTreeHistory.js";
import type { CopyTreeOptions } from "../../../shared/types/ipc/copyTree.js";

const VALID_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);
const CONFIG_DIR = path.normalize("/tmp/daintree-projects");

function historyFilePath(projectId: string): string {
  return path.join(CONFIG_DIR, projectId, "copy-tree-history.json");
}

/**
 * Model copy-tree-history.json on disk keyed by file path, with a per-write
 * delay that widens the read→write window. An implementation without the
 * per-project queue loses one of two concurrent appends here, so these tests
 * fail loudly if the queue is ever removed.
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

/** Mirrors ProjectStore.appendCopyTreeRun: read, fold and write in one turn. */
function append(
  store: ProjectFileStore,
  projectId: string,
  id: string,
  now: number,
  overrides: Partial<CopyTreeHistoryAppendInput> = {}
): Promise<void> {
  return store.enqueueCopyTreeHistoryUpdate(projectId, async () => {
    const current = await store.getCopyTreeHistory(projectId);
    return applyCopyTreeRun(
      current,
      {
        options: {},
        source: "toolbar",
        worktreeId: "wt-1",
        stats: { fileCount: 1 },
        ...overrides,
      },
      { id, now }
    );
  });
}

function readDisk(disk: Map<string, string>, projectId: string): CopyTreeHistoryRecord[] {
  const raw = disk.get(historyFilePath(projectId));
  expect(raw).toBeDefined();
  return (JSON.parse(raw as string) as { records: CopyTreeHistoryRecord[] }).records;
}

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
      append(store, VALID_ID, "id-1", 1_000, { options: { modified: true } }),
      append(store, VALID_ID, "id-2", 2_000, { options: { changed: "develop" } }),
    ]);

    const records = readDisk(disk, VALID_ID);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.id).sort()).toEqual(["id-1", "id-2"]);
  });

  it("collapses two concurrent appends of identical options into one bumped entry", async () => {
    const disk = installDiskModel(5);

    await Promise.all([
      append(store, VALID_ID, "id-1", 1_000),
      append(store, VALID_ID, "id-2", 2_000),
    ]);

    const records = readDisk(disk, VALID_ID);
    expect(records).toHaveLength(1);
    // Without serialization the second write would overwrite a snapshot read
    // before the first landed, leaving runCount at 1.
    expect(records[0].runCount).toBe(2);
  });

  it("keeps different projects independent", async () => {
    const disk = installDiskModel(5);

    await Promise.all([
      append(store, VALID_ID, "id-1", 1_000),
      append(store, OTHER_ID, "id-2", 1_000),
    ]);

    expect(readDisk(disk, VALID_ID).map((r) => r.id)).toEqual(["id-1"]);
    expect(readDisk(disk, OTHER_ID).map((r) => r.id)).toEqual(["id-2"]);
  });

  it("does not let a failed update poison the next one in the chain", async () => {
    const disk = installDiskModel(5);

    const failing = store.enqueueCopyTreeHistoryUpdate(VALID_ID, () => {
      throw new Error("updater blew up");
    });
    const following = append(store, VALID_ID, "id-2", 2_000);

    await expect(failing).rejects.toThrow("updater blew up");
    await expect(following).resolves.toBeUndefined();
    expect(readDisk(disk, VALID_ID).map((r) => r.id)).toEqual(["id-2"]);
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

    await append(store, VALID_ID, "id-1", 1_000);

    expect(fsMock.mkdir).toHaveBeenCalledWith(path.join(CONFIG_DIR, VALID_ID), { recursive: true });
    expect(readDisk(disk, VALID_ID).map((r) => r.id)).toEqual(["id-1"]);
  });

  it("quarantines a damaged file by renaming it, never by deleting it", async () => {
    installDiskModel();
    fsMock.readFile.mockResolvedValue("{ not json");

    await expect(store.getCopyTreeHistory(VALID_ID)).resolves.toEqual([]);

    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
    const [from, to] = utilsMock.resilientRename.mock.calls[0] as [string, string];
    expect(from).toBe(historyFilePath(VALID_ID));
    expect(to.startsWith(`${historyFilePath(VALID_ID)}.corrupted.`)).toBe(true);
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

    await expect(append(store, VALID_ID, "id-1", 1_000)).rejects.toThrow("EPERM");
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("reads back what a previous append wrote", async () => {
    installDiskModel();

    await append(store, VALID_ID, "id-1", 1_000, { options: { modified: true } });
    const records = await store.getCopyTreeHistory(VALID_ID);

    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("Modified files");
    expect((records[0].options as CopyTreeOptions).modified).toBe(true);
  });

  it("starts fresh after a damaged file is quarantined", async () => {
    const disk = installDiskModel();
    disk.set(historyFilePath(VALID_ID), "{ not json");

    await append(store, VALID_ID, "id-1", 1_000);

    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
    expect(readDisk(disk, VALID_ID).map((r) => r.id)).toEqual(["id-1"]);
  });

  it("writes the versioned envelope, not a bare array", async () => {
    const disk = installDiskModel();
    await append(store, VALID_ID, "id-1", 1_000);

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
