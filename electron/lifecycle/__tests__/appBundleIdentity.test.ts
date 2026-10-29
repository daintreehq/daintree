import type { BigIntStats } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canRelaunchReplacedApp,
  captureAppBundleIdentity,
  isAppBundleReplaced,
  resetAppBundleIdentityForTests,
  type AppBundleIdentityOptions,
} from "../appBundleIdentity.js";

const EXEC = "/Applications/Daintree.app/Contents/MacOS/Daintree";
const RESOURCES = "/Applications/Daintree.app/Contents/Resources";
const ASAR = `${RESOURCES}/app.asar`;

interface FakeFile {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

let disk: Map<string, FakeFile | NodeJS.ErrnoException>;
let nextIno = 100n;

function put(path: string, overrides: Partial<FakeFile> = {}): void {
  disk.set(path, { ino: nextIno++, size: 1000n, mtimeNs: 1n, ...overrides });
}

function fail(path: string, code: string): void {
  disk.set(path, Object.assign(new Error(code), { code }));
}

const statSync = vi.fn((path: string): BigIntStats => {
  const entry = disk.get(path);
  if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  if (entry instanceof Error) throw entry;
  return { dev: 1n, ...entry, isFile: () => true } as unknown as BigIntStats;
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
    expect(canRelaunchReplacedApp()).toBe(false);
  });

  it("sees a rename-swap install, which gives every file a new inode", () => {
    capture();
    put(EXEC);
    put(ASAR);

    expect(isAppBundleReplaced()).toBe(true);
    expect(canRelaunchReplacedApp()).toBe(true);
  });

  it("sees an archive replaced on its own, as an in-place sync leaves it", () => {
    capture();
    put(ASAR);

    expect(isAppBundleReplaced()).toBe(true);
  });

  it("sees a file rewritten in place by its size or modification time", () => {
    capture();
    const asar = disk.get(ASAR) as FakeFile;
    disk.set(ASAR, { ...asar, mtimeNs: asar.mtimeNs + 1n });
    expect(isAppBundleReplaced()).toBe(true);

    disk.set(ASAR, { ...asar, size: asar.size + 1n });
    expect(isAppBundleReplaced()).toBe(true);
  });

  it("counts a launched file that is gone as replaced, but won't relaunch into nothing", () => {
    capture();
    disk.delete(EXEC);

    expect(isAppBundleReplaced()).toBe(true);
    expect(canRelaunchReplacedApp()).toBe(false);
  });

  it("treats a file it can't read as unknown, not replaced", () => {
    capture();
    fail(ASAR, "EACCES");

    expect(isAppBundleReplaced()).toBe(false);
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
