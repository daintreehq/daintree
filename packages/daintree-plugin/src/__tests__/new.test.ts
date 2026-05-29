import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scaffoldPlugin } from "../commands/new.js";
import { getPluginManifestSchema } from "../../../../electron/schemas/plugin.js";
import { TEMPLATE_KINDS } from "../scaffold/templates.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-new-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

describe("scaffoldPlugin", () => {
  for (const template of TEMPLATE_KINDS) {
    it(`scaffolds a valid project from the "${template}" template`, async () => {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "issue-helper",
        publisher: "acme",
        displayName: "Issue Helper",
        template,
      });

      expect(result.scopedName).toBe("acme.issue-helper");
      expect(result.dir).toBe(path.join(tmpDir, "issue-helper"));

      // plugin.json passes the host's manifest schema.
      const manifest = await readJson(path.join(result.dir, "plugin.json"));
      const parsed = getPluginManifestSchema(false).safeParse(manifest);
      expect(parsed.success).toBe(true);
      expect(manifest.name).toBe("acme.issue-helper");

      // package.json + entry exist.
      const pkg = await readJson(path.join(result.dir, "package.json"));
      expect(pkg.name).toBe("acme.issue-helper");
      expect((pkg.scripts as Record<string, string>).package).toContain("daintree-plugin package");
      await expect(fs.access(path.join(result.dir, "src", "index.ts"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(result.dir, ".gitignore"))).resolves.toBeUndefined();
    });
  }

  it("refuses to overwrite an existing directory", async () => {
    await fs.mkdir(path.join(tmpDir, "taken"));
    await expect(
      scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "taken",
        publisher: "acme",
        displayName: "Taken",
        template: "command",
      })
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an invalid publisher segment", async () => {
    await expect(
      scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "ok-name",
        publisher: "Acme Corp",
        displayName: "x",
        template: "command",
      })
    ).rejects.toThrow(/Publisher/);
  });

  it("rejects an invalid plugin-name segment", async () => {
    await expect(
      scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "Bad_Name",
        publisher: "acme",
        displayName: "x",
        template: "command",
      })
    ).rejects.toThrow(/Plugin name/);
  });

  it("view template contributes a panel view with a built componentPath", async () => {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "viewer",
      publisher: "acme",
      displayName: "Viewer",
      template: "view",
    });
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    const views = (manifest.contributes as { experimental_views: Array<{ componentPath: string }> })
      .experimental_views;
    expect(views[0].componentPath).toBe("dist/panel.js");
    await expect(fs.access(path.join(result.dir, "src", "panel.tsx"))).resolves.toBeUndefined();
  });
});
