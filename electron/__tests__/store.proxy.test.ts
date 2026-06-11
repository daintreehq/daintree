import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("electron-store", async () => {
  const conf = await import("conf");
  return { default: conf.default };
});

import {
  store,
  initializeStore,
  invalidateStoreValueCache,
  _resetStoreInstance,
  _peekStoreInstance,
} from "../store.js";

describe("store Proxy", () => {
  let tempDir: string;

  function testOptions(cwd: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { defaults: { _schemaVersion: 0 } as Record<string, unknown>, cwd } as any;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-proxy-"));
    _resetStoreInstance();
  });

  afterEach(() => {
    _resetStoreInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not initialize at module-load time — only on explicit init or first access", () => {
    expect(_peekStoreInstance()).toBeUndefined();
  });

  it("delegates get() and set() to the initialized instance", () => {
    initializeStore(testOptions(tempDir));
    store.set("_schemaVersion" as never, 7 as never);
    expect(store.get("_schemaVersion" as never)).toBe(7);
  });

  it("supports `key in store` via the has trap", () => {
    initializeStore(testOptions(tempDir));
    expect("get" in store).toBe(true);
    expect("set" in store).toBe(true);
    expect("definitelyMissingMethod" in store).toBe(false);
  });

  it("binds methods so callers can detach them without losing `this`", () => {
    initializeStore(testOptions(tempDir));
    const get = store.get;
    expect(() => get("_schemaVersion" as never)).not.toThrow();
    expect(get("_schemaVersion" as never)).toBe(0);
  });

  it("lazy-initializes on first proxy access when init was skipped", () => {
    expect(_peekStoreInstance()).toBeUndefined();
    void store.get;
    expect(_peekStoreInstance()).toBeDefined();
  });

  it("re-initializes after _resetStoreInstance()", () => {
    initializeStore(testOptions(tempDir));
    const first = _peekStoreInstance();
    expect(first).toBeDefined();
    _resetStoreInstance();
    expect(_peekStoreInstance()).toBeUndefined();
    initializeStore(testOptions(tempDir));
    expect(_peekStoreInstance()).toBeDefined();
  });

  describe("value cache", () => {
    it("serves repeat reads from the in-memory snapshot, not the file", () => {
      initializeStore(testOptions(tempDir));
      expect(store.get("_schemaVersion" as never)).toBe(0);
      // Rewrite the file behind electron-store's back; a cached read must
      // not see it (proving no per-get disk read happens).
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 42 }), "utf8");
      expect(store.get("_schemaVersion" as never)).toBe(0);
    });

    it("invalidates on set() so the next read re-snapshots the file", () => {
      initializeStore(testOptions(tempDir));
      expect(store.get("_schemaVersion" as never)).toBe(0);
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 42, other: 1 }), "utf8");
      store.set("other" as never, 2 as never);
      expect(store.get("_schemaVersion" as never)).toBe(42);
      expect(store.get("other" as never)).toBe(2);
    });

    it("invalidates on delete()", () => {
      initializeStore(testOptions(tempDir));
      store.set("flag" as never, true as never);
      expect(store.get("flag" as never)).toBe(true);
      store.delete("flag" as never);
      expect(store.get("flag" as never)).toBeUndefined();
    });

    it("invalidateStoreValueCache() forces a re-read after an external file swap", () => {
      initializeStore(testOptions(tempDir));
      expect(store.get("_schemaVersion" as never)).toBe(0);
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 9 }), "utf8");
      invalidateStoreValueCache();
      expect(store.get("_schemaVersion" as never)).toBe(9);
    });

    it("resolves dot-notation paths against the snapshot", () => {
      initializeStore(testOptions(tempDir));
      store.set("nested" as never, { inner: { value: 7 } } as never);
      expect(store.get("nested.inner.value" as never)).toBe(7);
      expect(store.get("nested.missing.value" as never)).toBeUndefined();
      expect(store.get("nested.missing" as never, "fallback" as never)).toBe("fallback");
    });

    it("returns isolated clones — mutating a read result cannot poison later reads", () => {
      initializeStore(testOptions(tempDir));
      store.set("obj" as never, { list: [1] } as never);
      const first = store.get("obj" as never) as { list: number[] };
      first.list.push(2);
      const second = store.get("obj" as never) as { list: number[] };
      expect(second.list).toEqual([1]);
    });

    it("bypasses the cache for the in-memory fallback store", () => {
      initializeStore(testOptions("/nonexistent/\0/path"));
      expect(_peekStoreInstance()?.path).toBe("");
      store.set("k" as never, "v" as never);
      expect(store.get("k" as never)).toBe("v");
    });
  });
});
