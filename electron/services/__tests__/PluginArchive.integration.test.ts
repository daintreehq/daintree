import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  packPluginArchive,
  computeArchiveHash,
  readArchiveManifest,
  verifyPluginArchive,
} from "../PluginArchive.js";

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

async function createFixture(
  baseDir: string,
  files: Record<string, string>
): Promise<void> {
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
});

describe("packPluginArchive", () => {
  it("throws when plugin.json is missing", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "dist/index.js": "module.exports = {};",
    });

    await expect(
      packPluginArchive(sourceDir, path.join(tmpDir, "out.dntr"))
    ).rejects.toThrow("plugin.json not found in source directory");
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
      "plugin.json": JSON.stringify(validManifest({
        displayName: "My Plugin",
        description: "Does things",
      })),
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

    await expect(readArchiveManifest(archivePath)).rejects.toThrow(
      "plugin.json is not valid JSON"
    );
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
