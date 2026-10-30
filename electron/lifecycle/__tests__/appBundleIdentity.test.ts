import type { BigIntStats } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAppBundleLaunchable,
  captureAppBundleIdentity,
  isAppBundleReplaced,
  resetAppBundleIdentityForTests,
  type AppBundleIdentityOptions,
} from "../appBundleIdentity.js";

const EXEC = "/Applications/Daintree.app/Contents/MacOS/Daintree";
const RESOURCES = "/Applications/Daintree.app/Contents/Resources";
const ASAR = path.join(RESOURCES, "app.asar");

interface FakeFile {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  directory?: boolean;
}

let disk: Map<string, FakeFile | NodeJS.ErrnoException>;
let nextIno = 100n;

function put(path: string, overrides: Partial<FakeFile> = {}): void {
  disk.set(path, { dev: 1n, ino: nextIno++, size: 1000n, mtimeNs: 1n, ...overrides });
}

function fail(path: string, code: string): void {
  disk.set(path, Object.assign(new Error(code), { code }));
}

const statSync = vi.fn((path: string, options?: { bigint?: boolean }): BigIntStats => {
  // A number inode loses precision past 2^53, so only bigint stats are served.
  if (!options?.bigint) throw new Error("expected a bigint stat");
  const entry = disk.get(path);
  if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  if (entry instanceof Error) throw entry;
  const { directory, ...ids } = entry;
  return { ...ids, isFile: () => !directory } as unknown as BigIntStats;
});

function capture(overrides: Partial<AppBundleIdentityOptions> = {}): void {
  captureAppBundleIdentity({
    platform: "darwin",
    isPackaged: true,
    execPath: EXEC,
    resourcesPath: RESOURCES,
    loadStatSync: () => statSync,
    ...overrides,
  });
}

describe("appBundleIdentity (#14937)", () => {
  beforeEach(() => {
    resetAppBundleIdentityForTests();
    disk = new Map();
    statSync.mockClear();
    put(EXEC);
    put(ASAR);
  });

  afterEach(() => {
    resetAppBundleIdentityForTests();
  });

  it("reports nothing while the launched bundle is still in place", () => {
    capture();

    expect(isAppBundleReplaced()).toBe(false);
    expect(isAppBundleLaunchable()).toBe(true);
  });

  it("sees a rename-swap install, which gives every file a new inode", () => {
    capture();
    put(EXEC);
    put(ASAR);

    expect(isAppBundleReplaced()).toBe(true);
    expect(isAppBundleLaunchable()).toBe(true);
  });

  it("sees an archive replaced on its own, as an in-place sync leaves it", () => {
    capture();
    put(ASAR);

    expect(isAppBundleReplaced()).toBe(true);
  });

  it.each<[string, keyof FakeFile]>([
    ["size", "size"],
    ["modification time", "mtimeNs"],
    ["device", "dev"],
  ])("sees a file rewritten in place by its %s", (_case, field) => {
    capture();
    const asar = disk.get(ASAR) as FakeFile;
    disk.set(ASAR, { ...asar, [field]: (asar[field] as bigint) + 1n });

    expect(isAppBundleReplaced()).toBe(true);
  });

  it.each([
    ["the executable is gone", () => disk.delete(EXEC)],
    ["the archive is gone, as an interrupted copy leaves it", () => disk.delete(ASAR)],
    ["the bundle's folder was swapped for a file", () => fail(EXEC, "ENOTDIR")],
  ])("counts it replaced but won't relaunch when %s", (_case, arrange) => {
    capture();
    arrange();

    expect(isAppBundleReplaced()).toBe(true);
    expect(isAppBundleLaunchable()).toBe(false);
  });

  it("won't relaunch into an archive that is no longer a file", () => {
    capture();
    put(ASAR, { directory: true });

    expect(isAppBundleLaunchable()).toBe(false);
  });

  it("treats a file it can't read as unknown, not replaced", () => {
    capture();
    fail(ASAR, "EACCES");

    expect(isAppBundleReplaced()).toBe(false);
  });

  it("still checks the rest of the bundle past a file it can't read", () => {
    capture();
    fail(EXEC, "EACCES");
    put(ASAR);

    expect(isAppBundleReplaced()).toBe(true);
  });

  it("never adopts a later bundle as its baseline", () => {
    capture();
    put(EXEC);
    capture();

    expect(isAppBundleReplaced()).toBe(true);
  });

  it.each<[string, Partial<AppBundleIdentityOptions>]>([
    ["a dev run", { isPackaged: false }],
    ["Linux", { platform: "linux" }],
    ["Windows", { platform: "win32" }],
    ["a process with no resources path", { resourcesPath: undefined }],
  ])("checks nothing in %s", (_case, overrides) => {
    const loadStatSync = vi.fn(() => statSync);
    capture({ ...overrides, loadStatSync });
    put(EXEC);

    expect(isAppBundleReplaced()).toBe(false);
    expect(isAppBundleLaunchable()).toBe(false);
    expect(loadStatSync).not.toHaveBeenCalled();
    expect(statSync).not.toHaveBeenCalled();
  });

  it("reports nothing when the baseline couldn't be taken", () => {
    disk.delete(ASAR);
    capture();
    put(ASAR);

    expect(isAppBundleReplaced()).toBe(false);
  });

  it("reports nothing when the unpatched stat isn't available", () => {
    capture({
      loadStatSync: () => {
        throw new Error("Cannot find module 'original-fs'");
      },
    });
    put(EXEC);

    expect(isAppBundleReplaced()).toBe(false);
  });
});
