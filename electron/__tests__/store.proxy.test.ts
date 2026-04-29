import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("electron-store", async () => {
  const conf = await import("conf");
  return { default: conf.default };
});

import { store, initializeStore, _resetStoreInstance, _peekStoreInstance } from "../store.js";

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
});
