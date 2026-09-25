import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import path from "path";
import os from "os";
import {
  ensureOwnerOnlyDir,
  tightenDirPermissions,
  tightenDirPermissionsSync,
  tightenFilePermissionsSync,
} from "../fs.js";

// chmod is a POSIX no-op on Windows, so the mode-bit assertions only run there.
const posixIt = process.platform === "win32" ? it.skip : it;

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

describe("tightenFilePermissionsSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "daintree-perms-file-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  posixIt("tightens a world-readable file to owner-only", () => {
    const target = path.join(tmpDir, "data.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o644);

    tightenFilePermissionsSync(target);

    expect(mode(target)).toBe(0o600);
  });

  posixIt("leaves a world-readable file untouched when platform is win32", () => {
    const target = path.join(tmpDir, "data.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o644);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    tightenFilePermissionsSync(target);

    // The win32 guard must bail before chmod — mode stays exactly as it was.
    expect(mode(target)).toBe(0o644);
  });

  it("does not throw on a missing path", () => {
    expect(() => tightenFilePermissionsSync(path.join(tmpDir, "absent.json"))).not.toThrow();
  });

  it("does not throw on an empty path", () => {
    expect(() => tightenFilePermissionsSync("")).not.toThrow();
  });
});

describe("tightenDirPermissionsSync / tightenDirPermissions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "daintree-perms-dir-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  posixIt("tightens a pre-existing 0755 directory in place (upgrade case)", () => {
    const dir = path.join(tmpDir, "sessions");
    mkdirSync(dir);
    chmodSync(dir, 0o755);

    tightenDirPermissionsSync(dir);

    expect(mode(dir)).toBe(0o700);
  });

  posixIt("async variant tightens a pre-existing 0755 directory", async () => {
    const dir = path.join(tmpDir, "history");
    mkdirSync(dir);
    chmodSync(dir, 0o755);

    await tightenDirPermissions(dir);

    expect(mode(dir)).toBe(0o700);
  });

  posixIt("both variants leave a 0755 directory untouched on win32", async () => {
    const syncDir = path.join(tmpDir, "sync");
    const asyncDir = path.join(tmpDir, "async");
    mkdirSync(syncDir);
    mkdirSync(asyncDir);
    chmodSync(syncDir, 0o755);
    chmodSync(asyncDir, 0o755);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    tightenDirPermissionsSync(syncDir);
    await tightenDirPermissions(asyncDir);

    expect(mode(syncDir)).toBe(0o755);
    expect(mode(asyncDir)).toBe(0o755);
  });

  it("does not throw on a missing directory", async () => {
    const absent = path.join(tmpDir, "absent");
    expect(() => tightenDirPermissionsSync(absent)).not.toThrow();
    await expect(tightenDirPermissions(absent)).resolves.toBeUndefined();
  });
});

describe("ensureOwnerOnlyDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "daintree-owner-dir-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  posixIt("creates a missing directory at 0o700", async () => {
    const dir = path.join(tmpDir, "inbox");

    await ensureOwnerOnlyDir(dir);

    expect(statSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe(0o700);
  });

  posixIt("tightens an existing directory left at the umask default", async () => {
    const dir = path.join(tmpDir, "inbox");
    mkdirSync(dir);
    chmodSync(dir, 0o755);

    await ensureOwnerOnlyDir(dir);

    expect(mode(dir)).toBe(0o700);
  });

  posixIt("refuses a symlink at the name and leaves its target alone", async () => {
    const target = path.join(tmpDir, "elsewhere");
    mkdirSync(target);
    chmodSync(target, 0o777);
    const dir = path.join(tmpDir, "inbox");
    symlinkSync(target, dir);

    await expect(ensureOwnerOnlyDir(dir)).rejects.toThrow(/real directory/);

    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(mode(target)).toBe(0o777);
    expect(readdirSync(target)).toEqual([]);
  });

  it("refuses a regular file at the name", async () => {
    const dir = path.join(tmpDir, "inbox");
    writeFileSync(dir, "not a dir");

    await expect(ensureOwnerOnlyDir(dir)).rejects.toThrow(/real directory/);
  });

  posixIt("refuses a directory owned by another user without touching it", async () => {
    const dir = path.join(tmpDir, "inbox");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const ownUid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(ownUid + 1);

    await expect(ensureOwnerOnlyDir(dir)).rejects.toThrow(/another user/);

    expect(mode(dir)).toBe(0o755);
  });
});
