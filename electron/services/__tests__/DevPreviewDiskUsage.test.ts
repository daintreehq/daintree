// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeDirSize } from "../DevPreviewDiskUsage.js";

const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });
const vanished = () => Object.assign(new Error("gone"), { code: "ENOENT" });

describe("computeDirSize on the Windows walk", () => {
  let tmp: string;
  let root: string;
  let nested: string;
  let rootFile: string;
  let nestedFile: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-preview-size-")));
    root = path.join(tmp, "root");
    nested = path.join(root, "nested");
    rootFile = path.join(root, "a.bin");
    nestedFile = path.join(nested, "b.bin");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(rootFile, Buffer.alloc(7));
    fs.writeFileSync(nestedFile, Buffer.alloc(11));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Each failing predicate returns the error to throw for that call, or null to
  // pass it through; `n` is how many times that exact path has been seen.
  function injectFailures(failures: {
    opendir?: (target: string, n: number) => Error | null;
    lstat?: (target: string, n: number) => Error | null;
  }) {
    const realOpendir = fsPromises.opendir.bind(fsPromises);
    const realLstat = fsPromises.lstat.bind(fsPromises);
    const seen = new Map<string, number>();
    const count = (kind: string, target: string) => {
      const key = `${kind}:${target}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return n;
    };
    const opendir = vi.spyOn(fsPromises, "opendir").mockImplementation((async (
      target: string,
      options?: unknown
    ) => {
      const err = failures.opendir?.(String(target), count("opendir", String(target)));
      if (err) throw err;
      return realOpendir(target, options as never);
    }) as never);
    const lstat = vi.spyOn(fsPromises, "lstat").mockImplementation((async (
      target: string,
      options?: unknown
    ) => {
      const err = failures.lstat?.(String(target), count("lstat", String(target)));
      if (err) throw err;
      return realLstat(target, options as never);
    }) as never);
    const opened = (target: string) =>
      opendir.mock.calls.filter(([arg]) => String(arg) === target).length;
    return { opened, lstat };
  }

  it("measures a complete tree", async () => {
    const spies = injectFailures({});
    expect(await computeDirSize(root, "win32")).toBe(18);
    expect(spies.opened(root)).toBe(1);
  });

  it("measures an empty directory as zero, not unknown", async () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    const spies = injectFailures({});
    expect(await computeDirSize(empty, "win32")).toBe(0);
    expect(spies.opened(empty)).toBe(1);
  });

  it("answers unknown, not zero, for a nonempty root that can't be opened", async () => {
    const spies = injectFailures({ opendir: (target) => (target === root ? denied() : null) });
    expect(await computeDirSize(root, "win32")).toBeNull();
    expect(spies.opened(root)).toBe(2);
  });

  it("answers unknown, not the partial sum, when a nested directory can't be opened", async () => {
    const spies = injectFailures({ opendir: (target) => (target === nested ? denied() : null) });
    expect(await computeDirSize(root, "win32")).toBeNull();
    expect(spies.opened(nested)).toBe(2);
  });

  it("answers unknown, not the partial sum, when a file can't be read", async () => {
    const spies = injectFailures({
      lstat: (target) => (target === nestedFile ? vanished() : null),
    });
    expect(await computeDirSize(root, "win32")).toBe(null);
    expect(spies.lstat.mock.calls.filter(([arg]) => String(arg) === nestedFile)).toHaveLength(2);
  });

  it("measures the whole tree when a transient failure clears on the second pass", async () => {
    const spies = injectFailures({
      lstat: (target, n) => {
        if (target !== nestedFile || n !== 1) return null;
        // The first pass has already counted the 7-byte file; a second pass
        // that kept its subtotal or inode set would still report 7 for it.
        fs.writeFileSync(rootFile, Buffer.alloc(9));
        return vanished();
      },
    });
    expect(await computeDirSize(root, "win32")).toBe(9 + 11);
    expect(spies.opened(root)).toBe(2);
  });

  it("doesn't take a file replaced by a directory mid-scan as the figure", async () => {
    injectFailures({
      lstat: (target, n) => {
        if (target !== nestedFile || n !== 1) return null;
        fs.rmSync(nestedFile);
        fs.mkdirSync(nestedFile);
        fs.writeFileSync(path.join(nestedFile, "c.bin"), Buffer.alloc(1000));
        return null;
      },
    });
    // The first pass saw the directory where it had listed a file and
    // discarded itself; the second walks the replacement's contents.
    expect(await computeDirSize(root, "win32")).toBe(7 + 1000);
  });

  it("counts a hard-linked file once", async () => {
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    fs.mkdirSync(left);
    fs.mkdirSync(right);
    fs.writeFileSync(path.join(left, "shared.bin"), Buffer.alloc(100));
    fs.linkSync(path.join(left, "shared.bin"), path.join(right, "shared.bin"));
    expect(await computeDirSize(root, "win32")).toBe(18 + 100);
  });

  it("counts every path when the filesystem reports no inode", async () => {
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    fs.mkdirSync(left);
    fs.mkdirSync(right);
    fs.writeFileSync(path.join(left, "shared.bin"), Buffer.alloc(100));
    fs.linkSync(path.join(left, "shared.bin"), path.join(right, "shared.bin"));
    const realLstat = fsPromises.lstat.bind(fsPromises);
    vi.spyOn(fsPromises, "lstat").mockImplementation((async (target: string) => {
      const stat = await realLstat(target);
      return path.basename(String(target)) === "shared.bin"
        ? { dev: stat.dev, ino: 0, size: stat.size, isDirectory: () => false }
        : stat;
    }) as never);
    expect(await computeDirSize(root, "win32")).toBe(18 + 200);
  });

  it("answers unknown for a path that isn't a directory", async () => {
    expect(await computeDirSize(rootFile, "win32")).toBeNull();
    expect(await computeDirSize(path.join(tmp, "missing"), "win32")).toBeNull();
  });
});
