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

  it("leaves the authoring skill and tour captures out of the archive", async () => {
    await fixture();
    await writeFile(".claude/skills/daintree-tour/SKILL.md", "---\nname: daintree-tour\n---\n");
    await writeFile(".tour-preview/daintree/capture.json", "{}");
    await writeFile(".gitignore", "dist/\nnode_modules/\n.tour-preview/\n");
    const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
    expect(result.files.some((f) => f.startsWith(".claude/"))).toBe(false);
    expect(result.files.some((f) => f.startsWith(".tour-preview/"))).toBe(false);
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

  it("packages a plugin.json saved with a UTF-8 byte-order mark", async () => {
    await fixture();
    const manifest = await fs.readFile(path.join(tmpDir, "plugin.json"), "utf8");
    await writeFile("plugin.json", "\uFEFF" + manifest);
    const result = await runPackage({ dir: tmpDir, skipBuild: true });
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

  describe("tour assets", () => {
    async function tourManifest(audioUrl: string | null = "tours/welcome/intro.ogg") {
      await writeFile(
        "plugin.json",
        JSON.stringify({
          name: "acme.welcome-tour",
          version: "0.1.0",
          engines: { daintree: ">=0.38.0" },
          contributes: {
            tours: [
              {
                id: "welcome",
                title: "Welcome Tour",
                componentPath: "dist/tour.js",
                audioHosts: ["cdn.example.com"],
                chapters: [
                  { id: "intro", duration: 6, audioUrl, narrationHash: "3fa9c21e" },
                  {
                    id: "publish",
                    duration: 5,
                    audioUrl: "https://cdn.example.com/tours/welcome/publish.ogg",
                    narrationHash: "0b7d1c44",
                  },
                ],
              },
            ],
          },
        })
      );
    }

    it("refuses a tour whose scene module is missing, naming the path", async () => {
      await tourManifest();

      await expect(runPackage({ dir: tmpDir, dryRun: true, skipBuild: true })).rejects.toThrow(
        /dist\/tour\.js/
      );
      await expect(runPackage({ dir: tmpDir, skipBuild: true })).rejects.toThrow(/dist\/tour\.js/);
      const entries = await fs.readdir(tmpDir);
      expect(entries.some((e) => e.endsWith(".dntr"))).toBe(false);
    });

    it("packages a tour whose local narration is missing, since playback falls back to silence", async () => {
      await tourManifest();
      await writeFile("dist/tour.js", "export default {};");

      const result = await runPackage({ dir: tmpDir, skipBuild: true });
      expect(result.files).toContain("dist/tour.js");
      expect((await verifyPluginArchive(result.outputPath!)).valid).toBe(true);
    });

    it("ships a tour scene module from a gitignored custom output dir", async () => {
      await tourManifest(null);
      const manifest = JSON.parse(await fs.readFile(path.join(tmpDir, "plugin.json"), "utf8"));
      manifest.contributes.tours[0].componentPath = "./build/tour.js";
      await writeFile("plugin.json", JSON.stringify(manifest));
      await writeFile("build/tour.js", "export default {};");
      await writeFile(".gitignore", "build/\n");

      const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
      expect(result.files).toContain("build/tour.js");
    });
  });

  it("refuses missing Assistant knowledge, including a skill directory without SKILL.md", async () => {
    await fixture();
    const manifest = JSON.parse(await fs.readFile(path.join(tmpDir, "plugin.json"), "utf8"));
    manifest.contributes = {
      databases: [{ id: "ledger", location: "local" }],
      assistantKnowledge: {
        instructions: "knowledge/instructions.md",
        skills: [{ id: "deploy", path: "knowledge/skills/deploy" }],
        references: [{ id: "api", path: "./knowledge/api.md" }],
      },
    };
    await writeFile("plugin.json", JSON.stringify(manifest));
    await writeFile("knowledge/instructions.md", "# Instructions");
    await writeFile("knowledge/skills/deploy/notes.md", "# Not the manifest");

    const failure = runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
    await expect(failure).rejects.toThrow(/knowledge\/skills\/deploy\/SKILL\.md/);
    await expect(runPackage({ dir: tmpDir, dryRun: true, skipBuild: true })).rejects.toThrow(
      /knowledge\/api\.md/
    );

    await writeFile("knowledge/skills/deploy/SKILL.md", "---\nname: deploy\n---\n");
    await writeFile("knowledge/api.md", "# API");
    const result = await runPackage({ dir: tmpDir, skipBuild: true });
    expect((await verifyPluginArchive(result.outputPath!)).valid).toBe(true);
  });

  it("refuses a referenced file reached through a symlink that leaves the plugin", async () => {
    await fixture();
    const manifest = JSON.parse(await fs.readFile(path.join(tmpDir, "plugin.json"), "utf8"));
    manifest.contributes = { skills: [{ id: "tdd", name: "TDD", path: "skills/tdd.md" }] };
    await writeFile("plugin.json", JSON.stringify(manifest));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-package-outside-"));
    try {
      await fs.writeFile(path.join(outside, "tdd.md"), "# tdd", "utf8");
      await fs.mkdir(path.join(tmpDir, "skills"), { recursive: true });
      await fs.symlink(path.join(outside, "tdd.md"), path.join(tmpDir, "skills", "tdd.md"));

      await expect(runPackage({ dir: tmpDir, dryRun: true, skipBuild: true })).rejects.toThrow(
        /outside the plugin directory.*skills\[0\]\.path "skills\/tdd\.md"/
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("dry run never invokes the Vite build (no vite in fixture)", async () => {
    await fixture();
    // No node_modules/.bin/vite exists; if dry-run tried to build it would throw.
    const result = await runPackage({ dir: tmpDir, dryRun: true });
    expect(result.outputPath).toBeUndefined();
  });
});

describe("project templates (#13825)", () => {
  async function templateFixture(): Promise<void> {
    await writeFile(
      "plugin.json",
      JSON.stringify({
        name: "acme.packtest",
        version: "0.2.0",
        main: "dist/index.js",
        engines: { daintree: "^0.11.0" },
        contributes: {
          projectTemplates: [{ id: "site", title: "Site", description: "A starter site." }],
        },
      })
    );
    await writeFile("dist/index.js", "export const x = 1;");
    await writeFile(".gitignore", "dist/\nnode_modules/\n*.log\n");
    await writeFile("project-templates/site/src/main.ts", "export {};");
    await writeFile("project-templates/site/.gitignore", "node_modules\n");
    await writeFile("project-templates/site/.daintree/recipes/dev.json", "{}");
    await writeFile("project-templates/site/notes.log", "template content");
    await writeFile("project-templates/site/node_modules/dep/index.js", "");
  }

  it("ships every template file, sources and dotfiles included, whatever .gitignore says", async () => {
    await templateFixture();
    const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
    expect(result.files).toEqual(
      expect.arrayContaining([
        "project-templates/site/src/main.ts",
        "project-templates/site/.gitignore",
        "project-templates/site/.daintree/recipes/dev.json",
        "project-templates/site/notes.log",
      ])
    );
    expect(result.files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("still lets .dntrignore leave template files out", async () => {
    await templateFixture();
    await writeFile(".dntrignore", "project-templates/site/notes.log\n");
    const result = await runPackage({ dir: tmpDir, dryRun: true, skipBuild: true });
    expect(result.files).not.toContain("project-templates/site/notes.log");
    expect(result.files).toContain("project-templates/site/.gitignore");
  });

  it("writes an archive that verifies", async () => {
    await templateFixture();
    const result = await runPackage({ dir: tmpDir, skipBuild: true });
    const verify = await verifyPluginArchive(result.outputPath!);
    expect(verify.valid).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink in a template rather than dropping it",
    async () => {
      await templateFixture();
      await fs.symlink(
        path.join(tmpDir, "dist", "index.js"),
        path.join(tmpDir, "project-templates", "site", "linked.js")
      );
      await expect(runPackage({ dir: tmpDir, dryRun: true, skipBuild: true })).rejects.toThrow(
        "project-templates/site/linked.js"
      );
    }
  );

  it.skipIf(process.platform === "win32")(
    "refuses a template folder that is itself a symlink",
    async () => {
      await templateFixture();
      const outside = path.join(tmpDir, "..", `outside-${path.basename(tmpDir)}`);
      await fs.mkdir(outside, { recursive: true });
      try {
        await fs.writeFile(path.join(outside, ".env"), "SECRET=1");
        await fs.rm(path.join(tmpDir, "project-templates", "site"), { recursive: true });
        await fs.symlink(outside, path.join(tmpDir, "project-templates", "site"));
        await expect(runPackage({ dir: tmpDir, dryRun: true, skipBuild: true })).rejects.toThrow(
          "project-templates/site is a symbolic link"
        );
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    }
  );

  it("refuses a declared template with no files to ship", async () => {
    await templateFixture();
    await fs.rm(path.join(tmpDir, "project-templates"), { recursive: true });
    await expect(runPackage({ dir: tmpDir, dryRun: true, skipBuild: true })).rejects.toThrow(
      "project-templates/site/"
    );
  });
});
