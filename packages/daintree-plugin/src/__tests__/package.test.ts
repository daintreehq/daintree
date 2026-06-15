import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPackage } from "../commands/package.js";
import { verifyPluginArchive } from "../../../../electron/services/PluginArchive.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-package-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(rel: string, content: string): Promise<void> {
  const full = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

async function fixture(): Promise<void> {
  await writeFile(
    "plugin.json",
    JSON.stringify({
      name: "acme.packtest",
      version: "0.2.0",
      main: "dist/index.js",
      engines: { daintree: "^0.11.0" },
    })
  );
  await writeFile("dist/index.js", "export const x = 1;");
  await writeFile("dist/index.js.map", '{"version":3}');
  await writeFile("src/index.ts", "export const x: number = 1;");
  await writeFile("node_modules/dep/index.js", "module.exports = {}");
  // dist/ and node_modules/ are gitignored — dist must still ship (build output).
  await writeFile(".gitignore", "dist/\nnode_modules/\n");
}

describe("runPackage", () => {
  it("dry run lists files without writing a .dntr", async () => {
    await fixture();
    const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
    expect(result.outputPath).toBeUndefined();
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((e) => e.endsWith(".dntr"))).toBe(false);
  });

  it("includes built output, excludes source and node_modules", async () => {
    await fixture();
    const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
    expect(result.files).toContain("plugin.json");
    expect(result.files).toContain("dist/index.js");
    expect(result.files).not.toContain("src/index.ts");
    expect(result.files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    // Source maps excluded by default.
    expect(result.files).not.toContain("dist/index.js.map");
  });

  it("excludes dev-only files (package.json, lockfile, tsconfig, configs)", async () => {
    await fixture();
    await writeFile("package.json", JSON.stringify({ name: "acme.packtest", private: true }));
    await writeFile("package-lock.json", "{}");
    await writeFile("tsconfig.json", "{}");
    await writeFile("vite.config.ts", "export default {};");
    const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
    expect(result.files).not.toContain("package.json");
    expect(result.files).not.toContain("package-lock.json");
    expect(result.files).not.toContain("tsconfig.json");
    expect(result.files).not.toContain("vite.config.ts");
    // Real plugin output still ships.
    expect(result.files).toContain("plugin.json");
    expect(result.files).toContain("dist/index.js");
  });

  it("includes source maps when sourcemaps=true", async () => {
    await fixture();
    const result = await runPackage({
      dir: tmpDir,
      dryRun: true,
      skipBuild: true,
      sourcemaps: true,
    });
    expect(result.files).toContain("dist/index.js.map");
  });

  it("writes a verifiable .dntr archive", async () => {
    await fixture();
    const result = await runPackage({ dir: tmpDir, skipBuild: true });
    expect(result.outputPath).toBe(path.join(tmpDir, "acme.packtest-0.2.0.dntr"));
    const verify = await verifyPluginArchive(result.outputPath!);
    expect(verify.valid).toBe(true);
    if (verify.valid) {
      expect(verify.manifest.name).toBe("acme.packtest");
    }
  });

  it("fails on an invalid manifest", async () => {
    await writeFile("plugin.json", JSON.stringify({ name: "no-dot", version: "1.0.0" }));
    await writeFile("dist/index.js", "export const x = 1;");
    await expect(runPackage({ dir: tmpDir, skipBuild: true })).rejects.toThrow(/validation failed/);
  });

  it("rejects a path-traversal version before any archive is written", async () => {
    await writeFile(
      "plugin.json",
      JSON.stringify({
        name: "acme.packtest",
        version: "../../escape",
        main: "dist/index.js",
        engines: { daintree: "^0.11.0" },
      })
    );
    await writeFile("dist/index.js", "export const x = 1;");
    await expect(runPackage({ dir: tmpDir, skipBuild: true })).rejects.toThrow(/validation failed/);
  });

  it("dry run never invokes the Vite build (no vite in fixture)", async () => {
    await fixture();
    // No node_modules/.bin/vite exists; if dry-run tried to build it would throw.
    const result = await runPackage({ dir: tmpDir, dryRun: true });
    expect(result.outputPath).toBeUndefined();
  });
});
