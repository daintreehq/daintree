import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { SlashCommandService } from "../SlashCommandService.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "daintree-slash-commands-"));
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
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GEMINI_CONFIG_DIR: process.env.GEMINI_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.GEMINI_CONFIG_DIR;
  delete process.env.CODEX_HOME;
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

  it("excludes Gemini TOML commands with user-invocable = false", async () => {
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(projectRoot, ".gemini", "commands", "visible.toml"),
        `description = "Visible command"
prompt = "Do visible thing"
`
      );

      await writeFile(
        path.join(projectRoot, ".gemini", "commands", "hidden.toml"),
        `description = "Hidden command"
user-invocable = false
prompt = "Do hidden thing"
`
      );

      const commands = await service.list("gemini", projectRoot);
      const visible = commands.find((c) => c.label === "/visible");
      const hidden = commands.find((c) => c.label === "/hidden");

      expect(visible).toBeDefined();
      expect(visible?.description).toBe("Visible command");
      expect(hidden).toBeUndefined();
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("merges Codex project skills over user skills as $-prefixed capabilities", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(homeRoot, ".codex", "skills", "deploy", "SKILL.md"),
        `---
description: "User deploy skill"
---

Deploy from the user skill.
`
      );

      await writeFile(
        path.join(projectRoot, ".agents", "skills", "deploy", "SKILL.md"),
        `---
description: "Project deploy skill"
---

Deploy from the project skill.
`
      );

      const commands = await service.list("codex", path.join(projectRoot, "nested", "dir"));
      const skill = commands.find((c) => c.label === "$deploy");
      const oldPromptLabel = commands.find((c) => c.label === "/prompts:deploy");

      expect(skill).toBeDefined();
      expect(skill?.scope).toBe("project");
      expect(skill?.kind).toBe("skill");
      expect(skill?.trigger).toBe("$");
      expect(skill?.description).toBe("Project deploy skill");
      expect(oldPromptLabel).toBeUndefined();
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("labels simple Codex skills with $", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(projectRoot, ".agents", "skills", "merge-prs", "SKILL.md"),
        `---
description: "Merge all PRs"
---

Merge them all.
`
      );

      const commands = await service.list("codex", projectRoot);
      const skill = commands.find((c) => c.label === "$merge-prs");

      expect(skill).toBeTruthy();
      expect(skill?.scope).toBe("project");
      expect(skill?.kind).toBe("skill");
      expect(skill?.description).toBe("Merge all PRs");
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("ignores the retired .codex/commands and .codex/prompts directories", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

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
      await writeFile(
        path.join(projectRoot, ".codex", "prompts", "old-prompt.md"),
        `---
description: "An old prompt"
---

Old prompt body.
`
      );

      const commands = await service.list("codex", projectRoot);

      expect(commands.find((c) => c.label === "/my-command")).toBeUndefined();
      expect(commands.find((c) => c.label === "/prompts:old-prompt")).toBeUndefined();
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("discovers Codex built-in system skills under ~/.codex/skills/.system", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(homeRoot, ".codex", "skills", ".system", "imagegen", "SKILL.md"),
        `---
description: "Generate images"
---

Generate images.
`
      );

      const commands = await service.list("codex", projectRoot);
      const skill = commands.find((c) => c.label === "$imagegen");

      expect(skill).toBeDefined();
      expect(skill?.scope).toBe("built-in");
      expect(skill?.kind).toBe("skill");
      expect(skill?.description).toBe("Generate images");
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("honours CODEX_HOME for user skill discovery", async () => {
    const homeRoot = await makeTempDir();
    const codexHome = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);
    process.env.CODEX_HOME = codexHome;

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(codexHome, "skills", "research", "SKILL.md"),
        `---
description: "Relocated user skill"
---

Research things.
`
      );

      const commands = await service.list("codex", projectRoot);
      const skill = commands.find((c) => c.label === "$research");

      expect(skill).toBeDefined();
      expect(skill?.scope).toBe("user");
      expect(skill?.kind).toBe("skill");
      expect(skill?.description).toBe("Relocated user skill");
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(codexHome, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("excludes commands with user-invocable: false", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "commands", "internal.md"),
        `---
description: "Internal pipeline command"
user-invocable: false
---

Not for users.
`
      );

      const commands = await service.list("claude", root);
      const internal = commands.find((c) => c.label === "/internal");

      expect(internal).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes commands with user-invocable: no", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "commands", "hidden.md"),
        `---
description: "Hidden command"
user-invocable: no
---

Hidden.
`
      );

      const commands = await service.list("claude", root);
      const hidden = commands.find((c) => c.label === "/hidden");

      expect(hidden).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("includes commands with user-invocable: true or absent header", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "commands", "explicit-true.md"),
        `---
description: "Explicitly invocable"
user-invocable: true
---

Visible.
`
      );

      await writeFile(
        path.join(root, ".claude", "commands", "no-header.md"),
        `---
description: "No invocable header"
---

Also visible.
`
      );

      const commands = await service.list("claude", root);
      const explicitTrue = commands.find((c) => c.label === "/explicit-true");
      const noHeader = commands.find((c) => c.label === "/no-header");

      expect(explicitTrue).toBeDefined();
      expect(explicitTrue?.description).toBe("Explicitly invocable");
      expect(noHeader).toBeDefined();
      expect(noHeader?.description).toBe("No invocable header");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("handles case-insensitive user-invocable values in commands", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();

    try {
      await fs.mkdir(path.join(root, ".git"));

      await writeFile(
        path.join(root, ".claude", "commands", "upper-false.md"),
        `---
description: "Upper false"
user-invocable: FALSE
---

Hidden.
`
      );

      await writeFile(
        path.join(root, ".claude", "commands", "mixed-no.md"),
        `---
description: "Mixed no"
user-invocable: No
---

Hidden.
`
      );

      const commands = await service.list("claude", root);

      expect(commands.find((c) => c.label === "/upper-false")).toBeUndefined();
      expect(commands.find((c) => c.label === "/mixed-no")).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes Codex skills with user-invocable: false", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(projectRoot, ".agents", "skills", "internal", "SKILL.md"),
        `---
description: "Internal Codex skill"
user-invocable: false
---

Not for users.
`
      );

      const commands = await service.list("codex", projectRoot);
      const internal = commands.find((c) => c.label === "$internal");

      expect(internal).toBeUndefined();
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
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

  it("warns when frontmatter closing --- falls outside the 8 KiB read buffer", async () => {
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      const filler = "x".repeat(9 * 1024);
      const cmdPath = path.join(projectRoot, ".claude", "commands", "huge.md");
      await writeFile(
        cmdPath,
        `---
description: "Huge frontmatter"
filler: "${filler}"
user-invocable: false
---

Body.
`
      );

      const commands = await service.list("claude", projectRoot);
      const huge = commands.find((c) => c.label === "/huge");

      expect(huge).toBeDefined();
      expect(huge?.description).toBe("Custom command");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain("[SlashCommandService] frontmatter truncated:");
      expect(message).toContain(cmdPath);
    } finally {
      warnSpy.mockRestore();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not warn on ordinary Markdown without frontmatter", async () => {
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(projectRoot, ".claude", "commands", "plain.md"),
        `# Plain command

No frontmatter at all.
`
      );

      const commands = await service.list("claude", projectRoot);
      const plain = commands.find((c) => c.label === "/plain");

      expect(plain).toBeDefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("honours CLAUDE_CONFIG_DIR for user command and skill discovery", async () => {
    const homeRoot = await makeTempDir();
    const claudeDir = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    const prevHome = process.env.HOME;
    const prevUserprofile = process.env.USERPROFILE;
    const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;

    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    delete process.env.XDG_CONFIG_HOME;

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(claudeDir, "commands", "relocated.md"),
        `---
description: "Relocated user command"
---

Relocated.
`
      );

      await writeFile(
        path.join(claudeDir, "skills", "relocated-skill", "SKILL.md"),
        `---
description: "Relocated user skill"
---

Skill body.
`
      );

      const commands = await service.list("claude", projectRoot);
      const cmd = commands.find((c) => c.label === "/relocated");
      const skill = commands.find((c) => c.label === "/relocated-skill" && c.kind === "skill");

      expect(cmd).toBeDefined();
      expect(cmd?.scope).toBe("user");
      expect(cmd?.description).toBe("Relocated user command");
      expect(skill).toBeDefined();
      expect(skill?.scope).toBe("user");
      expect(skill?.description).toBe("Relocated user skill");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUserprofile !== undefined) process.env.USERPROFILE = prevUserprofile;
      else delete process.env.USERPROFILE;
      if (prevClaudeConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      else delete process.env.CLAUDE_CONFIG_DIR;
      if (prevXdgConfigHome !== undefined) process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(claudeDir, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("honours GEMINI_CONFIG_DIR for user command discovery", async () => {
    const homeRoot = await makeTempDir();
    const geminiDir = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();

    const prevHome = process.env.HOME;
    const prevUserprofile = process.env.USERPROFILE;
    const prevGeminiConfigDir = process.env.GEMINI_CONFIG_DIR;
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;

    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    process.env.GEMINI_CONFIG_DIR = geminiDir;
    delete process.env.XDG_CONFIG_HOME;

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      await writeFile(
        path.join(geminiDir, "commands", "relocated.toml"),
        `description = "Relocated Gemini command"
prompt = "Do the thing"
`
      );

      const commands = await service.list("gemini", projectRoot);
      const cmd = commands.find((c) => c.label === "/relocated");

      expect(cmd).toBeDefined();
      expect(cmd?.scope).toBe("user");
      expect(cmd?.description).toBe("Relocated Gemini command");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUserprofile !== undefined) process.env.USERPROFILE = prevUserprofile;
      else delete process.env.USERPROFILE;
      if (prevGeminiConfigDir !== undefined) process.env.GEMINI_CONFIG_DIR = prevGeminiConfigDir;
      else delete process.env.GEMINI_CONFIG_DIR;
      if (prevXdgConfigHome !== undefined) process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(geminiDir, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps a /review command and a $review skill distinct (dedupe includes trigger)", async () => {
    const homeRoot = await makeTempDir();
    const projectRoot = await makeTempDir();
    const service = new SlashCommandService();
    const prev = overrideHome(homeRoot);

    try {
      await fs.mkdir(path.join(projectRoot, ".git"));

      // /review is a Codex built-in command; a project skill named "review"
      // must coexist as $review rather than dedupe against it.
      await writeFile(
        path.join(projectRoot, ".agents", "skills", "review", "SKILL.md"),
        `---
description: "Review skill"
---

Review via skill.
`
      );

      const commands = await service.list("codex", projectRoot);
      const command = commands.find((c) => c.label === "/review");
      const skill = commands.find((c) => c.label === "$review");

      expect(command).toBeDefined();
      expect(command?.trigger).toBe("/");
      expect(command?.kind).toBe("command");

      expect(skill).toBeDefined();
      expect(skill?.trigger).toBe("$");
      expect(skill?.kind).toBe("skill");
      expect(skill?.description).toBe("Review skill");
      // Exact id proves the skill idNamespace survives (scope:skill:name).
      expect(skill?.id).toBe("project:skill:review");

      expect(command?.id).not.toBe(skill?.id);
    } finally {
      restoreHome(prev);
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
