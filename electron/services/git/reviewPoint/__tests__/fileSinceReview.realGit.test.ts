import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewComparisonResult } from "../../../../../shared/types/reviewComparison.js";
import type { ReviewPoint } from "../../../../../shared/types/reviewPoint.js";
import { captureReviewPoint, type CaptureReviewPointOptions } from "../captureReviewPoint.js";
import { compareReviewPoint } from "../compareReviewPoint.js";
import { readFileSinceReview } from "../fileSinceReview.js";
import type { ReviewFileSinceSide } from "../../../../../shared/types/ipc/reviewMarks.js";

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

async function compareNow(repo: string, point: ReviewPoint): Promise<Compared> {
  const result = await compareReviewPoint(repo, point);
  if (
    result.state !== "comparable" &&
    result.state !== "reviewed-commit-missing" &&
    result.state !== "incomplete"
  ) {
    throw new Error(`Expected a comparison: ${JSON.stringify(result)}`);
  }
  return result;
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

async function sinceReview(
  repo: string,
  point: ReviewPoint,
  filePath: string,
  side?: ReviewFileSinceSide
) {
  const result = await compareNow(repo, point);
  const file = result.files.find((candidate) => candidate.path === filePath);
  if (!file) throw new Error(`${filePath} isn't in the comparison`);
  const chosen = side ?? (file.worktree !== "unchanged" ? "worktree" : "index");
  return readFileSinceReview(repo, point, file, chosen);
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-file-since-review-")));
  vi.stubEnv("HOME", root);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readFileSinceReview", () => {
  it("diffs the reviewed working-tree version against the current one when git holds it", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "reviewed\n");
    git(repo, "add", "a.txt");
    const point = await review(repo);
    write(repo, "a.txt", "current\n");

    const view = await sinceReview(repo, point, "a.txt", "worktree");

    expect(view.kind).toBe("exact");
    if (view.kind !== "exact") return;
    expect(view.patch).toContain("--- a/a.txt\n+++ b/a.txt\n");
    expect(view.patch).toContain("-reviewed\n+current\n");
    expect(view.patch).not.toContain("topic");
  });

  it("diffs the reviewed index entry against the current one", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "staged one\n");
    git(repo, "add", "a.txt");
    const point = await review(repo);
    write(repo, "a.txt", "staged two\n");
    git(repo, "add", "a.txt");

    const view = await sinceReview(repo, point, "a.txt", "index");

    expect(view.kind).toBe("exact");
    if (view.kind !== "exact") return;
    expect(view.patch).toContain("-staged one\n+staged two\n");
  });

  it("reads a file the point didn't list as the reviewed commit's version", async () => {
    const repo = topicRepo();
    const point = await review(repo);
    write(repo, "b.txt", "edited later\n");

    const view = await sinceReview(repo, point, "b.txt");

    expect(view.kind).toBe("exact");
    if (view.kind !== "exact") return;
    expect(view.patch).toContain("-b\n+edited later\n");
  });

  it("says the reviewed version is unavailable when it only lived in the working tree", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "never staged\n");
    const point = await review(repo);
    write(repo, "a.txt", "now\n");

    const view = await sinceReview(repo, point, "a.txt", "worktree");

    expect(view.kind).toBe("unavailable");
    if (view.kind !== "unavailable") return;
    expect(view.reason).toBe("reviewed-content-missing");
    expect(view.changed).toBe(true);
    // Set against the reviewed commit, which is not the reviewed version.
    expect(view.standIn?.commit).toBe(head(repo));
    expect(view.standIn?.patch).toContain("-a topic\n+now\n");
    expect(view.standIn?.patch).not.toContain("never staged");
  });

  it("still reports the file changed after it was reverted to HEAD, where a HEAD diff is empty", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "never staged\n");
    const point = await review(repo);
    git(repo, "checkout", "--", "a.txt");

    const view = await sinceReview(repo, point, "a.txt", "worktree");

    expect(view).toEqual({
      kind: "unavailable",
      reason: "reviewed-content-missing",
      changed: true,
      standIn: null,
    });
  });

  it("treats a collected reviewed object as unavailable", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "staged then dropped\n");
    git(repo, "add", "a.txt");
    const point = await review(repo);
    git(repo, "reset", "-q", "--", "a.txt");
    git(repo, "checkout", "--", "a.txt");
    write(repo, "a.txt", "different\n");
    collectGarbage(repo);

    const view = await sinceReview(repo, point, "a.txt", "worktree");

    expect(view.kind).toBe("unavailable");
  });

  it("shows an added file against nothing and a deleted file against nothing", async () => {
    const repo = topicRepo();
    write(repo, "c.txt", "c\n");
    git(repo, "add", "c.txt");
    const point = await review(repo);
    fs.rmSync(path.join(repo, "c.txt"));

    const view = await sinceReview(repo, point, "c.txt", "worktree");

    expect(view.kind).toBe("exact");
    if (view.kind !== "exact") return;
    expect(view.patch).toContain("deleted file mode 100644");
    expect(view.patch).toContain("+++ /dev/null");
    expect(view.patch).toContain("-c\n");
  });

  it("answers unchanged for a side that holds what it held", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "dirty\n");
    const point = await review(repo);
    write(repo, "b.txt", "other\n");
    const result = await compareNow(repo, point);
    const file = result.files.find((candidate) => candidate.path === "b.txt");
    if (!file) throw new Error("b.txt missing");

    expect(await readFileSinceReview(repo, point, file, "index")).toEqual({ kind: "unchanged" });
  });

  it("does not pass binary or non-UTF-8 content through as text", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", Buffer.from([0, 1, 2]));
    git(repo, "add", "a.txt");
    const point = await review(repo);
    write(repo, "a.txt", Buffer.from([0, 9, 9]));

    expect((await sinceReview(repo, point, "a.txt", "worktree")).kind).toBe("binary");
  });

  it("reports mode-only changes without a patch", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "same\n");
    git(repo, "add", "a.txt");
    const point = await review(repo);
    fs.chmodSync(path.join(repo, "a.txt"), 0o755);

    const view = await sinceReview(repo, point, "a.txt", "worktree");

    expect(view).toEqual({ kind: "mode-only", from: "100644", to: "100755" });
  });

  it("diffs the index by its own entries, apart from the working tree", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "staged one\n");
    git(repo, "add", "a.txt");
    write(repo, "a.txt", "tree one\n");
    const point = await review(repo);
    write(repo, "a.txt", "staged two\n");
    git(repo, "add", "a.txt");
    write(repo, "a.txt", "tree two\n");

    const index = await sinceReview(repo, point, "a.txt", "index");
    const tree = await sinceReview(repo, point, "a.txt", "worktree");

    expect(index.kind === "exact" && index.patch).toContain("-staged one\n+staged two\n");
    expect(index.kind === "exact" && index.patch).not.toContain("tree");
    // The tree never held the staged text, and its own reviewed bytes were never stored.
    expect(tree.kind).toBe("unavailable");
  });

  it("does not pass invalid UTF-8 text through as a diff", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", Buffer.from([0x61, 0xff, 0x0a]));
    git(repo, "add", "a.txt");
    const point = await review(repo);
    write(repo, "a.txt", Buffer.from([0x62, 0xff, 0x0a]));

    expect((await sinceReview(repo, point, "a.txt", "worktree")).kind).toBe("binary");
  });

  it("shows a file added after review as new, and an empty one as added", async () => {
    const repo = topicRepo();
    const point = await review(repo);
    write(repo, "n.txt", "new\n");
    write(repo, "e.txt", "");
    fs.rmSync(path.join(repo, "b.txt"));
    write(repo, "b.txt", "");

    const added = await sinceReview(repo, point, "n.txt", "worktree");
    const empty = await sinceReview(repo, point, "e.txt", "worktree");

    expect(added.kind === "exact" && added.patch).toContain("new file mode 100644");
    expect(added.kind === "exact" && added.patch).toContain("--- /dev/null");
    expect(empty).toEqual({ kind: "empty-file", change: "added" });
  });

  it("shows a reviewed empty file that was deleted as deleted, not unchanged", async () => {
    const repo = topicRepo();
    write(repo, "z.txt", "");
    git(repo, "add", "z.txt");
    const point = await review(repo);
    fs.rmSync(path.join(repo, "z.txt"));

    expect(await sinceReview(repo, point, "z.txt", "worktree")).toEqual({
      kind: "empty-file",
      change: "deleted",
    });
  });

  it("won't call an unlisted file's reviewed version exact when line endings are converted", async () => {
    const repo = topicRepo();
    git(repo, "config", "core.autocrlf", "true");
    const point = await review(repo);
    write(repo, "b.txt", "later\r\n");

    const view = await sinceReview(repo, point, "b.txt", "worktree");

    expect(view.kind).toBe("unavailable");
    if (view.kind !== "unavailable") return;
    expect(view.reason).toBe("reviewed-not-raw");
    expect(view.standIn?.patch).toContain("-b\n");
  });

  posixOnly("quotes a path that would break a patch header", async () => {
    const repo = topicRepo();
    write(repo, 'we"ird\nname.txt', "one\n");
    git(repo, "add", "-A");
    const point = await review(repo);
    write(repo, 'we"ird\nname.txt', "two\n");

    const view = await sinceReview(repo, point, 'we"ird\nname.txt', "worktree");

    expect(view.kind).toBe("exact");
    if (view.kind !== "exact") return;
    const header = view.patch.split("\n").slice(0, 3);
    expect(header[0]).toBe('diff --git "a/we\\"ird\\nname.txt" "b/we\\"ird\\nname.txt"');
    expect(header[1]).toBe('--- "a/we\\"ird\\nname.txt"');
  });

  it("leaves the repository and the working tree untouched", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "never staged\n");
    const point = await review(repo);
    write(repo, "a.txt", "now\n");
    await compareNow(repo, point);
    const before = snapshot(repo);

    await sinceReview(repo, point, "a.txt", "worktree");

    expect(snapshot(repo)).toEqual(before);
  });
});
