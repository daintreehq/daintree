import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROJECT_TEMPLATE_LIMITS,
  ProjectTemplateError,
  buildProjectTemplateInventory,
  loadProjectTemplateInventory,
  previewProjectTemplate,
  resolveProjectTemplateDir,
  writeProjectTemplate,
  type ProjectTemplateInventory,
} from "../projectTemplateFiles.js";
import {
  clearPluginProjectTemplateRegistry,
  registerPluginProjectTemplates,
} from "../PluginProjectTemplateRegistry.js";

const isWindows = process.platform === "win32";

let tmp: string;
let pluginDir: string;
let templateDir: string;

async function put(relPath: string, content: string | Buffer = "x"): Promise<void> {
  const abs = path.join(templateDir, ...relPath.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function refusal(): Promise<string> {
  const err = await buildProjectTemplateInventory(templateDir).then(
    () => null,
    (error: unknown) => error
  );
  expect(err).toBeInstanceOf(ProjectTemplateError);
  return (err as Error).message;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-template-"));
  pluginDir = path.join(tmp, "plugin");
  templateDir = path.join(pluginDir, "project-templates", "site");
  await fs.mkdir(templateDir, { recursive: true });
  clearPluginProjectTemplateRegistry();
});

afterEach(async () => {
  clearPluginProjectTemplateRegistry();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("buildProjectTemplateInventory", () => {
  it("lists every file sorted, keeping sources and dotfiles, and marks the ones that matter", async () => {
    await put("src/index.ts", "export {};\n");
    await put(".gitignore", "node_modules\n");
    await put("AGENTS.md", "# Agents\n");
    await put(".claude/commands/build.md", "Build it.\n");
    await put(".daintree/plugins/site-tools/plugin.json", "{}");
    await put(".daintree/recipes/dev.json", "{}");
    await put(".vscode/settings.json", "{}");

    const inventory = await buildProjectTemplateInventory(templateDir);

    expect(inventory.files.map(({ path: p, kind }) => [p, kind])).toEqual([
      [".claude/commands/build.md", "instructions"],
      [".daintree/plugins/site-tools/plugin.json", "project-plugin"],
      [".daintree/recipes/dev.json", "file"],
      [".gitignore", "file"],
      [".vscode/settings.json", "file"],
      ["AGENTS.md", "instructions"],
      ["src/index.ts", "file"],
    ]);
    expect(inventory.totalBytes).toBe(
      inventory.files.reduce((sum, file) => sum + file.content.length, 0)
    );
    const ts = inventory.files.find((file) => file.path === "src/index.ts");
    expect(ts?.content.toString()).toBe("export {};\n");
    expect(ts?.size).toBe(ts?.content.length);
  });

  it("gives the same files the same digest, and a changed byte a new one", async () => {
    await put("README.md", "hello");
    const first = await buildProjectTemplateInventory(templateDir);
    const again = await buildProjectTemplateInventory(templateDir);
    expect(again.digest).toBe(first.digest);

    await put("README.md", "hellp");
    const changed = await buildProjectTemplateInventory(templateDir);
    expect(changed.digest).not.toBe(first.digest);
  });

  it.each([
    [".git/HEAD", "repository metadata"],
    ["vendor/.git", "repository metadata"],
    [".gitmodules", "repository metadata"],
    ["node_modules/left-pad/index.js", "installed dependencies"],
    [".mcp.json", "agent configuration"],
    ["packages/app/.mcp.json", "agent configuration"],
    [".claude/settings.json", "agent configuration"],
    [".claude/settings.local.json", "agent configuration"],
    [".claude/hooks/pre-tool.sh", "agent configuration"],
    [".codex/config.toml", "agent configuration"],
    [".gemini/settings.json", "agent configuration"],
    [".cursor/mcp.json", "agent configuration"],
    [".vscode/mcp.json", "agent configuration"],
    ["opencode.json", "agent configuration"],
  ])("refuses the whole template when it includes %s", async (relPath, what) => {
    await put("README.md");
    await put(relPath);
    const message = await refusal();
    expect(message).toContain(what);
  });

  it("is case-insensitive about what it refuses", async () => {
    await put("Node_Modules/x/index.js");
    expect(await refusal()).toContain("installed dependencies");
  });

  it.skipIf(isWindows).each([
    ["con.txt", "reserved name"],
    ["notes.", "ends with a dot"],
    ["a:b.txt", "can't store"],
  ])("refuses a name Windows can't write: %s", async (name, problem) => {
    await put(name);
    expect(await refusal()).toContain(problem);
  });

  it("refuses two names that are one file on a case-insensitive disk", async (ctx) => {
    await put("Readme.md", "a");
    await put("README.md", "b");
    if ((await fs.readdir(templateDir)).length < 2) ctx.skip();
    expect(await refusal()).toContain("would be the same file");
  });

  it.skipIf(isWindows)("refuses a symlinked file or folder", async () => {
    await put("README.md");
    await fs.symlink(path.join(tmp, "outside"), path.join(templateDir, "link"));
    expect(await refusal()).toContain("symbolic link");
  });

  it.skipIf(isWindows)("refuses a FIFO", async () => {
    execFileSync("mkfifo", [path.join(templateDir, "pipe")]);
    expect(await refusal()).toContain("isn't a regular file");
  });

  it("refuses a file over the per-file cap", async () => {
    await put("big.bin", Buffer.alloc(PROJECT_TEMPLATE_LIMITS.fileBytes + 1));
    expect(await refusal()).toContain("big.bin");
  });

  it("refuses more files than the cap", async () => {
    await Promise.all(
      Array.from({ length: PROJECT_TEMPLATE_LIMITS.files + 1 }, (_, i) => put(`f${i}.txt`))
    );
    expect(await refusal()).toContain(`more than ${PROJECT_TEMPLATE_LIMITS.files}`);
  });

  it("refuses files that add up past the total cap", async () => {
    const each = PROJECT_TEMPLATE_LIMITS.fileBytes - 1;
    const count = Math.floor(PROJECT_TEMPLATE_LIMITS.totalBytes / each) + 1;
    for (let i = 0; i < count; i++) await put(`part-${i}.bin`, Buffer.alloc(each));
    expect(await refusal()).toContain("add up to more than");
  });

  it("refuses folders nested past the depth cap", async () => {
    const deep = Array.from({ length: PROJECT_TEMPLATE_LIMITS.depth + 1 }, (_, i) => `d${i}`);
    await put([...deep, "file.txt"].join("/"));
    expect(await refusal()).toContain("folders deep");
  });

  it("refuses a template with no files", async () => {
    await fs.mkdir(path.join(templateDir, "empty"));
    expect(await refusal()).toContain("no files");
  });
});

describe("resolveProjectTemplateDir", () => {
  it("returns the template's folder inside the plugin", async () => {
    expect(await resolveProjectTemplateDir(pluginDir, "site")).toBe(
      path.join(await fs.realpath(pluginDir), "project-templates", "site")
    );
  });

  it("refuses a template whose folder is missing", async () => {
    await expect(resolveProjectTemplateDir(pluginDir, "blog")).rejects.toBeInstanceOf(
      ProjectTemplateError
    );
  });

  it.skipIf(isWindows)("refuses a template folder that is a symlink", async () => {
    const elsewhere = path.join(tmp, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "secret.txt"), "x");
    await fs.symlink(elsewhere, path.join(pluginDir, "project-templates", "linked"));
    await expect(resolveProjectTemplateDir(pluginDir, "linked")).rejects.toThrow("isn't a folder");
  });
});

describe("previewProjectTemplate", () => {
  it("previews a registered template's files without their bytes", async () => {
    await put("README.md", "hello");
    registerPluginProjectTemplates("acme.sites", "Acme Sites", pluginDir, [
      { id: "site", title: "Site", description: "A site." },
    ]);

    const preview = await previewProjectTemplate("acme.sites", "site");
    expect(preview).toEqual({
      status: "ready",
      digest: (await loadProjectTemplateInventory("acme.sites", "site")).digest,
      totalBytes: 5,
      files: [{ path: "README.md", size: 5, kind: "file" }],
    });
  });

  it("reports a template no plugin offers any more, as data", async () => {
    await put("README.md");
    expect(await previewProjectTemplate("acme.sites", "site")).toEqual({
      status: "unusable",
      reason: "This template is no longer available.",
    });
  });

  it("reports why a template can't be copied, as data", async () => {
    await put(".mcp.json");
    registerPluginProjectTemplates("acme.sites", "Acme Sites", pluginDir, [
      { id: "site", title: "Site", description: "A site." },
    ]);
    const preview = await previewProjectTemplate("acme.sites", "site");
    expect(preview.status).toBe("unusable");
    expect(preview.status === "unusable" && preview.reason).toContain("agent configuration");
  });
});

describe("writeProjectTemplate", () => {
  let dest: string;

  beforeEach(async () => {
    dest = path.join(tmp, "new-project");
    await fs.mkdir(dest);
  });

  async function listTree(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push(`${child}/`);
          await walk(path.join(dir, entry.name), child);
        } else {
          out.push(child);
        }
      }
    };
    await walk(root, "");
    return out.sort();
  }

  it("writes exactly the inventory's files and folders", async () => {
    await put("src/index.ts", "export {};\n");
    await put(".gitignore", "dist\n");
    await fs.mkdir(path.join(templateDir, "empty"));
    const inventory = await buildProjectTemplateInventory(templateDir);

    await writeProjectTemplate(dest, inventory);

    expect(await listTree(dest)).toEqual([".gitignore", "src/", "src/index.ts"]);
    expect(await fs.readFile(path.join(dest, "src", "index.ts"), "utf8")).toBe("export {};\n");
  });

  it.skipIf(isWindows)("never copies an executable bit", async () => {
    await put("run.sh", "#!/bin/sh\n");
    await fs.chmod(path.join(templateDir, "run.sh"), 0o755);
    await writeProjectTemplate(dest, await buildProjectTemplateInventory(templateDir));
    const mode = (await fs.stat(path.join(dest, "run.sh"))).mode & 0o777;
    expect(mode & 0o111).toBe(0);
  });

  it("refuses a folder that isn't empty, and leaves what is there alone", async () => {
    await put("README.md", "template");
    await fs.writeFile(path.join(dest, "mine.txt"), "mine");
    await expect(
      writeProjectTemplate(dest, await buildProjectTemplateInventory(templateDir))
    ).rejects.toThrow("isn't empty");
    expect(await listTree(dest)).toEqual(["mine.txt"]);
  });

  it("removes everything it wrote when a write fails part way", async () => {
    // A file whose path is also a folder for another file: the folder is
    // created first, so writing the file fails after other work has landed.
    const inventory: ProjectTemplateInventory = {
      digest: "d",
      totalBytes: 2,
      files: [
        { path: "a/b.txt", size: 1, kind: "file", content: Buffer.from("1") },
        { path: "a/b.txt/c.txt", size: 1, kind: "file", content: Buffer.from("2") },
      ],
    };
    await expect(writeProjectTemplate(dest, inventory)).rejects.toThrow();
    expect(await listTree(dest)).toEqual([]);
  });
});
