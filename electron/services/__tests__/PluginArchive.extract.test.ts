import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import zlib from "zlib";
import { packPluginArchive, extractPluginArchive } from "../PluginArchive.js";

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
function buildRawZip(entries: Array<{ name: string; content: string }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.content);
    const nameBuf = Buffer.from(e.name, "utf-8");
    const crc = zlib.crc32(data) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const localOffset = offset;
    chunks.push(lfh, nameBuf, data);
    offset += lfh.length + nameBuf.length + data.length;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
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

  it("rejects an oversize archive before extracting", async () => {
    const archivePath = path.join(tmpDir, "huge.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([{ name: "plugin.json", content: JSON.stringify(validManifest()) }])
    );
    const handle = await fs.open(archivePath, "a");
    try {
      await handle.truncate(30 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    const dest = path.join(tmpDir, "extracted-huge");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/exceeds/);
  });
});
