import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ReviewComparisonFile,
  ReviewComparisonResult,
} from "../../../../../shared/types/reviewComparison.js";
import type { ReviewPoint } from "../../../../../shared/types/reviewPoint.js";
import { captureReviewPoint, type CaptureReviewPointOptions } from "../captureReviewPoint.js";
import { compareReviewPoint, type CompareReviewPointOptions } from "../compareReviewPoint.js";

// Real repositories throughout, like the capture's own tests: the comparison is
// only as good as what git actually reports after each kind of history change.

const posixOnly = process.platform === "win32" ? it.skip : it;

let root: string;

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
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

function write(repo: string, relative: string, content: string | Buffer): void {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [relative, content] of Object.entries(files)) write(repo, relative, content);
  git(repo, "add", ...Object.keys(files));
  git(repo, "commit", "-q", "-m", message);
  return head(repo);
}

function head(repo: string): string {
  return git(repo, "rev-parse", "HEAD").trim();
}

let repoCount = 0;

/** `main` with three files, and `topic` checked out on top of it with one commit. */
function topicRepo(): string {
  const repo = path.join(root, `repo-${++repoCount}`);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  commit(repo, "base", { "a.txt": "a\n", "b.txt": "b\n", "g.txt": "g\n" });
  git(repo, "checkout", "-q", "-b", "topic");
  commit(repo, "topic edits a", { "a.txt": "a topic\n" });
  return repo;
}

/** Drops every reference to unreachable commits, then the commits themselves. */
function collectGarbage(repo: string): void {
  fs.rmSync(path.join(repo, ".git", "ORIG_HEAD"), { force: true });
  git(repo, "reflog", "expire", "--expire=now", "--all");
  git(repo, "gc", "-q", "--prune=now");
}

function exists(repo: string, oid: string): boolean {
  try {
    git(repo, "cat-file", "-e", `${oid}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

async function review(
  repo: string,
  options: Partial<CaptureReviewPointOptions> = {}
): Promise<ReviewPoint> {
  const result = await captureReviewPoint(repo, {
    base: { kind: "ref", ref: "refs/heads/main" },
    ...options,
  });
  if (result.kind !== "captured") throw new Error(`Expected a point: ${JSON.stringify(result)}`);
  // What a stored mark looks like by the time it's compared.
  return JSON.parse(JSON.stringify(result.point)) as ReviewPoint;
}

type Compared = Extract<
  ReviewComparisonResult,
  { state: "comparable" | "reviewed-commit-missing" | "incomplete" }
>;

async function compareNow(
  repo: string,
  point: ReviewPoint,
  options: CompareReviewPointOptions = {}
): Promise<Compared> {
  const result = await compareReviewPoint(repo, point, options);
  if (
    result.state !== "comparable" &&
    result.state !== "reviewed-commit-missing" &&
    result.state !== "incomplete"
  ) {
    throw new Error(`Expected a comparison: ${JSON.stringify(result)}`);
  }
  return result;
}

function summary(result: Compared): Record<string, Partial<ReviewComparisonFile>> {
  return Object.fromEntries(
    result.files.map((file) => [
      file.path,
      {
        status: file.status,
        index: file.index,
        worktree: file.worktree,
        baseUpdate: file.baseUpdate,
      },
    ])
  );
}

function commitsOf(result: Compared): Array<{ subject: string; kind: string }> {
  if (result.commits.kind !== "listed") throw new Error("Expected listed commits");
  return result.commits.commits.map(({ subject, kind }) => ({ subject, kind }));
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const record = (full: string) => {
    const stats = fs.lstatSync(full, { bigint: true });
    const digest = stats.isFile()
      ? createHash("sha1").update(fs.readFileSync(full)).digest("hex")
      : "";
    out.set(full, [stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, digest].join(":"));
    if (stats.isDirectory()) {
      for (const name of fs.readdirSync(full)) record(path.join(full, name));
    }
  };
  record(dir);
  return out;
}

const MODIFIED_TREE = { status: "modified", index: "unchanged", worktree: "changed" } as const;
const MODIFIED_BOTH = { status: "modified", index: "changed", worktree: "changed" } as const;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-review-compare-")));
  vi.stubEnv("HOME", root);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("compareReviewPoint", () => {
  it("says nothing changed only when nothing did", async () => {
    const repo = topicRepo();
    write(repo, "b.txt", "dirty\n");
    const point = await review(repo);

    const result = await compareNow(repo, point);

    expect(result.state).toBe("comparable");
    expect(result.files).toEqual([]);
    expect(result.commits).toEqual({
      kind: "listed",
      history: "extended",
      commits: [],
      truncated: false,
    });
  });

  it("lists linear new commits and the files they changed", async () => {
    const repo = topicRepo();
    const point = await review(repo);
    commit(repo, "edit b", { "b.txt": "b2\n" });
    const added = commit(repo, "add c", { "c.txt": "c\n" });

    const result = await compareNow(repo, point);

    expect(result.state).toBe("comparable");
    expect(summary(result)).toEqual({
      "b.txt": { ...MODIFIED_BOTH, baseUpdate: "none" },
      "c.txt": { status: "added", index: "changed", worktree: "changed", baseUpdate: "none" },
    });
    expect(commitsOf(result)).toEqual([
      { subject: "add c", kind: "new" },
      { subject: "edit b", kind: "new" },
    ]);
    if (result.commits.kind !== "listed") throw new Error("unreachable");
    expect(result.commits.history).toBe("extended");
    expect(result.commits.commits[0]).toMatchObject({
      oid: added,
      authorName: "T",
      authorEmail: "t@example.com",
    });
    // Each side carries what #14587 needs to show the reviewed version.
    const b = result.files.find((file) => file.path === "b.txt");
    expect(b?.reviewed).toEqual({
      kind: "unlisted",
      entry: { mode: "100644", oid: git(repo, "rev-parse", "main:b.txt").trim() },
    });
  });

  describe("an uncommitted edit reviewed and then committed unchanged", () => {
    it.each([
      ["unstaged", false],
      ["staged", true],
    ])("lists one new commit and no files when it was %s", async (_, staged) => {
      const repo = topicRepo();
      write(repo, "b.txt", "b edited\n");
      if (staged) git(repo, "add", "b.txt");
      const point = await review(repo);
      git(repo, "commit", "-q", "-am", "commit the edit");

      const result = await compareNow(repo, point);

      expect(result.state).toBe("comparable");
      expect(result.files).toEqual([]);
      expect(commitsOf(result)).toEqual([{ subject: "commit the edit", kind: "new" }]);
    });

    it("holds when git converts line endings, so raw bytes never match a blob", async () => {
      const repo = topicRepo();
      git(repo, "config", "core.autocrlf", "true");
      write(repo, "b.txt", "b edited\r\nsecond\r\n");
      const point = await review(repo);
      git(repo, "commit", "-q", "-am", "commit the edit");
      // The stored blob has LF endings, the file on disk still has CRLF.
      expect(git(repo, "cat-file", "-p", "HEAD:b.txt")).toBe("b edited\nsecond\n");

      const result = await compareNow(repo, point);

      expect(result.state).toBe("comparable");
      expect(result.files).toEqual([]);

      // A later change to the line endings alone is still a change to the bytes.
      write(repo, "b.txt", "b edited\nsecond\n");
      expect(summary(await compareNow(repo, point))["b.txt"]).toMatchObject({
        status: "modified",
        worktree: "changed",
      });
    });

    it("holds for a reviewed deletion later committed", async () => {
      const repo = topicRepo();
      fs.rmSync(path.join(repo, "b.txt"));
      const point = await review(repo);
      git(repo, "commit", "-q", "-am", "delete b");

      const result = await compareNow(repo, point);

      expect(result.files).toEqual([]);
      expect(commitsOf(result)).toEqual([{ subject: "delete b", kind: "new" }]);
    });
  });

  it("lists an index that now holds content no side held at review", async () => {
    const repo = topicRepo();
    write(repo, "b.txt", "reviewed\n");
    const point = await review(repo);
    write(repo, "b.txt", "never seen\n");
    git(repo, "add", "b.txt");
    write(repo, "b.txt", "reviewed\n");

    const result = await compareNow(repo, point);

    expect(summary(result)).toEqual({
      "b.txt": { status: "modified", index: "changed", worktree: "unchanged", baseUpdate: "none" },
    });
  });

  it("lists a dirty file edited again", async () => {
    const repo = topicRepo();
    write(repo, "b.txt", "first edit\n");
    const point = await review(repo);
    write(repo, "b.txt", "second edit\n");

    const result = await compareNow(repo, point);

    expect(summary(result)).toEqual({ "b.txt": { ...MODIFIED_TREE, baseUpdate: "none" } });
  });

  describe("staged and unstaged changes that cancel out", () => {
    it("lists a staged change the working tree undoes", async () => {
      const repo = topicRepo();
      const point = await review(repo);
      write(repo, "b.txt", "staged\n");
      git(repo, "add", "b.txt");
      write(repo, "b.txt", "b\n");

      const result = await compareNow(repo, point);

      expect(summary(result)).toEqual({
        "b.txt": {
          status: "modified",
          index: "changed",
          worktree: "unchanged",
          baseUpdate: "none",
        },
      });
    });

    it("lists nothing once the index holds what the working tree held at review", async () => {
      const repo = topicRepo();
      write(repo, "b.txt", "staged\n");
      git(repo, "add", "b.txt");
      write(repo, "b.txt", "b\n");
      const point = await review(repo);
      git(repo, "reset", "-q", "--", "b.txt");

      const result = await compareNow(repo, point);

      expect(result.files).toEqual([]);
    });
  });

  it("lists untracked files added, edited and removed", async () => {
    const repo = topicRepo();
    write(repo, "edited.txt", "one\n");
    write(repo, "removed.txt", "gone soon\n");
    write(repo, "kept.txt", "same\n");
    const point = await review(repo);
    write(repo, "edited.txt", "two\n");
    fs.rmSync(path.join(repo, "removed.txt"));
    write(repo, "added/new.txt", "new\n");

    const result = await compareNow(repo, point);

    expect(summary(result)).toEqual({
      "added/new.txt": {
        status: "added",
        index: "unchanged",
        worktree: "changed",
        baseUpdate: "none",
      },
      "edited.txt": { ...MODIFIED_TREE, baseUpdate: "none" },
      "removed.txt": {
        status: "deleted",
        index: "unchanged",
        worktree: "changed",
        baseUpdate: "none",
      },
    });
  });

  describe("rebase onto a moved base", () => {
    function moveMain(repo: string): void {
      git(repo, "checkout", "-q", "main");
      commit(repo, "main edits g", { "g.txt": "g on main\n" });
      git(repo, "checkout", "-q", "topic");
    }

    it("reports only the base's files, and the reviewed commit as patch-equivalent", async () => {
      const repo = topicRepo();
      const point = await review(repo);
      moveMain(repo);
      git(repo, "rebase", "-q", "main");

      const result = await compareNow(repo, point);

      expect(result.state).toBe("comparable");
      expect(summary(result)).toEqual({ "g.txt": { ...MODIFIED_BOTH, baseUpdate: "only" } });
      expect(commitsOf(result)).toEqual([{ subject: "topic edits a", kind: "patch-equivalent" }]);
      if (result.commits.kind !== "listed") throw new Error("unreachable");
      expect(result.commits.history).toBe("rewritten");
    });

    it("tells new work apart from the rebased commits", async () => {
      const repo = topicRepo();
      const point = await review(repo);
      moveMain(repo);
      git(repo, "rebase", "-q", "main");
      commit(repo, "new work", { "b.txt": "new work\n" });

      const result = await compareNow(repo, point);

      expect(summary(result)).toEqual({
        "b.txt": { ...MODIFIED_BOTH, baseUpdate: "none" },
        "g.txt": { ...MODIFIED_BOTH, baseUpdate: "only" },
      });
      expect(commitsOf(result)).toEqual([
        { subject: "new work", kind: "new" },
        { subject: "topic edits a", kind: "patch-equivalent" },
      ]);
    });
  });

  it("calls a message-only amend patch-equivalent", async () => {
    const repo = topicRepo();
    const point = await review(repo);
    git(repo, "commit", "-q", "--amend", "-m", "reworded");

    const result = await compareNow(repo, point);

    expect(result.state).toBe("comparable");
    expect(result.files).toEqual([]);
    expect(commitsOf(result)).toEqual([{ subject: "reworded", kind: "patch-equivalent" }]);
  });

  it("calls a message-only amend of a merge patch-equivalent", async () => {
    const repo = topicRepo();
    git(repo, "checkout", "-q", "main");
    commit(repo, "main edits g", { "g.txt": "g on main\n" });
    git(repo, "checkout", "-q", "topic");
    git(repo, "merge", "-q", "--no-edit", "main");
    const point = await review(repo);
    git(repo, "commit", "-q", "--amend", "-m", "merge reworded");

    const result = await compareNow(repo, point);

    expect(result.files).toEqual([]);
    expect(commitsOf(result)).toEqual([{ subject: "merge reworded", kind: "patch-equivalent" }]);
  });

  it("keeps files from the stored identities when a force push and gc remove the reviewed commit", async () => {
    const repo = topicRepo();
    write(repo, "b.txt", "uncommitted\n");
    const point = await review(repo);
    const reviewedCommit = head(repo);
    git(repo, "checkout", "-q", "--", "b.txt");
    git(repo, "reset", "-q", "--hard", "main");
    commit(repo, "rewritten", { "a.txt": "a rewritten\n" });
    collectGarbage(repo);
    expect(exists(repo, reviewedCommit)).toBe(false);

    const result = await compareNow(repo, point);

    expect(result.state).toBe("reviewed-commit-missing");
    expect(result.commits).toEqual({ kind: "unavailable", reason: "reviewed-commit-missing" });
    expect(summary(result)).toEqual({
      "a.txt": { ...MODIFIED_BOTH, baseUpdate: "none" },
      "b.txt": { ...MODIFIED_TREE, baseUpdate: "none" },
    });
  });

  it("says it's incomplete when neither the reviewed commit nor its base survives", async () => {
    const repo = topicRepo();
    git(repo, "checkout", "-q", "-b", "stack", "main");
    commit(repo, "stack base", { "s.txt": "s\n" });
    git(repo, "checkout", "-q", "-B", "topic", "stack");
    commit(repo, "on the stack", { "a.txt": "stacked\n" });
    const point = await review(repo, { base: { kind: "ref", ref: "refs/heads/stack" } });
    const stackBase = point.base.tip ?? "";
    git(repo, "reset", "-q", "--hard", "main");
    git(repo, "branch", "-q", "-D", "stack");
    commit(repo, "rewritten", { "g.txt": "rewritten\n" });
    collectGarbage(repo);
    expect(exists(repo, stackBase)).toBe(false);

    const result = await compareNow(repo, point);

    expect(result.state).toBe("incomplete");
    if (result.state !== "incomplete") throw new Error("unreachable");
    expect(result.reasons).toContain("reviewed-state-unavailable");
    expect(result.commits).toEqual({ kind: "unavailable", reason: "reviewed-commit-missing" });
    // What it can still say, it says: a.txt was listed then and differs now.
    expect(summary(result)["a.txt"]).toMatchObject({
      status: "modified",
      worktree: "changed",
      // With the base gone there's no base update to tell it by.
      baseUpdate: "unknown",
    });
  });

  describe("merging the base in", () => {
    it("lists the base's files as the base update's, and only the merge commit", async () => {
      const repo = topicRepo();
      const point = await review(repo);
      git(repo, "checkout", "-q", "main");
      commit(repo, "main edits g", { "g.txt": "g on main\n" });
      git(repo, "checkout", "-q", "topic");
      git(repo, "merge", "-q", "--no-edit", "main");

      const result = await compareNow(repo, point);

      expect(result.state).toBe("comparable");
      expect(summary(result)).toEqual({ "g.txt": { ...MODIFIED_BOTH, baseUpdate: "only" } });
      expect(commitsOf(result)).toEqual([
        { subject: "Merge branch 'main' into topic", kind: "new" },
      ]);
      if (result.commits.kind !== "listed") throw new Error("unreachable");
      expect(result.commits.history).toBe("extended");
      expect(result.commits.commits[0]?.parents).toHaveLength(2);
    });

    it("reports a base change landing inside a file already reviewed", async () => {
      const repo = path.join(root, `repo-${++repoCount}`);
      fs.mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      commit(repo, "base", { "long.txt": "1\n2\n3\n4\n5\n6\n7\n8\n" });
      git(repo, "checkout", "-q", "-b", "topic");
      commit(repo, "topic edits the top", { "long.txt": "1 topic\n2\n3\n4\n5\n6\n7\n8\n" });
      const point = await review(repo);
      git(repo, "checkout", "-q", "main");
      commit(repo, "main edits the bottom", { "long.txt": "1\n2\n3\n4\n5\n6\n7\n8 main\n" });
      git(repo, "checkout", "-q", "topic");
      git(repo, "merge", "-q", "--no-edit", "main");
      expect(fs.readFileSync(path.join(repo, "long.txt"), "utf8")).toBe(
        "1 topic\n2\n3\n4\n5\n6\n7\n8 main\n"
      );

      const result = await compareNow(repo, point);

      expect(summary(result)).toEqual({ "long.txt": { ...MODIFIED_BOTH, baseUpdate: "also" } });
    });
  });

  describe("a base fast-forward over the branch", () => {
    it("keeps the reviewed files reviewed when the base swallows the branch", async () => {
      const repo = topicRepo();
      const point = await review(repo);
      git(repo, "branch", "-q", "-f", "main", "topic");

      const result = await compareNow(repo, point);

      expect(result.state).toBe("comparable");
      expect(result.files).toEqual([]);
      expect(commitsOf(result)).toEqual([]);
    });

    it("lists what the base brought past the branch, but none of its history", async () => {
      const repo = topicRepo();
      const point = await review(repo);
      git(repo, "checkout", "-q", "main");
      git(repo, "merge", "-q", "--ff-only", "topic");
      commit(repo, "main edits g", { "g.txt": "g on main\n" });
      git(repo, "checkout", "-q", "topic");
      git(repo, "merge", "-q", "--ff-only", "main");

      const result = await compareNow(repo, point);

      expect(summary(result)).toEqual({ "g.txt": { ...MODIFIED_BOTH, baseUpdate: "only" } });
      expect(commitsOf(result)).toEqual([]);
    });
  });

  it.each([
    ["committed", true],
    ["in the working tree", false],
  ])("lists a file reverted to the base, %s", async (_, committed) => {
    const repo = topicRepo();
    const point = await review(repo);
    write(repo, "a.txt", "a\n");
    if (committed) git(repo, "commit", "-q", "-am", "revert a");

    const result = await compareNow(repo, point);

    expect(summary(result)).toEqual({
      "a.txt": committed
        ? { ...MODIFIED_BOTH, baseUpdate: "none" }
        : { ...MODIFIED_TREE, baseUpdate: "none" },
    });
  });

  it("lists a rename as the old path deleted and the new one added", async () => {
    const repo = topicRepo();
    const point = await review(repo);
    git(repo, "mv", "b.txt", "renamed.txt");

    const result = await compareNow(repo, point);

    expect(summary(result)).toEqual({
      "b.txt": { status: "deleted", index: "changed", worktree: "changed", baseUpdate: "none" },
      "renamed.txt": { status: "added", index: "changed", worktree: "changed", baseUpdate: "none" },
    });
  });

  it("compares a binary file by its bytes", async () => {
    const repo = topicRepo();
    write(repo, "blob.bin", Buffer.from([0, 1, 2, 0xff, 0, 3]));
    const point = await review(repo);
    write(repo, "blob.bin", Buffer.from([0, 1, 2, 0xfe, 0, 3]));

    const result = await compareNow(repo, point);

    expect(summary(result)).toEqual({ "blob.bin": { ...MODIFIED_TREE, baseUpdate: "none" } });
  });

  posixOnly("compares a symlink by its link text", async () => {
    const repo = topicRepo();
    fs.symlinkSync("a.txt", path.join(repo, "link"));
    git(repo, "add", "link");
    git(repo, "commit", "-q", "-m", "link");
    const point = await review(repo);
    fs.rmSync(path.join(repo, "link"));
    fs.symlinkSync("b.txt", path.join(repo, "link"));

    const result = await compareNow(repo, point);

    expect(summary(result)).toEqual({ link: { ...MODIFIED_TREE, baseUpdate: "none" } });
    const link = result.files[0];
    expect(link?.current).toMatchObject({ kind: "listed", worktree: { kind: "symlink" } });
  });

  it("compares a detached HEAD", async () => {
    const repo = topicRepo();
    git(repo, "checkout", "-q", "--detach");
    const point = await review(repo);
    commit(repo, "detached work", { "b.txt": "detached\n" });

    const result = await compareNow(repo, point);

    expect(result.state).toBe("comparable");
    expect(result.head.kind).toBe("detached");
    expect(Object.keys(summary(result))).toEqual(["b.txt"]);
    expect(commitsOf(result)).toEqual([{ subject: "detached work", kind: "new" }]);
  });

  it.each([
    ["another branch", ["checkout", "-q", "-b", "other"]],
    ["a detached HEAD", ["checkout", "-q", "--detach"]],
  ])("refuses a point reviewed on another branch after switching to %s", async (_, args) => {
    const repo = topicRepo();
    const point = await review(repo);
    git(repo, ...args);

    const result = await compareReviewPoint(repo, point);

    expect(result).toMatchObject({
      state: "different-branch",
      reviewed: { kind: "branch", branch: "topic" },
    });
  });

  it("says an incomplete review point makes the comparison incomplete, and lists what it couldn't see", async () => {
    const repo = topicRepo();
    write(repo, "u1.txt", "1\n");
    write(repo, "u2.txt", "2\n");
    write(repo, "u3.txt", "3\n");
    const point = await review(repo, { limits: { maxPaths: 2 } });
    expect(point.incomplete?.reasons).toEqual(["path-limit"]);

    const result = await compareNow(repo, point);

    expect(result.state).toBe("incomplete");
    if (result.state !== "incomplete") throw new Error("unreachable");
    expect(result.reasons).toEqual(["reviewed-point-incomplete"]);
    expect(result.gaps.map((gap) => [gap.path, gap.side, gap.reason])).toEqual([
      ["u2.txt", "reviewed", "path-limit"],
      ["u3.txt", "reviewed", "path-limit"],
    ]);
    expect(summary(result)).toEqual({
      "u2.txt": { status: "unknown", index: "unknown", worktree: "unknown", baseUpdate: "none" },
      "u3.txt": { status: "unknown", index: "unknown", worktree: "unknown", baseUpdate: "none" },
    });
    expect(result.files[0]?.current).toMatchObject({
      kind: "listed",
      worktree: { kind: "file" },
    });
  });

  it("never infers a reviewed identity for a path the point left out without naming", async () => {
    const repo = topicRepo();
    write(repo, "f.txt", "A\n");
    git(repo, "add", "f.txt");
    git(repo, "commit", "-q", "-m", "add f");
    write(repo, "f.txt", "B\n");
    // a.txt fills the one entry; f.txt is past the cap on both paths and names.
    const point = await review(repo, { limits: { maxPaths: 1, maxUncoveredListed: 0 } });
    expect(point.incomplete).toMatchObject({ uncovered: [], uncoveredCount: 1 });
    // Commit B, then stage and leave A: the index and working tree read like
    // the commit before, which is not what the working tree held at review.
    git(repo, "commit", "-q", "-am", "commit B");
    write(repo, "f.txt", "A\n");
    git(repo, "add", "f.txt");

    const result = await compareNow(repo, point);

    expect(result.state).toBe("incomplete");
    expect(summary(result)["f.txt"]).toEqual({
      status: "unknown",
      index: "unknown",
      worktree: "unknown",
      baseUpdate: "none",
    });
    expect(result.files.find((file) => file.path === "f.txt")?.reviewed).toEqual({
      kind: "uncovered",
      reason: "path-limit",
    });
  });

  it("says the current state is incomplete when it can't all be read", async () => {
    const repo = topicRepo();
    const point = await review(repo);
    write(repo, "big.txt", "x".repeat(64));

    const result = await compareNow(repo, point, { limits: { maxFileBytes: 16 } });

    expect(result.state).toBe("incomplete");
    if (result.state !== "incomplete") throw new Error("unreachable");
    expect(result.reasons).toEqual(["current-state-incomplete"]);
    expect(summary(result)).toEqual({
      "big.txt": { status: "unknown", index: "unchanged", worktree: "unknown", baseUpdate: "none" },
    });
  });

  it("caps the commit list and says so", async () => {
    const repo = topicRepo();
    const point = await review(repo);
    for (const n of [1, 2, 3]) commit(repo, `c${n}`, { "b.txt": `${n}\n` });

    const result = await compareNow(repo, point, { limits: { maxCommits: 2 } });

    expect(result.commits).toMatchObject({ kind: "listed", truncated: true });
    expect(commitsOf(result).map((entry) => entry.subject)).toEqual(["c3", "c2"]);
  });

  posixOnly("never writes to the repository", async () => {
    const repo = topicRepo();
    const point = await review(repo);
    git(repo, "checkout", "-q", "main");
    commit(repo, "main edits g", { "g.txt": "g on main\n" });
    git(repo, "checkout", "-q", "topic");
    git(repo, "rebase", "-q", "main");
    write(repo, "b.txt", "dirty\n");
    write(repo, "u.txt", "untracked\n");
    const before = snapshot(path.join(repo, ".git"));

    await compareNow(repo, point);

    expect(snapshot(path.join(repo, ".git"))).toEqual(before);
  });

  describe("refusals", () => {
    it("refuses a point taken in another worktree on the same branch name", async () => {
      const repo = topicRepo();
      const other = path.join(root, `worktree-${repoCount}`);
      git(repo, "worktree", "add", "-q", "-b", "elsewhere", other);
      const point = await review(other);
      git(repo, "worktree", "remove", other);
      git(repo, "checkout", "-q", "elsewhere");

      expect(await compareReviewPoint(repo, point)).toMatchObject({
        state: "failed",
        reason: "invalid-review-point",
      });
    });

    it("refuses a point that isn't one", async () => {
      const repo = topicRepo();
      const point = await review(repo);
      const edited = { ...point, entries: [...point.entries, ...point.entries] };

      expect(await compareReviewPoint(repo, edited)).toMatchObject({
        state: "failed",
        reason: "invalid-review-point",
      });
    });

    it("answers a cancelled comparison as cancelled", async () => {
      const repo = topicRepo();
      const point = await review(repo);
      const controller = new AbortController();
      controller.abort();

      expect(await compareReviewPoint(repo, point, { signal: controller.signal })).toMatchObject({
        state: "failed",
        reason: "cancelled",
      });
    });

    it("answers by its deadline", async () => {
      const repo = topicRepo();
      const point = await review(repo);

      expect(await compareReviewPoint(repo, point, { limits: { timeoutMs: 1 } })).toMatchObject({
        state: "failed",
        reason: "deadline",
      });
    });
  });
});
