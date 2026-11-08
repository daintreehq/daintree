// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_DU_OPERANDS,
  isStrictlyInside,
  measureDirectorySize,
  parseDuGrandTotal,
} from "../DirectoryDiskUsage.js";

const MB = 1024 * 1024;
const posixOnly = process.platform === "win32" ? describe.skip : describe;

async function writeBytes(file: string, bytes: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Random content so no filesystem compresses or dedupes it away.
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 4096) buf.writeUInt32LE((Math.random() * 2 ** 32) >>> 0, i);
  await fs.writeFile(file, buf);
}

describe("parseDuGrandTotal", () => {
  it("reads the closing total line", () => {
    expect(parseDuGrandTotal("12\t/a\n30\t/b\n42\ttotal\n")).toBe(42);
  });

  it("refuses output without a total line rather than reading a per-operand figure", () => {
    expect(parseDuGrandTotal("12\t/a\n30\t/b\n")).toBeNull();
    expect(parseDuGrandTotal("")).toBeNull();
    expect(parseDuGrandTotal("x\ttotal\n")).toBeNull();
  });

  it("refuses a total too large to hold exactly", () => {
    expect(parseDuGrandTotal(`${Number.MAX_SAFE_INTEGER}\ttotal\n`)).toBeNull();
  });
});

describe("isStrictlyInside", () => {
  it("matches by path component, not by string prefix", () => {
    expect(isStrictlyInside("/repo", "/repo/.worktrees/a", "linux")).toBe(true);
    expect(isStrictlyInside("/repo", "/repo-other/a", "linux")).toBe(false);
    expect(isStrictlyInside("/repo", "/repo", "linux")).toBe(false);
    expect(isStrictlyInside("/repo/a", "/repo", "linux")).toBe(false);
  });

  it("ignores case on Windows", () => {
    expect(isStrictlyInside("C:\\Repo", "c:\\repo\\wt", "win32")).toBe(true);
    expect(isStrictlyInside("C:\\Repo", "C:\\Repo2\\wt", "win32")).toBe(false);
  });
});

describe("measureDirectorySize", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "disk-usage-")));
  });

  afterEach(async () => {
    await fs.chmod(path.join(tmp, "root", "locked"), 0o755).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("answers null, not zero, for a root that isn't a directory", async () => {
    await writeBytes(path.join(tmp, "file"), 4096);
    expect(await measureDirectorySize(path.join(tmp, "missing"))).toBeNull();
    expect(await measureDirectorySize(path.join(tmp, "file"))).toBeNull();
  });

  it("measures an empty directory as a number, not unknown", async () => {
    await fs.mkdir(path.join(tmp, "empty"));
    const size = await measureDirectorySize(path.join(tmp, "empty"));
    expect(size).not.toBeNull();
    expect(size).toBeLessThan(64 * 1024);
  });

  it("answers null when the signal is already aborted", async () => {
    await writeBytes(path.join(tmp, "root", "a"), 4096);
    const controller = new AbortController();
    controller.abort();
    expect(
      await measureDirectorySize(path.join(tmp, "root"), { signal: controller.signal })
    ).toBeNull();
  });

  posixOnly("on POSIX", () => {
    it("counts a file's blocks", async () => {
      await writeBytes(path.join(tmp, "root", "data"), MB);
      const size = await measureDirectorySize(path.join(tmp, "root"));
      expect(size).toBeGreaterThanOrEqual(MB);
      expect(size).toBeLessThan(MB + 256 * 1024);
    });

    it("leaves a nested worktree out of its parent and counts it in itself", async () => {
      const root = path.join(tmp, "root");
      const nested = path.join(root, ".worktrees", "feature");
      await writeBytes(path.join(root, "src", "a"), 256 * 1024);
      await writeBytes(path.join(root, ".worktrees", "notes"), 128 * 1024);
      await writeBytes(path.join(nested, "node_modules", "big"), 2 * MB);

      const whole = (await measureDirectorySize(root))!;
      const parent = (await measureDirectorySize(root, { exclude: [nested] }))!;
      const child = (await measureDirectorySize(nested))!;

      expect(whole).toBeGreaterThan(2 * MB);
      expect(parent).toBeLessThan(MB);
      // The sibling inside `.worktrees` is still the parent's.
      expect(parent).toBeGreaterThanOrEqual(384 * 1024);
      expect(child).toBeGreaterThanOrEqual(2 * MB);
      // Parent and child partition the whole, to within directory blocks and
      // du's kilobyte rounding.
      expect(Math.abs(parent + child - whole)).toBeLessThan(64 * 1024);
    });

    it("ignores exclusions outside the root and lookalike prefixes", async () => {
      const root = path.join(tmp, "root");
      await writeBytes(path.join(root, "data"), MB);
      await writeBytes(path.join(tmp, "root-sibling", "data"), MB);
      const plain = await measureDirectorySize(root);
      const withOutside = await measureDirectorySize(root, {
        exclude: [path.join(tmp, "root-sibling"), tmp, root],
      });
      expect(withOutside).toBe(plain);
    });

    it("measures a parent whose only content is a nested worktree", async () => {
      const root = path.join(tmp, "root");
      const nested = path.join(root, "wt");
      await writeBytes(path.join(nested, "data"), MB);
      const parent = await measureDirectorySize(root, { exclude: [nested] });
      expect(parent).not.toBeNull();
      expect(parent).toBeLessThan(64 * 1024);
    });

    it("counts a hard link once, even across the operands an exclusion splits", async () => {
      const root = path.join(tmp, "root");
      const nested = path.join(root, "deps", "wt");
      await writeBytes(path.join(root, "a", "file"), MB);
      await fs.mkdir(path.join(root, "deps", "other"), { recursive: true });
      await fs.link(path.join(root, "a", "file"), path.join(root, "deps", "other", "link"));
      await fs.mkdir(nested, { recursive: true });

      const size = (await measureDirectorySize(root, { exclude: [nested] }))!;
      expect(size).toBeGreaterThanOrEqual(MB);
      expect(size).toBeLessThan(MB + 256 * 1024);
    });

    it("doesn't follow a symlink out of the tree", async () => {
      const root = path.join(tmp, "root");
      await writeBytes(path.join(tmp, "outside", "big"), 2 * MB);
      await fs.mkdir(root);
      await fs.symlink(path.join(tmp, "outside"), path.join(root, "node_modules"));
      const size = await measureDirectorySize(root);
      expect(size).not.toBeNull();
      expect(size).toBeLessThan(64 * 1024);
    });

    it("answers null when part of the tree can't be read", async () => {
      if (process.getuid?.() === 0) return;
      const root = path.join(tmp, "root");
      await writeBytes(path.join(root, "locked", "data"), 4096);
      await fs.chmod(path.join(root, "locked"), 0o000);
      expect(await measureDirectorySize(root)).toBeNull();
    });

    it("walks instead of splitting du when the frontier is too wide, and agrees with du", async () => {
      const root = path.join(tmp, "root");
      const nested = path.join(root, "wt");
      await writeBytes(path.join(nested, "data"), MB);
      await fs.mkdir(root, { recursive: true });
      await Promise.all(
        Array.from({ length: MAX_DU_OPERANDS + 1 }, (_, i) =>
          fs.writeFile(path.join(root, `f${i}`), "x")
        )
      );
      await writeBytes(path.join(root, "f0"), 512 * 1024);

      const walked = (await measureDirectorySize(root, { exclude: [nested] }))!;
      await fs.rm(nested, { recursive: true });
      const viaDu = (await measureDirectorySize(root))!;

      expect(walked).toBeGreaterThanOrEqual(512 * 1024);
      expect(Math.abs(walked - viaDu)).toBeLessThan(64 * 1024);
    });
  });
});
