import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
