import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNew, scaffoldPlugin } from "../commands/new.js";
import { runValidate } from "../commands/validate.js";
import {
  listReferenceAppFiles,
  referenceAppRoot,
  referenceMcpName,
  REFERENCE_APP_NAME,
  stageReferenceApp,
} from "../scaffold/referenceApp.js";
import { SCAFFOLD_TOOLCHAIN_RANGES } from "../scaffold/templates.js";
import { getPluginManifestSchema } from "../../../../electron/schemas/plugin.js";

let tmpDir: string;
let projectRoot: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-app-scaffold-")));
  projectRoot = path.join(tmpDir, "shop");
  await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function scaffoldApp(targetDir = "orders", displayName = "Order Desk") {
  return scaffoldPlugin({
    cwd: tmpDir,
    targetDir,
    publisher: "shop",
    displayName,
    template: "app",
    projectRoot,
  });
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

describe("the app template", () => {
  it("scaffolds a project application that validates and loads from the copied build", async () => {
    const result = await scaffoldApp();
    const manifest = await readJson(path.join(result.dir, "plugin.json"));
    expect(manifest).toMatchObject({
      name: "shop.orders",
      displayName: "Order Desk",
      scope: "project",
      mcpName: "orders",
      application: { name: "Order Desk", destination: "home" },
    });
    expect(getPluginManifestSchema("project").safeParse(manifest).success).toBe(true);
    // The CLI's own validator, as `doctor` runs it: every componentPath, icon
    // and tour module the manifest names has to exist in the copied dist/.
    const validated = await runValidate({ dir: result.dir, origin: "project" });
    expect(validated.errors).toEqual([]);
  });

  it("copies the reference's build byte for byte, so the app opens before any install", async () => {
    const result = await scaffoldApp();
    const reference = await referenceAppRoot();
    const builtFiles = (await listReferenceAppFiles(reference)).filter((f) =>
      f.startsWith("dist/")
    );
    expect(builtFiles).toContain("dist/index.js");
    for (const file of builtFiles) {
      expect(await fs.readFile(path.join(result.dir, file))).toEqual(
        await fs.readFile(path.join(reference, file))
      );
    }
    await expect(fs.access(path.join(result.dir, "node_modules"))).rejects.toThrow();
  });

  it("builds a dist that never names the reference, which is what lets a rename skip the rebuild", async () => {
    const reference = await referenceAppRoot();
    for (const file of await listReferenceAppFiles(reference)) {
      if (!file.startsWith("dist/") && !file.startsWith("src/")) continue;
      const text = await fs.readFile(path.join(reference, file), "utf8");
      expect(text.includes(REFERENCE_APP_NAME), file).toBe(false);
    }
  });

  it("renames the prose, tests and skill with the plugin, pointing at its own MCP server", async () => {
    const result = await scaffoldApp();
    for (const file of [
      "README.md",
      "AGENTS.md",
      "__tests__/worker.test.ts",
      "review/home.stories.tsx",
    ]) {
      const text = await fs.readFile(path.join(result.dir, file), "utf8");
      expect(text.includes(REFERENCE_APP_NAME), file).toBe(false);
    }
    const agents = await fs.readFile(path.join(result.dir, "AGENTS.md"), "utf8");
    expect(agents).toContain(".daintree/data/shop.orders/");
    const skill = await fs.readFile(path.join(result.dir, "skills/request-desk.md"), "utf8");
    expect(skill).toContain("daintree-orders");
  });

  it("pins the toolchain the CLI was built beside, tour included", async () => {
    const result = await scaffoldApp();
    const pkg = (await readJson(path.join(result.dir, "package.json"))) as {
      name: string;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("shop.orders");
    for (const [name, range] of Object.entries(SCAFFOLD_TOOLCHAIN_RANGES)) {
      expect(pkg.devDependencies[name], name).toBe(range);
    }
  });

  it("keeps the reference's own package.json on the released toolchain ranges", async () => {
    const pkg = (await readJson(path.join(await referenceAppRoot(), "package.json"))) as {
      devDependencies: Record<string, string>;
    };
    for (const [name, range] of Object.entries(SCAFFOLD_TOOLCHAIN_RANGES)) {
      expect(pkg.devDependencies[name], name).toBe(range);
    }
  });

  it("writes nothing outside its own directory except the watcher recipe", async () => {
    // Agent instructions and config the project already has are the user's.
    const owned: Record<string, string> = {
      "AGENTS.md": "# Ours\n",
      "CLAUDE.md": "@AGENTS.md\n",
      ".claude/settings.json": '{"permissions":{}}\n',
      ".daintree/mcp.json": '{"plugins":{}}\n',
    };
    for (const [rel, content] of Object.entries(owned)) {
      await fs.mkdir(path.dirname(path.join(projectRoot, rel)), { recursive: true });
      await fs.writeFile(path.join(projectRoot, rel), content);
    }
    const result = await scaffoldApp();
    for (const [rel, content] of Object.entries(owned)) {
      expect(await fs.readFile(path.join(projectRoot, rel), "utf8"), rel).toBe(content);
    }
    expect((await fs.readdir(projectRoot)).sort()).toEqual(
      [".claude", ".daintree", ".git", "AGENTS.md", "CLAUDE.md"].sort()
    );
    expect((await fs.readdir(path.join(projectRoot, ".daintree"))).sort()).toEqual([
      "mcp.json",
      "plugins",
      "recipes",
    ]);
    expect(result.recipePath).toBeDefined();
  });

  it("refuses to scaffold an application outside a project", async () => {
    await expect(
      scaffoldPlugin({
        cwd: tmpDir,
        targetDir: "orders",
        publisher: "shop",
        displayName: "Order Desk",
        template: "app",
      })
    ).rejects.toThrow(/needs --project/);
    expect(await fs.readdir(tmpDir)).toEqual(["shop"]);
  });

  it("refuses --template app without --project before prompting or writing", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    try {
      await expect(
        runNew("orders", { yes: true, publisher: "shop", template: "app" })
      ).rejects.toThrow(/needs --project/);
    } finally {
      cwd.mockRestore();
    }
    expect(await fs.readdir(tmpDir)).toEqual(["shop"]);
  });
});

describe("referenceMcpName", () => {
  it("derives a name the manifest accepts from any plugin segment", async () => {
    const manifest = await readJson(path.join(await referenceAppRoot(), "plugin.json"));
    const schema = getPluginManifestSchema("project");
    for (const name of [
      "orders",
      "a-very-long-plugin-name-indeed",
      "abcdefghijklmno-x",
      "docs",
      "runbooks",
    ]) {
      const mcpName = referenceMcpName(name);
      expect(mcpName.length, name).toBeLessThanOrEqual(16);
      expect(schema.safeParse({ ...manifest, mcpName }).success, name).toBe(true);
    }
  });
});

describe("stageReferenceApp", () => {
  it("stages only what a scaffold receives", async () => {
    const from = path.join(tmpDir, "ref");
    const files: Record<string, string> = {
      "plugin.json": "{}",
      "dist/index.js": "export {}",
      "src/index.ts": "export {}",
      "node_modules/x/index.js": "",
      "test-results/shot.png": "",
      ".tour-preview/index.html": "",
      "notes.txt": "",
    };
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(from, rel)), { recursive: true });
      await fs.writeFile(path.join(from, rel), content);
    }
    const to = path.join(tmpDir, "staged");
    await stageReferenceApp(from, to);
    expect(await listReferenceAppFiles(to)).toEqual([
      "dist/index.js",
      "plugin.json",
      "src/index.ts",
    ]);
  });
});
