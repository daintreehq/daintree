import type { FileHandle } from "fs/promises";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { CLAUDE_BUILTIN_SLASH_COMMANDS, type SlashCommand } from "../../shared/types/index.js";

const FRONTMATTER_MAX_BYTES = 8 * 1024;

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

async function readFrontmatterDescription(filePath: string): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(FRONTMATTER_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");

    const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
    if (!normalized.startsWith("---")) return null;

    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) return null;

    const frontmatter = normalized.slice(3, endIndex);
    const match = frontmatter.match(/^description:\s*(.+)$/m);
    if (!match) return null;
    return stripWrappingQuotes(match[1] ?? "");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function scanCommandDirectory(
  dirPath: string,
  scope: SlashCommand["scope"],
  agentId: SlashCommand["agentId"]
): Promise<SlashCommand[]> {
  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) return [];
  } catch {
    return [];
  }

  const results: SlashCommand[] = [];

  const walk = async (currentDir: string): Promise<void> => {
    let entries: Array<import("fs").Dirent> = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith(".")) return;

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          return;
        }

        if (!entry.isFile()) return;
        if (!entry.name.toLowerCase().endsWith(".md")) return;

        const relPath = path.relative(dirPath, fullPath);
        const relNoExt = relPath.slice(0, -3); // remove ".md"
        const name = relNoExt.split(path.sep).join(":");
        const label = `/${name}`;
        const description = (await readFrontmatterDescription(fullPath)) ?? "Custom command";

        results.push({
          id: `${scope}:${name}`,
          label,
          description,
          scope,
          agentId,
          sourcePath: fullPath,
        });
      })
    );
  };

  await walk(dirPath);
  return results;
}

function getClaudeCommandSearchPaths(projectPath?: string): Array<{
  dirPath: string;
  scope: SlashCommand["scope"];
}> {
  const dirs: Array<{ dirPath: string; scope: SlashCommand["scope"] }> = [];

  if (projectPath) {
    dirs.push({ dirPath: path.join(projectPath, ".claude", "commands"), scope: "project" });
  }

  const home = os.homedir();
  dirs.push({ dirPath: path.join(home, ".claude", "commands"), scope: "user" });

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    dirs.push({ dirPath: path.join(xdgConfigHome, "claude", "commands"), scope: "user" });
  } else {
    dirs.push({ dirPath: path.join(home, ".config", "claude", "commands"), scope: "user" });
  }

  if (process.platform === "darwin") {
    dirs.push({
      dirPath: path.join(home, "Library", "Application Support", "Claude", "commands"),
      scope: "global",
    });
    dirs.push({
      dirPath: path.join("/", "Library", "Application Support", "Claude", "commands"),
      scope: "global",
    });
  }

  if (process.platform === "win32") {
    const programData = process.env.ProgramData ?? "C:\\ProgramData";
    dirs.push({ dirPath: path.join(programData, "Claude", "commands"), scope: "global" });
  }

  if (process.platform === "linux") {
    dirs.push({ dirPath: path.join("/", "etc", "claude", "commands"), scope: "global" });
    dirs.push({
      dirPath: path.join("/", "usr", "local", "share", "claude", "commands"),
      scope: "global",
    });
  }

  const seen = new Set<string>();
  return dirs.filter(({ dirPath }) => {
    const key = path.resolve(dirPath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class SlashCommandService {
  async list(agentId: SlashCommand["agentId"], projectPath?: string): Promise<SlashCommand[]> {
    if (agentId !== "claude") return [];

    const effectiveProjectPath = projectPath ? await resolveProjectRoot(projectPath) : undefined;
    const builtIns = CLAUDE_BUILTIN_SLASH_COMMANDS;
    const searchPaths = getClaudeCommandSearchPaths(effectiveProjectPath);
    const scanned = await Promise.all(
      searchPaths.map(({ dirPath, scope }) => scanCommandDirectory(dirPath, scope, "claude"))
    );

    const mergedByLabel = new Map<string, SlashCommand>();

    for (const cmd of builtIns) mergedByLabel.set(cmd.label, cmd);

    const priority = ["global", "user", "project"] as const;
    for (const scope of priority) {
      for (const list of scanned) {
        for (const cmd of list) {
          if (cmd.scope !== scope) continue;
          mergedByLabel.set(cmd.label, cmd);
        }
      }
    }

    return Array.from(mergedByLabel.values()).sort((a, b) => a.label.localeCompare(b.label));
  }
}

export const slashCommandService = new SlashCommandService();

async function resolveProjectRoot(startPath: string): Promise<string> {
  let current = path.resolve(startPath);

  try {
    const stats = await fs.stat(current);
    if (!stats.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  for (let i = 0; i < 50; i++) {
    try {
      const gitPath = path.join(current, ".git");
      await fs.stat(gitPath);
      return current;
    } catch {
      // keep walking up
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.resolve(startPath);
}
