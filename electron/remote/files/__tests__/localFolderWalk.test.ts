import { execFileSync } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Small enough to cross with real fixture folders; the walk and the shared
// tally read the same mocked limit.
const FILE_LIMIT = vi.hoisted(() => 40);
vi.mock("../../../../shared/types/remoteHosts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../shared/types/remoteHosts.js")>()),
  FOLDER_UPLOAD_MAX_FILES: FILE_LIMIT,
}));

import {
  FOLDER_WALK_MAX_ENTRIES,
  LocalFolderWalkError,
  walkLocalFolder,
  type LocalFolderWalkFs,
  type LocalFolderWalkResult,
} from "../localFolderWalk.js";

const posix = process.platform !== "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lfw-")));
});

afterEach(async () => {
  await fs.chmod(dir, 0o700).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
});

/** Writes `files` (relative path → content, or null for an empty folder) under `dir/<root>`. */
async function fixture(root: string, files: Record<string, string | null>): Promise<string> {
  const base = path.join(dir, root);
  await fs.mkdir(base, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(base, relative);
    if (content === null) {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  return base;
}

function walk(localPath: string, options: Partial<Parameters<typeof walkLocalFolder>[1]> = {}) {
  return walkLocalFolder(localPath, {
    signal: new AbortController().signal,
    // A stand-in filesystem is POSIX unless a test says otherwise, so one
    // that models no parent folder runs the same on a Windows runner.
    platform: options.fs && "lstated" in options.fs ? "linux" : undefined,
    ...options,
  });
}

function ready(result: LocalFolderWalkResult) {
  if (result.status !== "ready") throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  return result;
}

function refused(result: LocalFolderWalkResult) {
  if (result.status !== "refused") throw new Error("expected a refusal");
  return result;
}

/** The node filesystem, counting the items it was asked about. */
function countingFs(): { fs: LocalFolderWalkFs; lstats: () => number } {
  let lstats = 0;
  return {
    fs: {
      opendir: (folder, options) => fs.opendir(folder, options),
      lstat: (target) => {
        lstats += 1;
        return fs.lstat(target);
      },
      readlink: (target) => fs.readlink(target),
      access: (target, mode) => fs.access(target, mode),
    },
    lstats: () => lstats,
  };
}

describe("walking a dropped folder", () => {
  it("summarizes nested files and empty folders, root first and each folder before what it holds", async () => {
    const root = await fixture("Project", {
      "README.md": "hello",
      "src/app.ts": "x".repeat(100),
      "src/lib/util.ts": "y".repeat(10),
      "empty/": null,
      "deep/er/est/": null,
    });
    if (posix) await fs.chmod(path.join(root, "src/app.ts"), 0o755);

    const { summary, snapshot } = ready(await walk(root));

    expect(summary.rootName).toBe("Project");
    expect(summary.lowerBound).toBe(false);
    expect(summary.totals).toEqual({ fileCount: 3, folderCount: 6, totalBytes: 115 });
    expect(summary.notCopied).toEqual({ count: 0, items: [] });
    expect(summary.largest.map((item) => [item.path, item.totalBytes])).toEqual([
      ["Project/src/", 110],
      ["Project/README.md", 5],
      ["Project/deep/", 0],
      ["Project/empty/", 0],
    ]);
    expect(summary.largest[0]).toMatchObject({ kind: "folder", fileCount: 2, folderCount: 2 });

    expect(snapshot.entries.map((entry) => entry.path)).toEqual([
      "Project/",
      "Project/README.md",
      "Project/deep/",
      "Project/deep/er/",
      "Project/deep/er/est/",
      "Project/empty/",
      "Project/src/",
      "Project/src/app.ts",
      "Project/src/lib/",
      "Project/src/lib/util.ts",
    ]);
    const app = snapshot.entries.find((entry) => entry.path === "Project/src/app.ts")!;
    expect(app).toMatchObject({ kind: "file", size: 100, executable: posix });
    const stat = await fs.lstat(path.join(root, "src/app.ts"));
    expect(app.ino).toBe(stat.ino);
    expect(app.mtimeMs).toBe(stat.mtimeMs);
    expect(snapshot.entries.find((entry) => entry.path === "Project/README.md")).toMatchObject({
      executable: false,
    });
  });

  it.skipIf(!posix)(
    "lists symlinks, dangling ones included, as not copied and never follows them",
    async () => {
      const outside = await fixture("outside", { "secret.txt": "s".repeat(1000) });
      const root = await fixture("Root", { "a.txt": "a" });
      await fs.symlink(outside, path.join(root, "linked-folder"));
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "linked-file"));
      await fs.symlink(path.join(dir, "nowhere"), path.join(root, "dangling"));

      const { summary, snapshot } = ready(await walk(root));

      expect(summary.totals).toEqual({ fileCount: 1, folderCount: 0, totalBytes: 1 });
      expect(summary.notCopied.count).toBe(3);
      expect(summary.notCopied.items.map((item) => [item.path, item.reason]).sort()).toEqual([
        ["Root/dangling", "symlink"],
        ["Root/linked-file", "symlink"],
        ["Root/linked-folder", "symlink"],
      ]);
      expect(snapshot.entries.map((entry) => entry.path)).toEqual(["Root/", "Root/a.txt"]);
      expect(snapshot.notCopied).toHaveLength(3);
    }
  );

  it.skipIf(!posix)("lists a FIFO as a special file without opening it", async () => {
    const root = await fixture("Root", { "a.txt": "a" });
    execFileSync("mkfifo", [path.join(root, "pipe")]);

    // A FIFO opened for reading would block until a writer came: finishing at
    // all shows it was never opened.
    const { summary } = ready(await walk(root));

    expect(summary.notCopied.items).toEqual([{ path: "Root/pipe", reason: "special-file" }]);
    expect(summary.totals.fileCount).toBe(1);
  });

  it("counts hidden files and folders, and names the outermost of them", async () => {
    const root = await fixture("Root", {
      ".env": "KEY=1",
      ".git/HEAD": "ref",
      ".git/objects/ab/cdef": "zz",
      "src/.eslintrc": "{}",
      "src/index.ts": "x",
    });

    const { summary, snapshot } = ready(await walk(root));

    expect(summary.hidden).toEqual({
      fileCount: 4,
      folderCount: 3,
      totalBytes: 5 + 3 + 2 + 2,
      paths: ["Root/.env", "Root/.git/", "Root/src/.eslintrc"],
    });
    expect(summary.totals.fileCount).toBe(5);
    expect(snapshot.entries.some((entry) => entry.path === "Root/.git/objects/ab/cdef")).toBe(true);
  });

  it("refuses names a case-insensitive disk would merge, naming the pair", async () => {
    const root = await fixture("Root", { "readme.md": "a" });
    const caseSensitive = await fs
      .writeFile(path.join(root, "README.md"), "b", { flag: "wx" })
      .then(() => true)
      .catch(() => false);
    if (!caseSensitive) return;

    const { problem, summary } = refused(await walk(root));

    expect(problem.kind).toBe("clash");
    expect(problem.kind === "clash" && [...problem.paths].sort()).toEqual([
      "Root/README.md",
      "Root/readme.md",
    ]);
    expect(summary.lowerBound).toBe(true);
  });

  it("refuses a case clash between a file and a folder on any disk", async () => {
    const walkFs = fakeFs({
      "/x/Root": { listed: "dir" },
      "/x/Root/Docs": { listed: "file", size: 3 },
      "/x/Root/docs": { listed: "dir" },
    });

    const { problem } = refused(await walk("/x/Root", { fs: walkFs }));

    expect(problem).toEqual({ kind: "clash", paths: ["Root/Docs", "Root/docs/"] });
  });

  it("refuses a folder one file past the file limit, naming its largest contributors", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < FILE_LIMIT; i++) files[`many/f${i}.txt`] = "";
    files["one.txt"] = "1";
    const root = await fixture("Root", files);

    const { problem, summary } = refused(await walk(root));

    expect(problem).toEqual({
      kind: "limit",
      limit: "files",
      maximum: FILE_LIMIT,
      actual: FILE_LIMIT + 1,
      paths: ["Root/many/", "Root/one.txt"],
    });
    expect(summary.totals.fileCount).toBe(FILE_LIMIT + 1);
    expect(summary.lowerBound).toBe(true);
  });

  it("stops a folder far past the file limit as soon as it is proven over, and says at least", async () => {
    const files: Record<string, string> = {};
    for (const folder of ["a", "b", "c"]) {
      for (let i = 0; i < FILE_LIMIT * 5; i++) files[`${folder}/f${i}.txt`] = "";
    }
    const root = await fixture("Root", files);
    const counting = countingFs();

    const { problem, summary } = refused(await walk(root, { fs: counting.fs }));

    expect(problem.kind === "limit" && problem.limit).toBe("files");
    expect(summary.lowerBound).toBe(true);
    expect(summary.totals.fileCount).toBe(FILE_LIMIT + 1);
    // Root, its three folders, then files: far fewer than the 600 there are.
    expect(counting.lstats()).toBeLessThan(FILE_LIMIT * 3);
    // Only the folder walked first holds any files yet; which one that is is
    // up to the disk's listing order.
    expect(problem.kind === "limit" && problem.paths).toHaveLength(1);
    expect(["Root/a/", "Root/b/", "Root/c/"]).toContain(
      problem.kind === "limit" && problem.paths[0]
    );
  });

  it("refuses a folder past the size limit without reading the files", async () => {
    const root = await fixture("Root", { "a/": null, "b/": null, "small.txt": "s" });
    // Sparse: their size is what is counted, and no content is written.
    for (const name of ["a/big.bin", "b/big.bin"]) {
      const handle = await fs.open(path.join(root, name), "w");
      await handle.truncate(300 * 1024 * 1024);
      await handle.close();
    }

    const { problem, summary } = refused(await walk(root));

    expect(problem).toMatchObject({ kind: "limit", limit: "bytes", maximum: 500 * 1024 * 1024 });
    expect(problem.kind === "limit" && problem.actual).toBeGreaterThan(500 * 1024 * 1024);
    expect(problem.kind === "limit" && problem.paths.slice(0, 2).sort()).toEqual([
      "Root/a/",
      "Root/b/",
    ]);
    expect(summary.lowerBound).toBe(true);
  });

  it("refuses a name the host can't keep apart from a path", async () => {
    if (!posix) return;
    const root = await fixture("Root", { "back\\slash.txt": "x" });

    const { problem } = refused(await walk(root));

    expect(problem).toEqual({ kind: "path", problem: "separator", path: "Root/back\\slash.txt" });
  });

  it.skipIf(!posix || isRoot)(
    "leaves out what can't be read rather than sending it empty",
    async () => {
      const root = await fixture("Root", {
        "ok.txt": "ok",
        "locked/inside.txt": "x",
        "sealed.txt": "x",
      });
      await fs.chmod(path.join(root, "locked"), 0o000);
      await fs.chmod(path.join(root, "sealed.txt"), 0o000);
      try {
        const { summary, snapshot } = ready(await walk(root));

        expect(summary.notCopied.items.map((item) => [item.path, item.reason]).sort()).toEqual([
          ["Root/locked", "unreadable"],
          ["Root/sealed.txt", "unreadable"],
        ]);
        expect(summary.totals).toEqual({ fileCount: 1, folderCount: 0, totalBytes: 2 });
        expect(snapshot.entries.map((entry) => entry.path)).toEqual(["Root/", "Root/ok.txt"]);
      } finally {
        await fs.chmod(path.join(root, "locked"), 0o700);
      }
    }
  );

  it.skipIf(!posix)("never follows a dropped link to a folder", async () => {
    const real = await fixture("Real", { "a.txt": "a" });
    const link = path.join(dir, "Link");
    await fs.symlink(real, link);

    await expect(walk(link)).rejects.toMatchObject({ reason: "link" });
  });

  it("refuses a dropped file as not a folder", async () => {
    const file = path.join(dir, "file.txt");
    await fs.writeFile(file, "x");

    await expect(walk(file)).rejects.toMatchObject({ reason: "not-a-folder" });
  });

  it("stops when cancelled", async () => {
    const root = await fixture("Root", { "a/b.txt": "b" });
    const controller = new AbortController();
    controller.abort();

    await expect(walk(root, { signal: controller.signal })).rejects.toBeInstanceOf(
      LocalFolderWalkError
    );
  });

  it("stops mid-walk when cancelled while a listing is slow", async () => {
    const controller = new AbortController();
    let listed!: () => void;
    const listing = new Promise<void>((resolve) => (listed = resolve));
    const base = fakeFs({
      "/x/Root": { listed: "dir" },
      "/x/Root/a": { listed: "dir" },
      "/x/Root/a/f": { listed: "file", size: 1 },
    });
    const slow: LocalFolderWalkFs = {
      ...base,
      lstat: async (target) => {
        if (target === path.join("/x/Root/a", "f")) {
          controller.abort();
          listed();
        }
        return base.lstat(target);
      },
    };

    const walked = walk("/x/Root", { fs: slow, signal: controller.signal });
    await listing;

    await expect(walked).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("gives up on a folder of items it can't copy once it has looked at too many", async () => {
    const tree: Record<string, FakeNode> = {
      "/x/Root": { listed: "dir" },
      "/x/Root/sockets": { listed: "dir" },
    };
    for (let i = 0; i < FOLDER_WALK_MAX_ENTRIES + 50; i++)
      tree[`/x/Root/sockets/s${i}`] = { listed: "fifo" };

    const { problem, summary } = refused(await walk("/x/Root", { fs: fakeFs(tree) }));

    expect(problem).toEqual({
      kind: "walk-limit",
      maximum: FOLDER_WALK_MAX_ENTRIES,
      actual: FOLDER_WALK_MAX_ENTRIES + 1,
      paths: ["Root/sockets/"],
    });
    expect(summary.notCopied.count).toBe(FOLDER_WALK_MAX_ENTRIES);
    expect(summary.lowerBound).toBe(true);
  });

  it("fails rather than summarize a folder swapped while it was listed", async () => {
    const base = fakeFs({
      "/x/Root": { listed: "dir" },
      "/x/Root/a": { listed: "dir" },
      "/x/Root/a/f": { listed: "file", size: 1 },
    });
    let seen = 0;
    const swapped: LocalFolderWalkFs = {
      ...base,
      lstat: async (target) => {
        const stat = await base.lstat(target);
        if (target.split(path.sep).join("/") !== "/x/Root/a") return stat;
        seen += 1;
        return seen === 1 ? stat : ({ ...stat, ino: stat.ino + 1000 } as Stats);
      },
    };

    await expect(walk("/x/Root", { fs: swapped })).rejects.toMatchObject({ reason: "changed" });
  });

  it("reports nothing read from a folder swapped while it was listed, refused or not", async () => {
    const tree: Record<string, FakeNode> = {
      "/x/Root": { listed: "dir" },
      "/x/Root/a": { listed: "dir" },
    };
    for (let i = 0; i <= FILE_LIMIT; i++) tree[`/x/Root/a/secret-${i}`] = { listed: "file" };
    const base = fakeFs(tree);
    let seen = 0;
    const swapped: LocalFolderWalkFs = {
      ...base,
      lstat: async (target) => {
        const stat = await base.lstat(target);
        if (target.split(path.sep).join("/") !== "/x/Root/a") return stat;
        seen += 1;
        // Found and checked before listing as itself, then gone by the end.
        return seen <= 2 ? stat : ({ ...stat, ino: stat.ino + 1000 } as Stats);
      },
    };

    await expect(walk("/x/Root", { fs: swapped })).rejects.toMatchObject({ reason: "changed" });
  });
});

describe("walking on Windows", () => {
  it("tells symlinks and junctions from other reparse points, and follows neither", async () => {
    const walkFs = fakeFs({
      "C:/Users/me": { listed: "dir" },
      "C:/Users/me/Proj": { listed: "dir" },
      "C:/Users/me/Proj/app.exe": { listed: "file", size: 4, mode: 0o100777 },
      // A junction or symlink: listed as a link, and lstat agrees.
      "C:/Users/me/Proj/My Music": { listed: "link", actual: "link" },
      // A WSL socket: listed as a link (any reparse point is), lstat says file.
      "C:/Users/me/Proj/agent.sock": { listed: "link", actual: "file", size: 0 },
      "C:/Users/me/Proj/mount": { listed: "link", actual: "dir" },
    });

    const { summary, snapshot } = ready(
      await walk("C:/Users/me/Proj", { fs: walkFs, platform: "win32" })
    );

    expect(summary.notCopied.items.map((item) => [item.path, item.reason]).sort()).toEqual([
      ["Proj/My Music", "symlink"],
      ["Proj/agent.sock", "reparse-point"],
      ["Proj/mount", "reparse-point"],
    ]);
    expect(summary.totals).toEqual({ fileCount: 1, folderCount: 0, totalBytes: 4 });
    // Windows has no executable bit to carry, whatever stat's mode says.
    expect(snapshot.entries.find((entry) => entry.path === "Proj/app.exe")?.executable).toBe(false);
    // lstat would follow a reparse point it can't read as a link.
    expect(walkFs.lstated.filter((target) => target !== "C:/Users/me/Proj/app.exe")).toEqual([
      "C:/Users/me/Proj",
      "C:/Users/me/Proj",
    ]);
  });

  it("never follows a dropped folder that is itself a reparse point", async () => {
    const walkFs = fakeFs({
      "C:/Users/me": { listed: "dir" },
      "C:/Users/me/Synced": { listed: "link", actual: "dir" },
      "C:/Users/me/Synced/file.txt": { listed: "file", size: 1 },
    });

    await expect(
      walk("C:/Users/me/Synced", { fs: walkFs, platform: "win32" })
    ).rejects.toMatchObject({ reason: "link" });
    expect(walkFs.lstated).toEqual([]);
  });

  it("matches the dropped folder's exact name before a case-folded one", async () => {
    // A case-sensitive directory (WSL can make them) holding a link and a
    // plain folder whose names differ only by case.
    const walkFs = fakeFs({
      "C:/src": { listed: "dir" },
      "C:/src/Proj": { listed: "link", actual: "dir" },
      "C:/src/proj": { listed: "dir" },
      "C:/src/proj/a.txt": { listed: "file", size: 1 },
    });

    const { summary } = ready(await walk("C:/src/proj", { fs: walkFs, platform: "win32" }));

    expect(summary.totals.fileCount).toBe(1);
  });

  it("fails rather than guess when the dropped folder's parent can't settle what it is", async () => {
    const unlisted = fakeFs({
      "C:/Users/me/Proj": { listed: "dir" },
      "C:/Users/me/Proj/a.txt": { listed: "file", size: 1 },
    });
    const missing = fakeFs({
      "C:/Users/me": { listed: "dir" },
      "C:/Users/me/Other": { listed: "dir" },
    });
    const ambiguous = fakeFs({
      "C:/src": { listed: "dir" },
      "C:/src/PROJ": { listed: "dir" },
      "C:/src/Proj": { listed: "link", actual: "dir" },
    });

    for (const [walkFs, root] of [
      [unlisted, "C:/Users/me/Proj"],
      [missing, "C:/Users/me/Proj"],
      [ambiguous, "C:/src/proj"],
    ] as const) {
      await expect(walk(root, { fs: walkFs, platform: "win32" })).rejects.toMatchObject({
        reason: "unreadable",
      });
      expect(walkFs.lstated).toEqual([]);
    }
  });
});

interface FakeNode {
  /** What the folder listing says it is. */
  listed: "file" | "dir" | "link" | "fifo";
  /** What lstat says, when it differs. */
  actual?: "file" | "dir" | "link";
  size?: number;
  mode?: number;
}

/**
 * A filesystem of `tree` (absolute POSIX-style paths), as a listing, lstat and
 * readlink would report it, noting every path lstat was asked about.
 */
function fakeFs(tree: Record<string, FakeNode>): LocalFolderWalkFs & { lstated: string[] } {
  const lstated: string[] = [];
  const inodes = new Map(Object.keys(tree).map((key, index) => [key, index + 1]));
  const children = new Map<string, string[]>();
  for (const key of Object.keys(tree)) {
    const parent = path.posix.dirname(key);
    if (parent === key || !(parent in tree)) continue;
    children.set(parent, [...(children.get(parent) ?? []), key]);
  }
  const node = (target: string): FakeNode => {
    const found = tree[target.split(path.sep).join("/")];
    if (!found) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return found;
  };
  const dirent = (key: string): Dirent => {
    const { listed } = tree[key]!;
    return {
      name: path.posix.basename(key),
      isFile: () => listed === "file",
      isDirectory: () => listed === "dir",
      isSymbolicLink: () => listed === "link",
      isFIFO: () => listed === "fifo",
      isSocket: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
    } as Dirent;
  };
  return {
    async opendir(folder) {
      const key = folder.split(path.sep).join("/");
      const found = node(key);
      if ((found.actual ?? found.listed) !== "dir") {
        throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      }
      const listing = (children.get(key) ?? []).map(dirent);
      return {
        async *[Symbol.asyncIterator]() {
          yield* listing;
        },
        close: async () => {},
      };
    },
    lstated,
    async readlink(target) {
      const found = node(target);
      if (found.listed === "link" && (found.actual ?? "link") === "link") return "C:/elsewhere";
      throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    },
    async lstat(target) {
      const key = target.split(path.sep).join("/");
      lstated.push(key);
      const found = node(key);
      const kind = found.actual ?? found.listed;
      return {
        isFile: () => kind === "file",
        isDirectory: () => kind === "dir",
        isSymbolicLink: () => kind === "link",
        size: found.size ?? 0,
        mode: found.mode ?? 0o100644,
        mtimeMs: 1,
        ctimeMs: 1,
        dev: 1,
        ino: inodes.get(key)!,
      } as Stats;
    },
    async access() {},
  };
}
