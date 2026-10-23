import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  isExcludedArchiveEntry,
  packPluginArchive,
  readArchiveTemplateProjectPlugins,
  verifyPluginArchive,
} from "../PluginArchive.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-archive-templates-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(root: string, relPath: string, content = "x"): Promise<void> {
  const abs = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe("project template payloads in a .dntr (#13825)", () => {
  it("keeps a template's sources, dev files and dotfiles that a plugin's own would lose", () => {
    for (const name of [
      "project-templates/site/src/main.ts",
      "project-templates/site/src/App.tsx",
      "project-templates/site/dist/app.js.map",
      "project-templates/site/package.json",
      "project-templates/site/vite.config.ts",
      "project-templates/site/.gitignore",
      "project-templates/site/.daintree/plugins/site-tools/plugin.json",
    ]) {
      expect(isExcludedArchiveEntry(name), name).toBe(false);
    }
    // The same files outside the payload root are still stripped.
    expect(isExcludedArchiveEntry("templates/site/src/main.ts")).toBe(true);
    expect(isExcludedArchiveEntry("src/main.ts")).toBe(true);
  });

  it("never ships a template's installed dependencies, repository or Finder litter", () => {
    expect(isExcludedArchiveEntry("project-templates/site/node_modules/x/index.js")).toBe(true);
    expect(isExcludedArchiveEntry("project-templates/site/.git/HEAD")).toBe(true);
    expect(isExcludedArchiveEntry("project-templates/site/src/.DS_Store")).toBe(true);
  });

  it("packs a template intact and the archive verifies", async () => {
    const src = path.join(tmpDir, "plugin");
    await write(
      src,
      "plugin.json",
      JSON.stringify({
        name: "acme.sites",
        version: "1.0.0",
        contributes: {
          projectTemplates: [{ id: "site", title: "Site", description: "A site." }],
        },
      })
    );
    await write(src, "dist/index.js");
    await write(src, "src/index.ts");
    await write(src, "project-templates/site/src/main.ts", "export {};\n");
    await write(src, "project-templates/site/.gitignore", "dist\n");
    await write(src, "project-templates/site/package.json", "{}");
    await write(src, "project-templates/site/node_modules/x/index.js");
    await write(src, "project-templates/site/.daintree/plugins/site-tools/plugin.json", "{}");

    const archive = path.join(tmpDir, "acme.dntr");
    await packPluginArchive(src, archive);

    const verified = await verifyPluginArchive(archive);
    expect(verified.valid).toBe(true);

    const projectPlugins = await readArchiveTemplateProjectPlugins(archive, ["site", "blog"]);
    expect(Object.fromEntries(projectPlugins)).toEqual({ site: ["site-tools"], blog: [] });

    // Packed from the same tree, the plugin's own source is still left out.
    const { default: yauzl } = await import("yauzl");
    const names = await new Promise<string[]>((resolve, reject) => {
      yauzl.open(archive, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const seen: string[] = [];
        zip.on("entry", (entry: { fileName: string }) => {
          seen.push(entry.fileName);
          zip.readEntry();
        });
        zip.on("end", () => resolve(seen));
        zip.readEntry();
      });
    });
    expect(names).toContain("project-templates/site/src/main.ts");
    expect(names).toContain("project-templates/site/.gitignore");
    expect(names).toContain("project-templates/site/package.json");
    expect(names).not.toContain("src/index.ts");
    expect(names.some((name) => name.includes("node_modules"))).toBe(false);
  });

  it("finds a project plugin whatever case its folders are written in", async () => {
    const src = path.join(tmpDir, "plugin");
    await write(
      src,
      "plugin.json",
      JSON.stringify({
        name: "acme.sites",
        version: "1.0.0",
        contributes: {
          projectTemplates: [{ id: "site", title: "Site", description: "A site." }],
        },
      })
    );
    await write(src, "project-templates/site/.DAINTREE/Plugins/Site-Tools/plugin.json", "{}");
    // `ſ` folds to `s` on a case-insensitive disk, so this is `plugins` there.
    await write(src, "project-templates/blog/.daintree/plugin\u017F/blog-tools/plugin.json", "{}");
    const archive = path.join(tmpDir, "acme.dntr");
    await packPluginArchive(src, archive);

    const projectPlugins = await readArchiveTemplateProjectPlugins(archive, ["site", "blog"]);
    expect(Object.fromEntries(projectPlugins)).toEqual({
      site: ["Site-Tools"],
      blog: ["blog-tools"],
    });
  });

  it("reads nothing for an archive that declares no templates", async () => {
    expect((await readArchiveTemplateProjectPlugins(path.join(tmpDir, "x.dntr"), [])).size).toBe(0);
  });
});
