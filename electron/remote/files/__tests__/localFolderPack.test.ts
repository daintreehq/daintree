import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  folderPackDir,
  LocalFolderPackError,
  packLocalFolder,
  sweepFolderPacks,
  type FolderPackProgress,
  type LocalFolderPackResult,
} from "../localFolderPack.js";
import { walkLocalFolder, type FolderSnapshot } from "../localFolderWalk.js";

const posix = process.platform !== "win32";

let dir: string;
let packs: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lfp-")));
  packs = path.join(dir, "packs");
});

afterEach(async () => {
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

async function summarize(localPath: string): Promise<FolderSnapshot> {
  const walked = await walkLocalFolder(localPath, { signal: new AbortController().signal });
  if (walked.status !== "ready") throw new Error("expected a ready folder");
  return walked.snapshot;
}

function packResult(
  snapshot: FolderSnapshot,
  options: { signal?: AbortSignal; onProgress?: (progress: FolderPackProgress) => void } = {}
): Promise<LocalFolderPackResult> {
  return packLocalFolder(snapshot, {
    signal: options.signal ?? new AbortController().signal,
    onProgress: options.onProgress,
    dir: packs,
  });
}

async function pack(snapshot: FolderSnapshot, options: Parameters<typeof packResult>[1] = {}) {
  const result = await packResult(snapshot, options);
  if (result.status !== "packed") throw new Error(`expected a packed folder, got ${result.status}`);
  return result.archive;
}

async function changedBy(promise: Promise<LocalFolderPackResult>) {
  const result = await promise;
  if (result.status !== "changed") throw new Error("expected the pack to find a change");
  return result;
}

async function packFailure(promise: Promise<unknown>): Promise<LocalFolderPackError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(LocalFolderPackError);
  return error as LocalFolderPackError;
}

async function archivesLeft(): Promise<string[]> {
  return fs.readdir(packs).catch(() => []);
}

interface ReadEntry {
  path: string;
  mode: number;
  flags: number;
  data: Buffer;
}

/**
 * Reads a folder archive as strictly as the host does: the end record is the
 * last 22 bytes, every central record agrees with its local header and data
 * descriptor, and the entries tile the archive with nothing between them.
 */
function readArchive(archive: Buffer): ReadEntry[] {
  const endAt = archive.byteLength - 22;
  expect(archive.readUInt32LE(endAt)).toBe(0x06054b50);
  expect(archive.readUInt16LE(endAt + 20)).toBe(0);
  const count = archive.readUInt16LE(endAt + 10);
  expect(archive.readUInt16LE(endAt + 8)).toBe(count);
  const centralSize = archive.readUInt32LE(endAt + 12);
  const centralOffset = archive.readUInt32LE(endAt + 16);
  expect(centralOffset + centralSize).toBe(endAt);

  const entries: ReadEntry[] = [];
  let expectedOffset = 0;
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(archive.readUInt16LE(cursor + 4) >> 8).toBe(3);
    const flags = archive.readUInt16LE(cursor + 8);
    expect(archive.readUInt16LE(cursor + 10)).toBe(0);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressed = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    expect(compressed).toBe(size);
    const nameLength = archive.readUInt16LE(cursor + 28);
    expect(archive.readUInt16LE(cursor + 30)).toBe(0);
    expect(archive.readUInt16LE(cursor + 32)).toBe(0);
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    const offset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength;

    expect(offset).toBe(expectedOffset);
    expect(archive.readUInt32LE(offset)).toBe(0x04034b50);
    expect(archive.readUInt16LE(offset + 6)).toBe(flags);
    expect(archive.readUInt16LE(offset + 8)).toBe(0);
    expect(archive.readUInt16LE(offset + 26)).toBe(nameLength);
    expect(archive.readUInt16LE(offset + 28)).toBe(0);
    expect(archive.subarray(offset + 30, offset + 30 + nameLength).equals(name)).toBe(true);
    const descriptor = (flags & 0x0008) !== 0;
    const local = [14, 18, 22].map((at) => archive.readUInt32LE(offset + at));
    expect(local).toEqual(descriptor ? [0, 0, 0] : [crc, size, size]);
    const dataStart = offset + 30 + nameLength;
    const data = archive.subarray(dataStart, dataStart + size);
    expect(zlib.crc32(data)).toBe(crc);
    let end = dataStart + size;
    if (descriptor) {
      expect(archive.readUInt32LE(end)).toBe(0x08074b50);
      expect([4, 8, 12].map((at) => archive.readUInt32LE(end + at))).toEqual([crc, size, size]);
      end += 16;
    }
    expectedOffset = end;
    entries.push({ path: name.toString("utf8"), mode, flags, data: Buffer.from(data) });
  }
  expect(expectedOffset).toBe(centralOffset);
  expect(cursor).toBe(endAt);
  return entries;
}

describe("packing a summarized folder", () => {
  it("packs exactly the summarized entries and reads back entry by entry", async () => {
    const files = {
      "README.md": "# Project\n",
      "src/app.ts": "export const app = 1;\n",
      "src/lib/deep/util.ts": "export {};\n",
      "empty/": null,
      "zero.txt": "",
      ".env": "SECRET=1\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "bin/run.sh": "#!/bin/sh\necho hi\n",
      "émoji 🎉.txt": "unicode name",
    };
    const root = await fixture("Project", files);
    if (posix) await fs.chmod(path.join(root, "bin/run.sh"), 0o755);
    const snapshot = await summarize(root);

    const packed = await pack(snapshot);

    const bytes = await fs.readFile(packed.path);
    expect(packed.archiveBytes).toBe(bytes.byteLength);
    expect(packed.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    expect(path.dirname(packed.path)).toBe(packs);
    const entries = readArchive(bytes);
    expect(entries.map((entry) => entry.path)).toEqual(snapshot.entries.map((entry) => entry.path));
    for (const [i, entry] of entries.entries()) {
      const summarized = snapshot.entries[i]!;
      expect(entry.flags & 0x0800).toBe(0x0800);
      if (summarized.kind === "folder") {
        expect(entry.mode).toBe(0o040700);
        expect(entry.data.byteLength).toBe(0);
        expect(entry.flags & 0x0008).toBe(0);
        continue;
      }
      const relative = summarized.path.split("/").slice(1).join(path.sep);
      expect(entry.data.equals(await fs.readFile(path.join(root, relative)))).toBe(true);
      expect(entry.flags & 0x0008).toBe(0x0008);
      const executable = posix && summarized.path === "Project/bin/run.sh";
      expect(entry.mode).toBe(executable ? 0o100700 : 0o100600);
    }
    expect(entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["Project/", "Project/empty/", "Project/.env", "Project/.git/HEAD"])
    );
    const contents = Object.values(files).filter((content) => content !== null);
    expect(packed.totals).toEqual({
      fileCount: contents.length,
      // src, src/lib, src/lib/deep, empty, .git, bin
      folderCount: 6,
      totalBytes: contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0),
    });
  });

  it("carries no time, so the same folder packs to the same bytes", async () => {
    const root = await fixture("Project", { "a.txt": "a", "b/c.txt": "c" });
    const first = await pack(await summarize(root));
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(root, "a.txt"), later, later);

    const second = await pack(await summarize(root));

    expect(second.sha256).toBe(first.sha256);
  });

  it("keeps the archive and its folder owner-only", async () => {
    if (!posix) return;
    const snapshot = await summarize(await fixture("Project", { "a.txt": "a" }));

    const packed = await pack(snapshot);

    expect((await fs.stat(packs)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(packed.path)).mode & 0o777).toBe(0o600);
  });

  it("leaves out what the summary left out without stopping", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "a.txt": "a" });
    await fs.symlink(path.join(root, "a.txt"), path.join(root, "link.txt"));
    const snapshot = await summarize(root);
    expect(snapshot.notCopied).toEqual([{ path: "Project/link.txt", reason: "symlink" }]);

    const entries = readArchive(await fs.readFile((await pack(snapshot)).path));

    expect(entries.map((entry) => entry.path)).toEqual(["Project/", "Project/a.txt"]);
  });

  it("reports files and bytes as it goes, ending at the totals", async () => {
    const snapshot = await summarize(
      await fixture("Project", { "a.txt": "aaaa", "b/c.txt": "cc", "d/": null })
    );
    const seen: FolderPackProgress[] = [];

    await pack(snapshot, { onProgress: (progress) => seen.push(progress) });

    expect(seen[0]).toEqual({ filesDone: 0, filesTotal: 2, bytesDone: 0, bytesTotal: 6 });
    expect(seen.at(-1)).toEqual({ filesDone: 2, filesTotal: 2, bytesDone: 6, bytesTotal: 6 });
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.bytesDone).toBeGreaterThanOrEqual(seen[i - 1]!.bytesDone);
      expect(seen[i]!.filesDone).toBeGreaterThanOrEqual(seen[i - 1]!.filesDone);
    }
  });

  it("serves the archive as a transfer source per attempt, and removes it once", async () => {
    const snapshot = await summarize(await fixture("Project", { "a.txt": "hello" }));
    const packed = await pack(snapshot);

    const first = await packed.openSource();
    expect(first.size).toBe(packed.archiveBytes);
    expect(first.sha256).toBe(packed.sha256);
    const bytes = Buffer.from(await first.read(0, first.size));
    expect(bytes.equals(await fs.readFile(packed.path))).toBe(true);
    await first.close?.();
    const second = await packed.openSource();

    await Promise.all([packed.remove(), packed.remove()]);
    await packed.remove();

    expect(await archivesLeft()).toEqual([]);
    // Removing closed the source still open.
    await expect(second.read(0, 1)).rejects.toThrow();
    await expect(packed.openSource()).rejects.toThrow();
  });
});

describe("a folder that changed after its summary", () => {
  it("stops when a file grew, naming it, and leaves no archive", async () => {
    const root = await fixture("Project", { "a.txt": "a", "src/grows.ts": "short" });
    const snapshot = await summarize(root);
    await fs.appendFile(path.join(root, "src/grows.ts"), " and longer");

    expect(await packResult(snapshot)).toEqual({
      status: "changed",
      path: "Project/src/grows.ts",
      change: "modified",
    });
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a file shrank", async () => {
    const root = await fixture("Project", { "a.txt": "a long line" });
    const snapshot = await summarize(root);
    await fs.truncate(path.join(root, "a.txt"), 2);

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/a.txt", change: "modified" });
  });

  it("stops when a file was deleted, naming it", async () => {
    const root = await fixture("Project", { "a.txt": "a", "src/gone.ts": "x" });
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "src/gone.ts"));

    expect(await packResult(snapshot)).toEqual({
      status: "changed",
      path: "Project/src/gone.ts",
      change: "gone",
    });
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a summarized folder holds a new file, naming it", async () => {
    const root = await fixture("Project", { "a.txt": "a", "src/app.ts": "x" });
    const snapshot = await summarize(root);
    await fs.writeFile(path.join(root, "src/new.ts"), "y");

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/src/new.ts", change: "new" });
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a file arrives in a folder after the folder was listed", async () => {
    const root = await fixture("Project", { "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    const snapshot = await summarize(root);
    let added = false;

    const result = await changedBy(
      packResult(snapshot, {
        onProgress: (progress) => {
          if (progress.filesDone !== 1 || added) return;
          added = true;
          fsSync.writeFileSync(path.join(root, "late.txt"), "late");
        },
      })
    );

    expect(result).toMatchObject({ path: "Project/late.txt", change: "new" });
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a summarized folder is gone", async () => {
    const root = await fixture("Project", { "a.txt": "a", "empty/": null });
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "empty"), { recursive: true });

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/empty/", change: "gone" });
  });

  it("stops when a file of the same size was written to", async () => {
    const root = await fixture("Project", { "a.txt": "aaaa" });
    const snapshot = await summarize(root);
    await fs.writeFile(path.join(root, "a.txt"), "bbbb");
    const later = new Date(snapshot.entries[1]!.mtimeMs + 5_000);
    await fs.utimes(path.join(root, "a.txt"), later, later);

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/a.txt", change: "modified" });
  });

  it("stops when a file became executable, the one mode bit carried", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "run.sh": "#!/bin/sh\n" });
    const snapshot = await summarize(root);
    await fs.chmod(path.join(root, "run.sh"), 0o755);

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/run.sh", change: "modified" });
  });

  it("stops when a file was swapped for a link, without following it", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "a.txt": "a" });
    const outside = path.join(dir, "outside.txt");
    await fs.writeFile(outside, "a");
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "a.txt"));
    await fs.symlink(outside, path.join(root, "a.txt"));

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/a.txt", change: "type" });
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a folder was swapped for a link to one just like it", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "src/a.txt": "a" });
    const snapshot = await summarize(root);
    await fixture("elsewhere", { "a.txt": "a" });
    await fs.rename(path.join(root, "src"), path.join(dir, "moved"));
    await fs.symlink(path.join(dir, "elsewhere"), path.join(root, "src"));

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/src/", change: "type" });
  });

  it("stops when a file was swapped for a FIFO, without waiting on it", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "src/a.txt": "a" });
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "src/a.txt"));
    execFileSync("mkfifo", [path.join(root, "src/a.txt")]);

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/src/a.txt", change: "type" });
  });

  it("stops when a left-out link was replaced by a file", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "a.txt": "a" });
    await fs.symlink(path.join(root, "a.txt"), path.join(root, "link.txt"));
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "link.txt"));
    await fs.writeFile(path.join(root, "link.txt"), "now a file");

    const result = await changedBy(packResult(snapshot));

    expect(result).toMatchObject({ path: "Project/link.txt", change: "type" });
  });
});

describe("cancelling a pack", () => {
  it("stops midway and leaves no temporary file", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${String(i).padStart(2, "0")}.txt`] = "x".repeat(1000);
    const snapshot = await summarize(await fixture("Project", files));
    const controller = new AbortController();
    let lastProgress: FolderPackProgress | null = null;

    const error = await packFailure(
      packResult(snapshot, {
        signal: controller.signal,
        onProgress: (progress) => {
          lastProgress = progress;
          if (progress.filesDone === 5) controller.abort();
        },
      })
    );

    expect(error.reason).toBe("cancelled");
    expect(lastProgress).toMatchObject({ filesDone: 5 });
    expect(await archivesLeft()).toEqual([]);
  });

  it("refuses at once when already cancelled", async () => {
    const snapshot = await summarize(await fixture("Project", { "a.txt": "a" }));
    const controller = new AbortController();
    controller.abort();

    expect((await packFailure(packResult(snapshot, { signal: controller.signal }))).reason).toBe(
      "cancelled"
    );
    expect(await archivesLeft()).toEqual([]);
  });
});

describe("the startup sweep", () => {
  const archiveName = () => `${crypto.randomBytes(16).toString("hex")}.zip`;

  it("removes a stale archive and leaves everything else alone", async () => {
    await fs.mkdir(packs, { recursive: true, mode: 0o700 });
    const stale = [archiveName(), archiveName()];
    const unrelated = ["notes.txt", `${archiveName()}.bak`, "123-abc.zip", archiveName().toUpperCase()];
    for (const name of [...stale, ...unrelated]) await fs.writeFile(path.join(packs, name), "x");
    const folderNamedLikeOne = archiveName();
    await fs.mkdir(path.join(packs, folderNamedLikeOne));
    const outside = path.join(dir, archiveName());
    await fs.writeFile(outside, "x");
    const linkNamedLikeOne = archiveName();
    if (posix) await fs.symlink(outside, path.join(packs, linkNamedLikeOne));

    expect(await sweepFolderPacks(packs)).toBe(stale.length);

    const left = await fs.readdir(packs);
    expect(left.sort()).toEqual(
      [...unrelated, folderNamedLikeOne, ...(posix ? [linkNamedLikeOne] : [])].sort()
    );
    await expect(fs.stat(outside)).resolves.toBeTruthy();
  });

  it("never removes an archive this process is still holding", async () => {
    const snapshot = await summarize(await fixture("Project", { "a.txt": "a" }));
    const packed = await pack(snapshot);

    expect(await sweepFolderPacks(packs)).toBe(0);
    await expect(fs.stat(packed.path)).resolves.toBeTruthy();

    await packed.remove();
    await fs.writeFile(packed.path, "left behind");
    expect(await sweepFolderPacks(packs)).toBe(1);
  });

  it("never sweeps through a folder that is a link", async () => {
    if (!posix) return;
    const real = path.join(dir, "real");
    await fs.mkdir(real);
    const stale = path.join(real, archiveName());
    await fs.writeFile(stale, "x");
    await fs.symlink(real, packs);

    expect(await sweepFolderPacks(packs)).toBe(0);
    await expect(fs.stat(stale)).resolves.toBeTruthy();
  });

  it("does nothing when there is no folder yet", async () => {
    expect(await sweepFolderPacks(packs)).toBe(0);
  });
});

describe("where archives are packed", () => {
  it("is one folder per user data folder, so two Daintrees never sweep each other's", () => {
    const packaged = folderPackDir("/Users/a/Library/Application Support/Daintree");
    const dev = folderPackDir("/Users/a/Library/Application Support/daintree-dev");

    expect(path.dirname(packaged)).toBe(os.tmpdir());
    expect(dev).not.toBe(packaged);
    expect(folderPackDir("/Users/a/Library/Application Support/Daintree")).toBe(packaged);
  });
});
