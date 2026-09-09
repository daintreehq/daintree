import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DraftStore } from "../drafts";
import { __resetKeyedMutexForTests } from "../../../../../electron/utils/keyedMutex";
import type { DocumentIdentity, DraftRecord } from "../../shared/protocol";
import type { PluginFsApi } from "../../../../../shared/types/plugin";

/**
 * A host.fs stand-in over a real temp directory: the store only needs the
 * three calls the host offers a data-dir write, and the atomic checked write
 * is modelled by a plain write here — the host's own tests own that contract.
 */
function fakeFs(): Pick<PluginFsApi, "readFile" | "writeFile" | "readdir" | "stat"> {
  return {
    readFile: (filePath) => fs.readFile(filePath, "utf-8"),
    writeFile: async (filePath, contents) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf-8");
      return { revision: "n/a" };
    },
    readdir: async (dirPath) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry) => {
          const stat = await fs.stat(path.join(dirPath, entry.name));
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            isSymbolicLink: entry.isSymbolicLink(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        })
      );
    },
    stat: async (target) => {
      const stat = await fs.stat(target);
      return {
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    },
  };
}

const identity: DocumentIdentity = {
  projectId: "p1",
  worktreePath: "/repo",
  filePath: "/repo/docs/plan.md",
};

function record(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    stateVersion: 1,
    identity,
    baseRevision: "a".repeat(64),
    baseText: "# Plan\n",
    draftText: "# Plan\n\nMore\n",
    hasBom: false,
    eol: "\n",
    updatedAt: 1_000,
    ...overrides,
  };
}

let dir: string;
let store: DraftStore;

beforeEach(async () => {
  __resetKeyedMutexForTests();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "md-drafts-"));
  store = new DraftStore({ fs: fakeFs(), draftsDir: path.join(dir, "drafts") });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("DraftStore (#12323)", () => {
  it("stores, reads back and lists a record under a hashed file name", async () => {
    await expect(store.put(record(), 1)).resolves.toEqual({ status: "stored" });
    const files = await fs.readdir(store.directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(files[0]).not.toContain("plan");
    await expect(store.get(identity)).resolves.toEqual(record());
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.identity).toEqual(identity);
  });

  it("returns null for a missing or corrupt record", async () => {
    await expect(store.get(identity)).resolves.toBeNull();
    await store.put(record(), 1);
    const [file] = await fs.readdir(store.directory);
    await fs.writeFile(path.join(store.directory, file!), "{not json");
    await expect(store.get(identity)).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("deletes a record and reports whether one existed", async () => {
    await store.put(record(), 1);
    await expect(store.delete(identity, 2)).resolves.toBe(true);
    await expect(store.delete(identity, 3)).resolves.toBe(false);
    await expect(store.get(identity)).resolves.toBeNull();
  });

  it("ignores a put that arrives after a delete with a later generation", async () => {
    await store.put(record(), 1);
    await store.delete(identity, 3);
    // The debounced write from before the discard lands late.
    await expect(store.put(record({ draftText: "stale" }), 2)).resolves.toEqual({
      status: "ignored",
    });
    await expect(store.get(identity)).resolves.toBeNull();
    // A genuinely newer draft is stored again.
    await expect(store.put(record({ draftText: "fresh" }), 4)).resolves.toEqual({
      status: "stored",
    });
    expect((await store.get(identity))?.draftText).toBe("fresh");
  });

  it("serialises a put and a delete on the same identity in call order", async () => {
    const put = store.put(record(), 1);
    const del = store.delete(identity, 2);
    await Promise.all([put, del]);
    await expect(store.get(identity)).resolves.toBeNull();
  });

  it("keeps identities apart, worktree included", async () => {
    const other: DocumentIdentity = { ...identity, worktreePath: "/repo-wt2" };
    await store.put(record(), 1);
    await store.put(record({ identity: other, draftText: "other" }), 1);
    expect((await store.get(identity))?.draftText).toBe("# Plan\n\nMore\n");
    expect((await store.get(other))?.draftText).toBe("other");
    expect(await store.list()).toHaveLength(2);
  });

  it("refuses a new record past the record cap without evicting anything", async () => {
    for (let i = 0; i < 50; i++) {
      const result = await store.put(
        record({ identity: { ...identity, filePath: `/repo/${i}.md` } }),
        1
      );
      expect(result).toEqual({ status: "stored" });
    }
    const overflow = await store.put(
      record({ identity: { ...identity, filePath: "/repo/x.md" } }),
      1
    );
    expect(overflow).toMatchObject({ status: "full", records: 50 });
    expect(await store.list()).toHaveLength(50);
    // Replacing an existing record is still allowed at the cap.
    await expect(
      store.put(record({ identity: { ...identity, filePath: "/repo/0.md" }, draftText: "v2" }), 2)
    ).resolves.toEqual({ status: "stored" });
  });

  it("refuses a record that would push storage past the byte cap", async () => {
    const big = record({ draftText: "x".repeat(9 * 1024 * 1024) });
    await expect(store.put(big, 1)).resolves.toEqual({ status: "stored" });
    const second = record({
      identity: { ...identity, filePath: "/repo/second.md" },
      draftText: "y".repeat(8 * 1024 * 1024),
    });
    await expect(store.put(second, 1)).resolves.toMatchObject({ status: "full" });
  });

  it("lists newest first", async () => {
    await store.put(record({ updatedAt: 10 }), 1);
    await store.put(
      record({ identity: { ...identity, filePath: "/repo/b.md" }, updatedAt: 30 }),
      1
    );
    await store.put(
      record({ identity: { ...identity, filePath: "/repo/c.md" }, updatedAt: 20 }),
      1
    );
    const listed = await store.list();
    expect(listed.map((d) => d.updatedAt)).toEqual([30, 20, 10]);
  });
});
