import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../../../utils/logger.js", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { repairMovedSubmodulePaths } from "../submodulePathRepair.js";

const OLD = "/old/project";

describe("repairMovedSubmodulePaths", () => {
  let newRoot: string;

  beforeEach(async () => {
    newRoot = await mkdtemp(path.join(os.tmpdir(), "submod-repair-"));
    await mkdir(path.join(newRoot, ".git"), { recursive: true });
  });

  afterEach(async () => {
    await rm(newRoot, { recursive: true, force: true });
  });

  async function writeModuleConfig(rel: string, worktreeValue: string): Promise<string> {
    const file = path.join(newRoot, ".git", rel, "config");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${worktreeValue}\n`,
      "utf-8"
    );
    return file;
  }

  async function writeGitlink(checkoutRel: string, gitdirValue: string): Promise<string> {
    const dir = path.join(newRoot, checkoutRel);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, ".git");
    await writeFile(file, `gitdir: ${gitdirValue}\n`, "utf-8");
    return file;
  }

  it("rebases an absolute core.worktree and absolute gitlink pointer under the old root", async () => {
    const config = await writeModuleConfig("modules/lib", "/old/project/vendor/lib");
    const gitlink = await writeGitlink("vendor/lib", "/old/project/.git/modules/lib");

    await repairMovedSubmodulePaths(OLD, newRoot);

    expect(await readFile(config, "utf-8")).toContain(`worktree = ${newRoot}/vendor/lib`);
    expect(await readFile(gitlink, "utf-8")).toBe(`gitdir: ${newRoot}/.git/modules/lib\n`);
  });

  it("leaves relative pointers byte-for-byte unchanged", async () => {
    const config = await writeModuleConfig("modules/lib", "../../../vendor/lib");
    const gitlink = await writeGitlink("vendor/lib", "../.git/modules/lib");
    const configBefore = await readFile(config, "utf-8");
    const gitlinkBefore = await readFile(gitlink, "utf-8");

    await repairMovedSubmodulePaths(OLD, newRoot);

    expect(await readFile(config, "utf-8")).toBe(configBefore);
    expect(await readFile(gitlink, "utf-8")).toBe(gitlinkBefore);
  });

  it("does not touch a sibling that merely shares the old-root prefix", async () => {
    const config = await writeModuleConfig("modules/lib", "/old/project-copy/vendor/lib");
    const before = await readFile(config, "utf-8");

    await repairMovedSubmodulePaths(OLD, newRoot);

    expect(await readFile(config, "utf-8")).toBe(before);
  });

  it("rebases a quoted core.worktree containing spaces, keeping it quoted", async () => {
    const config = await writeModuleConfig("modules/lib", '"/old/project/my vendor/lib"');

    await repairMovedSubmodulePaths(OLD, newRoot);

    expect(await readFile(config, "utf-8")).toContain(`worktree = "${newRoot}/my vendor/lib"`);
  });

  it("repairs a submodule owned by a linked worktree (worktrees/<id>/modules)", async () => {
    const config = await writeModuleConfig("worktrees/wt1/modules/lib", "/old/project/vendor/lib");

    await repairMovedSubmodulePaths(OLD, newRoot);

    expect(await readFile(config, "utf-8")).toContain(`worktree = ${newRoot}/vendor/lib`);
  });

  it("keeps repairing other modules when one config is malformed, and never throws", async () => {
    await writeFile(
      path.join(newRoot, ".git", "modules", "broken", "config"),
      "not an ini at all",
      "utf-8"
    ).catch(() => {});
    await mkdir(path.join(newRoot, ".git", "modules", "broken"), { recursive: true });
    await writeFile(path.join(newRoot, ".git", "modules", "broken", "config"), "\x00\x00garbage");
    const good = await writeModuleConfig("modules/good", "/old/project/vendor/good");

    await expect(repairMovedSubmodulePaths(OLD, newRoot)).resolves.toBeUndefined();

    expect(await readFile(good, "utf-8")).toContain(`worktree = ${newRoot}/vendor/good`);
  });

  it("preserves CRLF line endings when rewriting the config", async () => {
    const file = path.join(newRoot, ".git", "modules", "lib", "config");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `[core]\r\n\tworktree = /old/project/vendor/lib\r\n`, "utf-8");

    await repairMovedSubmodulePaths(OLD, newRoot);

    const out = await readFile(file, "utf-8");
    expect(out).toBe(`[core]\r\n\tworktree = ${newRoot}/vendor/lib\r\n`);
  });

  it("is a no-op when old and new roots are equal or empty", async () => {
    const config = await writeModuleConfig("modules/lib", "/old/project/vendor/lib");
    const before = await readFile(config, "utf-8");

    await repairMovedSubmodulePaths(OLD, OLD);
    await repairMovedSubmodulePaths("", newRoot);

    expect(await readFile(config, "utf-8")).toBe(before);
  });
});
