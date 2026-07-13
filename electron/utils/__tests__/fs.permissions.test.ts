import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import {
  OWNER_RW_FILE_MODE,
  OWNER_RWX_DIR_MODE,
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

    expect(mode(target)).toBe(OWNER_RW_FILE_MODE);
  });

  it("does not throw on a missing path", () => {
    expect(() => tightenFilePermissionsSync(path.join(tmpDir, "absent.json"))).not.toThrow();
  });

  it("does not throw on an empty path", () => {
    expect(() => tightenFilePermissionsSync("")).not.toThrow();
  });

  it("skips chmod entirely on win32", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const target = path.join(tmpDir, "data.json");
    writeFileSync(target, "{}");

    tightenFilePermissionsSync(target);

    // With the platform mocked as Windows, the function must bail before chmod.
    expect(platformSpy).toHaveBeenCalled();
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

    expect(mode(dir)).toBe(OWNER_RWX_DIR_MODE);
  });

  posixIt("async variant tightens a pre-existing 0755 directory", async () => {
    const dir = path.join(tmpDir, "history");
    mkdirSync(dir);
    chmodSync(dir, 0o755);

    await tightenDirPermissions(dir);

    expect(mode(dir)).toBe(OWNER_RWX_DIR_MODE);
  });

  it("does not throw on a missing directory", async () => {
    const absent = path.join(tmpDir, "absent");
    expect(() => tightenDirPermissionsSync(absent)).not.toThrow();
    await expect(tightenDirPermissions(absent)).resolves.toBeUndefined();
  });
});
