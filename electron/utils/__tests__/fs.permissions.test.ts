import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import {
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
