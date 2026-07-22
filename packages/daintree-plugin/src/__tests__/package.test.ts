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

  describe(".dntrignore", () => {
    it("excludes files that .gitignore keeps tracked", async () => {
      await fixture();
      await writeFile("README.md", "# docs");
      await writeFile("notes/design.md", "# notes");
      await writeFile(".dntrignore", "notes/\n");

      const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
      expect(result.files.some((f) => f.startsWith("notes/"))).toBe(false);
      // Un-ignored siblings still ship — this prunes, it doesn't allowlist.
      expect(result.files).toContain("README.md");
    });

    it("prunes stray files inside protected build output", async () => {
      await fixture();
      await writeFile("dist/docs/internal.md", "# internal");
      await writeFile(".dntrignore", "dist/docs/\n");

      const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
      // dist/ is force-included against .gitignore, so this is the case that
      // fails if .dntrignore is applied only to the gitignore-aware pass.
      expect(result.files).not.toContain("dist/docs/internal.md");
      expect(result.files).toContain("dist/index.js");
    });

    it("is not overridden by a .gitignore negation", async () => {
      await fixture();
      await writeFile("README.md", "# readme");
      // `*.md` + `!README.md` is an everyday .gitignore shape. Folding both
      // files into one ordered rule list would let that negation cancel the
      // .dntrignore rule and ship the file anyway.
      await writeFile(".gitignore", "dist/\nnode_modules/\n*.md\n!README.md\n");
      await writeFile(".dntrignore", "README.md\n");

      const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
      expect(result.files).not.toContain("README.md");
    });

    it("cannot re-include a file .gitignore dropped", async () => {
      await fixture();
      await writeFile("secret.txt", "shh");
      await writeFile(".gitignore", "dist/\nnode_modules/\nsecret.txt\n");
      // .dntrignore only ever subtracts; a negation in it must not add back.
      await writeFile(".dntrignore", "!secret.txt\n");

      const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
      expect(result.files).not.toContain("secret.txt");
    });

    it("fails before writing when it would drop a manifest-referenced file", async () => {
      await fixture();
      await writeFile(".dntrignore", "dist/index.js\n");

      // Named error, not a silently broken archive — and it fires on the dry
      // run too, which is the documented way to audit the file list.
      await expect(runPackage({ dir: tmpDir, dryRun: true, skipBuild: true })).rejects.toThrow(
        /dist\/index\.js/
      );

      await expect(runPackage({ dir: tmpDir, skipBuild: true })).rejects.toThrow(/dist\/index\.js/);
      const entries = await fs.readdir(tmpDir);
      expect(entries.some((e) => e.endsWith(".dntr"))).toBe(false);
    });

    it("fails when it would drop a contributed skill", async () => {
      await writeFile(
        "plugin.json",
        JSON.stringify({
          name: "acme.packtest",
          version: "0.2.0",
          main: "dist/index.js",
          engines: { daintree: "^0.11.0" },
          contributes: { skills: [{ id: "tdd", name: "TDD", path: "skills/tdd.md" }] },
        })
      );
      await writeFile("dist/index.js", "export const x = 1;");
      await writeFile("skills/tdd.md", "# tdd");
      await writeFile(".gitignore", "dist/\nnode_modules/\n");
      // A plausible authoring mistake: excluding docs also excludes the skill,
      // which the host would otherwise just skip with a warning at runtime.
      await writeFile(".dntrignore", "*.md\n");

      await expect(runPackage({ dir: tmpDir, dryRun: true, skipBuild: true })).rejects.toThrow(
        /skills\/tdd\.md/
      );
    });

    it("leaves vendored runtime deps under the build output alone", async () => {
      await fixture();
      await writeFile("dist/node_modules/dep/index.js", "module.exports = {}");
      await writeFile(".dntrignore", "notes/\n");

      // Only a ROOT node_modules is excluded from a .dntr, so a plugin that
      // vendors its runtime deps into dist/ ships them.
      const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
      expect(result.files).toContain("dist/node_modules/dep/index.js");
      expect(result.files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    });

    it("cannot drop the manifest", async () => {
      await fixture();
      await writeFile(".dntrignore", "plugin.json\n");

      const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
      expect(result.files).toContain("plugin.json");
    });

    it("keeps itself out of the archive", async () => {
      await fixture();
      await writeFile(".dntrignore", "notes/\n");

      const result = await runPackage({ dir: tmpDir, skipBuild: true });
      expect(result.files).not.toContain(".dntrignore");
      const verify = await verifyPluginArchive(result.outputPath!);
      expect(verify.valid).toBe(true);
    });
  });

  it("preserves a gitignored custom output dir referenced with a leading ./", async () => {
    await writeFile(
      "plugin.json",
      JSON.stringify({
        name: "acme.packtest",
        version: "0.2.0",
        main: "./build/index.js",
        engines: { daintree: "^0.11.0" },
      })
    );
    await writeFile("build/index.js", "export const x = 1;");
    await writeFile(".gitignore", "build/\nnode_modules/\n");

    // The `./` has to be stripped before the top segment is read, or `build/`
    // is never treated as protected and the entry point is silently dropped.
    const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
    expect(result.files).toContain("build/index.js");
  });

  it("dry run never invokes the Vite build (no vite in fixture)", async () => {
    await fixture();
    // No node_modules/.bin/vite exists; if dry-run tried to build it would throw.
    const result = await runPackage({ dir: tmpDir, dryRun: true });
    expect(result.outputPath).toBeUndefined();
  });
});
