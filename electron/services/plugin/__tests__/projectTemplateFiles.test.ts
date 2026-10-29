import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock(import("../../../utils/logger.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  logError: mocks.logError,
}));

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
    [".github/hooks/pre-tool.json", "agent configuration"],
    [".github/copilot/settings.json", "agent configuration"],
    [".aider.model.settings.yml", "agent configuration"],
    [".windsurf/hooks.json", "agent configuration"],
    [".amazonq/mcp.json", "agent configuration"],
    [".continue/mcpServers/db.yaml", "agent configuration"],
    [".roo/mcp.json", "agent configuration"],
    [".cline/hooks/pre.sh", "agent configuration"],
    ["GIT~2", "repository metadata"],
    // Spellings a case-insensitive disk resolves to a refused name: `ſ` folds
    // to `s` on APFS, and a full-width letter is its ASCII form after NFKC.
    [".claude/\u017Fettings.json", "agent configuration"],
    [".cur\u017For/mcp.json", "agent configuration"],
    [".\uFF47it/HEAD", "repository metadata"],
  ])("refuses the whole template when it includes %s", async (relPath, what) => {
    await put("README.md");
    await put(relPath);
    const message = await refusal();
    expect(message).toContain(what);
  });

  it("allows the instruction folders inside agent folders, and marks them", async () => {
    await put(".cursor/rules/style.mdc", "Use tabs.\n");
    await put(".kiro/steering/architecture.md", "# Architecture\n");
    await put(
      ".claude/agents/reviewer.md",
      "---\nname: reviewer\ndescription: Reviews.\n---\nBe kind.\n"
    );
    // Front matter outside an agent's folder is just a document.
    await put("docs/post.md", "---\nhooks: yes\n---\n");

    const inventory = await buildProjectTemplateInventory(templateDir);
    expect(inventory.files.map(({ path: p, kind }) => [p, kind])).toEqual([
      [".claude/agents/reviewer.md", "instructions"],
      [".cursor/rules/style.mdc", "instructions"],
      [".kiro/steering/architecture.md", "instructions"],
      ["docs/post.md", "file"],
    ]);
  });

  it.each([
    [".claude/agents/reviewer.md", "---\nname: reviewer\nhooks:\n  PreToolUse: []\n---\n", "hooks"],
    [".claude/agents/db.md", "\uFEFF---\r\nmcpServers:\r\n  db: {}\r\n---\r\n", "mcpServers"],
    [
      ".claude/commands/ship.md",
      "---\nallowed-tools: Bash(git push:*)\n---\nShip it.\n",
      "allowed-tools",
    ],
    [".cursor/rules/run.mdc", '---\n"Permissions": all\n---\n', "Permissions"],
  ])(
    "refuses an agent file whose front matter configures the agent: %s",
    async (relPath, content, key) => {
      await put(relPath, content);
      const message = await refusal();
      expect(message).toContain(key);
      expect(message).toContain("agent configuration");
    }
  );

  it.each([
    [".claude/agents/indented.md", "---\n  name: x\n  hooks: {}\n---\n", "hooks"],
    [".claude/agents/flow.md", "---\n{name: x, mcpServers: {db: {}}}\n---\n", "mcpServers"],
    [".claude/agents/escaped.md", '---\n"ho\\u006fks": {}\n---\n', "hooks"],
    [".claude/agents/merged.md", "---\nbase: &b {hooks: {}}\n<<: *b\n---\n", "hooks"],
    [
      ".claude/agents/long.md",
      `---\ndescription: ${"x".repeat(70 * 1024)}\nallowed-tools: Bash\n---\n`,
      "allowed-tools",
    ],
  ])("reads front matter as YAML, so %s can't hide a key", async (relPath, content, key) => {
    await put(relPath, content);
    expect(await refusal()).toContain(key);
  });

  it("refuses an agent file whose front matter isn't readable YAML", async () => {
    await put(".claude/agents/broken.md", "---\nname: [unclosed\n---\n");
    expect(await refusal()).toContain("isn't readable YAML");
  });

  it("refuses two names that fold together only after a second round", async (ctx) => {
    await put("stra\u00DFe.txt", "a");
    await put("STRA\u1E9EE.txt", "b");
    if ((await fs.readdir(templateDir)).length < 2) ctx.skip();
    expect(await refusal()).toContain("would be the same file");
  });

  it("only reads the leading front-matter block", async () => {
    await put(".claude/agents/notes.md", "---\nname: notes\n---\nhooks: this is prose\n");
    const inventory = await buildProjectTemplateInventory(templateDir);
    expect(inventory.files.map((file) => file.path)).toEqual([".claude/agents/notes.md"]);
  });

  it.each([
    ["a zero-width character", ".g\u200Cit"],
    ["a bidi override", "photo\u202Egnp.js"],
  ])("refuses a name with %s, which can read as another name", async (_label, name) => {
    await put(name);
    expect(await refusal()).toContain("invisible or control character");
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

  it("says the files couldn't be read without the errno or path, and logs both", async () => {
    await put("README.md");
    registerPluginProjectTemplates("acme.sites", "Acme Sites", pluginDir, [
      { id: "site", title: "Site", description: "A site." },
    ]);
    const failure = Object.assign(
      new Error(`EACCES: permission denied, scandir '${templateDir}'`),
      { code: "EACCES" }
    );
    const readdir = vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);

    try {
      expect(await previewProjectTemplate("acme.sites", "site")).toEqual({
        status: "unusable",
        reason: "Couldn't read this template's files.",
        retryable: true,
      });
      expect(mocks.logError).toHaveBeenCalledWith("Couldn't read this template's files.", failure, {
        pluginId: "acme.sites",
        templateId: "site",
      });
    } finally {
      readdir.mockRestore();
    }
  });

  it("reads a folder it can't inspect as a read failure, not a missing folder", async () => {
    await put("README.md");
    registerPluginProjectTemplates("acme.sites", "Acme Sites", pluginDir, [
      { id: "site", title: "Site", description: "A site." },
    ]);
    const failure = Object.assign(new Error(`EACCES: permission denied, lstat '${templateDir}'`), {
      code: "EACCES",
    });
    const lstat = vi.spyOn(fs, "lstat").mockRejectedValueOnce(failure);

    try {
      expect(await previewProjectTemplate("acme.sites", "site")).toEqual({
        status: "unusable",
        reason: "Couldn't read this template's files.",
        retryable: true,
      });
    } finally {
      lstat.mockRestore();
    }
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

  it("removes the files and folders it wrote when a write fails part way", async () => {
    // The third entry repeats the second, so its exclusive create fails after
    // two files and their folder have landed.
    const file = (filePath: string) => ({
      path: filePath,
      size: 1,
      kind: "file" as const,
      content: Buffer.from("1"),
    });
    const inventory: ProjectTemplateInventory = {
      digest: "d",
      totalBytes: 3,
      files: [file("a/x.txt"), file("a/y.txt"), file("a/y.txt")],
    };
    await expect(writeProjectTemplate(dest, inventory)).rejects.toThrow();
    expect(await listTree(dest)).toEqual([]);
  });

  it("stops, and leaves the swapped-in folder alone, when a folder it made is replaced mid-copy", async () => {
    const inventory: ProjectTemplateInventory = {
      digest: "d",
      totalBytes: 1,
      files: [{ path: "a/x.txt", size: 1, kind: "file", content: Buffer.from("1") }],
    };
    // The copy looks at `a` twice: once to record what it made, then before
    // writing into it. Between the two, `a` is moved aside and replaced.
    const swapped = path.join(dest, "a");
    const realLstat = fs.lstat.bind(fs);
    let looks = 0;
    const spy = vi.spyOn(fs, "lstat").mockImplementation((async (target: string) => {
      if (target === swapped && ++looks === 2) {
        await fs.rename(swapped, path.join(dest, "a-moved"));
        await fs.mkdir(swapped);
      }
      return realLstat(target);
    }) as typeof fs.lstat);
    try {
      await expect(writeProjectTemplate(dest, inventory)).rejects.toThrow("changed while");
    } finally {
      spy.mockRestore();
    }
    expect(await listTree(dest)).toEqual(["a-moved/", "a/"]);
  });
});
