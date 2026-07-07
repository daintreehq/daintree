import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  agentSupportsAssistantContent,
  ensureAssistantContentDir,
  getProjectAssistantContentDir,
  syncAssistantContent,
} from "../AssistantContentMirror.js";

let tmpDir: string;
let sessionPath: string;
let projectPath: string;
let globalDir: string;

async function writeSource(root: string, relPath: string, content = "content"): Promise<void> {
  const abs = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

async function readSession(relPath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(sessionPath, ...relPath.split("/")), "utf-8");
  } catch {
    return null;
  }
}

async function sync(agentId: string) {
  return syncAssistantContent({
    sessionPath,
    projectPath,
    agentId,
    globalContentDir: globalDir,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-content-mirror-"));
  sessionPath = path.join(tmpDir, "session");
  projectPath = path.join(tmpDir, "project");
  globalDir = path.join(tmpDir, "global-assistant");
  await fs.mkdir(sessionPath, { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("agentSupportsAssistantContent", () => {
  it("maps claude, codex, and copilot but not assistant-only or unknown agents", () => {
    expect(agentSupportsAssistantContent("claude")).toBe(true);
    expect(agentSupportsAssistantContent("codex")).toBe(true);
    expect(agentSupportsAssistantContent("copilot")).toBe(true);
    expect(agentSupportsAssistantContent("daintree-assistant")).toBe(false);
    expect(agentSupportsAssistantContent("gemini")).toBe(false);
  });
});

describe("syncAssistantContent", () => {
  it("returns null for agents without a content mapping", async () => {
    expect(await sync("daintree-assistant")).toBeNull();
    expect(await sync("gemini")).toBeNull();
  });

  it("mirrors claude commands and skills from the global source", async () => {
    await writeSource(globalDir, ".claude/commands/review.md", "do a review");
    await writeSource(globalDir, ".claude/skills/deploy/SKILL.md", "deploy skill");

    const result = await sync("claude");

    expect(result).toEqual({ copied: 2, removed: 0 });
    expect(await readSession(".claude/commands/review.md")).toBe("do a review");
    expect(await readSession(".claude/skills/deploy/SKILL.md")).toBe("deploy skill");
  });

  it("translates shared .agents/skills into .claude/skills for claude sessions", async () => {
    await writeSource(globalDir, ".agents/skills/shared-thing/SKILL.md", "shared");

    await sync("claude");

    expect(await readSession(".claude/skills/shared-thing/SKILL.md")).toBe("shared");
    expect(await readSession(".agents/skills/shared-thing/SKILL.md")).toBeNull();
  });

  it("keeps shared skills under .agents/skills verbatim for codex sessions", async () => {
    await writeSource(globalDir, ".agents/skills/shared-thing/SKILL.md", "shared");
    await writeSource(globalDir, ".claude/commands/review.md", "claude only");

    const result = await sync("codex");

    expect(result).toEqual({ copied: 1, removed: 0 });
    expect(await readSession(".agents/skills/shared-thing/SKILL.md")).toBe("shared");
    expect(await readSession(".claude/commands/review.md")).toBeNull();
  });

  it("mirrors both skills trees for copilot but not claude commands", async () => {
    await writeSource(globalDir, ".agents/skills/a/SKILL.md", "a");
    await writeSource(globalDir, ".claude/skills/b/SKILL.md", "b");
    await writeSource(globalDir, ".claude/commands/c.md", "c");

    const result = await sync("copilot");

    expect(result).toEqual({ copied: 2, removed: 0 });
    expect(await readSession(".agents/skills/a/SKILL.md")).toBe("a");
    expect(await readSession(".claude/skills/b/SKILL.md")).toBe("b");
    expect(await readSession(".claude/commands/c.md")).toBeNull();
  });

  it("lets project sources override global sources", async () => {
    await writeSource(globalDir, ".claude/commands/review.md", "global");
    const projectContent = getProjectAssistantContentDir(projectPath);
    await writeSource(projectContent, ".claude/commands/review.md", "project");

    await sync("claude");

    expect(await readSession(".claude/commands/review.md")).toBe("project");
  });

  it("lets an explicit .claude skill override the translated shared skill of the same name", async () => {
    await writeSource(globalDir, ".agents/skills/dupe/SKILL.md", "shared version");
    await writeSource(globalDir, ".claude/skills/dupe/SKILL.md", "claude version");

    await sync("claude");

    expect(await readSession(".claude/skills/dupe/SKILL.md")).toBe("claude version");
  });

  it("replaces a shadowed skill wholesale instead of merging files from both", async () => {
    await writeSource(globalDir, ".agents/skills/dupe/SKILL.md", "shared version");
    await writeSource(globalDir, ".agents/skills/dupe/scripts/helper.py", "shared helper");
    await writeSource(globalDir, ".claude/skills/dupe/SKILL.md", "claude version");

    await sync("claude");

    expect(await readSession(".claude/skills/dupe/SKILL.md")).toBe("claude version");
    expect(await readSession(".claude/skills/dupe/scripts/helper.py")).toBeNull();
  });

  it("keeps commands per-file so project and global command sets merge", async () => {
    await writeSource(globalDir, ".claude/commands/global-only.md", "global");
    const projectContent = getProjectAssistantContentDir(projectPath);
    await writeSource(projectContent, ".claude/commands/project-only.md", "project");

    await sync("claude");

    expect(await readSession(".claude/commands/global-only.md")).toBe("global");
    expect(await readSession(".claude/commands/project-only.md")).toBe("project");
  });

  it("removes previously mirrored files that vanished from the source", async () => {
    await writeSource(globalDir, ".claude/commands/old.md", "old");
    await sync("claude");
    expect(await readSession(".claude/commands/old.md")).toBe("old");

    await fs.rm(path.join(globalDir, ".claude", "commands", "old.md"));
    const result = await sync("claude");

    expect(result).toEqual({ copied: 0, removed: 1 });
    expect(await readSession(".claude/commands/old.md")).toBeNull();
  });

  it("cleans up empty skill directories after removal", async () => {
    await writeSource(globalDir, ".claude/skills/gone/SKILL.md", "x");
    await sync("claude");

    await fs.rm(path.join(globalDir, ".claude", "skills", "gone"), { recursive: true });
    await sync("claude");

    await expect(fs.stat(path.join(sessionPath, ".claude", "skills", "gone"))).rejects.toThrow();
  });

  it("cleans up files mirrored for a different agent on agent switch", async () => {
    await writeSource(globalDir, ".claude/commands/review.md", "claude");
    await sync("claude");
    expect(await readSession(".claude/commands/review.md")).toBe("claude");

    const result = await sync("codex");

    expect(result?.removed).toBe(1);
    expect(await readSession(".claude/commands/review.md")).toBeNull();
  });

  it("removes the stale session copy when a source file grows past the size cap", async () => {
    const bigPath = path.join(globalDir, ".claude", "commands", "grew.md");
    await writeSource(globalDir, ".claude/commands/grew.md", "small");
    await sync("claude");
    expect(await readSession(".claude/commands/grew.md")).toBe("small");

    await fs.writeFile(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const result = await sync("claude");

    expect(result?.removed).toBe(1);
    expect(await readSession(".claude/commands/grew.md")).toBeNull();
  });

  it("retries a failed stale-file removal on the next sync", async () => {
    await writeSource(globalDir, ".claude/commands/flaky.md", "x");
    await sync("claude");
    await fs.rm(path.join(globalDir, ".claude", "commands", "flaky.md"));

    const staleAbs = path.join(sessionPath, ".claude", "commands", "flaky.md");
    const realRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, opts) => {
      if (target === staleAbs) throw new Error("EBUSY: simulated");
      return realRm(target as string, opts);
    });

    const failed = await sync("claude");
    expect(failed?.removed).toBe(0);
    expect(await readSession(".claude/commands/flaky.md")).toBe("x");

    rmSpy.mockRestore();
    const retried = await sync("claude");
    expect(retried?.removed).toBe(1);
    expect(await readSession(".claude/commands/flaky.md")).toBeNull();
  });

  it("rejects manifest entries that smuggle traversal through backslash segments", async () => {
    const mcpJson = path.join(sessionPath, ".mcp.json");
    await fs.writeFile(mcpJson, "{}", "utf-8");
    await fs.writeFile(
      path.join(sessionPath, ".daintree-user-content.json"),
      JSON.stringify({
        version: 1,
        files: [".claude/commands/x\\..\\..\\.mcp.json", ".claude/commands/c:evil.md"],
      }),
      "utf-8"
    );

    const result = await sync("claude");

    expect(result?.removed).toBe(0);
    expect(await readSession(".mcp.json")).toBe("{}");
  });

  it("refuses to delete or copy through a symlinked directory inside the session", async () => {
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "SKILL.md"), "precious", "utf-8");
    await fs.mkdir(path.join(sessionPath, ".claude"), { recursive: true });
    await fs.symlink(outside, path.join(sessionPath, ".claude", "skills"), "dir");
    await fs.writeFile(
      path.join(sessionPath, ".daintree-user-content.json"),
      JSON.stringify({ version: 1, files: [".claude/skills/SKILL.md"] }),
      "utf-8"
    );
    await writeSource(globalDir, ".claude/skills/mine/SKILL.md", "user skill");

    const result = await sync("claude");

    expect(result?.removed).toBe(0);
    expect(result?.copied).toBe(0);
    expect(await fs.readFile(path.join(outside, "SKILL.md"), "utf-8")).toBe("precious");
    await expect(fs.stat(path.join(outside, "mine"))).rejects.toThrow();
  });

  it("never deletes files outside the mirror roots even with a corrupt manifest", async () => {
    const mcpJson = path.join(sessionPath, ".mcp.json");
    await fs.writeFile(mcpJson, "{}", "utf-8");
    const settingsPath = path.join(sessionPath, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, "{}", "utf-8");
    await fs.writeFile(
      path.join(sessionPath, ".daintree-user-content.json"),
      JSON.stringify({
        version: 1,
        files: [
          ".mcp.json",
          ".claude/settings.json",
          ".claude/commands/../settings.json",
          ".claude/commands/../../escape.md",
        ],
      }),
      "utf-8"
    );

    const result = await sync("claude");

    expect(result?.removed).toBe(0);
    expect(await readSession(".mcp.json")).toBe("{}");
    expect(await readSession(".claude/settings.json")).toBe("{}");
  });

  it("leaves unmanaged user files inside the session dir alone", async () => {
    const handRolled = path.join(sessionPath, ".claude", "commands", "hand-rolled.md");
    await fs.mkdir(path.dirname(handRolled), { recursive: true });
    await fs.writeFile(handRolled, "mine", "utf-8");

    const result = await sync("claude");

    expect(result?.removed).toBe(0);
    expect(await readSession(".claude/commands/hand-rolled.md")).toBe("mine");
  });

  it("follows symlinked skill directories in the source", async () => {
    const external = path.join(tmpDir, "external-skill");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, "SKILL.md"), "linked", "utf-8");
    await fs.mkdir(path.join(globalDir, ".claude", "skills"), { recursive: true });
    await fs.symlink(external, path.join(globalDir, ".claude", "skills", "linked-skill"), "dir");

    await sync("claude");

    expect(await readSession(".claude/skills/linked-skill/SKILL.md")).toBe("linked");
  });

  it("skips dot-entries in source trees", async () => {
    await writeSource(globalDir, ".claude/commands/.hidden.md", "hidden");
    await writeSource(globalDir, ".claude/commands/visible.md", "visible");

    const result = await sync("claude");

    expect(result).toEqual({ copied: 1, removed: 0 });
    expect(await readSession(".claude/commands/.hidden.md")).toBeNull();
  });

  it("syncs cleanly when no source folders exist", async () => {
    const result = await sync("claude");
    expect(result).toEqual({ copied: 0, removed: 0 });
  });

  it("refreshes changed file content on every sync", async () => {
    await writeSource(globalDir, ".claude/commands/review.md", "v1");
    await sync("claude");
    await writeSource(globalDir, ".claude/commands/review.md", "v2");

    await sync("claude");

    expect(await readSession(".claude/commands/review.md")).toBe("v2");
  });
});

describe("bundled help template invariant", () => {
  it("ships no content under the mirror destination roots", async () => {
    // The mirror's ordering safety (user files never clobber template files,
    // stale-manifest cleanup never deletes template content) relies on the
    // bundled help template not shipping .claude/commands, .claude/skills, or
    // .agents. If the template ever grows one of these, the mirror needs an
    // explicit reconciliation strategy first.
    const repoHelpDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "help"
    );
    await expect(fs.stat(path.join(repoHelpDir, "CLAUDE.md"))).resolves.toBeTruthy();
    for (const root of [".claude/commands", ".claude/skills", ".agents"]) {
      await expect(fs.stat(path.join(repoHelpDir, ...root.split("/")))).rejects.toThrow();
    }
  });
});

describe("ensureAssistantContentDir", () => {
  it("creates the standard layout and README without clobbering existing files", async () => {
    const target = path.join(tmpDir, "ensure-target");
    const created = await ensureAssistantContentDir(target);

    expect(created).toBe(target);
    for (const dir of [".claude/commands", ".claude/skills", ".agents/skills"]) {
      const stat = await fs.stat(path.join(target, ...dir.split("/")));
      expect(stat.isDirectory()).toBe(true);
    }
    const readme = await fs.readFile(path.join(target, "README.md"), "utf-8");
    expect(readme).toContain(".agents/skills/");

    await fs.writeFile(path.join(target, "README.md"), "customized", "utf-8");
    await ensureAssistantContentDir(target);
    expect(await fs.readFile(path.join(target, "README.md"), "utf-8")).toBe("customized");
  });
});
