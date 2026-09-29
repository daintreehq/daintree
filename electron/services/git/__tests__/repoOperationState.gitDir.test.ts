import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGitDir } from "../repoOperationState.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let root: string;
let repo: string;
let linked: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-op-gitdir-")));
  repo = path.join(root, "main");
  linked = path.join(root, "linked");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, [
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=T",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  git(repo, ["worktree", "add", "-q", "-b", "topic", linked]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveGitDir — filesystem path", () => {
  it.each([
    ["a regular repository", () => repo],
    ["a linked worktree", () => linked],
  ])("resolves %s without spawning git, matching rev-parse", async (_label, cwd) => {
    const revparse = vi.fn();
    const expected = path.resolve(cwd(), git(cwd(), ["rev-parse", "--git-dir"]));

    const result = await resolveGitDir({ revparse } as never, cwd());

    expect(fs.realpathSync(result)).toBe(fs.realpathSync(expected));
    expect(revparse).not.toHaveBeenCalled();
  });

  it("falls back to rev-parse from a subdirectory the .git entry is not in", async () => {
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const revparse = vi.fn().mockResolvedValue("../.git\n");

    const result = await resolveGitDir({ revparse } as never, sub);

    expect(revparse).toHaveBeenCalledWith(["--git-dir"]);
    expect(result).toBe(path.join(repo, ".git"));
  });

  describe("with the repository relocated through the environment", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each(["GIT_DIR", "GIT_COMMON_DIR"])("defers to rev-parse while %s is set", async (key) => {
      vi.stubEnv(key, path.join(linked, "elsewhere.git"));
      const revparse = vi.fn().mockResolvedValue("/relocated.git\n");

      const result = await resolveGitDir({ revparse } as never, repo);

      expect(revparse).toHaveBeenCalledWith(["--git-dir"]);
      expect(result).toBe("/relocated.git");
    });
  });

  it("defers a relative gitfile under a symlinked path to rev-parse", async () => {
    const real = path.join(root, "rel-real");
    const decoy = path.join(root, "alias-parent");
    fs.mkdirSync(path.join(real, "checkout"), { recursive: true });
    fs.mkdirSync(path.join(real, "gd"), { recursive: true });
    fs.writeFileSync(path.join(real, "gd", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(real, "checkout", ".git"), "gitdir: ../gd\n");
    // A decoy git dir exactly where the literal join through the link lands.
    fs.mkdirSync(path.join(decoy, "gd"), { recursive: true });
    fs.writeFileSync(path.join(decoy, "gd", "HEAD"), "ref: refs/heads/main\n");
    fs.symlinkSync(path.join(real, "checkout"), path.join(decoy, "checkout"));
    const revparse = vi.fn().mockResolvedValue(`${path.join(real, "gd")}\n`);

    const result = await resolveGitDir({ revparse } as never, path.join(decoy, "checkout"));

    expect(revparse).toHaveBeenCalledWith(["--git-dir"]);
    expect(result).toBe(path.join(real, "gd"));
  });
});
