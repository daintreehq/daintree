import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { GitPluginError } from "simple-git";
import { createBoundRepositoryGit, createContinueGit, createHardenedGit } from "../hardenedGit.js";

// Real git through the real simple-git: every other hardenedGit suite mocks
// simple-git, so none of them can see its environment guard or argv scanner
// rejecting a profile at spawn time.

const require = createRequire(import.meta.url);
const cjsCp = require("child_process") as typeof import("child_process");
const realSpawn = cjsCp.spawn;

const roots: string[] = [];

/** Fixture git, isolated from both the developer's config and the wrapper. */
function fixtureEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: fixtureEnv(home),
    encoding: "utf8",
    // The conflicting rebase and merge below fail on purpose.
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-realgit-")));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "repo@example.com");
  git(dir, "config", "user.name", "Repo Owner");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
  git(dir, "add", "file.txt");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** Every env handed to a spawned git, forwarded unchanged to the real spawn. */
function captureSpawnEnvs(): NodeJS.ProcessEnv[] {
  const envs: NodeJS.ProcessEnv[] = [];
  vi.spyOn(cjsCp, "spawn").mockImplementation(((...args: Parameters<typeof cjsCp.spawn>) => {
    const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
    if (options?.env) envs.push({ ...options.env });
    return (realSpawn as (...a: unknown[]) => ReturnType<typeof cjsCp.spawn>)(...args);
  }) as typeof cjsCp.spawn);
  // simple-git's ESM build binds `spawn` as a named import.
  syncBuiltinESMExports();
  return envs;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-realgit-home-")));
  roots.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("hardened profile against real git", () => {
  it("runs status, add and commit with hostile git variables inherited", async () => {
    const repo = makeRepo();
    const elsewhere = makeRepo();
    // Each of these would either redirect git or be refused by simple-git's
    // environment guard if the wrapper handed it through.
    vi.stubEnv("GIT_DIR", path.join(elsewhere, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", path.join(elsewhere, "index"));
    vi.stubEnv("GIT_EDITOR", "false");
    vi.stubEnv("GIT_PAGER", "false");

    fs.writeFileSync(path.join(repo, "file.txt"), "changed\n");
    const hardened = await createHardenedGit(repo);

    expect((await hardened.status()).modified).toEqual(["file.txt"]);
    await hardened.add(["file.txt"]);
    await hardened.commit("change");

    expect(git(repo, "log", "-1", "--format=%s")).toBe("change");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(elsewhere, "log", "-1", "--format=%s")).toBe("base");
  });

  it("hands git its hardening variables and none of the inherited git ones", async () => {
    const repo = makeRepo();
    vi.stubEnv("GIT_TRACE", "/dev/null");
    vi.stubEnv("Git_Work_Tree", "/somewhere/else");
    const envs = captureSpawnEnvs();

    await (await createHardenedGit(repo)).status();

    expect(envs).toHaveLength(1);
    const env = envs[0];
    expect(env.GIT_LITERAL_PATHSPECS).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS).toBe("true");
    expect(env.GIT_TRACE).toBeUndefined();
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "git_work_tree")).toEqual([]);
  });

  it("keeps an inherited author identity, which only labels the commit", async () => {
    const repo = makeRepo();
    vi.stubEnv("GIT_AUTHOR_NAME", "Inherited Author");
    fs.writeFileSync(path.join(repo, "file.txt"), "changed\n");

    const hardened = await createHardenedGit(repo);
    await hardened.add(["file.txt"]);
    await hardened.commit("change");

    expect(git(repo, "log", "-1", "--format=%an")).toBe("Inherited Author");
  });

  it("rejects an abbreviated long option instead of letting git expand it", async () => {
    const repo = makeRepo();

    await expect((await createHardenedGit(repo)).raw(["status", "--porc"])).rejects.toMatchObject({
      reason: "DISALLOWED_ABBREVIATED",
    });
  });

  it("refuses to bind another repository, which only the bound profile may do", async () => {
    const repo = makeRepo();
    const gitDir = path.join(repo, ".git");
    const head = git(repo, "rev-parse", "HEAD");

    await expect(
      (await createHardenedGit(repo)).raw(["--git-dir", gitDir, "rev-parse", "HEAD"])
    ).rejects.toBeInstanceOf(GitPluginError);
    expect(
      (
        await (await createBoundRepositoryGit(repo)).raw(["--git-dir", gitDir, "rev-parse", "HEAD"])
      ).trim()
    ).toBe(head);
  });
});

describe("continue profile against real git", () => {
  it("finishes a conflicted rebase without opening an editor", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "topic");
    fs.writeFileSync(path.join(repo, "file.txt"), "topic\n");
    git(repo, "commit", "-q", "-am", "topic change");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "file.txt"), "main\n");
    git(repo, "commit", "-q", "-am", "main change");
    git(repo, "checkout", "-q", "topic");
    expect(() => git(repo, "rebase", "main")).toThrow();

    fs.writeFileSync(path.join(repo, "file.txt"), "resolved\n");
    git(repo, "add", "file.txt");
    // An editor that fails would abort the continue if git ever reached it.
    vi.stubEnv("GIT_EDITOR", "false");
    vi.stubEnv("EDITOR", "false");
    vi.stubEnv("VISUAL", "false");

    await (await createContinueGit(repo)).rebase(["--continue"]);

    expect(fs.existsSync(path.join(repo, ".git", "rebase-merge"))).toBe(false);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("topic change");
    expect(git(repo, "show", "HEAD:file.txt")).toBe("resolved");
  });

  it("finishes a conflicted merge with git's own message", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "topic");
    fs.writeFileSync(path.join(repo, "file.txt"), "topic\n");
    git(repo, "commit", "-q", "-am", "topic change");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "file.txt"), "main\n");
    git(repo, "commit", "-q", "-am", "main change");
    expect(() => git(repo, "merge", "topic")).toThrow();

    fs.writeFileSync(path.join(repo, "file.txt"), "resolved\n");
    git(repo, "add", "file.txt");
    vi.stubEnv("GIT_EDITOR", "false");

    await (await createContinueGit(repo)).merge(["--continue"]);

    expect(git(repo, "rev-list", "--count", "--merges", "HEAD")).toBe("1");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("is the only profile allowed to name an editor", async () => {
    const repo = makeRepo();

    await expect(
      (await createHardenedGit(repo)).env({ ...process.env, GIT_EDITOR: "true" }).status()
    ).rejects.toBeInstanceOf(GitPluginError);
  });
});
