import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PluginSettingsStore } from "../PluginSettingsStore.js";

let tmpDir: string;

function storeAt(...segments: string[]): { store: PluginSettingsStore; filePath: string } {
  const filePath = path.join(tmpDir, ...segments);
  return { store: new PluginSettingsStore(filePath), filePath };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-settings-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginSettingsStore", () => {
  it("returns undefined for an unset key when the file does not exist", async () => {
    const { store } = storeAt("missing", "acme.plugin.json");
    expect(await store.get("token")).toBeUndefined();
  });

  it("set creates the directory, persists JSON, and round-trips the value", async () => {
    const { store, filePath } = storeAt("nested", "dir", "acme.plugin.json");
    const changed = await store.set("token", "sk-test");
    expect(changed).toBe(true);
    expect(await store.get<string>("token")).toBe("sk-test");

    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ token: "sk-test" });
  });

  it("persists across store instances pointed at the same file", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("count", 3);
    await store.set("flag", true);

    const reopened = new PluginSettingsStore(filePath);
    expect(await reopened.get<number>("count")).toBe(3);
    expect(await reopened.get<boolean>("flag")).toBe(true);
  });

  it("stores structured values", async () => {
    const { store } = storeAt("acme.plugin.json");
    const value = { nested: { list: [1, 2, 3] }, name: "x" };
    await store.set("config", value);
    expect(await store.get("config")).toEqual(value);
  });

  const chmodIt = process.platform === "win32" ? it.skip : it;
  chmodIt("writes the file with mode 0o600", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("token", "secret");
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("set returns false for a no-op write of an equal value", async () => {
    const { store } = storeAt("acme.plugin.json");
    expect(await store.set("k", { a: 1 })).toBe(true);
    expect(await store.set("k", { a: 1 })).toBe(false);
    expect(await store.set("k", { a: 2 })).toBe(true);
  });

  it("rejects when the file contains invalid JSON", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not json", "utf-8");
    await expect(store.get("token")).rejects.toThrow(/not valid JSON/);
  });

  it("rejects when the file contains a non-object JSON value", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify([1, 2, 3]), "utf-8");
    await expect(store.get("token")).rejects.toThrow(/must contain a JSON object/);
  });

  // Skipped where directory mode bits don't gate writes (Windows, or running
  // as root which bypasses permission checks).
  const rollbackIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
  rollbackIt("rolls back the in-memory value when the write fails", async () => {
    const dir = path.join(tmpDir, "ro");
    await fs.mkdir(dir, { recursive: true });
    const store = new PluginSettingsStore(path.join(dir, "acme.plugin.json"));
    // Read+execute only: load() (readFile → ENOENT) still succeeds, but the
    // atomic write of the temp file into the directory fails with EACCES.
    await fs.chmod(dir, 0o555);
    try {
      await expect(store.set("token", "value")).rejects.toBeTruthy();
      // The optimistic in-memory mutation must not survive a failed persist.
      expect(await store.get("token")).toBeUndefined();
    } finally {
      // Restore write perms so afterEach can remove the tree.
      await fs.chmod(dir, 0o755);
    }
  });

  it("recovers on the same instance after a corrupt file is repaired", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ broken", "utf-8");
    await expect(store.get("token")).rejects.toThrow(/not valid JSON/);

    // External repair — the same store instance must not stay poisoned.
    await fs.writeFile(filePath, JSON.stringify({ token: "fixed" }), "utf-8");
    expect(await store.get<string>("token")).toBe("fixed");
  });

  it("does not diverge from disk when the caller mutates a stored object", async () => {
    const { store } = storeAt("acme.plugin.json");
    const value = { a: 1 };
    await store.set("config", value);
    value.a = 2;
    expect(await store.get<{ a: number }>("config")).toEqual({ a: 1 });
  });

  const idempotentIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
  idempotentIt("treats an equal-value set as a no-op, even when the dir is read-only", async () => {
    const dir = path.join(tmpDir, "idem");
    await fs.mkdir(dir, { recursive: true });
    const store = new PluginSettingsStore(path.join(dir, "acme.plugin.json"));
    expect(await store.set("token", "v1")).toBe(true);
    await fs.chmod(dir, 0o555);
    try {
      // Equal value: must skip the write and not fail on the read-only dir.
      expect(await store.set("token", "v1")).toBe(false);
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });

  it("serializes concurrent writes so all keys are persisted", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await Promise.all([store.set("a", 1), store.set("b", 2), store.set("c", 3), store.set("d", 4)]);
    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });

  describe("delete", () => {
    it("removes a stored key and reports the change", async () => {
      const { store, filePath } = storeAt("acme.plugin.json");
      await store.set("token", "sk-test");
      expect(await store.delete("token")).toBe(true);
      expect(await store.get("token")).toBeUndefined();
      const raw = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(raw)).toEqual({});
    });

    it("returns false when deleting an absent key", async () => {
      const { store } = storeAt("acme.plugin.json");
      expect(await store.delete("missing")).toBe(false);
    });

    it("leaves sibling keys intact", async () => {
      const { store } = storeAt("acme.plugin.json");
      await store.set("a", 1);
      await store.set("b", 2);
      expect(await store.delete("a")).toBe(true);
      expect(await store.get("a")).toBeUndefined();
      expect(await store.get<number>("b")).toBe(2);
    });

    it("persists the deletion across instances", async () => {
      const { store, filePath } = storeAt("acme.plugin.json");
      await store.set("token", "sk-test");
      await store.delete("token");
      const reopened = new PluginSettingsStore(filePath);
      expect(await reopened.get("token")).toBeUndefined();
    });

    const rollbackDeleteIt =
      process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
    rollbackDeleteIt("rolls back the in-memory delete when the write fails", async () => {
      const dir = path.join(tmpDir, "ro-del");
      await fs.mkdir(dir, { recursive: true });
      const store = new PluginSettingsStore(path.join(dir, "acme.plugin.json"));
      await store.set("token", "value");
      await fs.chmod(dir, 0o555);
      try {
        await expect(store.delete("token")).rejects.toBeTruthy();
        // The optimistic in-memory delete must not survive a failed persist.
        expect(await store.get<string>("token")).toBe("value");
      } finally {
        await fs.chmod(dir, 0o755);
      }
    });
  });
});

describe("PluginSettingsStore after the file changes underneath it", () => {
  it("reads a rewrite that landed from outside, as a pull or branch switch would", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");

    await fs.writeFile(filePath, JSON.stringify({ channel: "x", cadence: 3 }));

    expect(await store.get("channel")).toBe("x");
    expect(await store.get("cadence")).toBe(3);
  });

  it("keeps the outside change when it writes next, instead of restoring its stale copy", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");
    await fs.writeFile(filePath, JSON.stringify({ channel: "x", cadence: 3 }));

    await store.set("reviewer", "sam");

    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({
      channel: "x",
      cadence: 3,
      reviewer: "sam",
    });
  });

  it("gives every concurrent read the rewritten file, and writes on top of it", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");
    await fs.writeFile(filePath, JSON.stringify({ channel: "x" }));

    const reads = await Promise.all(Array.from({ length: 20 }, () => store.get("channel")));
    expect(new Set(reads)).toEqual(new Set(["x"]));

    await store.set("reviewer", "sam");
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({
      channel: "x",
      reviewer: "sam",
    });
  });

  it("makes a write wait for a reload already in flight rather than write over it", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");
    await fs.writeFile(filePath, JSON.stringify({ channel: "x" }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
      await gate;
      return realReadFile(...(args as Parameters<typeof fs.readFile>));
    });
    try {
      const read = store.get("channel");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const write = store.set("reviewer", "sam");
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      expect(await read).toBe("x");
      await write;
    } finally {
      spy.mockRestore();
    }

    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({
      channel: "x",
      reviewer: "sam",
    });
  });

  it("doesn't lend its values the identity of a file replaced right after its own write", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");

    const realStat = fs.stat.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      // First stat: the pre-write freshness check. Second: the post-write one —
      // a checkout lands just before it.
      if (++calls === 2) await fs.writeFile(filePath, JSON.stringify({ channel: "x" }));
      return realStat(...(args as Parameters<typeof fs.stat>));
    });
    try {
      await store.set("reviewer", "sam");
    } finally {
      spy.mockRestore();
    }

    expect(await store.get("channel")).toBe("x");
    expect(await store.get("reviewer")).toBeUndefined();
  });

  it("sees the file deleted and recreated", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");
    await fs.rm(filePath);
    expect(await store.get("channel")).toBeUndefined();

    await fs.writeFile(filePath, JSON.stringify({ channel: "news" }));
    expect(await store.get("channel")).toBe("news");
  });

  it("answers a read racing its own write with the value being written", async () => {
    const { store } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");

    const write = store.set("channel", "x");
    const reads = await Promise.all([store.get("channel"), store.get("channel")]);
    await write;

    for (const value of reads) expect(["blog", "x"]).toContain(value);
    expect(await store.get("channel")).toBe("x");
  });
});
