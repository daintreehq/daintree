import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRemoteInventoryReader } from "../remoteInventory.js";

describe("createRemoteInventoryReader", () => {
  let commonDir: string;

  beforeEach(async () => {
    commonDir = await mkdtemp(path.join(os.tmpdir(), "remote-inventory-"));
    await writeFile(path.join(commonDir, "config"), "[core]\n");
  });

  afterEach(async () => {
    await rm(commonDir, { recursive: true, force: true });
  });

  // Asked before every background fetch, so an unchanged config must cost a
  // stat and nothing else.
  it("reads git once while the config holds still", async () => {
    const read = vi.fn(async () => ["origin"]);
    const inventory = createRemoteInventoryReader(read);

    expect(await inventory("/wt", commonDir)).toEqual(["origin"]);
    expect(await inventory("/wt", commonDir)).toEqual(["origin"]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the config changes", async () => {
    const read = vi.fn(async () => [] as string[]);
    const inventory = createRemoteInventoryReader(read);
    await inventory("/wt", commonDir);

    read.mockResolvedValueOnce(["origin"]);
    await writeFile(path.join(commonDir, "config"), '[remote "origin"]\n\turl = x\n');
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(commonDir, "config"), later, later);

    expect(await inventory("/wt", commonDir)).toEqual(["origin"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("re-reads once the cached answer ages out", async () => {
    let now = 1_000;
    const read = vi.fn(async () => ["origin"]);
    const inventory = createRemoteInventoryReader(read, () => now);
    await inventory("/wt", commonDir);

    now += 5 * 60_000;
    await inventory("/wt", commonDir);
    expect(read).toHaveBeenCalledTimes(2);
  });

  // Siblings share `config` but not necessarily their effective config.
  it("never serves one worktree's answer to another", async () => {
    const read = vi.fn(async (worktreePath: string) => (worktreePath === "/a" ? [] : ["origin"]));
    const inventory = createRemoteInventoryReader(read);

    expect(await inventory("/a", commonDir)).toEqual([]);
    expect(await inventory("/b", commonDir)).toEqual(["origin"]);
  });

  it("bypasses the cache when asked for a fresh read", async () => {
    const read = vi.fn(async () => ["origin"]);
    const inventory = createRemoteInventoryReader(read);
    await inventory("/wt", commonDir);
    await inventory("/wt", commonDir, true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  // A config written while `git remote` ran may not be in its answer; a stale
  // "none" would suppress the fetch a just-added remote needs.
  it("reports unknown when the config changes during the read", async () => {
    const read = vi.fn(async () => {
      await writeFile(path.join(commonDir, "config"), '[remote "origin"]\n\turl = x\n');
      return [] as string[];
    });
    const inventory = createRemoteInventoryReader(read);

    expect(await inventory("/wt", commonDir)).toBeNull();
  });

  // Unknown must never be reported as "no remotes" — that would hide a real
  // failure behind the local-only state.
  it("reports unknown, uncached, when git cannot answer", async () => {
    const read = vi.fn(async () => null);
    const inventory = createRemoteInventoryReader(read);

    expect(await inventory("/wt", commonDir)).toBeNull();
    expect(await inventory("/wt", commonDir)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reports unknown when the config cannot be read", async () => {
    const read = vi.fn(async () => ["origin"]);
    const inventory = createRemoteInventoryReader(read);

    expect(await inventory("/wt", path.join(commonDir, "missing"))).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
