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
const linuxOnly = process.platform === "linux" ? it : it.skip;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

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

/**
 * Plain status, the way anything other than the capture would run it, filters
 * and all. Optional locks stay off so it can't refresh the index the capture
 * then reads.
 */
function plainStatus(cwd: string): string {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd,
      env: { ...fixtureEnv(), GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // A failing required filter fails status too; only its side effect matters.
    return "";
  }
}

function write(repo: string, relative: string, content: string | Buffer): void {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function blob(content: string | Buffer, format: "sha1" | "sha256" = "sha1"): string {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

let repoCount = 0;
function newDir(): string {
  const dir = path.join(root, `repo-${++repoCount}`);
  fs.mkdirSync(dir);
  return dir;
}

/** `main` with two files, and `topic` checked out on top of it. */
function topicRepo(objectFormat: "sha1" | "sha256" = "sha1"): string {
  const repo = newDir();
  git(repo, "init", "-q", "-b", "main", `--object-format=${objectFormat}`);
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
  // Every point survives the trip a stored mark takes, refinements included.
  expect(ReviewPointSchema.parse(JSON.parse(JSON.stringify(result.point)))).toEqual(result.point);
  return result.point;
}

function entry(point: ReviewPoint, filePath: string) {
  return point.entries.find((candidate) => candidate.path === filePath);
}

function paths(point: ReviewPoint): string[] {
  return point.entries.map((candidate) => candidate.path);
}

/**
 * Every file and directory under the git dir: bytes, inode and times. A
 * directory's times move when anything is created or removed in it, so even a
 * lock file that came and went shows up.
 */
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

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-review-point-")));
  // The capture's own git reads HOME for global config; keep it on the fixture.
  vi.stubEnv("HOME", root);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterAll(() => {
  vi.unstubAllEnvs();
  // A test may leave an unreadable file behind; make sure cleanup can remove it.
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
    expect(fs.realpathSync.native(point.worktreePath)).toBe(fs.realpathSync.native(repo));
    expect(fs.realpathSync.native(point.gitDir)).toBe(
      fs.realpathSync.native(path.join(repo, ".git"))
    );
    expect(fs.realpathSync.native(point.commonDir)).toBe(
      fs.realpathSync.native(path.join(repo, ".git"))
    );
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
    write(repo, "a.txt", "remote\n");
    git(repo, "commit", "-q", "-am", "remote");
    const remoteTip = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "reset", "-q", "--hard", "main");
    git(repo, "remote", "add", "origin", repo);
    git(repo, "update-ref", "refs/remotes/origin/main", remoteTip);

    const point = await capturePoint(repo, { base: { kind: "branch", branch: "main" } });
    // The remote-tracking ref wins over the local branch, as on the card.
    expect(point.base).toMatchObject({ ref: "refs/remotes/origin/main", tip: remoteTip });
  });

  describe("never writes to the repository", () => {
    posixOnly("leaves objects, the index, refs and every other git file as they were", async () => {
      const repo = topicRepo();
      const cleanRan = path.join(root, `clean-ran-${repoCount}`);
      const processRan = path.join(root, `process-ran-${repoCount}`);
      write(repo, "f.spy", "x\n");
      write(repo, "f.proc", "x\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "filtered files");
      // Filters that leave a trace, the way git-lfs's would write into .git/lfs.
      git(repo, "config", "filter.spy.clean", `sh -c 'touch "${cleanRan}"; cat'`);
      git(repo, "config", "filter.spy.required", "true");
      git(repo, "config", "filter.proc.process", `sh -c 'touch "${processRan}"; exit 1'`);
      // Not required, so its failure leaves status going on to the next file.
      git(repo, "config", "filter.proc.required", "false");
      write(repo, ".git/info/attributes", "*.spy filter=spy\n*.proc filter=proc\n");
      // Same size, later mtime: git can only tell by hashing the content.
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(repo, "f.spy"), later, later);
      fs.utimesSync(path.join(repo, "f.proc"), later, later);
      write(repo, "a.txt", "dirty\n");
      write(repo, "b.txt", "staged\n");
      git(repo, "add", "b.txt");
      write(repo, "u.txt", "untracked\n");

      // The fixture is armed: a plain status runs both filters.
      plainStatus(repo);
      expect(fs.existsSync(cleanRan) && fs.existsSync(processRan)).toBe(true);
      fs.rmSync(cleanRan);
      fs.rmSync(processRan);

      const objectsBefore = git(repo, "count-objects", "-v");
      const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
      const before = snapshot(path.join(repo, ".git"));

      await capturePoint(repo);

      expect(git(repo, "count-objects", "-v")).toBe(objectsBefore);
      expect(fs.readFileSync(path.join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
      expect(snapshot(path.join(repo, ".git"))).toEqual(before);
      expect(fs.existsSync(cleanRan)).toBe(false);
      expect(fs.existsSync(processRan)).toBe(false);
    });

    linuxOnly("refuses to run when a filter's name can't be switched off exactly", async () => {
      const repo = topicRepo();
      const config = path.join(repo, ".git", "config");
      fs.appendFileSync(
        config,
        Buffer.concat([
          Buffer.from('[filter "bad'),
          Buffer.from([0xff]),
          Buffer.from('"]\n\tclean = cat\n'),
        ])
      );
      expect(await capture(repo)).toMatchObject({ kind: "failed", reason: "git-failed" });
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

  describe("index states", () => {
    it("records intent-to-add, with and without its file", async () => {
      const repo = topicRepo();
      write(repo, "ita.txt", "later\n");
      git(repo, "add", "-N", "ita.txt");
      expect(entry(await capturePoint(repo), "ita.txt")).toEqual({
        path: "ita.txt",
        head: null,
        index: { kind: "intent-to-add", mode: "100644" },
        worktree: { kind: "file", mode: "100644", oid: blob("later\n"), size: 6 },
      });

      // Status reports HEAD's side from the index once the file is gone.
      fs.rmSync(path.join(repo, "ita.txt"));
      expect(entry(await capturePoint(repo), "ita.txt")).toEqual({
        path: "ita.txt",
        head: null,
        index: { kind: "intent-to-add", mode: "100644" },
        worktree: { kind: "absent" },
      });
    });

    it("records intent-to-add even when its placeholder matches HEAD", async () => {
      const repo = topicRepo();
      write(repo, "empty.txt", "");
      git(repo, "add", "empty.txt");
      git(repo, "commit", "-q", "-m", "empty");
      git(repo, "rm", "-q", "--cached", "empty.txt");
      git(repo, "add", "-N", "empty.txt");
      expect(entry(await capturePoint(repo), "empty.txt")).toMatchObject({
        head: { mode: "100644", oid: blob("") },
        index: { kind: "intent-to-add", mode: "100644" },
      });
    });

    posixOnly(
      "takes an intent-to-add file's mode when git ignores the executable bit",
      async () => {
        const repo = topicRepo();
        write(repo, "run.sh", "#!/bin/sh\n");
        fs.chmodSync(path.join(repo, "run.sh"), 0o755);
        git(repo, "add", "-N", "run.sh");
        git(repo, "config", "core.fileMode", "false");
        fs.chmodSync(path.join(repo, "run.sh"), 0o644);
        expect(entry(await capturePoint(repo), "run.sh")).toMatchObject({
          index: { kind: "intent-to-add", mode: "100755" },
          worktree: { kind: "file", mode: "100755" },
        });
      }
    );

    it("keeps a staged empty file apart from intent-to-add", async () => {
      const repo = topicRepo();
      write(repo, "empty.txt", "");
      git(repo, "add", "empty.txt");
      fs.rmSync(path.join(repo, "empty.txt"));
      expect(entry(await capturePoint(repo), "empty.txt")?.index).toEqual({
        kind: "entry",
        mode: "100644",
        oid: blob(""),
      });
    });

    it("records each conflicted stage and HEAD's side", async () => {
      const repo = topicRepo();
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

    it("sees a change git hides behind assume-unchanged", async () => {
      const repo = topicRepo();
      git(repo, "update-index", "--assume-unchanged", "a.txt");
      write(repo, "a.txt", "hidden\n");
      expect(entry(await capturePoint(repo), "a.txt")?.worktree).toMatchObject({
        oid: blob("hidden\n"),
      });
    });

    it("sees a skip-worktree file only once it's on disk", async () => {
      const repo = topicRepo();
      git(repo, "update-index", "--skip-worktree", "a.txt");
      fs.rmSync(path.join(repo, "a.txt"));
      expect((await capturePoint(repo)).entries).toEqual([]);

      write(repo, "a.txt", "materialised\n");
      expect(entry(await capturePoint(repo), "a.txt")?.worktree).toMatchObject({
        oid: blob("materialised\n"),
      });
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

    posixOnly("takes the mode from the index when git ignores the executable bit", async () => {
      const repo = topicRepo();
      git(repo, "config", "core.fileMode", "false");
      fs.chmodSync(path.join(repo, "a.txt"), 0o755);
      write(repo, "a.txt", "edited\n");
      expect(entry(await capturePoint(repo), "a.txt")?.worktree).toMatchObject({
        mode: "100644",
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

    posixOnly("reads a link checked out as a file when core.symlinks is off", async () => {
      const repo = topicRepo();
      fs.symlinkSync("a.txt", path.join(repo, "link"));
      git(repo, "add", "link");
      git(repo, "commit", "-q", "-m", "link");
      git(repo, "config", "core.symlinks", "false");
      fs.rmSync(path.join(repo, "link"));
      write(repo, "link", "a.txt");
      expect(entry(await capturePoint(repo), "link")?.worktree).toEqual({
        kind: "symlink",
        oid: blob("a.txt"),
      });
    });

    posixOnly("never follows a directory replaced by a symlink", async () => {
      const repo = topicRepo();
      write(repo, "dir/file.txt", "inside\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "dir");
      const outside = newDir();
      write(outside, "file.txt", "outside\n");
      fs.rmSync(path.join(repo, "dir"), { recursive: true });
      fs.symlinkSync(outside, path.join(repo, "dir"));
      const point = await capturePoint(repo);
      expect(entry(point, "dir/file.txt")?.worktree).toEqual({ kind: "absent" });
    });

    posixOnly("records a file replaced by a directory as a directory", async () => {
      const repo = topicRepo();
      fs.rmSync(path.join(repo, "a.txt"));
      write(repo, "a.txt/inner", "x\n");
      const point = await capturePoint(repo);
      expect(entry(point, "a.txt")?.worktree).toEqual({ kind: "directory" });
      expect(entry(point, "a.txt/inner")?.worktree).toMatchObject({ kind: "file" });
    });

    posixOnly("never opens a FIFO", async () => {
      const repo = topicRepo();
      fs.rmSync(path.join(repo, "a.txt"));
      execFileSync("mkfifo", [path.join(repo, "a.txt")]);
      const point = await capturePoint(repo);
      expect(entry(point, "a.txt")?.worktree).toEqual({
        kind: "unverifiable",
        reason: "special-file",
      });
      expect(point.incomplete?.reasons).toEqual(["special-file"]);
    });

    (isRoot || process.platform === "win32" ? it.skip : it)(
      "marks a file it can't read unverifiable",
      async () => {
        const repo = topicRepo();
        write(repo, "a.txt", "secret\n");
        fs.chmodSync(path.join(repo, "a.txt"), 0o000);
        try {
          const point = await capturePoint(repo);
          expect(entry(point, "a.txt")?.worktree).toEqual({
            kind: "unverifiable",
            reason: "unreadable",
          });
        } finally {
          fs.chmodSync(path.join(repo, "a.txt"), 0o644);
        }
      }
    );

    describe("submodules", () => {
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
        expect(point.incomplete).toEqual({
          reasons: ["submodule-contents"],
          uncovered: [{ path: "sub", reason: "submodule-contents" }],
          uncoveredCount: 1,
        });
      });

      it("says it can't vouch for files the submodule was told not to look at", async () => {
        const { repo, sub, commit } = withSubmodule();
        git(sub, "update-index", "--assume-unchanged", "s.txt");
        write(sub, "s.txt", "hidden\n");
        expect(entry(await capturePoint(repo), "sub")?.worktree).toEqual({
          kind: "submodule",
          commit,
          contents: "unknown",
        });
      });

      it("treats an unpopulated submodule as git does", async () => {
        const { repo } = withSubmodule();
        git(repo, "submodule", "deinit", "-q", "-f", "sub");
        const point = await capturePoint(repo);
        expect(point.entries).toEqual([]);
        expect(point.incomplete).toBeNull();

        write(repo, "sub/stray.txt", "x\n");
        expect(entry(await capturePoint(repo), "sub")?.worktree).toEqual({
          kind: "submodule",
          commit: null,
          contents: "unknown",
        });
      });

      it.each([
        ["left out as clean", false],
        ["listed as moved", true],
      ])("notices its contents changing while it's captured, %s", async (_label, move) => {
        const { repo, sub } = withSubmodule();
        if (move) {
          write(sub, "s.txt", "s2\n");
          git(sub, "commit", "-q", "-am", "s2");
        }
        const result = await capture(repo, {
          beforeValidation: async () => write(sub, "s.txt", "edited mid-capture\n"),
        });
        expect(result).toEqual({ kind: "changed-during-capture" });
      });
    });
  });

  describe("paths", () => {
    posixOnly("keeps unusual names exactly as git spells them, in byte order", async () => {
      const repo = topicRepo();
      const names = [
        "tab\tname.txt",
        "new\nline.txt",
        'quote"name.txt',
        "space name.txt",
        "-leading-dash.txt",
        "back\\slash.txt",
        "日本語.txt",
        "Zebra.txt",
      ];
      for (const name of names) write(repo, name, `${name}\n`);
      const point = await capturePoint(repo);
      const expected = names.slice().sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      expect(paths(point)).toEqual(expected);
      for (const name of names) {
        expect(entry(point, name)?.worktree).toMatchObject({ oid: blob(`${name}\n`) });
        expect(entry(point, name)?.pathBytes).toBeUndefined();
      }
    });

    posixOnly("keeps a name that starts with a byte order mark", async () => {
      const repo = topicRepo();
      write(repo, "\uFEFFbom.txt", "bom\n");
      const point = await capturePoint(repo);
      expect(paths(point)).toEqual(["\uFEFFbom.txt"]);
      expect(point.entries[0]?.pathBytes).toBeUndefined();
    });

    it("never folds case", async () => {
      const repo = topicRepo();
      write(repo, "Case.txt", "upper\n");
      write(repo, "case.txt", "lower\n");
      const listed = fs.readdirSync(repo);
      const point = await capturePoint(repo);
      if (listed.includes("Case.txt") && listed.includes("case.txt")) {
        expect(entry(point, "Case.txt")?.worktree).toMatchObject({ oid: blob("upper\n") });
        expect(entry(point, "case.txt")?.worktree).toMatchObject({ oid: blob("lower\n") });
      } else {
        // One file on disk, under the name it was created with.
        expect(paths(point)).toEqual(["Case.txt"]);
      }
    });

    // macOS and Windows refuse names that aren't valid UTF-8; Linux keeps them.
    linuxOnly(
      "keeps names that aren't valid UTF-8 as bytes, even when they display alike",
      async () => {
        const repo = topicRepo();
        const first = Buffer.from([0x62, 0xff, 0x2e, 0x74]);
        const second = Buffer.from([0x62, 0xfe, 0x2e, 0x74]);
        fs.writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), first]), "first\n");
        fs.writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), second]), "second\n");
        const point = await capturePoint(repo);
        const byBytes = new Map(point.entries.map((item) => [item.pathBytes, item]));
        expect(point.entries).toHaveLength(2);
        expect(point.entries[0].path).toBe(point.entries[1].path);
        expect(byBytes.get(first.toString("base64"))?.worktree).toMatchObject({
          oid: blob("first\n"),
        });
        expect(byBytes.get(second.toString("base64"))?.worktree).toMatchObject({
          oid: blob("second\n"),
        });
      }
    );
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

    posixOnly("finds an edit a many-to-one clean filter hides from git", async () => {
      const repo = newDir();
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "filter.fold.clean", "tr X '\\n'");
      write(repo, ".gitattributes", "*.cfg filter=fold\n");
      write(repo, "app.cfg", "a=1\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "cfg");
      // Committed on the base, so only the working tree can bring it into the change set.
      git(repo, "checkout", "-q", "-b", "topic");

      // Same size, later mtime, and the same bytes once cleaned.
      write(repo, "app.cfg", "a=1X");
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(repo, "app.cfg"), later, later);
      expect(plainStatus(repo)).toBe("");

      expect(entry(await capturePoint(repo), "app.cfg")?.worktree).toMatchObject({
        oid: blob("a=1X"),
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

    posixOnly("counts link text against the byte budget", async () => {
      const repo = topicRepo();
      fs.symlinkSync("a.txt", path.join(repo, "link"));
      expect(
        entry(await capturePoint(repo, { limits: { maxTotalBytes: 0 } }), "link")?.worktree
      ).toEqual({
        kind: "unverifiable",
        reason: "byte-limit",
      });
    });

    it("hashes a file across many read chunks", async () => {
      const repo = topicRepo();
      const big = Buffer.alloc(600 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = i % 251;
      write(repo, "big.bin", big);
      expect(entry(await capturePoint(repo), "big.bin")?.worktree).toMatchObject({
        oid: blob(big),
        size: big.length,
      });
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

    it("stops when the caller cancels, before or during the capture", async () => {
      const repo = topicRepo();
      const before = new AbortController();
      before.abort();
      expect(await capture(repo, { signal: before.signal })).toMatchObject({
        kind: "failed",
        reason: "cancelled",
      });

      const during = new AbortController();
      const result = await capture(repo, {
        signal: during.signal,
        beforeValidation: async () => during.abort(),
      });
      expect(result).toMatchObject({ kind: "failed", reason: "cancelled" });
    });
  });

  describe("a worktree that changes while it's captured", () => {
    it.each([
      [
        "a file already read is edited again",
        (repo: string) => write(repo, "a.txt", "edited again, longer\n"),
      ],
      ["a new file appears", (repo: string) => write(repo, "appeared.txt", "new\n")],
      [
        "the index is rewritten",
        (repo: string) => git(repo, "update-index", "--assume-unchanged", "b.txt"),
      ],
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
      expect(fs.realpathSync.native(point.worktreePath)).toBe(fs.realpathSync.native(linked));
      expect(fs.realpathSync.native(point.commonDir)).toBe(
        fs.realpathSync.native(path.join(repo, ".git"))
      );
      expect(fs.realpathSync.native(point.gitDir)).toBe(
        fs.realpathSync.native(path.join(repo, ".git", "worktrees", path.basename(linked)))
      );
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
      expect(point.incomplete).toBeNull();
      expect(point.entries).toEqual([
        {
          path: "loose.txt",
          head: null,
          index: { kind: "absent" },
          worktree: { kind: "file", mode: "100644", oid: blob("l\n"), size: 2 },
        },
        {
          path: "staged.txt",
          head: null,
          index: { kind: "entry", mode: "100644", oid: blob("s\n") },
          worktree: { kind: "file", mode: "100644", oid: blob("s\n"), size: 2 },
        },
      ]);
    });

    it("captures a SHA-256 repository", async () => {
      let repo: string;
      try {
        repo = topicRepo("sha256");
      } catch {
        // A git built without SHA-256 support.
        return;
      }
      write(repo, "a.txt", "edited\n");
      const point = await capturePoint(repo);
      expect(point.objectFormat).toBe("sha256");
      expect(entry(point, "a.txt")).toMatchObject({
        head: { oid: blob("a\n", "sha256") },
        worktree: { oid: blob("edited\n", "sha256") },
      });
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
      // Each base contributes the path the other one already has.
      expect(paths(point)).toEqual(["left.txt", "right.txt"]);
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
