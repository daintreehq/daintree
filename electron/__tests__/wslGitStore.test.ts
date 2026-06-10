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
  _resetStoreInstance,
  clearWslGitEntry,
  writeWslGitMap,
} from "../store.js";

describe("wslGitByWorktree store helpers (#9926)", () => {
  let tempDir: string;

  function testOptions(cwd: string) {
    // Mirror the production defaults shape for the keys these tests touch
    // (electron-store returns the default for missing keys, so the in-shape
    // `wslGitByWorktree: {}` is what real callers see on first read).

    return {
      defaults: {
        _schemaVersion: 0,
        wslGitByWorktree: {},
      } as Record<string, unknown>,
      cwd,
    } as any;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-wsl-git-store-"));
    _resetStoreInstance();
    initializeStore(testOptions(tempDir));
  });

  afterEach(() => {
    _resetStoreInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("clearWslGitEntry drops the requested key and leaves siblings intact", () => {
    store.set("wslGitByWorktree", {
      "/repo/a": { enabled: true, dismissed: false },
      "/repo/b": { enabled: false, dismissed: true },
    });

    clearWslGitEntry("/repo/a");

    expect(store.get("wslGitByWorktree")).toEqual({
      "/repo/b": { enabled: false, dismissed: true },
    });
  });

  it("clearWslGitEntry writes {} (never undefined) when clearing the last key", () => {
    store.set("wslGitByWorktree", {
      "/repo/only": { enabled: true, dismissed: true },
    });

    clearWslGitEntry("/repo/only");

    // electron-store v11 throws on set(undefined); the helper must always
    // write a real object so the on-disk shape stays consistent.
    expect(store.get("wslGitByWorktree")).toEqual({});
  });

  it("clearWslGitEntry is a no-op when the key is missing", () => {
    store.set("wslGitByWorktree", {
      "/repo/a": { enabled: true, dismissed: false },
    });

    clearWslGitEntry("/repo/never-existed");

    expect(store.get("wslGitByWorktree")).toEqual({
      "/repo/a": { enabled: true, dismissed: false },
    });
  });

  it("clearWslGitEntry is a no-op when the persisted map is empty", () => {
    // No prior set — store proxy returns the default ({}) on first read.
    clearWslGitEntry("/repo/whatever");
    expect(store.get("wslGitByWorktree")).toEqual({});
  });

  it("clearWslGitEntry is a no-op on junk input", () => {
    store.set("wslGitByWorktree", {
      "/repo/a": { enabled: true, dismissed: false },
    });

    // Each of these is rejected by the type guard at the entry of the helper.
    clearWslGitEntry("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearWslGitEntry(undefined as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearWslGitEntry(null as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearWslGitEntry(42 as any);

    expect(store.get("wslGitByWorktree")).toEqual({
      "/repo/a": { enabled: true, dismissed: false },
    });
  });

  it("clearWslGitEntry does not mutate the original map (read-mutate-set, not in-place delete)", () => {
    // Captured as a defensive snapshot: helpers that hold a reference to the
    // previous shape and only call set(undefined) would corrupt subsequent
    // reads. The helper clones into a fresh object before deleting, so the
    // next read returns the original sibling entry from the cloned map.
    store.set("wslGitByWorktree", {
      "/repo/a": { enabled: true, dismissed: false },
      "/repo/b": { enabled: true, dismissed: false },
    });

    clearWslGitEntry("/repo/a");

    // Repeat-clear must still find /repo/b (the prior in-place delete would
    // have left a torn shape behind).
    clearWslGitEntry("/repo/b");
    expect(store.get("wslGitByWorktree")).toEqual({});
  });

  it("writeWslGitMap replaces the whole map atomically", () => {
    store.set("wslGitByWorktree", {
      "/repo/old": { enabled: true, dismissed: false },
    });

    writeWslGitMap({
      "/repo/new-a": { enabled: true, dismissed: false },
      "/repo/new-b": { enabled: false, dismissed: true },
    });

    expect(store.get("wslGitByWorktree")).toEqual({
      "/repo/new-a": { enabled: true, dismissed: false },
      "/repo/new-b": { enabled: false, dismissed: true },
    });
  });

  it("writeWslGitMap normalizes junk input to {} so it never writes undefined", () => {
    store.set("wslGitByWorktree", {
      "/repo/old": { enabled: true, dismissed: false },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeWslGitMap(null as any);
    expect(store.get("wslGitByWorktree")).toEqual({});
  });
});
