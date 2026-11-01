import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Real git: the other FileSearchService suites stub the listing, so none of them
// can tell a successful empty `ls-files` apart from a non-repository failure.

const LS_FILES = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];

const roots: string[] = [];
const services: Array<{ dispose: () => void }> = [];
let root: string;
let home: string;

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: path.dirname(root),
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: fixtureEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFile(filePath: string, content = "x"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "repo@example.com");
  git(dir, "config", "user.name", "Repo Owner");
  git(dir, "config", "commit.gpgsign", "false");
}

async function createService() {
  const { FileSearchService } = await import("../FileSearchService.js");
  const service = new FileSearchService();
  services.push(service);
  return service;
}

beforeEach(() => {
  vi.resetModules();
  // The Windows temp directory can use an 8.3 alias that git expands.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-filesearch-")));
  roots.push(root);
  home = path.join(root, "home");
  fs.mkdirSync(home);
  // The service spawns git with the process env, so keep the developer's
  // config out and stop discovery from climbing past the fixture root.
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CEILING_DIRECTORIES", path.dirname(root));
});

afterEach(() => {
  for (const service of services) service.dispose();
  services.length = 0;
  vi.unstubAllEnvs();
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  roots.length = 0;
});

describe("FileSearchService against real git", () => {
  it("lists nothing from a fully ignored subtree of a repository", async () => {
    const repo = path.join(root, "repo");
    makeRepo(repo);
    writeFile(path.join(repo, ".gitignore"), "/ignored/\n");
    writeFile(path.join(repo, "tracked.ts"));
    writeFile(path.join(repo, "ignored", "private.txt"));
    writeFile(path.join(repo, "ignored", "nested", ".env.local"));
    git(repo, "add", ".gitignore", "tracked.ts");
    git(repo, "commit", "-q", "-m", "init");

    const ignoredDir = path.join(repo, "ignored");
    // The precondition this case exists for: git succeeds and answers empty.
    expect(git(ignoredDir, ...LS_FILES)).toBe("");

    const service = await createService();
    await expect(service.listFiles(ignoredDir)).resolves.toEqual([]);
    await expect(service.search({ cwd: ignoredDir, query: "private" })).resolves.toEqual([]);
    await expect(
      service.searchNaturalLanguage({ cwd: ignoredDir, description: "private" })
    ).resolves.toEqual([]);
  });

  it("hides the same ignored files whether or not the subtree holds a tracked file", async () => {
    const repo = path.join(root, "repo");
    makeRepo(repo);
    writeFile(path.join(repo, ".gitignore"), "*.secret\n");
    writeFile(path.join(repo, "mixed", "tracked.ts"));
    writeFile(path.join(repo, "mixed", "key.secret"));
    writeFile(path.join(repo, "only-ignored", "key.secret"));
    git(repo, "add", ".gitignore", "mixed/tracked.ts");
    git(repo, "commit", "-q", "-m", "init");

    const service = await createService();
    await expect(service.listFiles(path.join(repo, "mixed"))).resolves.toEqual(["tracked.ts"]);
    await expect(service.listFiles(path.join(repo, "only-ignored"))).resolves.toEqual([]);
  });

  it("lists untracked, unignored files beside ignored ones in a subtree with nothing committed", async () => {
    const repo = path.join(root, "repo");
    makeRepo(repo);
    writeFile(path.join(repo, ".gitignore"), "*.log\n");
    writeFile(path.join(repo, "scratch", "notes.md"));
    writeFile(path.join(repo, "scratch", "run.log"));

    const service = await createService();
    await expect(service.listFiles(path.join(repo, "scratch"))).resolves.toEqual(["notes.md"]);
  });

  // Deliberate: git can't tell an ignored generated folder from an unrelated
  // project that a home-directory repository happens to cover with `*`, so both
  // get git's answer rather than a walker that would list every ignored name.
  it("lists nothing from a folder that a parent repository ignores with `*`", async () => {
    const outer = path.join(root, "outer");
    makeRepo(outer);
    writeFile(path.join(outer, ".gitignore"), "*\n");
    const project = path.join(outer, "project");
    writeFile(path.join(project, "src", "main.ts"));

    expect(git(project, ...LS_FILES)).toBe("");

    const service = await createService();
    await expect(service.listFiles(project)).resolves.toEqual([]);
  });

  it("still lists an independent repository nested under an ignoring parent", async () => {
    const outer = path.join(root, "outer");
    makeRepo(outer);
    writeFile(path.join(outer, ".gitignore"), "*\n");
    const inner = path.join(outer, "inner");
    makeRepo(inner);
    writeFile(path.join(inner, ".gitignore"), "*.log\n");
    writeFile(path.join(inner, "src", "main.ts"));
    // Only git hides this, so seeing it missing proves the inner repository's
    // listing answered rather than the walker.
    writeFile(path.join(inner, "src", "debug.log"));
    expect(path.normalize(git(inner, "rev-parse", "--show-toplevel").trim())).toBe(inner);

    const service = await createService();
    const files = await service.listFiles(inner);
    expect([...files].sort()).toEqual([".gitignore", "src/", "src/main.ts"]);
  });

  it("falls back to the disk walker in a directory outside any repository", async () => {
    const plain = path.join(root, "plain");
    writeFile(path.join(plain, "a.txt"));
    writeFile(path.join(plain, "sub", "b.txt"));
    writeFile(path.join(plain, "node_modules", "dep", "index.js"));

    // The precondition this case exists for: git fails rather than answering.
    const probe = spawnSync("git", LS_FILES, { cwd: plain, env: fixtureEnv(), encoding: "utf8" });
    expect(probe.status).toBe(128);
    expect(probe.stdout).toBe("");
    expect(probe.stderr).toMatch(/not a git repository/i);

    const service = await createService();
    const files = await service.listFiles(plain);
    expect([...files].sort()).toEqual(["a.txt", "sub/", "sub/b.txt"]);
    await expect(service.search({ cwd: plain, query: "b.txt" })).resolves.toEqual(["sub/b.txt"]);
  });

  it("lists a path with several unmerged index stages once", async () => {
    const project = path.join(root, "conflict");
    makeRepo(project);
    writeFile(path.join(project, "dir", "c.txt"), "base\n");
    writeFile(path.join(project, "other.txt"));
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "base");
    git(project, "checkout", "-q", "-b", "side");
    writeFile(path.join(project, "dir", "c.txt"), "theirs\n");
    git(project, "commit", "-q", "-am", "side");
    git(project, "checkout", "-q", "main");
    writeFile(path.join(project, "dir", "c.txt"), "ours\n");
    git(project, "commit", "-q", "-am", "main");
    expect(spawnSync("git", ["merge", "side"], { cwd: project, env: fixtureEnv() }).status).toBe(1);

    const raw = git(project, ...LS_FILES).split("\0");
    expect(raw.filter((f) => f === "dir/c.txt")).toHaveLength(3);

    const service = await createService();
    const files = await service.listFiles(project);
    expect(files.filter((f) => f === "dir/c.txt")).toHaveLength(1);
    expect(files.filter((f) => f === "dir/")).toHaveLength(1);
    await expect(service.search({ cwd: project, query: "c.txt" })).resolves.toEqual(["dir/c.txt"]);
  });
});
