import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ReviewPointSchema,
  type ReviewPoint,
  type ReviewPointBaseRequest,
  type ReviewPointCaptureResult,
} from "../../../../../shared/types/reviewPoint.js";
import { captureReviewPoint, type CaptureReviewPointOptions } from "../captureReviewPoint.js";

// Real repositories throughout: what a review point claims is only as good as
// git's actual output for the states it has to cover.

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
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
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

function blob(content: string | Buffer): string {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

let repoCount = 0;
function newDir(): string {
  const dir = path.join(root, `repo-${++repoCount}`);
  fs.mkdirSync(dir);
  return dir;
}

/** `main` with two files, and `topic` checked out on top of it. */
function topicRepo(): string {
  const repo = newDir();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, "a.txt", "a\n");
  write(repo, "b.txt", "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "topic");
  return repo;
}

const MAIN: ReviewPointBaseRequest = { kind: "ref", ref: "refs/heads/main" };

async function capture(
  repo: string,
  options: Partial<CaptureReviewPointOptions> = {}
): Promise<ReviewPointCaptureResult> {
  return captureReviewPoint(repo, { base: MAIN, ...options });
}

async function capturePoint(
  repo: string,
  options: Partial<CaptureReviewPointOptions> = {}
): Promise<ReviewPoint> {
  const result = await capture(repo, options);
  if (result.kind !== "captured")
    throw new Error(`Expected a point, got ${JSON.stringify(result)}`);
  // Every point survives the trip a stored mark takes.
  expect(ReviewPointSchema.parse(JSON.parse(JSON.stringify(result.point)))).toEqual(result.point);
  return result.point;
}

function entry(point: ReviewPoint, filePath: string) {
  return point.entries.find((candidate) => candidate.path === filePath);
}

function paths(point: ReviewPoint): string[] {
  return point.entries.map((candidate) => candidate.path);
}

/** Every file under the git dir: bytes, inode and times, so any write shows. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stats = fs.lstatSync(full, { bigint: true });
      if (stats.isDirectory()) {
        out.set(full, "dir");
        walk(full);
        continue;
      }
      const digest = stats.isFile()
        ? createHash("sha1").update(fs.readFileSync(full)).digest("hex")
        : "";
      out.set(full, [stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, digest].join(":"));
    }
  };
  walk(dir);
  return out;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-review-point-")));
  // The capture's own git reads HOME for global config; keep it on the fixture.
  vi.stubEnv("HOME", root);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("captureReviewPoint", () => {
  it("records the branch, HEAD, base and every changed path", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "a2\n");
    git(repo, "commit", "-q", "-am", "edit a");
    write(repo, "b.txt", "b staged\n");
    git(repo, "add", "b.txt");
    write(repo, "c/new.txt", "untracked\n");
    const head = git(repo, "rev-parse", "HEAD").trim();
    const mainTip = git(repo, "rev-parse", "main").trim();

    const point = await capturePoint(repo);

    expect(point.head).toEqual({ kind: "branch", branch: "topic", commit: head });
    expect(point.base).toEqual({
      requested: MAIN,
      ref: "refs/heads/main",
      tip: mainTip,
      mergeBases: [mainTip],
    });
    expect(point.worktreePath).toBe(repo);
    expect(point.gitDir).toBe(path.join(repo, ".git"));
    expect(point.commonDir).toBe(path.join(repo, ".git"));
    expect(point.objectFormat).toBe("sha1");
    expect(point.incomplete).toBeNull();
    expect(paths(point)).toEqual(["a.txt", "b.txt", "c/new.txt"]);

    expect(entry(point, "a.txt")).toEqual({
      path: "a.txt",
      head: { mode: "100644", oid: blob("a2\n") },
      index: { kind: "entry", mode: "100644", oid: blob("a2\n") },
      worktree: { kind: "file", mode: "100644", oid: blob("a2\n"), size: 3 },
    });
    expect(entry(point, "b.txt")).toMatchObject({
      head: { oid: blob("b\n") },
      index: { kind: "entry", oid: blob("b staged\n") },
      worktree: { kind: "file", oid: blob("b staged\n") },
    });
    expect(entry(point, "c/new.txt")).toMatchObject({
      head: null,
      index: { kind: "absent" },
      worktree: { kind: "file", oid: blob("untracked\n") },
    });
  });

  it("resolves a base branch the way the worktree card does", async () => {
    const repo = topicRepo();
    const point = await capturePoint(repo, { base: { kind: "branch", branch: "main" } });
    expect(point.base.ref).toBe("refs/heads/main");
    expect(point.entries).toEqual([]);
  });

  describe("never writes to the repository", () => {
    it("leaves objects, the index, refs and every other git file as they were", async () => {
      const repo = topicRepo();
      const sentinel = path.join(root, "clean-filter-ran");
      // A clean filter that leaves a trace: status hashes a stat-dirty file
      // through it, the way git-lfs's would write into .git/lfs.
      git(repo, "config", "filter.spy.clean", `sh -c 'touch "${sentinel}"; cat'`);
      git(repo, "config", "filter.spy.required", "true");
      write(repo, ".gitattributes", "*.spy filter=spy\n");
      write(repo, "f.spy", "x\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "spy");
      fs.rmSync(sentinel, { force: true });
      // Same size, later mtime: git can only tell by hashing the content.
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(repo, "f.spy"), later, later);
      write(repo, "a.txt", "dirty\n");
      write(repo, "b.txt", "staged\n");
      git(repo, "add", "b.txt");
      write(repo, "u.txt", "untracked\n");

      const objectsBefore = git(repo, "count-objects", "-v");
      const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
      const before = snapshot(path.join(repo, ".git"));

      await capturePoint(repo);

      expect(git(repo, "count-objects", "-v")).toBe(objectsBefore);
      expect(fs.readFileSync(path.join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
      expect(snapshot(path.join(repo, ".git"))).toEqual(before);
      expect(fs.existsSync(sentinel)).toBe(false);
    });
  });

  it("keeps the index and the working tree as separate identities", async () => {
    const repo = topicRepo();
    write(repo, "a.txt", "A\n");
    git(repo, "commit", "-q", "-am", "A");
    const aloneA = await capturePoint(repo);

    write(repo, "a.txt", "B\n");
    git(repo, "add", "a.txt");
    write(repo, "a.txt", "A\n");
    const stagedB = await capturePoint(repo);

    expect(entry(aloneA, "a.txt")?.index).toMatchObject({ oid: blob("A\n") });
    expect(entry(stagedB, "a.txt")?.index).toMatchObject({ oid: blob("B\n") });
    expect(entry(stagedB, "a.txt")?.worktree).toMatchObject({ oid: blob("A\n") });
    expect(stagedB.entries).not.toEqual(aloneA.entries);
  });

  it("records intent-to-add and conflicted index entries as such", async () => {
    const repo = topicRepo();
    write(repo, "ita.txt", "later\n");
    git(repo, "add", "-N", "ita.txt");
    expect(entry(await capturePoint(repo), "ita.txt")?.index).toEqual({ kind: "intent-to-add" });

    git(repo, "reset", "-q");
    fs.rmSync(path.join(repo, "ita.txt"));
    write(repo, "a.txt", "topic\n");
    git(repo, "commit", "-q", "-am", "topic");
    git(repo, "checkout", "-q", "main");
    write(repo, "a.txt", "main\n");
    git(repo, "commit", "-q", "-am", "main");
    git(repo, "checkout", "-q", "topic");
    try {
      git(repo, "merge", "-q", "main");
    } catch {
      // The conflict is the point.
    }
    const conflicted = entry(await capturePoint(repo), "a.txt");
    expect(conflicted?.head).toEqual({ mode: "100644", oid: blob("topic\n") });
    expect(conflicted?.index).toEqual({
      kind: "conflicted",
      stages: [
        { stage: 1, mode: "100644", oid: blob("a\n") },
        { stage: 2, mode: "100644", oid: blob("topic\n") },
        { stage: 3, mode: "100644", oid: blob("main\n") },
      ],
    });
  });

  describe("identities cover mode and type", () => {
    posixOnly("sees an executable bit change on its own", async () => {
      const repo = topicRepo();
      fs.chmodSync(path.join(repo, "a.txt"), 0o755);
      expect(entry(await capturePoint(repo), "a.txt")?.worktree).toEqual({
        kind: "file",
        mode: "100755",
        oid: blob("a\n"),
        size: 2,
      });
    });

    posixOnly("identifies a symlink by its link text, never its target", async () => {
      const repo = topicRepo();
      write(repo, "one.txt", "same\n");
      write(repo, "two.txt", "same\n");
      fs.symlinkSync("one.txt", path.join(repo, "link"));
      const first = entry(await capturePoint(repo), "link");
      expect(first?.worktree).toEqual({ kind: "symlink", oid: blob("one.txt") });

      // A target edit leaves the link as it was.
      write(repo, "one.txt", "edited\n");
      expect(entry(await capturePoint(repo), "link")?.worktree).toEqual(first?.worktree);

      // Retargeting at identical content does not.
      fs.rmSync(path.join(repo, "link"));
      fs.symlinkSync("two.txt", path.join(repo, "link"));
      expect(entry(await capturePoint(repo), "link")?.worktree).toEqual({
        kind: "symlink",
        oid: blob("two.txt"),
      });

      fs.rmSync(path.join(repo, "link"));
      fs.symlinkSync("missing", path.join(repo, "link"));
      expect(entry(await capturePoint(repo), "link")?.worktree).toEqual({
        kind: "symlink",
        oid: blob("missing"),
      });
    });

    posixOnly("records a file replaced by a directory as a directory", async () => {
      const repo = topicRepo();
      fs.rmSync(path.join(repo, "a.txt"));
      write(repo, "a.txt/inner", "x\n");
      const point = await capturePoint(repo);
      expect(entry(point, "a.txt")?.worktree).toEqual({ kind: "directory" });
      expect(entry(point, "a.txt/inner")?.worktree).toMatchObject({ kind: "file" });
    });

    describe("submodules", () => {
      function withSubmodule(): { repo: string; sub: string; commit: string } {
        const upstream = newDir();
        git(upstream, "init", "-q", "-b", "main");
        write(upstream, "s.txt", "s\n");
        git(upstream, "add", ".");
        git(upstream, "commit", "-q", "-m", "s");
        const repo = topicRepo();
        git(repo, "checkout", "-q", "main");
        git(repo, "submodule", "add", "-q", upstream, "sub");
        git(repo, "commit", "-q", "-m", "sub");
        git(repo, "checkout", "-q", "topic");
        git(repo, "merge", "-q", "--ff-only", "main");
        const sub = path.join(repo, "sub");
        return { repo, sub, commit: git(sub, "rev-parse", "HEAD").trim() };
      }

      it("leaves a clean submodule out", async () => {
        const { repo } = withSubmodule();
        const point = await capturePoint(repo);
        expect(point.entries).toEqual([]);
        expect(point.incomplete).toBeNull();
      });

      it("records a moved submodule's commit", async () => {
        const { repo, sub, commit } = withSubmodule();
        write(sub, "s.txt", "s2\n");
        git(sub, "commit", "-q", "-am", "s2");
        const moved = git(sub, "rev-parse", "HEAD").trim();
        const point = await capturePoint(repo);
        expect(entry(point, "sub")).toEqual({
          path: "sub",
          head: { mode: "160000", oid: commit },
          index: { kind: "entry", mode: "160000", oid: commit },
          worktree: { kind: "submodule", commit: moved, contents: "clean" },
        });
        expect(point.incomplete).toBeNull();
      });

      it("says it can't vouch for a submodule with changes inside it", async () => {
        const { repo, sub, commit } = withSubmodule();
        write(sub, "s.txt", "dirty\n");
        const point = await capturePoint(repo);
        expect(entry(point, "sub")?.worktree).toEqual({
          kind: "submodule",
          commit,
          contents: "dirty",
        });
        expect(point.incomplete).toMatchObject({
          reasons: ["submodule-contents"],
          uncovered: [{ path: "sub", reason: "submodule-contents" }],
          uncoveredCount: 1,
        });
      });

      it("treats an unpopulated submodule as git does", async () => {
        const { repo } = withSubmodule();
        git(repo, "submodule", "deinit", "-q", "-f", "sub");
        const point = await capturePoint(repo);
        expect(point.entries).toEqual([]);
        expect(point.incomplete).toBeNull();
      });
    });
  });

  describe("paths", () => {
    posixOnly("keeps unusual names exactly as git spells them", async () => {
      const repo = topicRepo();
      const names = [
        "tab\tname.txt",
        "new\nline.txt",
        'quote"name.txt',
        "space name.txt",
        "-leading-dash.txt",
        "back\\slash.txt",
        "日本語.txt",
      ];
      for (const name of names) write(repo, name, `${name}\n`);
      const point = await capturePoint(repo);
      for (const name of names) {
        expect(entry(point, name)?.worktree).toMatchObject({ oid: blob(`${name}\n`) });
        expect(entry(point, name)?.pathBytes).toBeUndefined();
      }
    });

    it("never folds case", async () => {
      const repo = topicRepo();
      write(repo, "Case.txt", "upper\n");
      write(repo, "case.txt", "lower\n");
      const caseSensitive =
        fs.readdirSync(repo).includes("Case.txt") && fs.readdirSync(repo).includes("case.txt");
      const point = await capturePoint(repo);
      if (caseSensitive) {
        expect(entry(point, "Case.txt")?.worktree).toMatchObject({ oid: blob("upper\n") });
        expect(entry(point, "case.txt")?.worktree).toMatchObject({ oid: blob("lower\n") });
      } else {
        // One file on disk, under the name it was created with.
        expect(paths(point)).toEqual(["Case.txt"]);
      }
    });

    it("keeps a name that isn't valid UTF-8 as bytes", async () => {
      const repo = topicRepo();
      const name = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]);
      try {
        fs.writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), name]), "bytes\n");
      } catch {
        // macOS and Windows refuse such names; Linux keeps them.
        return;
      }
      const point = await capturePoint(repo);
      const found = point.entries.find((candidate) => candidate.pathBytes !== undefined);
      expect(found?.pathBytes).toBe(name.toString("base64"));
      expect(found?.worktree).toMatchObject({ oid: blob("bytes\n") });
    });
  });

  describe("content git transforms on commit", () => {
    it("identifies line-ending variants apart even though git calls them equal", async () => {
      const repo = topicRepo();
      write(repo, ".gitattributes", "*.txt text=auto\n");
      write(repo, "eol.txt", "one\ntwo\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "eol");

      write(repo, "eol.txt", "one\r\ntwo\r\n");
      const crlf = await capturePoint(repo);
      write(repo, "eol.txt", "one\ntwo\n");
      const lf = await capturePoint(repo);

      expect(entry(crlf, "eol.txt")?.worktree).toMatchObject({ oid: blob("one\r\ntwo\r\n") });
      expect(entry(lf, "eol.txt")?.worktree).toMatchObject({ oid: blob("one\ntwo\n") });
    });

    posixOnly("identifies what a lossy clean filter would merge", async () => {
      const repo = topicRepo();
      git(repo, "config", "filter.strip.clean", "grep -v SECRET || true");
      write(repo, ".gitattributes", "*.cfg filter=strip\n");
      write(repo, "app.cfg", "a=1\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "cfg");

      write(repo, "app.cfg", "a=1\nSECRET=x\n");
      const withSecret = await capturePoint(repo);
      write(repo, "app.cfg", "a=1\nSECRET=y\n");
      const otherSecret = await capturePoint(repo);

      expect(entry(withSecret, "app.cfg")?.worktree).toMatchObject({
        oid: blob("a=1\nSECRET=x\n"),
      });
      expect(entry(otherSecret, "app.cfg")?.worktree).toMatchObject({
        oid: blob("a=1\nSECRET=y\n"),
      });
    });

    it("sees a change git hides behind assume-unchanged", async () => {
      const repo = topicRepo();
      git(repo, "update-index", "--assume-unchanged", "a.txt");
      write(repo, "a.txt", "hidden\n");
      expect(entry(await capturePoint(repo), "a.txt")?.worktree).toMatchObject({
        oid: blob("hidden\n"),
      });
    });
  });

  describe("limits", () => {
    it("marks a file over the per-file limit unverifiable and the point incomplete", async () => {
      const repo = topicRepo();
      write(repo, "huge.bin", Buffer.alloc(4096, 1));
      write(repo, "small.txt", "s\n");
      const point = await capturePoint(repo, { limits: { maxFileBytes: 1024 } });
      expect(entry(point, "huge.bin")?.worktree).toEqual({
        kind: "unverifiable",
        reason: "file-too-large",
      });
      expect(entry(point, "small.txt")?.worktree).toMatchObject({ kind: "file" });
      expect(point.incomplete).toEqual({
        reasons: ["file-too-large"],
        uncovered: [{ path: "huge.bin", reason: "file-too-large" }],
        uncoveredCount: 1,
      });
    });

    it("stops reading at the total byte budget", async () => {
      const repo = topicRepo();
      write(repo, "one.bin", Buffer.alloc(600, 1));
      write(repo, "two.bin", Buffer.alloc(600, 2));
      const point = await capturePoint(repo, { limits: { maxTotalBytes: 1000 } });
      const read = point.entries.filter((candidate) => candidate.worktree.kind === "file");
      expect(read).toHaveLength(1);
      expect(point.incomplete?.reasons).toEqual(["byte-limit"]);
    });

    it("names the paths past the path limit", async () => {
      const repo = topicRepo();
      for (const name of ["p1", "p2", "p3", "p4", "p5"]) write(repo, name, `${name}\n`);
      const point = await capturePoint(repo, { limits: { maxPaths: 3, maxUncoveredListed: 1 } });
      expect(paths(point)).toEqual(["p1", "p2", "p3"]);
      expect(point.incomplete).toEqual({
        reasons: ["path-limit"],
        uncovered: [{ path: "p4", reason: "path-limit" }],
        uncoveredCount: 2,
      });
    });

    it("lists an untracked directory whole when its files are too many", async () => {
      const repo = topicRepo();
      for (let i = 0; i < 6; i++) write(repo, `many/file-${i}.txt`, `${i}\n`);
      write(repo, "a.txt", "edited\n");
      const point = await capturePoint(repo, { limits: { maxPaths: 3 } });
      expect(paths(point)).toEqual(["a.txt"]);
      expect(point.incomplete).toEqual({
        reasons: ["untracked-directory"],
        uncovered: [{ path: "many/", reason: "untracked-directory" }],
        uncoveredCount: 1,
      });
    });

    it("says so when the change set is too large to list at all", async () => {
      const repo = topicRepo();
      for (let i = 0; i < 40; i++) write(repo, `file-with-a-long-name-${i}.txt`, `${i}\n`);
      const point = await capturePoint(repo, { limits: { maxGitOutputBytes: 1000 } });
      expect(point.entries).toEqual([]);
      expect(point.incomplete).toMatchObject({
        reasons: ["change-set-too-large"],
        uncoveredCount: null,
      });
      expect(point.head.kind).toBe("branch");
    });

    it("fails rather than hang past its time budget", async () => {
      const repo = topicRepo();
      expect(await capture(repo, { limits: { timeoutMs: 1 } })).toMatchObject({
        kind: "failed",
        reason: "deadline",
      });
    });

    it("stops when the caller cancels", async () => {
      const repo = topicRepo();
      const controller = new AbortController();
      controller.abort();
      expect(await capture(repo, { signal: controller.signal })).toMatchObject({
        kind: "failed",
        reason: "cancelled",
      });
    });
  });

  describe("a worktree that changes while it's captured", () => {
    it.each([
      [
        "a file already read is edited again",
        (repo: string) => write(repo, "a.txt", "edited again, longer\n"),
      ],
      ["a new file appears", (repo: string) => write(repo, "appeared.txt", "new\n")],
      ["a file is staged", (repo: string) => git(repo, "add", "a.txt")],
      [
        "the branch is switched at the same commit",
        (repo: string) => git(repo, "checkout", "-q", "-b", "other"),
      ],
    ])("says so when %s", async (_label, mutate) => {
      const repo = topicRepo();
      write(repo, "a.txt", "edited\n");
      const result = await capture(repo, { beforeValidation: async () => mutate(repo) });
      expect(result).toEqual({ kind: "changed-during-capture" });
    });
  });

  describe("where and on what it runs", () => {
    it("captures the main worktree on its base branch", async () => {
      const repo = topicRepo();
      git(repo, "checkout", "-q", "main");
      write(repo, "a.txt", "edited\n");
      const head = git(repo, "rev-parse", "HEAD").trim();
      const point = await capturePoint(repo);
      expect(point.head).toEqual({ kind: "branch", branch: "main", commit: head });
      expect(point.base.mergeBases).toEqual([head]);
      expect(paths(point)).toEqual(["a.txt"]);
    });

    it("captures a linked worktree against the shared repository", async () => {
      const repo = topicRepo();
      const linked = path.join(root, `linked-${repoCount}`);
      git(repo, "worktree", "add", "-q", "-b", "feature", linked, "main");
      write(linked, "b.txt", "linked\n");
      const point = await capturePoint(linked);
      expect(point.worktreePath).toBe(linked);
      expect(point.commonDir).toBe(path.join(repo, ".git"));
      expect(point.gitDir).toBe(path.join(repo, ".git", "worktrees", path.basename(linked)));
      expect(point.head).toMatchObject({ kind: "branch", branch: "feature" });
      expect(paths(point)).toEqual(["b.txt"]);
    });

    it("captures a detached HEAD", async () => {
      const repo = topicRepo();
      const head = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "--detach");
      expect((await capturePoint(repo)).head).toEqual({ kind: "detached", commit: head });
    });

    it("captures an unborn branch", async () => {
      const repo = newDir();
      git(repo, "init", "-q", "-b", "main");
      write(repo, "staged.txt", "s\n");
      git(repo, "add", "staged.txt");
      write(repo, "loose.txt", "l\n");
      const point = await capturePoint(repo);
      expect(point.head).toEqual({ kind: "unborn", branch: "main" });
      expect(point.base).toMatchObject({ tip: null, mergeBases: [] });
      expect(paths(point)).toEqual(["loose.txt", "staged.txt"]);
      expect(point.incomplete).toBeNull();
    });

    it("says the committed change set isn't covered when the base doesn't exist", async () => {
      const repo = topicRepo();
      const point = await capturePoint(repo, { base: { kind: "ref", ref: "refs/heads/missing" } });
      expect(point.base).toMatchObject({ ref: null, tip: null });
      expect(point.incomplete).toMatchObject({ reasons: ["base-unavailable"], uncoveredCount: 0 });
    });

    it("counts every path in HEAD when it shares no history with the base", async () => {
      const repo = topicRepo();
      git(repo, "checkout", "-q", "--orphan", "fresh");
      git(repo, "rm", "-q", "-r", "--cached", ".");
      fs.rmSync(path.join(repo, "a.txt"));
      fs.rmSync(path.join(repo, "b.txt"));
      write(repo, "only.txt", "o\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "orphan");
      const point = await capturePoint(repo);
      expect(point.base.mergeBases).toEqual([]);
      expect(paths(point)).toEqual(["only.txt"]);
    });

    it("covers every merge base when there is more than one", async () => {
      const repo = topicRepo();
      git(repo, "checkout", "-q", "-b", "left", "main");
      write(repo, "left.txt", "l\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "left");
      git(repo, "checkout", "-q", "-b", "right", "main");
      write(repo, "right.txt", "r\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "right");
      git(repo, "checkout", "-q", "-b", "cross-l", "left");
      git(repo, "merge", "-q", "--no-edit", "right");
      git(repo, "checkout", "-q", "-b", "cross-r", "right");
      git(repo, "merge", "-q", "--no-edit", "left");
      const point = await capturePoint(repo, { base: { kind: "ref", ref: "refs/heads/cross-l" } });
      expect(point.base.mergeBases).toHaveLength(2);
    });

    it("leaves a nested repository's contents uncovered", async () => {
      const repo = topicRepo();
      const nested = path.join(repo, "nested");
      fs.mkdirSync(nested);
      git(nested, "init", "-q");
      write(nested, "n.txt", "n\n");
      const point = await capturePoint(repo);
      expect(point.incomplete).toEqual({
        reasons: ["nested-repository"],
        uncovered: [{ path: "nested/", reason: "nested-repository" }],
        uncoveredCount: 1,
      });
    });

    it("refuses a path that isn't a repository, or isn't absolute", async () => {
      expect(await capture(newDir())).toMatchObject({ kind: "failed", reason: "not-a-repository" });
      expect(await capture("relative/path")).toMatchObject({
        kind: "failed",
        reason: "not-a-repository",
      });
    });

    it("refuses a base branch git would read as something else", async () => {
      const repo = topicRepo();
      expect(await capture(repo, { base: { kind: "branch", branch: "-x" } })).toMatchObject({
        kind: "failed",
        reason: "invalid-request",
      });
    });
  });
});
