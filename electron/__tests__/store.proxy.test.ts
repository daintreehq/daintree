import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Conf from "conf";

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

function initializeStoreForComparison(cwd: string) {
  // The unproxied conf path the proxy's write-through must match byte for byte.
  return new Conf({ defaults: { _schemaVersion: 0 }, cwd, configFileMode: 0o600 } as never) as {
    set(key: string, value: unknown): void;
    get(key: string): unknown;
  };
}

function findStoreDescriptor(proto: object | null): PropertyDescriptor | undefined {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, "store");
    if (d) return d;
  }
  return undefined;
}

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

    it("writes set() through to the snapshot instead of re-reading the file", () => {
      initializeStore(testOptions(tempDir));
      expect(store.get("_schemaVersion" as never)).toBe(0);
      const configPath = path.join(tempDir, "config.json");
      const readSpy = vi.spyOn(fs, "readFileSync");
      store.set("other" as never, 2 as never);
      expect(store.get("other" as never)).toBe(2);
      expect(store.get("_schemaVersion" as never)).toBe(0);
      const configReads = readSpy.mock.calls.filter(([p]) => p === configPath).length;
      readSpy.mockRestore();
      // Only conf's __internal__ preservation read inside the store setter.
      expect(configReads).toBeLessThanOrEqual(1);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        _schemaVersion: 0,
        other: 2,
      });
    });

    it("writes the same bytes conf's own set() would", () => {
      const confDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-proxy-conf-"));
      try {
        initializeStore(testOptions(tempDir));
        const direct = initializeStoreForComparison(confDir);
        const ops: [string, unknown][] = [
          ["appState", { sidebarWidth: 300, terminals: [{ id: "a" }], at: new Date(0) }],
          ["nested.inner.value", 7],
          ["nested.inner.other", { deep: [1, 2] }],
          ["prim", 1],
          ["prim.child", "replaces a primitive"],
          ["list", [1, 2]],
          ["list.0", "numeric segment falls back to conf"],
          ["list.named", "array intermediate falls back to conf"],
          ["nullable", null],
          ["nullable.child", "replaces a null"],
          ["dropped", { toJSON: () => undefined }],
          ["kept", { inner: { toJSON: () => undefined }, n: Number.NaN }],
          ["keyed", { toJSON: (key: string) => `serialized under ${key}` }],
          ["protoHolder", JSON.parse('{"__proto__":{"x":1},"y":2}')],
          ["protoHolder.b", "copying keeps an own __proto__ key"],
          ["nested.inner.value", 8],
        ];
        for (const [key, value] of ops) {
          store.set(key as never, value as never);
          direct.set(key, value);
          expect(store.get(key as never)).toEqual(direct.get(key));
          expect(fs.readFileSync(path.join(tempDir, "config.json"), "utf8")).toBe(
            fs.readFileSync(path.join(confDir, "config.json"), "utf8")
          );
        }
        invalidateStoreValueCache();
        for (const key of ["appState", "nested", "prim", "list", "nullable", "kept", "keyed"]) {
          expect(store.get(key as never)).toEqual(direct.get(key));
        }
      } finally {
        fs.rmSync(confDir, { recursive: true, force: true });
      }
    });

    it("caches a JSON copy so the caller's object cannot alias the snapshot", () => {
      initializeStore(testOptions(tempDir));
      const value = { list: [1], when: new Date(0) };
      store.set("obj" as never, value as never);
      value.list.push(2);
      expect(store.get("obj" as never)).toEqual({ list: [1], when: new Date(0).toISOString() });
    });

    it("keeps a nested write made by a change listener", () => {
      initializeStore(testOptions(tempDir));
      const instance = _peekStoreInstance() as unknown as {
        onDidChange(key: string, cb: () => void): () => void;
      };
      let fired = false;
      const off = instance.onDidChange("a", () => {
        if (fired) return;
        fired = true;
        store.set("b" as never, 2 as never);
      });
      store.set("a" as never, 1 as never);
      off();
      expect(store.get("b" as never)).toBe(2);
      store.set("c" as never, 3 as never);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf8"));
      expect(onDisk).toMatchObject({ a: 1, b: 2, c: 3 });
    });

    it("invalidates on appendToArray() so a later set() cannot drop the append", () => {
      initializeStore(testOptions(tempDir));
      store.set("list" as never, [] as never);
      store.appendToArray("list" as never, 1 as never);
      expect(store.get("list" as never)).toEqual([1]);
      store.set("other" as never, 2 as never);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf8"));
      expect(onDisk.list).toEqual([1]);
    });

    it("drops the snapshot when the write fails, so the next read reflects disk", () => {
      initializeStore(testOptions(tempDir));
      store.set("k" as never, 1 as never);
      const instance = _peekStoreInstance() as unknown as Record<string, unknown>;
      const proto = Object.getPrototypeOf(instance) as object;
      const descriptor = findStoreDescriptor(proto)!;
      Object.defineProperty(instance, "store", {
        configurable: true,
        get: descriptor.get,
        set() {
          throw new Error("disk full");
        },
      });
      try {
        expect(() => store.set("k" as never, 2 as never)).toThrow("disk full");
      } finally {
        delete instance.store;
      }
      expect(store.get("k" as never)).toBe(1);
    });

    it("rejects values conf rejects, without touching the snapshot", () => {
      initializeStore(testOptions(tempDir));
      store.set("k" as never, 1 as never);
      expect(() => store.set("k" as never, undefined as never)).toThrow(TypeError);
      expect(() => store.set("__internal__" as never, 1 as never)).toThrow(TypeError);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => store.set("k" as never, cyclic as never)).toThrow(TypeError);
      expect(store.get("k" as never)).toBe(1);
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
