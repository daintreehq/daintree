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

  it("escapes a hostile displayName so generated source stays well-formed", async () => {
    const displayName = 'Bob "The" Tool';
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "inject",
      publisher: "acme",
      displayName,
      template: "command",
    });
    const src = await fs.readFile(path.join(result.dir, "src", "index.ts"), "utf8");
    // Values are embedded via JSON.stringify, so inner quotes are escaped rather
    // than left raw to break the surrounding double-quoted literal.
    expect(src).toContain(JSON.stringify(`${displayName}: Run`));
    expect(src).toContain(JSON.stringify(`Hello from ${displayName}`));
    // plugin.json remains valid JSON with the verbatim display name.
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    expect(manifest.displayName).toBe(displayName);
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
    const contributes = manifest.contributes as {
      views: Array<{ id: string; componentPath: string }>;
      panels: Array<{ id: string; hasPty?: boolean }>;
    };
    expect(contributes.views[0].componentPath).toBe("dist/panel.js");
    await expect(fs.access(path.join(result.dir, "src", "panel.tsx"))).resolves.toBeUndefined();

    // The runtime (`PluginService.loadPlugin`) registers a panel kind only while
    // iterating declared `panels`, attaching a view's componentPath when ids
    // match. A view with no matching non-PTY panel is ignored, so the scaffold
    // must pair every view with a panel of the same id for it to render.
    const panel = contributes.panels.find((p) => p.id === contributes.views[0].id);
    expect(panel).toBeDefined();
    expect(panel?.hasPty ?? false).toBe(false);
  });

  it("full template pairs its contributed view with a matching panel", async () => {
    const result = await scaffoldPlugin({
      cwd: tmpDir,
      targetDir: "kitchen-sink",
      publisher: "acme",
      displayName: "Kitchen Sink",
      template: "full",
    });
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    const contributes = manifest.contributes as {
      views: Array<{ id: string }>;
      panels: Array<{ id: string; hasPty?: boolean }>;
    };
    const panel = contributes.panels.find((p) => p.id === contributes.views[0].id);
    expect(panel).toBeDefined();
    expect(panel?.hasPty ?? false).toBe(false);
  });

  for (const template of ["mcp", "full"] as const) {
    it(`"${template}" template builds the server entry through a separate node config`, async () => {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: `srv-${template}`,
        publisher: "acme",
        displayName: "Srv",
        template,
      });

      const clientConfig = await fs.readFile(path.join(result.dir, "vite.config.ts"), "utf8");
      const serverConfig = await fs.readFile(
        path.join(result.dir, "vite.config.server.ts"),
        "utf8"
      );

      // The server entry must NOT go through the browser config — that's the
      // bug where node code is built for the client environment and crashes.
      expect(clientConfig).not.toContain("src/server.ts");
      expect(serverConfig).toContain("src/server.ts");
      expect(serverConfig).toContain('daintreePlugin({ target: "node" })');
      // The second build pass must not wipe the browser output.
      expect(serverConfig).toContain("emptyOutDir: false");

      // The build script chains both passes so a plain `npm run build` produces
      // both bundles.
      const pkg = await readJson(path.join(result.dir, "package.json"));
      const buildScript = (pkg.scripts as Record<string, string>).build;
      expect(buildScript).toContain("vite build");
      expect(buildScript).toContain("--config vite.config.server.ts");
    });
  }

  for (const template of ["command", "view"] as const) {
    it(`"${template}" template has no separate server config`, async () => {
      const result = await scaffoldPlugin({
        cwd: tmpDir,
        targetDir: `nosrv-${template}`,
        publisher: "acme",
        displayName: "NoSrv",
        template,
      });
      await expect(fs.access(path.join(result.dir, "vite.config.server.ts"))).rejects.toThrow();
      const pkg = await readJson(path.join(result.dir, "package.json"));
      expect((pkg.scripts as Record<string, string>).build).toBe("vite build");
    });
  }
});
