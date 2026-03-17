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

function overrideHome(dir: string): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.XDG_CONFIG_HOME;
  return prev;
}

function restoreHome(prev: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(prev)) {
    if (val !== undefined) process.env[key] = val;
    else delete process.env[key];
  }
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

  it("discovers project skills from .claude/skills/", async () => {
    const homeRoot = await makeTempDir();
    const root = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "skills", "commit", "SKILL.md"),
        `---
description: "Create a conventional commit"
---

Commit instructions here.
`
      );

      const commands = await service.list("claude", root);
      const skill = commands.find((c) => c.label === "/commit" && c.kind === "skill");

      expect(skill).toBeDefined();
      expect(skill?.scope).toBe("project");
      expect(skill?.description).toBe("Create a conventional commit");
      expect(skill?.kind).toBe("skill");
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discovers user skills from ~/.claude/skills/", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(homeRoot, ".claude", "skills", "research", "SKILL.md"),
        `---
description: "Deep research skill"
---

Research things.
`
      );

      const commands = await service.list("claude", projectRoot);
      const skill = commands.find((c) => c.label === "/research" && c.kind === "skill");

      expect(skill).toBeDefined();
      expect(skill?.scope).toBe("user");
      expect(skill?.description).toBe("Deep research skill");
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("skill wins over same-scope command with the same label", async () => {
    const homeRoot = await makeTempDir();
    const root = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "commands", "deploy.md"),
        `---
description: "Deploy command"
---

Deploy via command.
`
      );

      await writeFile(
        path.join(root, ".claude", "skills", "deploy", "SKILL.md"),
        `---
description: "Deploy skill"
---

Deploy via skill.
`
      );

      const commands = await service.list("claude", root);
      const deploy = commands.find((c) => c.label === "/deploy");

      expect(deploy).toBeDefined();
      expect(deploy?.scope).toBe("project");
      expect(deploy?.kind).toBe("skill");
      expect(deploy?.description).toBe("Deploy skill");
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes skills with user-invocable: false", async () => {
    const homeRoot = await makeTempDir();
    const root = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "skills", "internal", "SKILL.md"),
        `---
description: "Internal only skill"
user-invocable: false
---

Not for users.
`
      );

      const commands = await service.list("claude", root);
      const internal = commands.find((c) => c.label === "/internal");

      expect(internal).toBeUndefined();
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("handles missing skills directory gracefully", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(root);

    try {
      await fs.mkdir(path.join(root, ".git"));

      const commands = await service.list("claude", root);
      expect(commands.length).toBeGreaterThan(0);
      const skills = commands.filter((c) => c.kind === "skill");
      expect(skills).toHaveLength(0);
    } finally {
      restoreHome(prev);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not recurse into nested skill subdirectories", async () => {
    const homeRoot = await makeTempDir();
    const root = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "skills", "deploy", "SKILL.md"),
        `---
description: "Deploy skill"
---

Deploy.
`
      );

      await writeFile(
        path.join(root, ".claude", "skills", "git", "work-issue", "SKILL.md"),
        `---
description: "Should not appear"
---

Nested.
`
      );

      const commands = await service.list("claude", root);
      const deploy = commands.find((c) => c.label === "/deploy" && c.kind === "skill");
      const nested = commands.find((c) => c.label === "/work-issue" && c.kind === "skill");
      const nestedAlt = commands.find((c) => c.label === "/git:work-issue" && c.kind === "skill");

      expect(deploy).toBeDefined();
      expect(nested).toBeUndefined();
      expect(nestedAlt).toBeUndefined();
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to 'Skill' description when frontmatter is missing", async () => {
    const homeRoot = await makeTempDir();
    const root = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "skills", "simple", "SKILL.md"),
        `# Simple Skill

Just some instructions without frontmatter.
`
      );

      const commands = await service.list("claude", root);
      const skill = commands.find((c) => c.label === "/simple" && c.kind === "skill");

      expect(skill).toBeDefined();
      expect(skill?.description).toBe("Skill");
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
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
