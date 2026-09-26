import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../../../../shared/types/project.js";
import { findRegisteredMatches, hostProjectsDir, scanForClones, scanRoots } from "../matcher.js";
import { parseConfigRemotes } from "../gitOps.js";
import { git, makeRepo, tempRoot } from "./gitFixtures.js";

let root: string;

beforeAll(() => {
  root = tempRoot("pah-match-");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function project(id: string, projectPath: string, lastOpened: number): Project {
  return { id, path: projectPath, name: path.basename(projectPath), emoji: "🌲", lastOpened };
}

const remotesByPath = new Map<string, Array<{ name: string; url: string }>>();
const lister = async (repoPath: string) => remotesByPath.get(repoPath) ?? [];

describe("findRegisteredMatches", () => {
  it("matches any remote against any remote, across SSH and HTTPS, most recent first", async () => {
    remotesByPath.set("/p/upstream-clone", [
      { name: "origin", url: "https://github.com/daintreehq/daintree.git" },
    ]);
    remotesByPath.set("/p/fork-clone", [
      { name: "origin", url: "git@github.com:greg/daintree.git" },
      { name: "upstream", url: "git@github.com:daintreehq/daintree.git" },
    ]);
    remotesByPath.set("/p/other", [{ name: "origin", url: "git@github.com:greg/other.git" }]);
    const projects = [
      project("a", "/p/upstream-clone", 100),
      project("b", "/p/fork-clone", 200),
      project("c", "/p/other", 300),
    ];
    const candidates = await findRegisteredMatches(
      {
        remoteUrls: ["git@github.com:greg/daintree.git", "https://github.com/DaintreeHQ/daintree"],
        committedProjectId: null,
      },
      { listProjects: () => projects, readCommittedProjectId: async () => null },
      lister
    );
    expect(candidates.map((c) => c.projectId)).toEqual(["b", "a"]);
    expect(candidates.every((c) => c.matchedBy === "remote-url")).toBe(true);
    expect(candidates[0]!.remotes).toHaveLength(2);
  });

  it("keeps a committed-id match as a candidate only, after every remote match", async () => {
    remotesByPath.set("/p/same-remote", [{ name: "origin", url: "git@github.com:a/b.git" }]);
    remotesByPath.set("/p/same-id", [{ name: "origin", url: "git@github.com:x/y.git" }]);
    const projects = [project("id-only", "/p/same-id", 999), project("url", "/p/same-remote", 1)];
    const candidates = await findRegisteredMatches(
      { remoteUrls: ["https://github.com/a/b"], committedProjectId: "committed-123" },
      {
        listProjects: () => projects,
        readCommittedProjectId: async (p) => (p === "/p/same-id" ? "committed-123" : null),
      },
      lister
    );
    expect(candidates.map((c) => [c.projectId, c.matchedBy])).toEqual([
      ["url", "remote-url"],
      ["id-only", "committed-id"],
    ]);
  });

  it("finds nothing for unrelated remotes and skips folders that aren't git-backed", async () => {
    const projects = [{ ...project("plain", "/p/same-remote", 1), gitBacked: false }];
    const candidates = await findRegisteredMatches(
      { remoteUrls: ["git@github.com:a/b.git"], committedProjectId: null },
      { listProjects: () => projects, readCommittedProjectId: async () => null },
      lister
    );
    expect(candidates).toEqual([]);
  });
});

describe("scanForClones", () => {
  it("finds unregistered clones up to two levels down by their git config", async () => {
    const scan = path.join(root, "scan");
    makeRepo(scan, "direct", "git@github.com:a/b.git");
    makeRepo(path.join(scan, "group"), "nested", "https://github.com/a/b");
    makeRepo(path.join(scan, "x", "y"), "too-deep", "git@github.com:a/b.git");
    makeRepo(scan, "unrelated", "git@github.com:a/c.git");
    const registered = makeRepo(scan, "registered", "git@github.com:a/b.git");
    // A linked worktree's `.git` is a file; its repository is elsewhere.
    git(path.join(scan, "direct"), [
      "worktree",
      "add",
      "-q",
      path.join(scan, "linked"),
      "-b",
      "wt",
    ]);

    const found = await scanForClones(
      ["git@github.com:A/B.git"],
      [scan],
      new Set([path.resolve(registered)])
    );
    expect(found.map((c) => path.relative(scan, c.path)).sort()).toEqual([
      "direct",
      path.join("group", "nested"),
    ]);
    expect(found.every((c) => c.source === "on-disk" && c.projectId === null)).toBe(true);
  });

  it("does nothing without a remote to look for", async () => {
    expect(await scanForClones([], [root], new Set())).toEqual([]);
  });
});

describe("projects folder", () => {
  it("is where most registered projects live, else ~/Projects, never walking home itself", async () => {
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "Projects"), { recursive: true });
    const none = { listProjects: () => [], homeDir: () => home };
    expect(await hostProjectsDir(none)).toBe(path.join(home, "Projects"));

    const many = {
      listProjects: () => [
        project("1", path.join(home, "code", "a"), 1),
        project("2", path.join(home, "code", "b"), 1),
        project("3", path.join(home, "c"), 1),
      ],
      homeDir: () => home,
    };
    expect(await hostProjectsDir(many)).toBe(path.join(home, "code"));
    expect(await scanRoots(many)).toEqual([path.join(home, "code")]);
  });
});

describe("parseConfigRemotes", () => {
  it("reads remote urls from a git config", () => {
    const config = [
      "[core]",
      "\trepositoryformatversion = 0",
      '[remote "origin"]',
      "\turl = git@github.com:a/b.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[remote "up stream"]',
      '\turl = "https://github.com/c/d"',
      '[branch "main"]',
      "\tremote = origin",
    ].join("\n");
    expect(parseConfigRemotes(config)).toEqual([
      { name: "origin", url: "git@github.com:a/b.git" },
      { name: "up stream", url: "https://github.com/c/d" },
    ]);
  });
});
