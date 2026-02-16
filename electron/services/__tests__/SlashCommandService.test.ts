import { describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { SlashCommandService } from "../SlashCommandService.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "canopy-slash-commands-"));
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("SlashCommandService", () => {
  it("includes /add-dir in Claude built-ins", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    const prevHome = process.env.HOME;
    process.env.HOME = homeRoot;

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      const commands = await service.list("claude", projectRoot);
      const addDir = commands.find((c) => c.label === "/add-dir");

      expect(addDir).toBeTruthy();
      expect(addDir?.scope).toBe("built-in");
    } finally {
      process.env.HOME = prevHome;
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("merges project commands over built-ins and parses frontmatter description", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();

    await fs.mkdir(path.join(root, ".git"));

    await writeFile(
      path.join(root, ".claude", "commands", "clear.md"),
      `---
description: "Custom clear description"
---

# clear
`
    );

    const commands = await service.list("claude", path.join(root, "nested", "dir"));
    const clear = commands.find((c) => c.label === "/clear");

    expect(clear).toBeTruthy();
    expect(clear?.scope).toBe("project");
    expect(clear?.description).toBe("Custom clear description");

    await fs.rm(root, { recursive: true, force: true });
  });

  it("supports nested commands using colon prefixes", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();

    await fs.mkdir(path.join(root, ".git"));

    await writeFile(
      path.join(root, ".claude", "commands", "git", "work-issue.md"),
      `---
description: "Create a branch for an issue"
---

Do the thing.
`
    );

    const commands = await service.list("claude", root);
    const cmd = commands.find((c) => c.label === "/git:work-issue");

    expect(cmd).toBeTruthy();
    expect(cmd?.scope).toBe("project");
    expect(cmd?.description).toBe("Create a branch for an issue");

    await fs.rm(root, { recursive: true, force: true });
  });

  it("merges Gemini project commands over user commands and supports nested namespaces", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    const prevHome = process.env.HOME;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;

    process.env.HOME = homeRoot;
    delete process.env.XDG_CONFIG_HOME;

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(homeRoot, ".gemini", "commands", "git", "commit.toml"),
        `description = "User commit description"
prompt = "Write a commit message"
`
      );

      await writeFile(
        path.join(projectRoot, ".gemini", "commands", "git", "commit.toml"),
        `description = "Project commit description"
prompt = "Write a project commit message"
`
      );

      await writeFile(
        path.join(projectRoot, ".gemini", "commands", "testing", "integration", "run.toml"),
        `description = """Run the integration test suite.
Use project conventions."""
prompt = "Run the tests"
`
      );

      const commands = await service.list("gemini", path.join(projectRoot, "nested", "dir"));

      const commit = commands.find((c) => c.label === "/git:commit");
      expect(commit).toBeDefined();
      expect(commit?.scope).toBe("project");
      expect(commit?.description).toBe("Project commit description");

      const nested = commands.find((c) => c.label === "/testing:integration:run");
      expect(nested).toBeDefined();
      expect(nested?.scope).toBe("project");
      expect(nested?.description).toBe("Run the integration test suite.\nUse project conventions.");
    } finally {
      process.env.HOME = prevHome;
      if (prevXdgConfigHome !== undefined) process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("merges Codex project prompts over user prompts and supports nested namespaces", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;

    process.env.HOME = homeRoot;
    delete process.env.CODEX_HOME;
    delete process.env.XDG_CONFIG_HOME;

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(homeRoot, ".codex", "prompts", "git", "work-issue.md"),
        `---
description: "User work issue prompt"
---

Do the user thing.
`
      );

      await writeFile(
        path.join(projectRoot, ".codex", "prompts", "git", "work-issue.md"),
        `---
description: "Project work issue prompt"
---

Do the project thing.
`
      );

      const commands = await service.list("codex", path.join(projectRoot, "nested", "dir"));
      const cmd = commands.find((c) => c.label === "/prompts:git:work-issue");
      const oldLabel = commands.find((c) => c.label === "/git:work-issue");

      expect(cmd).toBeDefined();
      expect(cmd?.scope).toBe("project");
      expect(cmd?.description).toBe("Project work issue prompt");
      expect(oldLabel).toBeUndefined();
    } finally {
      process.env.HOME = prevHome;
      if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
      if (prevXdgConfigHome !== undefined) process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("prefixes simple Codex prompts with /prompts:", async () => {
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(projectRoot, ".codex", "prompts", "merge-prs.md"),
        `---
description: "Merge all PRs"
---

Merge them all.
`
      );

      const commands = await service.list("codex", projectRoot);
      const cmd = commands.find((c) => c.label === "/prompts:merge-prs");

      expect(cmd).toBeTruthy();
      expect(cmd?.scope).toBe("project");
      expect(cmd?.description).toBe("Merge all PRs");
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not prefix Codex commands from commands directory", async () => {
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(projectRoot, ".codex", "commands", "my-command.md"),
        `---
description: "My custom command"
---

Do the command.
`
      );

      const commands = await service.list("codex", projectRoot);
      const cmd = commands.find((c) => c.label === "/my-command");

      expect(cmd).toBeTruthy();
      expect(cmd?.scope).toBe("project");
      expect(cmd?.description).toBe("My custom command");
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("handles deeply nested Codex prompts", async () => {
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(projectRoot, ".codex", "prompts", "github", "issues", "create.md"),
        `---
description: "Create a GitHub issue"
---

Create an issue.
`
      );

      const commands = await service.list("codex", projectRoot);
      const cmd = commands.find((c) => c.label === "/prompts:github:issues:create");

      expect(cmd).toBeDefined();
      expect(cmd?.scope).toBe("project");
      expect(cmd?.description).toBe("Create a GitHub issue");
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("allows same basename in commands and prompts with distinct IDs", async () => {
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(projectRoot, ".codex", "commands", "deploy.md"),
        `---
description: "Deploy command"
---

Deploy the app.
`
      );

      await writeFile(
        path.join(projectRoot, ".codex", "prompts", "deploy.md"),
        `---
description: "Deploy prompt"
---

Deploy prompt content.
`
      );

      const commands = await service.list("codex", projectRoot);
      const command = commands.find((c) => c.label === "/deploy");
      const prompt = commands.find((c) => c.label === "/prompts:deploy");

      expect(command).toBeDefined();
      expect(command?.id).toBe("project:deploy");
      expect(command?.description).toBe("Deploy command");

      expect(prompt).toBeDefined();
      expect(prompt?.id).toBe("project:prompts:deploy");
      expect(prompt?.description).toBe("Deploy prompt");

      expect(command?.id).not.toBe(prompt?.id);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
