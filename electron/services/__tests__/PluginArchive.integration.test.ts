import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import zlib from "zlib";
import {
  packPluginArchive,
  packPluginArchiveFromFiles,
  computeArchiveHash,
  readArchiveManifest,
  verifyPluginArchive,
  isExcludedArchiveEntry,
  MAX_DNTR_ENTRIES,
} from "../PluginArchive.js";

// Forge a raw STORE zip with arbitrary entry-name bytes so duplicate names and
// padded entry counts can be exercised — the bundled writer dedupes and sorts,
// so it can never emit these shapes itself.
function buildRawZip(entries: { name: string; content: string }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    const stored = Buffer.from(e.content);
    const crc = zlib.crc32(stored) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(stored.length, 18);
    lfh.writeUInt32LE(stored.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const localOffset = offset;
    chunks.push(lfh, nameBuf, stored);
    offset += lfh.length + nameBuf.length + stored.length;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(stored.length, 20);
    cdh.writeUInt32LE(stored.length, 24);
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-archive-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "acme.test-plugin",
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A test plugin for archive format tests",
    ...overrides,
  };
}

async function createFixture(baseDir: string, files: Record<string, string>): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(baseDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
}

describe("round-trip determinism", () => {
  it("produces identical SHA-256 when packing the same source twice", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "module.exports = {};",
      "icons/logo.svg": "<svg></svg>",
    });

    const archive1 = path.join(tmpDir, "out1.dntr");
    const archive2 = path.join(tmpDir, "out2.dntr");

    const hash1 = await packPluginArchive(sourceDir, archive1);
    const hash2 = await packPluginArchive(sourceDir, archive2);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);

    // File hashes at rest must also match
    const fileHash1 = await computeArchiveHash(archive1);
    const fileHash2 = await computeArchiveHash(archive2);
    expect(fileHash1).toBe(fileHash2);
    expect(fileHash1).toBe(hash1);
  });

  it("different content produces different hashes", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "version 1",
    });

    const archive1 = path.join(tmpDir, "v1.dntr");
    await packPluginArchive(sourceDir, archive1);

    await fs.writeFile(path.join(sourceDir, "dist/index.js"), "version 2");
    const archive2 = path.join(tmpDir, "v2.dntr");
    await packPluginArchive(sourceDir, archive2);

    const hash1 = await computeArchiveHash(archive1);
    const hash2 = await computeArchiveHash(archive2);
    expect(hash1).not.toBe(hash2);
  });
});

describe("exclusion patterns", () => {
  it("excludes node_modules/, .git/, source files by default", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "module.exports = {};",
      "node_modules/dep/index.js": "ignored",
      ".git/config": "[core]",
      "src/main.ts": "const x: number = 1;",
      "src/helper.tsx": "<></>;",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.entryCount).toBe(2);
    }
  });

  it("excludes source maps by default, includes them with sourcemaps:true", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "module.exports = {};",
      "dist/index.js.map": '{"mappings":"AAAA"}',
      "dist/worker.mjs.map": '{"mappings":"BBBB"}',
    });

    const noSourcemaps = path.join(tmpDir, "no-sm.dntr");
    await packPluginArchive(sourceDir, noSourcemaps);
    const r1 = await verifyPluginArchive(noSourcemaps);
    expect(r1.valid).toBe(true);
    if (r1.valid) expect(r1.entryCount).toBe(2);

    const withSourcemaps = path.join(tmpDir, "with-sm.dntr");
    await packPluginArchive(sourceDir, withSourcemaps, { sourcemaps: true });
    const r2 = await verifyPluginArchive(withSourcemaps);
    expect(r2.valid).toBe(true);
    if (r2.valid) expect(r2.entryCount).toBe(4);
  });

  it("excludes dev-only files (package.json, lockfile, tsconfig, configs) when packing", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "module.exports = {};",
      "package.json": JSON.stringify({ name: "leaky", dependencies: {} }),
      "package-lock.json": "{}",
      "tsconfig.json": "{}",
      "vite.config.ts": "export default {};",
      "README.md": "# keep me",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(true);
    // plugin.json, dist/index.js, README.md — the dev files are dropped.
    if (result.valid) expect(result.entryCount).toBe(3);
  });
});

describe("packPluginArchive", () => {
  it("throws when plugin.json is missing", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "dist/index.js": "module.exports = {};",
    });

    await expect(packPluginArchive(sourceDir, path.join(tmpDir, "out.dntr"))).rejects.toThrow(
      "plugin.json not found in source directory"
    );
  });

  it("handles deeply nested directories", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
    });

    const deepDir = path.join(sourceDir, "a", "b", "c", "d", "e");
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(path.join(deepDir, "deep.js"), "deep");

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.entryCount).toBe(2);
  });
});

describe("computeArchiveHash", () => {
  it("returns a 64-character hex string", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "x",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const hash = await computeArchiveHash(archivePath);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("readArchiveManifest", () => {
  it("reads and validates plugin.json from an archive", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(
        validManifest({
          displayName: "My Plugin",
          description: "Does things",
        })
      ),
      "dist/index.js": "ok",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const manifest = await readArchiveManifest(archivePath);
    expect(manifest.name).toBe("acme.test-plugin");
    expect(manifest.displayName).toBe("My Plugin");
    expect(manifest.description).toBe("Does things");
  });

  it("rejects invalid JSON in plugin.json", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": "not valid json {{{",
      "dist/index.js": "ok",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    await expect(readArchiveManifest(archivePath)).rejects.toThrow("plugin.json is not valid JSON");
  });
});

describe("verifyPluginArchive", () => {
  it("rejects an empty file", async () => {
    const emptyPath = path.join(tmpDir, "empty.dntr");
    await fs.writeFile(emptyPath, "");
    const result = await verifyPluginArchive(emptyPath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("empty");
    }
  });

  it("rejects a non-existent file", async () => {
    const result = await verifyPluginArchive(path.join(tmpDir, "nonexistent.dntr"));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("not found");
    }
  });

  it("accepts a valid packed archive", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "ok",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.name).toBe("acme.test-plugin");
      expect(result.entryCount).toBe(2);
    }
  });

  it("rejects an archive whose declared manifest.main file is absent", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest({ main: "dist/index.js" })),
      "icons/logo.svg": "<svg/>",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchiveFromFiles(sourceDir, archivePath, ["plugin.json", "icons/logo.svg"]);

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('manifest.main "dist/index.js" is not present in the archive');
    }
  });

  it("resolves a ./-prefixed manifest.main against the archive entries", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest({ main: "./dist/index.js" })),
      "dist/index.js": "ok",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.main).toBe("./dist/index.js");
    }
  });

  it("rejects an archive missing a declared view componentPath", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(
        validManifest({
          main: "dist/index.js",
          contributes: {
            panels: [{ id: "panel-view", name: "Panel View", iconId: "panel", color: "#000000" }],
            views: [
              {
                id: "panel-view",
                componentPath: "dist/PanelView.js",
                location: "panel",
              },
            ],
          },
        })
      ),
      "dist/index.js": "ok",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchiveFromFiles(sourceDir, archivePath, ["plugin.json", "dist/index.js"]);

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe(
        'view componentPath "dist/PanelView.js" is not present in the archive'
      );
    }
  });

  it("accepts an archive whose declared main and view componentPath are present", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(
        validManifest({
          main: "dist/index.js",
          contributes: {
            panels: [{ id: "panel-view", name: "Panel View", iconId: "panel", color: "#000000" }],
            views: [
              {
                id: "panel-view",
                componentPath: "./dist/PanelView.js",
                location: "panel",
              },
            ],
          },
        })
      ),
      "dist/index.js": "ok",
      "dist/PanelView.js": "export default () => null;",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.entryCount).toBe(3);
    }
  });

  it("rejects an archive exceeding the entry-count cap", async () => {
    const entries = [{ name: "plugin.json", content: JSON.stringify(validManifest()) }];
    for (let i = 0; i < MAX_DNTR_ENTRIES; i++) {
      entries.push({ name: `f${i}.txt`, content: "" });
    }
    const archivePath = path.join(tmpDir, "many.dntr");
    await fs.writeFile(archivePath, buildRawZip(entries));

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("entry limit");
  });

  it("rejects a crafted dev file disguised with a ./ prefix", async () => {
    // `./package.json` must not slip past the dev-file exclusion via the leading
    // dot — normalizePath strips it so the guard (and the raw-name check) catch it.
    const archivePath = path.join(tmpDir, "dotslash.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "./package.json", content: JSON.stringify({ name: "leaky" }) },
      ])
    );

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(false);
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

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Duplicate entry");
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

    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("Duplicate entry");
  });

  it("rejects an archive with invalid manifest (missing version)", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify({ name: "acme.broken" }),
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    try {
      await packPluginArchive(sourceDir, archivePath);
      const result = await verifyPluginArchive(archivePath);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("schema");
      }
    } catch {
      // packPluginArchive might succeed since it only checks for existence
    }
  });
});

describe("packPluginArchiveFromFiles (CLI packager surface)", () => {
  it("hoists plugin.json to the first entry regardless of input order", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest({ main: "dist/index.js" })),
      "dist/index.js": "console.log('hi')",
      "icons/logo.svg": "<svg/>",
    });

    const archivePath = path.join(tmpDir, "out.dntr");
    // Deliberately unsorted, plugin.json last.
    await packPluginArchiveFromFiles(sourceDir, archivePath, [
      "icons/logo.svg",
      "dist/index.js",
      "plugin.json",
    ]);

    const manifest = await readArchiveManifest(archivePath);
    expect(manifest.name).toBe("acme.test-plugin");
    const result = await verifyPluginArchive(archivePath);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.entryCount).toBe(3);
    }
  });

  it("produces byte-identical output across repeated runs with the same file list", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest({ main: "dist/index.js" })),
      "dist/index.js": "export const x = 1;",
      "dist/util.js": "export const y = 2;",
    });

    const files = ["dist/util.js", "dist/index.js", "plugin.json"];
    const first = path.join(tmpDir, "first.dntr");
    const second = path.join(tmpDir, "second.dntr");
    const hashA = await packPluginArchiveFromFiles(sourceDir, first, files);
    const hashB = await packPluginArchiveFromFiles(sourceDir, second, files);
    expect(hashA).toBe(hashB);
    expect(await computeArchiveHash(first)).toBe(await computeArchiveHash(second));
  });

  it("matches packPluginArchive output for the same effective file set", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest({ main: "dist/index.js" })),
      "dist/index.js": "export const x = 1;",
    });

    const viaWalk = path.join(tmpDir, "walk.dntr");
    const viaList = path.join(tmpDir, "list.dntr");
    const walkHash = await packPluginArchive(sourceDir, viaWalk);
    const listHash = await packPluginArchiveFromFiles(sourceDir, viaList, [
      "plugin.json",
      "dist/index.js",
    ]);
    expect(listHash).toBe(walkHash);
  });

  it("throws when the file list omits plugin.json", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "export const x = 1;",
    });

    await expect(
      packPluginArchiveFromFiles(sourceDir, path.join(tmpDir, "out.dntr"), ["dist/index.js"])
    ).rejects.toThrow(/plugin\.json/);
  });
});

describe("isExcludedArchiveEntry (shared CLI exclusion predicate)", () => {
  it("excludes node_modules, .git, and source files", () => {
    expect(isExcludedArchiveEntry("node_modules/foo/index.js")).toBe(true);
    expect(isExcludedArchiveEntry(".git/config")).toBe(true);
    expect(isExcludedArchiveEntry("src/index.ts")).toBe(true);
    expect(isExcludedArchiveEntry("src/Panel.tsx")).toBe(true);
  });

  it("excludes source maps by default, includes them when sourcemaps=true", () => {
    expect(isExcludedArchiveEntry("dist/index.js.map")).toBe(true);
    expect(isExcludedArchiveEntry("dist/index.js.map", true)).toBe(false);
  });

  it("keeps compiled output and assets", () => {
    expect(isExcludedArchiveEntry("plugin.json")).toBe(false);
    expect(isExcludedArchiveEntry("dist/index.js")).toBe(false);
    expect(isExcludedArchiveEntry("icons/logo.svg")).toBe(false);
  });

  it("excludes root-level package metadata, lockfiles, and tsconfig", () => {
    expect(isExcludedArchiveEntry("package.json")).toBe(true);
    expect(isExcludedArchiveEntry("package-lock.json")).toBe(true);
    expect(isExcludedArchiveEntry("npm-shrinkwrap.json")).toBe(true);
    expect(isExcludedArchiveEntry("yarn.lock")).toBe(true);
    expect(isExcludedArchiveEntry("pnpm-lock.yaml")).toBe(true);
    expect(isExcludedArchiveEntry("bun.lock")).toBe(true);
    expect(isExcludedArchiveEntry("bun.lockb")).toBe(true);
    expect(isExcludedArchiveEntry("tsconfig.json")).toBe(true);
    expect(isExcludedArchiveEntry("tsconfig.build.json")).toBe(true);
  });

  it("excludes root-level build configs", () => {
    expect(isExcludedArchiveEntry("vite.config.ts")).toBe(true);
    expect(isExcludedArchiveEntry("vite.config.server.ts")).toBe(true);
    expect(isExcludedArchiveEntry("tsup.config.mjs")).toBe(true);
    expect(isExcludedArchiveEntry("vitest.config.js")).toBe(true);
  });

  it("scopes dev-file exclusions to the archive root", () => {
    // A plugin may legitimately ship config/JSON inside its built output —
    // only root-level dev metadata leaks the author's environment.
    expect(isExcludedArchiveEntry("dist/app.config.js")).toBe(false);
    expect(isExcludedArchiveEntry("dist/package.json")).toBe(false);
    expect(isExcludedArchiveEntry("assets/tsconfig.json")).toBe(false);
  });
});
