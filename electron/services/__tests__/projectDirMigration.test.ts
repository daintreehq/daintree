import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ensureDaintreeDirMigrated } from "../projectDirMigration.js";

async function mkProject(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("ensureDaintreeDirMigrated", () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkProject("daintree-migration-");
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it("renames .canopy to .daintree when only legacy dir exists", async () => {
    const canopyDir = path.join(projectPath, ".canopy");
    await fs.mkdir(canopyDir);
    await fs.writeFile(path.join(canopyDir, "project.json"), '{"version":1}');

    await ensureDaintreeDirMigrated(projectPath);

    const daintreeDir = path.join(projectPath, ".daintree");
    await expect(fs.access(daintreeDir)).resolves.toBeUndefined();
    await expect(fs.access(canopyDir)).rejects.toThrow();
    const content = await fs.readFile(path.join(daintreeDir, "project.json"), "utf-8");
    expect(content).toBe('{"version":1}');
  });

  it("no-ops when .daintree already exists", async () => {
    const daintreeDir = path.join(projectPath, ".daintree");
    const canopyDir = path.join(projectPath, ".canopy");
    await fs.mkdir(daintreeDir);
    await fs.writeFile(path.join(daintreeDir, "new.json"), "new");
    await fs.mkdir(canopyDir);
    await fs.writeFile(path.join(canopyDir, "old.json"), "old");

    // Use a distinct path so the module's per-process cache doesn't skip this test.
    await ensureDaintreeDirMigrated(projectPath);

    await expect(fs.access(path.join(daintreeDir, "new.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(canopyDir, "old.json"))).resolves.toBeUndefined();
  });

  it("no-ops when neither dir exists", async () => {
    await ensureDaintreeDirMigrated(projectPath);
    await expect(fs.access(path.join(projectPath, ".daintree"))).rejects.toThrow();
  });

  it("refuses to migrate a symlink", async () => {
    const canopyPath = path.join(projectPath, ".canopy");
    const targetDir = path.join(projectPath, "elsewhere");
    await fs.mkdir(targetDir);
    await fs.symlink(targetDir, canopyPath);

    await ensureDaintreeDirMigrated(projectPath);

    const stat = await fs.lstat(canopyPath);
    expect(stat.isSymbolicLink()).toBe(true);
    await expect(fs.access(path.join(projectPath, ".daintree"))).rejects.toThrow();
  });
});
