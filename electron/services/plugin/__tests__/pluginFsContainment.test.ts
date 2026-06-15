import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { resolveContainedPath, PluginPathNotAllowedError } from "../pluginFsContainment.js";

describe("resolveContainedPath", () => {
  let root: string;
  let allowed: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-contain-"));
    allowed = path.join(root, "allowed");
    await fs.mkdir(allowed, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves a path inside an allowed root", async () => {
    const target = path.join(allowed, "file.txt");
    await fs.writeFile(target, "x");
    const resolved = await resolveContainedPath("p", target, [allowed]);
    // The realpath of the temp dir may differ (macOS /var → /private/var), so
    // assert containment by relationship rather than string equality.
    const rel = path.relative(await fs.realpath(allowed), resolved);
    expect(rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))).toBe(true);
  });

  it("resolves a not-yet-existent write target inside an allowed root", async () => {
    const target = path.join(allowed, "nested", "new.txt");
    // The parent doesn't exist yet; containment must still resolve it.
    const resolved = await resolveContainedPath("p", target, [allowed]);
    expect(path.basename(resolved)).toBe("new.txt");
  });

  it("rejects a traversal that escapes the allowed root", async () => {
    const escape = path.join(allowed, "..", "secret.txt");
    await expect(resolveContainedPath("p", escape, [allowed])).rejects.toBeInstanceOf(
      PluginPathNotAllowedError
    );
  });

  it("rejects a path entirely outside every allowed root", async () => {
    const outside = path.join(root, "elsewhere", "file.txt");
    await expect(resolveContainedPath("p", outside, [allowed])).rejects.toBeInstanceOf(
      PluginPathNotAllowedError
    );
  });

  it("rejects a symlink whose target escapes the allowed root", async () => {
    // A symlink LIVING inside the allowed root but POINTING outside must be
    // rejected — realpath resolution is the defense, not the link's location.
    const secretDir = path.join(root, "secret");
    await fs.mkdir(secretDir, { recursive: true });
    const secretFile = path.join(secretDir, "creds.txt");
    await fs.writeFile(secretFile, "TOPSECRET");

    const link = path.join(allowed, "escape-link");
    await fs.symlink(secretFile, link);

    await expect(resolveContainedPath("p", link, [allowed])).rejects.toBeInstanceOf(
      PluginPathNotAllowedError
    );
  });

  it("rejects a DANGLING symlink leaf pointing outside (write-escape vector)", async () => {
    // A symlink inside the allowed root whose target does NOT exist yet: realpath
    // throws, so without the lstat guard the lexical nearest-ancestor path would
    // contain it and a subsequent writeFile would follow the link and CREATE the
    // out-of-scope target. Must be rejected.
    const outsideTarget = path.join(root, "outside", "planted.txt");
    const link = path.join(allowed, "dangling-link");
    await fs.symlink(outsideTarget, link);
    await expect(resolveContainedPath("p", link, [allowed])).rejects.toBeInstanceOf(
      PluginPathNotAllowedError
    );
  });

  it("rejects a path traversing a dangling INTERMEDIATE symlink dir", async () => {
    // /allowed/linkdir -> /root/outside-missing (a dir that doesn't exist yet).
    // A write to /allowed/linkdir/new.txt must NOT be contained lexically: once
    // the link target is created, writeFile would escape scope through it.
    const link = path.join(allowed, "linkdir");
    await fs.symlink(path.join(root, "outside-missing"), link);
    const target = path.join(link, "new.txt");
    await expect(resolveContainedPath("p", target, [allowed])).rejects.toBeInstanceOf(
      PluginPathNotAllowedError
    );
  });

  it("accepts an in-root symlink that points to an in-root target", async () => {
    const realTarget = path.join(allowed, "real.txt");
    await fs.writeFile(realTarget, "ok");
    const link = path.join(allowed, "alias.txt");
    await fs.symlink(realTarget, link);
    const resolved = await resolveContainedPath("p", link, [allowed]);
    expect(path.basename(resolved)).toBe("real.txt");
  });

  it("rejects a relative path (no anchor)", async () => {
    await expect(resolveContainedPath("p", "relative/file.txt", [allowed])).rejects.toBeInstanceOf(
      PluginPathNotAllowedError
    );
  });

  it("rejects a NUL byte in the path", async () => {
    await expect(
      resolveContainedPath("p", path.join(allowed, "a\0b"), [allowed])
    ).rejects.toBeInstanceOf(PluginPathNotAllowedError);
  });

  it("rejects every path when allowedPaths is empty", async () => {
    const target = path.join(allowed, "file.txt");
    await fs.writeFile(target, "x");
    await expect(resolveContainedPath("p", target, [])).rejects.toBeInstanceOf(
      PluginPathNotAllowedError
    );
  });
});
