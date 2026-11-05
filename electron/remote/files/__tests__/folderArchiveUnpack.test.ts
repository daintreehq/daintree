import { createWriteStream, renameSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOLDER_UPLOAD_MAX_ARCHIVE_BYTES,
  FOLDER_UPLOAD_MAX_DEPTH,
  type FolderUploadTotals,
} from "../../../../shared/types/folderUpload.js";
import { BULK_CHUNK_BYTES } from "../../link/frames.js";
import { unpackFolderArchive, type UnpackFolderArchiveOptions } from "../folderArchiveUnpack.js";
import { folderArchiveMode } from "../folderUploadLinkMethods.js";
import {
  forgeFolderArchive,
  forgeLocalRecord,
  type ForgedEntry,
  type ForgeOptions,
} from "./forgeFolderArchive.js";

let base: string;
let staging: string;
let archivePath: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "folder-unpack-test-")));
  staging = path.join(base, "staging");
  archivePath = path.join(base, "upload.zip");
  await fs.mkdir(staging, { mode: 0o700 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

function declaredFor(entries: ForgedEntry[]): FolderUploadTotals {
  const totals = { fileCount: 0, folderCount: 0, totalBytes: 0 };
  for (const entry of entries) {
    const name = entry.name.toString();
    if (name.endsWith("/")) {
      if (name !== "Root/") totals.folderCount++;
    } else {
      totals.fileCount++;
      totals.totalBytes += Buffer.byteLength(entry.data ?? "");
    }
  }
  return totals;
}

async function unpack(
  entries: ForgedEntry[],
  options: {
    forge?: ForgeOptions;
    declared?: Partial<FolderUploadTotals>;
  } & Partial<Pick<UnpackFolderArchiveOptions, "signal" | "onProgress">> = {}
) {
  await fs.writeFile(archivePath, forgeFolderArchive(entries, options.forge));
  return unpackFolderArchive({
    archivePath,
    stagingDir: staging,
    rootName: "Root",
    declared: { ...declaredFor(entries), ...options.declared },
    signal: options.signal,
    onProgress: options.onProgress,
  });
}

async function stagingIsEmpty(): Promise<void> {
  expect(await fs.readdir(staging)).toEqual([]);
}

async function modeOf(relative: string): Promise<number> {
  return (await fs.lstat(path.join(staging, relative))).mode & 0o777;
}

const ROOT: ForgedEntry = { name: "Root/" };

type FileHandleMethods = { stat: () => Promise<unknown> };

/** Every FileHandle shares this prototype, so a spy on it sees the unpacker's handles too. */
async function fileHandlePrototype(): Promise<FileHandleMethods> {
  const probe = await fs.open(path.join(base, "probe"), "w");
  await probe.close();
  return Object.getPrototypeOf(probe) as FileHandleMethods;
}

describe("unpackFolderArchive: a valid archive", () => {
  it("unpacks a nested tree with an empty folder and an executable file, with the right modes", async () => {
    const before = await fs.lstat(staging);
    const progress: number[] = [];
    const entries: ForgedEntry[] = [
      ROOT,
      { name: "Root/src/" },
      { name: "Root/src/app.ts", data: "export const app = 1;\n" },
      { name: "Root/src/lib/" },
      { name: "Root/src/lib/deep.txt", data: "deep" },
      { name: "Root/bin/" },
      { name: "Root/bin/run.sh", data: "#!/bin/sh\necho hi\n", executable: true },
      { name: "Root/empty/" },
      { name: "Root/.env", data: "SECRET=1\n" },
      { name: "Root/zero.txt", data: "" },
      { name: "Root/naïve 文字.md", data: "unicode" },
    ];

    const result = await unpack(entries, {
      onProgress: ({ filesDone, filesTotal }) => progress.push(filesDone / filesTotal),
    });

    expect(result).toEqual({ ok: true, totals: declaredFor(entries) });
    expect(progress.at(-1)).toBe(1);
    expect(progress).toHaveLength(declaredFor(entries).fileCount);
    // The root folder is the staging folder itself, never a folder inside it.
    expect((await fs.lstat(staging)).ino).toBe(before.ino);
    expect((await fs.readdir(staging)).sort()).toEqual(
      [".env", "bin", "empty", "naïve 文字.md", "src", "zero.txt"].sort()
    );
    expect(await fs.readFile(path.join(staging, "src/lib/deep.txt"), "utf8")).toBe("deep");
    expect(await fs.readFile(path.join(staging, "bin/run.sh"), "utf8")).toBe(
      "#!/bin/sh\necho hi\n"
    );
    expect(await fs.readdir(path.join(staging, "empty"))).toEqual([]);
    expect((await fs.stat(path.join(staging, "zero.txt"))).size).toBe(0);

    expect(await modeOf("bin/run.sh")).toBe(0o700);
    expect(await modeOf("src/app.ts")).toBe(0o600);
    expect(await modeOf(".env")).toBe(0o600);
    for (const folder of ["src", "src/lib", "bin", "empty"]) {
      expect(await modeOf(folder)).toBe(0o700);
    }
  });

  it("restores modes the umask took away", async () => {
    const previous = process.umask(0o177);
    try {
      const result = await unpack([
        ROOT,
        { name: "Root/sub/" },
        { name: "Root/sub/tool", data: "x", executable: true },
      ]);
      expect(result.ok).toBe(true);
    } finally {
      process.umask(previous);
    }
    expect(await modeOf("sub")).toBe(0o700);
    expect(await modeOf("sub/tool")).toBe(0o700);
  });

  it("takes entries in any order, data descriptors and unflagged ASCII names", async () => {
    const result = await unpack([
      { name: "Root/a/b/c.txt", data: "c", descriptor: true, flags: 0x0008 },
      { name: "Root/a/b/", flags: 0 },
      { name: "Root/é.txt", data: "accent", descriptor: true },
      { name: "Root/a/", flags: 0 },
      { name: "Root/", flags: 0 },
    ]);
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(staging, "a/b/c.txt"), "utf8")).toBe("c");
    expect(await fs.readFile(path.join(staging, "é.txt"), "utf8")).toBe("accent");
  });

  it("reads an archive archiver streams, as a packer built on it would write one", async () => {
    const { ZipArchive } = await import("archiver");
    const zip = new ZipArchive({ store: true });
    const done = new Promise<void>((resolve, reject) => {
      const out = createWriteStream(archivePath);
      out.on("close", resolve);
      out.on("error", reject);
      zip.on("error", reject);
      zip.pipe(out);
    });
    const date = new Date("2020-01-01T00:00:00Z");
    zip.append(Buffer.alloc(0), { name: "Root/", mode: folderArchiveMode("folder"), date });
    zip.append(Buffer.alloc(0), { name: "Root/src/", mode: folderArchiveMode("folder"), date });
    zip.append(Readable.from([Buffer.from("streamed")]), {
      name: "Root/src/app.ts",
      mode: folderArchiveMode("file"),
      date,
    });
    zip.append(Readable.from([Buffer.from("#!/bin/sh\n")]), {
      name: "Root/run.sh",
      mode: folderArchiveMode("file", true),
      date,
    });
    void zip.finalize();
    await done;

    const result = await unpackFolderArchive({
      archivePath,
      stagingDir: staging,
      rootName: "Root",
      declared: { fileCount: 2, folderCount: 1, totalBytes: "streamed".length + 10 },
    });

    expect(result).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(staging, "src/app.ts"), "utf8")).toBe("streamed");
    expect(await modeOf("run.sh")).toBe(0o700);
  });
});

describe("unpackFolderArchive: forged archives", () => {
  it("refuses a ../ entry without writing anything, inside staging or out", async () => {
    const result = await unpack([
      ROOT,
      { name: "Root/ok.txt", data: "fine" },
      { name: "Root/../evil.txt", data: "escaped" },
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "unsafe-archive",
      rule: "content",
      entry: "Root/../evil.txt",
      problem: { kind: "path", problem: "dot-name", path: "Root/../evil.txt" },
    });
    await stagingIsEmpty();
    await expect(fs.lstat(path.join(base, "evil.txt"))).rejects.toThrow();
  });

  it.each([
    ["an absolute path", "/Root/abs.txt", "absolute"],
    ["a drive-letter path", "C:/Root/abs.txt", "drive-letter"],
    ["a backslash", "Root\\..\\evil.txt", "separator"],
    ["another root", "Other/x.txt", "outside-root"],
  ])("refuses %s", async (_label, name, problem) => {
    const result = await unpack([ROOT, { name, data: "x" }]);
    expect(result).toMatchObject({
      ok: false,
      reason: "unsafe-archive",
      rule: "content",
      entry: name,
      problem: { kind: "path", problem },
    });
    await stagingIsEmpty();
  });

  it("refuses a symlink entry", async () => {
    const result = await unpack([ROOT, { name: "Root/link", data: "/etc/passwd", mode: 0o120777 }]);
    expect(result).toEqual({
      ok: false,
      reason: "unsafe-archive",
      rule: "link",
      entry: "Root/link",
    });
    await stagingIsEmpty();
  });

  it.each([
    ["a FIFO", { name: "Root/pipe", mode: 0o010600 }, "special-file"],
    ["a device", { name: "Root/dev", mode: 0o020600 }, "special-file"],
    ["a mode the packer never writes", { name: "Root/a.txt", data: "x", mode: 0o100644 }, "mode"],
    ["a folder with a file's mode bits", { name: "Root/d/", mode: 0o040755 }, "mode"],
    ["an entry not made by Unix", { name: "Root/a.txt", data: "x", madeBy: 20 }, "mode"],
    ["a compressed entry", { name: "Root/a.txt", data: "x", method: 8 }, "method"],
    ["an encrypted entry", { name: "Root/a.txt", data: "x", flags: 0x0801 }, "flags"],
    [
      "a non-ASCII name without the UTF-8 flag",
      { name: "Root/é.txt", data: "x", flags: 0 },
      "name-encoding",
    ],
    [
      "a name that isn't UTF-8",
      { name: Buffer.from([0x52, 0x6f, 0x6f, 0x74, 0x2f, 0xff]), data: "x" },
      "name-encoding",
    ],
    ["a folder with data", { name: "Root/d/", data: "hidden" }, "size"],
  ] satisfies Array<[string, ForgedEntry, string]>)("refuses %s", async (_label, entry, rule) => {
    const result = await unpack([ROOT, { name: "Root/before.txt", data: "b" }, entry]);
    expect(result).toMatchObject({ ok: false, reason: "unsafe-archive", rule });
    await stagingIsEmpty();
  });

  describe("a header that lies about a file's size", () => {
    const content = "0123456789";

    it("refuses headers that agree on too small a size, hiding the rest of the data", async () => {
      // A careful forger keeps the CRC right for what the headers claim.
      const result = await unpack(
        [
          ROOT,
          {
            name: "Root/a.txt",
            data: content,
            size: 4,
            crc: zlib.crc32(content.slice(0, 4)),
          },
          { name: "Root/b.txt", data: "b" },
        ],
        { declared: { totalBytes: 5 } }
      );
      expect(result).toEqual({
        ok: false,
        reason: "unsafe-archive",
        rule: "layout",
        entry: "Root/a.txt",
      });
      await stagingIsEmpty();
    });

    it("refuses stored sizes that differ", async () => {
      const result = await unpack([ROOT, { name: "Root/a.txt", data: content, compressedSize: 4 }]);
      expect(result).toMatchObject({ ok: false, rule: "size", entry: "Root/a.txt" });
    });

    it.each([
      ["size", { size: 100 }],
      ["compressed size", { compressedSize: 100 }],
      ["CRC", { crc: 0x1234 }],
      ["flags", { flags: 0 }],
      ["method", { method: 8 }],
    ] satisfies Array<[string, ForgedEntry["local"]]>)(
      "refuses a local header whose %s disagrees with the central record",
      async (_label, local) => {
        const result = await unpack([ROOT, { name: "Root/a.txt", data: content, local }]);
        expect(result).toEqual({
          ok: false,
          reason: "unsafe-archive",
          rule: "header-mismatch",
          entry: "Root/a.txt",
        });
      }
    );

    it("takes a data descriptor whose local header already carries the real values", async () => {
      const crc = zlib.crc32(content);
      const result = await unpack([
        ROOT,
        {
          name: "Root/a.txt",
          data: content,
          descriptor: true,
          local: { crc, size: content.length, compressedSize: content.length },
        },
      ]);
      expect(result).toMatchObject({ ok: true });
    });

    it("refuses a local header naming a different entry", async () => {
      const result = await unpack([
        ROOT,
        { name: "Root/a.txt", data: content, local: { name: "Root/b.txt" } },
      ]);
      expect(result).toMatchObject({ ok: false, rule: "header-mismatch", entry: "Root/a.txt" });
    });

    it.each([
      ["size", { size: 99 }],
      ["compressed size", { compressedSize: 99 }],
      ["CRC", { crc: 0x1234 }],
    ] satisfies Array<[string, ForgedEntry["descriptorFields"]]>)(
      "refuses a data descriptor whose %s disagrees with the central record",
      async (_label, descriptorFields) => {
        const result = await unpack([
          ROOT,
          { name: "Root/a.txt", data: content, descriptor: true, descriptorFields },
        ]);
        expect(result).toEqual({
          ok: false,
          reason: "unsafe-archive",
          rule: "header-mismatch",
          entry: "Root/a.txt",
        });
      }
    );

    it("refuses a local header and descriptor that half fill in the real values", async () => {
      const result = await unpack([
        ROOT,
        { name: "Root/a.txt", data: content, descriptor: true, local: { size: content.length } },
      ]);
      expect(result).toMatchObject({ ok: false, rule: "header-mismatch", entry: "Root/a.txt" });
    });

    it("refuses sizes at ZIP64's sentinel", async () => {
      const result = await unpack([ROOT, { name: "Root/a.txt", data: "x", size: 0xffffffff }]);
      expect(result).toEqual({
        ok: false,
        reason: "unsafe-archive",
        rule: "size",
        entry: "Root/a.txt",
      });
    });

    it("refuses headers that agree on more data than the archive holds for the entry", async () => {
      const result = await unpack([ROOT, { name: "Root/a.txt", data: "x", size: 100 }], {
        declared: { totalBytes: 100 },
      });
      expect(result).toEqual({
        ok: false,
        reason: "unsafe-archive",
        rule: "layout",
        entry: "Root/a.txt",
      });
    });

    it("refuses content that doesn't match its CRC, removing what was written", async () => {
      const result = await unpack([
        ROOT,
        { name: "Root/first.txt", data: "first" },
        { name: "Root/a.txt", data: content, crc: 0x1234 },
      ]);
      expect(result).toMatchObject({ ok: false, rule: "crc", entry: "Root/a.txt" });
      await stagingIsEmpty();
    });
  });

  describe("counts the archive doesn't keep to", () => {
    const entries: ForgedEntry[] = [
      ROOT,
      { name: "Root/a.txt", data: "a" },
      { name: "Root/b.txt", data: "b" },
      { name: "Root/c.txt", data: "c" },
    ];

    it("refuses more files than declared at the first one over", async () => {
      const result = await unpack(entries, { declared: { fileCount: 2 } });
      expect(result).toEqual({
        ok: false,
        reason: "unsafe-archive",
        rule: "declared",
        entry: "Root/c.txt",
      });
      await stagingIsEmpty();
    });

    it("refuses more bytes than declared", async () => {
      const result = await unpack(entries, { declared: { totalBytes: 2 } });
      expect(result).toMatchObject({ ok: false, rule: "declared", entry: "Root/c.txt" });
    });

    it("refuses fewer files or folders than declared", async () => {
      expect(await unpack(entries, { declared: { fileCount: 4 } })).toEqual({
        ok: false,
        reason: "unsafe-archive",
        rule: "declared",
      });
      expect(await unpack(entries, { declared: { folderCount: 1 } })).toEqual({
        ok: false,
        reason: "unsafe-archive",
        rule: "declared",
      });
      expect(await unpack(entries, { declared: { totalBytes: 4 } })).toEqual({
        ok: false,
        reason: "unsafe-archive",
        rule: "declared",
      });
      await stagingIsEmpty();
    });

    it("refuses more folders than declared at the first one over", async () => {
      expect(await unpack([ROOT, { name: "Root/d/" }], { declared: { folderCount: 0 } })).toEqual({
        ok: false,
        reason: "unsafe-archive",
        rule: "declared",
        entry: "Root/d/",
      });
    });

    it.each([
      ["a negative count", { fileCount: -1 }],
      ["a fractional count", { folderCount: 0.5 }],
      ["a count past safe integers", { totalBytes: Number.MAX_SAFE_INTEGER + 1 }],
      ["NaN", { fileCount: Number.NaN }],
    ])("throws on %s declared", async (_label, declared) => {
      await expect(unpack(entries, { declared })).rejects.toBeInstanceOf(RangeError);
    });

    it("refuses an end record that counts fewer entries than the central directory holds", async () => {
      const result = await unpack(entries, { forge: { entryCount: 3 } });
      expect(result).toEqual({ ok: false, reason: "unsafe-archive", rule: "format" });
      await stagingIsEmpty();
    });
  });

  it("refuses names that collide by case", async () => {
    const result = await unpack([
      ROOT,
      { name: "Root/README.md", data: "upper" },
      { name: "Root/readme.md", data: "lower" },
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "name-clash",
      rule: "content",
      entry: "Root/readme.md",
      problem: { kind: "clash", paths: ["Root/README.md", "Root/readme.md"] },
    });
    await stagingIsEmpty();
  });

  it("refuses names that collide by normalization form", async () => {
    const composed = "Root/caf\u00e9/";
    const decomposed = "Root/cafe\u0301/";
    const result = await unpack([ROOT, { name: composed }, { name: decomposed }]);
    expect(result).toMatchObject({
      ok: false,
      reason: "name-clash",
      problem: { kind: "clash", paths: [composed, decomposed] },
    });
    await stagingIsEmpty();
  });

  it("refuses a file colliding with a folder of the same name", async () => {
    const result = await unpack([
      ROOT,
      { name: "Root/thing", data: "file" },
      { name: "Root/thing/" },
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "name-clash",
      rule: "content",
      entry: "Root/thing/",
      problem: { kind: "clash", paths: ["Root/thing", "Root/thing/"] },
    });
  });

  it("refuses a path past the depth bound and takes one at it", async () => {
    const folders = (depth: number): ForgedEntry[] => {
      const out: ForgedEntry[] = [ROOT];
      let prefix = "Root";
      for (let i = 1; i < depth; i++) {
        prefix = `${prefix}/d${i}`;
        out.push({ name: `${prefix}/` });
      }
      out.push({ name: `${prefix}/leaf.txt`, data: "leaf" });
      return out;
    };
    expect(await unpack(folders(FOLDER_UPLOAD_MAX_DEPTH))).toMatchObject({ ok: true });
    await fs.rm(staging, { recursive: true });
    await fs.mkdir(staging, { mode: 0o700 });

    const tooDeep = folders(FOLDER_UPLOAD_MAX_DEPTH + 1);
    const result = await unpack(tooDeep);
    expect(result).toMatchObject({
      ok: false,
      reason: "over-limits",
      rule: "content",
      problem: { kind: "limit", limit: "depth", actual: FOLDER_UPLOAD_MAX_DEPTH + 1 },
    });
    await stagingIsEmpty();
  });

  it("refuses a folder with no entry of its own, the root included", async () => {
    expect(
      await unpack([ROOT, { name: "Root/a/b.txt", data: "b" }], {
        declared: { folderCount: 1 },
      })
    ).toEqual({
      ok: false,
      reason: "unsafe-archive",
      rule: "missing-folder",
      entry: "Root/a/b.txt",
    });
    expect(await unpack([{ name: "Root/a.txt", data: "a" }])).toEqual({
      ok: false,
      reason: "unsafe-archive",
      rule: "missing-folder",
      entry: "Root/",
    });
    await stagingIsEmpty();
  });

  it.each([
    ["bytes before the first entry", { prefix: Buffer.from("junk") }, []],
    ["bytes between entries", {}, [{ name: "Root/gap.txt", data: "x", padding: Buffer.alloc(8) }]],
  ] satisfies Array<[string, ForgeOptions, ForgedEntry[]]>)(
    "refuses %s",
    async (_label, forge, extra) => {
      const result = await unpack([ROOT, ...extra, { name: "Root/z.txt", data: "z" }], { forge });
      expect(result).toMatchObject({ ok: false, reason: "unsafe-archive", rule: "layout" });
      await stagingIsEmpty();
    }
  );

  it("refuses bytes after the last entry's data", async () => {
    const result = await unpack([
      ROOT,
      { name: "Root/a.txt", data: "a", padding: Buffer.from("x") },
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "unsafe-archive",
      rule: "layout",
      entry: "Root/a.txt",
    });
  });

  it("refuses an entry whose data hides another whole entry", async () => {
    const inner: ForgedEntry = { name: "Root/b.txt", data: "bee" };
    const embedded = forgeLocalRecord(inner);
    // Root/'s local record, then a.txt's header; a.txt's data starts there.
    const embeddedAt = 30 + "Root/".length + 30 + "Root/a.txt".length;
    const result = await unpack([
      ROOT,
      { name: "Root/a.txt", data: embedded },
      { ...inner, localHeaderAt: embeddedAt },
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "unsafe-archive",
      rule: "layout",
      entry: "Root/a.txt",
    });
    await stagingIsEmpty();
  });

  it("takes central records in a different order from the entries they describe", async () => {
    const result = await unpack(
      [
        ROOT,
        { name: "Root/a/" },
        { name: "Root/a/x.txt", data: "x" },
        { name: "Root/y.txt", data: "y" },
      ],
      { forge: { centralOrder: [3, 2, 1, 0] } }
    );
    expect(result).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(staging, "a/x.txt"), "utf8")).toBe("x");
  });

  it.each([
    ["this disk's number", 4],
    ["the central directory's disk", 6],
    ["this disk's entry count", 8],
  ])("refuses an end record spanning disks by %s", async (_label, field) => {
    const archive = forgeFolderArchive([ROOT, { name: "Root/a.txt", data: "a" }]);
    archive.writeUInt16LE(
      archive.readUInt16LE(archive.length - 22 + field) + 1,
      archive.length - 22 + field
    );
    await fs.writeFile(archivePath, archive);
    const result = await unpackFolderArchive({
      archivePath,
      stagingDir: staging,
      rootName: "Root",
      declared: { fileCount: 1, folderCount: 0, totalBytes: 1 },
    });
    expect(result).toEqual({ ok: false, reason: "unsafe-archive", rule: "format" });
  });

  it("refuses a central record past the central directory's end", async () => {
    const archive = forgeFolderArchive([ROOT, { name: "Root/a.txt", data: "a" }]);
    // The last central record's comment length, claiming bytes past the end record's start.
    const lastRecordAt = archive.length - 22 - (46 + "Root/a.txt".length);
    archive.writeUInt16LE(10, lastRecordAt + 32);
    await fs.writeFile(archivePath, archive);
    const result = await unpackFolderArchive({
      archivePath,
      stagingDir: staging,
      rootName: "Root",
      declared: { fileCount: 1, folderCount: 0, totalBytes: 1 },
    });
    expect(result).toEqual({ ok: false, reason: "unsafe-archive", rule: "format" });
  });

  it("refuses a central record pointing at another entry's data", async () => {
    const result = await unpack([
      ROOT,
      { name: "Root/a.txt", data: "shared" },
      { name: "Root/b.txt", data: "shared", localHeaderOf: 1 },
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "unsafe-archive",
      rule: "header-mismatch",
      entry: "Root/b.txt",
    });
    await stagingIsEmpty();
  });

  it("refuses bytes after the end record", async () => {
    await fs.writeFile(
      archivePath,
      Buffer.concat([
        forgeFolderArchive([ROOT, { name: "Root/a.txt", data: "a" }]),
        Buffer.from("tail"),
      ])
    );
    const result = await unpackFolderArchive({
      archivePath,
      stagingDir: staging,
      rootName: "Root",
      declared: { fileCount: 1, folderCount: 0, totalBytes: 1 },
    });
    expect(result).toEqual({ ok: false, reason: "unsafe-archive", rule: "format" });
  });

  it.each([
    ["a plain comment", Buffer.from("packed by hand")],
    [
      "a comment holding a whole end record",
      Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]),
    ],
  ])("refuses an archive with %s", async (_label, comment) => {
    const result = await unpack([ROOT, { name: "Root/a.txt", data: "a" }], { forge: { comment } });
    expect(result).toEqual({ ok: false, reason: "unsafe-archive", rule: "format" });
  });

  it("refuses a folder whose CRC isn't that of empty content", async () => {
    const result = await unpack([ROOT, { name: "Root/d/", crc: 1 }]);
    expect(result).toEqual({ ok: false, reason: "unsafe-archive", rule: "crc", entry: "Root/d/" });
  });

  it("refuses an invalid root name before opening the archive", async () => {
    const result = await unpackFolderArchive({
      archivePath: path.join(base, "never-opened.zip"),
      stagingDir: staging,
      rootName: "..",
      declared: { fileCount: 0, folderCount: 0, totalBytes: 0 },
    });
    expect(result).toEqual({
      ok: false,
      reason: "unsafe-archive",
      rule: "content",
      problem: { kind: "path", problem: "dot-name", path: ".." },
    });
  });

  it("won't read an archive through a link", async () => {
    const real = path.join(base, "real.zip");
    await fs.writeFile(real, forgeFolderArchive([ROOT]));
    await fs.symlink(real, archivePath);
    await expect(
      unpackFolderArchive({
        archivePath,
        stagingDir: staging,
        rootName: "Root",
        declared: { fileCount: 0, folderCount: 0, totalBytes: 0 },
      })
    ).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("refuses an archive over the size limit before reading it", async () => {
    const handle = await fs.open(archivePath, "w");
    await handle.truncate(FOLDER_UPLOAD_MAX_ARCHIVE_BYTES + 1);
    await handle.close();
    const result = await unpackFolderArchive({
      archivePath,
      stagingDir: staging,
      rootName: "Root",
      declared: { fileCount: 1, folderCount: 0, totalBytes: 1 },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "over-limits",
      problem: { kind: "limit", limit: "archive-bytes" },
    });
  });

  it("refuses something that isn't a zip", async () => {
    await fs.writeFile(archivePath, "not a zip at all");
    const result = await unpackFolderArchive({
      archivePath,
      stagingDir: staging,
      rootName: "Root",
      declared: { fileCount: 0, folderCount: 0, totalBytes: 0 },
    });
    expect(result).toEqual({ ok: false, reason: "unsafe-archive", rule: "format" });
  });
});

describe("unpackFolderArchive: cancelling and rolling back", () => {
  const files: ForgedEntry[] = [
    ROOT,
    { name: "Root/sub/" },
    { name: "Root/sub/one.txt", data: "one" },
    { name: "Root/sub/two.txt", data: "two" },
    { name: "Root/three.txt", data: "three" },
    { name: "Root/four.txt", data: "four" },
  ];

  it("leaves the staging folder empty when cancelled halfway", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by the person");
    const promise = unpack(files, {
      signal: controller.signal,
      onProgress: ({ filesDone, filesTotal }) => {
        if (filesDone === filesTotal / 2) controller.abort(reason);
      },
    });
    await expect(promise).rejects.toBe(reason);
    await stagingIsEmpty();
  });

  it("stops partway through a file and removes it", async () => {
    const controller = new AbortController();
    const big = Buffer.alloc(BULK_CHUNK_BYTES * 3, 7);
    await fs.writeFile(
      archivePath,
      forgeFolderArchive([ROOT, { name: "Root/big.bin", data: big }])
    );
    const crc32 = zlib.crc32;
    let chunks = 0;
    vi.spyOn(zlib, "crc32").mockImplementation((data, value) => {
      if (++chunks === 2) controller.abort();
      return crc32(data, value);
    });
    await expect(
      unpackFolderArchive({
        archivePath,
        stagingDir: staging,
        rootName: "Root",
        declared: { fileCount: 1, folderCount: 0, totalBytes: big.length },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(chunks).toBe(2);
    await stagingIsEmpty();
  });

  it("rejects an already-cancelled unpack without touching staging", async () => {
    const reason = new Error("too late");
    await expect(unpack(files, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await stagingIsEmpty();
  });

  it("rejects, rather than reporting a clean stop, when something it can't remove is left", async () => {
    const controller = new AbortController();
    const promise = unpack(files, {
      signal: controller.signal,
      onProgress: () => {
        writeFileSync(path.join(staging, "sub", "foreign.txt"), "not ours");
        controller.abort();
      },
    });
    await expect(promise).rejects.toThrow(/couldn't remove everything/);
    expect(await fs.readdir(path.join(staging, "sub"))).toEqual(["foreign.txt"]);
  });

  it("still removes the tree when cancelled as the last file completes", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled at the end");
    const promise = unpack(files, {
      signal: controller.signal,
      onProgress: ({ filesDone, filesTotal }) => {
        if (filesDone === filesTotal) controller.abort(reason);
      },
    });
    await expect(promise).rejects.toBe(reason);
    await stagingIsEmpty();
  });

  it("fails with a progress callback's error and removes what it wrote", async () => {
    const failure = new Error("progress broke");
    const promise = unpack(files, {
      onProgress: () => {
        throw failure;
      },
    });
    await expect(promise).rejects.toBe(failure);
    await stagingIsEmpty();
  });

  it("still removes the tree when cancelled while the archive closes", async () => {
    const open = fs.open;
    const controller = new AbortController();
    let archiveCloses = 0;
    vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === archivePath) {
        const close = handle.close.bind(handle);
        handle.close = () => {
          archiveCloses++;
          controller.abort();
          return close();
        };
      }
      return handle;
    }) as typeof fs.open);
    await expect(
      unpack([ROOT, { name: "Root/a.txt", data: "a" }], { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(archiveCloses).toBe(1);
    await stagingIsEmpty();
  });

  it("counts an entry that vanishes as it is being removed as removed", async () => {
    const unlink = fs.unlink;
    vi.spyOn(fs, "unlink").mockImplementationOnce(async (target) => {
      await unlink(target);
      return unlink(target);
    });
    const controller = new AbortController();
    const promise = unpack(files, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await stagingIsEmpty();
  });

  it("reports a file whose identity couldn't be read back as left behind", async () => {
    const handleProto = await fileHandlePrototype();
    const stat = handleProto.stat;
    let calls = 0;
    const failure = Object.assign(new Error("EIO"), { code: "EIO" });
    // The archive's own stat comes first; the second is the first file's.
    vi.spyOn(handleProto, "stat").mockImplementation(function (this: unknown) {
      if (++calls === 2) return Promise.reject(failure);
      return stat.call(this);
    });
    const error = await unpack([ROOT, { name: "Root/a.txt", data: "a" }]).catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: expect.stringMatching(/couldn't remove everything/),
      cause: failure,
    });
    expect(await fs.readdir(staging)).toEqual(["a.txt"]);
  });

  it("reports a folder whose identity couldn't be read back as left behind", async () => {
    const failure = Object.assign(new Error("EIO"), { code: "EIO" });
    const lstat = fs.lstat;
    const target = path.join(staging, "sub");
    vi.spyOn(fs, "lstat").mockImplementation(((filePath: string, ...rest: unknown[]) =>
      filePath === target
        ? Promise.reject(failure)
        : (lstat as (...args: unknown[]) => Promise<unknown>)(
            filePath,
            ...rest
          )) as typeof fs.lstat);
    const error = await unpack([ROOT, { name: "Root/sub/" }]).catch((e: unknown) => e);
    vi.restoreAllMocks();
    expect(error).toMatchObject({
      message: expect.stringMatching(/couldn't remove everything/),
      cause: failure,
    });
    expect(await fs.readdir(staging)).toEqual(["sub"]);
  });

  it("never writes through a link planted where a file is about to go", async () => {
    const outside = path.join(base, "outside.txt");
    await fs.writeFile(outside, "original");
    const promise = unpack(files, {
      onProgress: ({ filesDone }) => {
        if (filesDone === 1) symlinkSync(outside, path.join(staging, "three.txt"));
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(outside, "utf8")).toBe("original");
    expect(await fs.readdir(staging)).toEqual(["three.txt"]);
  });

  it("stops when a folder it made is swapped for a link, writing nothing through it", async () => {
    const elsewhere = path.join(base, "elsewhere");
    await fs.mkdir(elsewhere);
    const promise = unpack(files, {
      onProgress: ({ filesDone }) => {
        if (filesDone !== 1) return;
        renameSync(path.join(staging, "sub"), path.join(base, "moved"));
        symlinkSync(elsewhere, path.join(staging, "sub"));
      },
    });
    await expect(promise).rejects.toThrow(/couldn't remove everything/);
    expect(await fs.readdir(elsewhere)).toEqual([]);
    expect(await fs.readdir(path.join(base, "moved"))).toEqual(["one.txt"]);
  });

  it("stops when a folder above the next file is moved away behind a link to it", async () => {
    const nested: ForgedEntry[] = [
      ROOT,
      { name: "Root/a/" },
      { name: "Root/a/b/" },
      { name: "Root/a/b/one.txt", data: "one" },
      { name: "Root/a/b/two.txt", data: "two" },
    ];
    const moved = path.join(base, "moved-a");
    const error = await unpack(nested, {
      onProgress: ({ filesDone }) => {
        if (filesDone !== 1) return;
        renameSync(path.join(staging, "a"), moved);
        symlinkSync(moved, path.join(staging, "a"));
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: expect.stringMatching(/couldn't remove everything/),
      cause: expect.objectContaining({ message: expect.stringMatching(/changed/) }),
    });
    await expect(fs.lstat(path.join(moved, "b", "two.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to start in a staging folder that isn't empty", async () => {
    await fs.writeFile(path.join(staging, "already.txt"), "x");
    await expect(unpack(files)).rejects.toThrow(/empty folder/);
    expect(await fs.readdir(staging)).toEqual(["already.txt"]);
  });

  it("refuses a staging folder that is a link to one", async () => {
    const linked = path.join(base, "linked-staging");
    await fs.symlink(staging, linked);
    await fs.writeFile(archivePath, forgeFolderArchive([ROOT]));
    await expect(
      unpackFolderArchive({
        archivePath,
        stagingDir: linked,
        rootName: "Root",
        declared: { fileCount: 0, folderCount: 0, totalBytes: 0 },
      })
    ).rejects.toThrow(/empty folder/);
  });
});
