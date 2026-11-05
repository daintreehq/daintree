import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalFolderPackError,
  packLocalFolder,
  sweepFolderPacks,
  type FolderPackProgress,
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

function pack(
  snapshot: FolderSnapshot,
  options: { signal?: AbortSignal; onProgress?: (progress: FolderPackProgress) => void } = {}
) {
  return packLocalFolder(snapshot, {
    signal: options.signal ?? new AbortController().signal,
    onProgress: options.onProgress,
    dir: packs,
  });
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

  it("serves the archive as a transfer source and removes it once", async () => {
    const snapshot = await summarize(await fixture("Project", { "a.txt": "hello" }));
    const packed = await pack(snapshot);

    const source = await packed.openSource();
    expect(source.size).toBe(packed.archiveBytes);
    expect(source.sha256).toBe(packed.sha256);
    const bytes = Buffer.from(await source.read(0, source.size));
    expect(bytes.equals(await fs.readFile(packed.path))).toBe(true);
    await source.close?.();

    await Promise.all([packed.remove(), packed.remove()]);
    await packed.remove();
    expect(await archivesLeft()).toEqual([]);
  });
});

describe("a folder that changed after its summary", () => {
  it("stops when a file grew, naming it, and leaves no archive", async () => {
    const root = await fixture("Project", { "a.txt": "a", "src/grows.ts": "short" });
    const snapshot = await summarize(root);
    await fs.appendFile(path.join(root, "src/grows.ts"), " and longer");

    const error = await packFailure(pack(snapshot));

    expect(error.reason).toBe("changed");
    expect(error.path).toBe("Project/src/grows.ts");
    expect(error.change).toBe("modified");
    expect(error.message).not.toContain("grows");
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a file was deleted, naming it", async () => {
    const root = await fixture("Project", { "a.txt": "a", "src/gone.ts": "x" });
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "src/gone.ts"));

    const error = await packFailure(pack(snapshot));

    expect(error.reason).toBe("changed");
    expect(error.path).toBe("Project/src/gone.ts");
    expect(error.change).toBe("gone");
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a summarized folder holds a new file, naming it", async () => {
    const root = await fixture("Project", { "a.txt": "a", "src/app.ts": "x" });
    const snapshot = await summarize(root);
    await fs.writeFile(path.join(root, "src/new.ts"), "y");

    const error = await packFailure(pack(snapshot));

    expect(error.path).toBe("Project/src/new.ts");
    expect(error.change).toBe("new");
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a summarized folder is gone", async () => {
    const root = await fixture("Project", { "a.txt": "a", "empty/": null });
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "empty"), { recursive: true });

    const error = await packFailure(pack(snapshot));

    expect(error.path).toBe("Project/empty/");
    expect(error.change).toBe("gone");
  });

  it("stops when a file of the same size was written to", async () => {
    const root = await fixture("Project", { "a.txt": "aaaa" });
    const snapshot = await summarize(root);
    await fs.writeFile(path.join(root, "a.txt"), "bbbb");
    const later = new Date(snapshot.entries[1]!.mtimeMs + 5_000);
    await fs.utimes(path.join(root, "a.txt"), later, later);

    const error = await packFailure(pack(snapshot));

    expect(error.path).toBe("Project/a.txt");
    expect(error.change).toBe("modified");
  });

  it("stops when a file was swapped for a link, without following it", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "a.txt": "a" });
    const outside = path.join(dir, "outside.txt");
    await fs.writeFile(outside, "a");
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "a.txt"));
    await fs.symlink(outside, path.join(root, "a.txt"));

    const error = await packFailure(pack(snapshot));

    expect(error.path).toBe("Project/a.txt");
    expect(await archivesLeft()).toEqual([]);
  });

  it("stops when a file was swapped for a FIFO, without waiting on it", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "src/a.txt": "a" });
    const snapshot = await summarize(root);
    // The folder listing is checked first, so the FIFO takes a known name.
    await fs.rm(path.join(root, "src/a.txt"));
    execFileSync("mkfifo", [path.join(root, "src/a.txt")]);

    const error = await packFailure(pack(snapshot));

    expect(error.path).toBe("Project/src/a.txt");
    expect(error.change).toBe("type");
  });

  it("stops when a left-out link was replaced by a file", async () => {
    if (!posix) return;
    const root = await fixture("Project", { "a.txt": "a" });
    await fs.symlink(path.join(root, "a.txt"), path.join(root, "link.txt"));
    const snapshot = await summarize(root);
    await fs.rm(path.join(root, "link.txt"));
    await fs.writeFile(path.join(root, "link.txt"), "now a file");

    const error = await packFailure(pack(snapshot));

    expect(error.path).toBe("Project/link.txt");
    expect(error.change).toBe("type");
  });
});

describe("cancelling a pack", () => {
  it("stops midway and leaves no temporary file", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${String(i).padStart(2, "0")}.txt`] = "x".repeat(1000);
    const snapshot = await summarize(await fixture("Project", files));
    const controller = new AbortController();

    const error = await packFailure(
      pack(snapshot, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.filesDone === 5) controller.abort();
        },
      })
    );

    expect(error.reason).toBe("cancelled");
    expect(await archivesLeft()).toEqual([]);
  });

  it("refuses at once when already cancelled", async () => {
    const snapshot = await summarize(await fixture("Project", { "a.txt": "a" }));
    const controller = new AbortController();
    controller.abort();

    expect((await packFailure(pack(snapshot, { signal: controller.signal }))).reason).toBe(
      "cancelled"
    );
    expect(await archivesLeft()).toEqual([]);
  });
});

describe("the startup sweep", () => {
  const hex = () => crypto.randomBytes(16).toString("hex");

  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", ""]);
    return child.pid!;
  }

  it("removes a stale archive and leaves everything else alone", async () => {
    await fs.mkdir(packs, { recursive: true, mode: 0o700 });
    const stale = `${deadPid()}-${hex()}.zip`;
    const ownLeftover = `${process.pid}-${hex()}.zip`;
    const otherRunning = `${process.ppid}-${hex()}.zip`;
    const oldRunning = `${process.ppid}-${hex()}.zip`;
    const unrelated = ["notes.txt", `${deadPid()}-${hex()}.zip.bak`, "123-abc.zip"];
    for (const name of [stale, ownLeftover, otherRunning, oldRunning, ...unrelated]) {
      await fs.writeFile(path.join(packs, name), "x");
    }
    await fs.mkdir(path.join(packs, `${deadPid()}-${hex()}.zip`));
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
    await fs.utimes(path.join(packs, oldRunning), dayAgo, dayAgo);
    const outside = path.join(dir, `${deadPid()}-${hex()}.zip`);
    await fs.writeFile(outside, "x");

    const removed = await sweepFolderPacks(packs);

    expect(removed).toBe(3);
    const left = await fs.readdir(packs);
    expect(left).toEqual(expect.arrayContaining([otherRunning, ...unrelated]));
    expect(left).not.toContain(stale);
    expect(left).not.toContain(ownLeftover);
    expect(left).not.toContain(oldRunning);
    expect(left).toHaveLength(unrelated.length + 2);
    await expect(fs.stat(outside)).resolves.toBeTruthy();
  });

  it("never removes an archive this process is still packing or holding", async () => {
    const snapshot = await summarize(await fixture("Project", { "a.txt": "a" }));
    const packed = await pack(snapshot);

    await sweepFolderPacks(packs);

    await expect(fs.stat(packed.path)).resolves.toBeTruthy();
    await packed.remove();
    await fs.writeFile(packed.path, "left behind");
    expect(await sweepFolderPacks(packs)).toBe(1);
  });

  it("never sweeps through a folder that is a link", async () => {
    if (!posix) return;
    const real = path.join(dir, "real");
    await fs.mkdir(real);
    const stale = path.join(real, `${deadPid()}-${hex()}.zip`);
    await fs.writeFile(stale, "x");
    await fs.symlink(real, packs);

    expect(await sweepFolderPacks(packs)).toBe(0);
    await expect(fs.stat(stale)).resolves.toBeTruthy();
  });

  it("does nothing when there is no folder yet", async () => {
    expect(await sweepFolderPacks(packs)).toBe(0);
  });
});
