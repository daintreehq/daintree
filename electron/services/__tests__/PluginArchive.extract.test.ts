import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import zlib from "zlib";
import { packPluginArchive, extractPluginArchive, MAX_DNTR_ENTRIES } from "../PluginArchive.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-extract-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "acme.test-plugin", version: "1.0.0", ...overrides };
}

async function createFixture(baseDir: string, files: Record<string, string>): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(baseDir, filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

// Build a raw STORE (uncompressed) zip with arbitrary entry-name bytes,
// bypassing the path sanitization `archiver` applies (it strips `..` segments
// before writing). This is the only way to forge a genuine zip-slip archive to
// exercise extractPluginArchive's traversal guards — the bundled writer would
// never emit one.
// Each entry is either STORE (`content` string) or a real DEFLATE entry
// (`deflateOf` raw buffer) so a genuine, internally-consistent zip-bomb can be
// built — large uncompressedSize, tiny compressed payload, valid CRC — that
// yauzl accepts and only the installer's own size guard rejects.
type RawEntry = { name: string; content: string } | { name: string; deflateOf: Buffer };

function buildRawZip(entries: RawEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    let method: number;
    let stored: Buffer;
    let uncompressedSize: number;
    let crc: number;
    if ("deflateOf" in e) {
      method = 8;
      stored = zlib.deflateRawSync(e.deflateOf);
      uncompressedSize = e.deflateOf.length;
      crc = zlib.crc32(e.deflateOf) >>> 0;
    } else {
      method = 0;
      stored = Buffer.from(e.content);
      uncompressedSize = stored.length;
      crc = zlib.crc32(stored) >>> 0;
    }
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(stored.length, 18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const localOffset = offset;
    chunks.push(lfh, nameBuf, stored);
    offset += lfh.length + nameBuf.length + stored.length;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(stored.length, 20);
    cdh.writeUInt32LE(uncompressedSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
  }
  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  chunks.push(centralBuf);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

describe("extractPluginArchive", () => {
  it("extracts every entry faithfully into the destination", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "module.exports = { hello: true };",
      "icons/logo.svg": "<svg></svg>",
    });
    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const dest = path.join(tmpDir, "extracted");
    await fs.mkdir(dest, { recursive: true });
    await extractPluginArchive(archivePath, dest);

    expect(await fs.readFile(path.join(dest, "dist/index.js"), "utf-8")).toBe(
      "module.exports = { hello: true };"
    );
    expect(await fs.readFile(path.join(dest, "icons/logo.svg"), "utf-8")).toBe("<svg></svg>");
    const manifest = JSON.parse(await fs.readFile(path.join(dest, "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("acme.test-plugin");
  });

  it("rejects a path-traversal entry and writes nothing outside the destination", async () => {
    const archivePath = path.join(tmpDir, "evil.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "../escape.js", content: "pwned" },
      ])
    );
    const dest = path.join(tmpDir, "extracted-evil");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow();
    const escaped = await fs
      .access(path.join(tmpDir, "escape.js"))
      .then(() => true)
      .catch(() => false);
    expect(escaped).toBe(false);
  });

  it("rejects a backslash entry name", async () => {
    const archivePath = path.join(tmpDir, "backslash.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "..\\escape.js", content: "pwned" },
      ])
    );
    const dest = path.join(tmpDir, "extracted-bs");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow();
  });

  it("rejects an absolute entry name", async () => {
    const archivePath = path.join(tmpDir, "absolute.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "/etc/passwd", content: "pwned" },
      ])
    );
    const dest = path.join(tmpDir, "extracted-abs");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow();
  });

  it("rejects a zip-bomb whose declared uncompressed size exceeds the limit", async () => {
    const archivePath = path.join(tmpDir, "bomb.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        // 31 MB of zeroes deflates to a few KB — a valid entry yauzl accepts,
        // whose uncompressedSize trips the installer's cumulative size guard.
        { name: "huge.bin", deflateOf: Buffer.alloc(31 * 1024 * 1024) },
      ])
    );
    const dest = path.join(tmpDir, "extracted-bomb");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/exceeds/);
    // Guard trips before the bomb entry is written.
    expect(
      await fs
        .access(path.join(dest, "huge.bin"))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it("rejects an archive exceeding the entry-count cap", async () => {
    const archivePath = path.join(tmpDir, "many.dntr");
    const entries: RawEntry[] = [{ name: "plugin.json", content: JSON.stringify(validManifest()) }];
    for (let i = 0; i < MAX_DNTR_ENTRIES; i++) {
      entries.push({ name: `f${i}.txt`, content: "" });
    }
    await fs.writeFile(archivePath, buildRawZip(entries));
    const dest = path.join(tmpDir, "extracted-many");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/entry limit/);
    expect(await fs.readdir(dest)).toEqual([]);
  });

  it("rejects an archive with a duplicate normalized entry name", async () => {
    const archivePath = path.join(tmpDir, "dup.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "dist/index.js", content: "first" },
        { name: "dist/index.js", content: "second" },
      ])
    );
    const dest = path.join(tmpDir, "extracted-dup");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/Duplicate entry/);
  });

  it("rejects an archive with a second plugin.json", async () => {
    const archivePath = path.join(tmpDir, "dup-manifest.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "dist/index.js", content: "ok" },
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
      ])
    );
    const dest = path.join(tmpDir, "extracted-dup-manifest");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/Duplicate entry/);
  });

  it("rejects an oversize archive before extracting", async () => {
    const archivePath = path.join(tmpDir, "huge.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([{ name: "plugin.json", content: JSON.stringify(validManifest()) }])
    );
    await fs.truncate(archivePath, 30 * 1024 * 1024 + 1);
    const dest = path.join(tmpDir, "extracted-huge");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/exceeds/);
  });
});
