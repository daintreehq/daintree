import type { FileHandle } from "fs/promises";
import { promises as fs } from "fs";
import * as path from "path";
import type { CompletionParserName } from "../../../shared/types/completionSources.js";

const FRONTMATTER_MAX_BYTES = 8 * 1024;
const TOML_MAX_BYTES = 16 * 1024;

/**
 * Raw output of a directory parser — deliberately free of `agentId`, trigger,
 * scope, label, or final id. The engine derives all of that per consumer, which
 * is what lets one physical `.agents/skills` scan become Claude's `/name` and
 * Codex's `$name` without semantic leakage.
 */
export interface RawCompletionEntry {
  /** Name segments (nested dirs); joined by the source's nesting joiner. */
  nameParts: string[];
  /** Path of the source file relative to the scanned root. */
  relativeSourcePath: string;
  description: string | null;
  userInvocable: boolean;
}

export type CompletionParser = (rootDir: string) => Promise<RawCompletionEntry[]>;

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

async function readYamlFrontmatter(
  filePath: string
): Promise<{ description: string | null; userInvocable: boolean }> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(FRONTMATTER_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");

    const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
    if (!normalized.startsWith("---")) return { description: null, userInvocable: true };

    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) {
      console.warn(
        `[SlashCommandService] frontmatter truncated: closing --- not found within ${FRONTMATTER_MAX_BYTES} bytes in ${filePath}`
      );
      return { description: null, userInvocable: true };
    }

    const frontmatter = normalized.slice(3, endIndex);

    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    const description = descMatch ? stripWrappingQuotes(descMatch[1] ?? "") : null;

    const invocableMatch = frontmatter.match(/^user-invocable:\s*(.+)$/m);
    let userInvocable = true;
    if (invocableMatch) {
      const val = stripWrappingQuotes(invocableMatch[1] ?? "").toLowerCase();
      if (val === "false" || val === "no") userInvocable = false;
    }

    return { description, userInvocable };
  } catch {
    return { description: null, userInvocable: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readTomlDescription(
  filePath: string
): Promise<{ description: string | null; userInvocable: boolean }> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(TOML_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TOML_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");

    const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;

    let description: string | null = null;
    const multilineDouble = normalized.match(/^description\s*=\s*"""\s*([\s\S]*?)\s*"""/m);
    if (multilineDouble?.[1]) {
      description = multilineDouble[1].trim();
    } else {
      const multilineSingle = normalized.match(/^description\s*=\s*'''\s*([\s\S]*?)\s*'''/m);
      if (multilineSingle?.[1]) {
        description = multilineSingle[1].trim();
      } else {
        const singleLine = normalized.match(/^description\s*=\s*(["'])(.*?)\1/m);
        if (singleLine?.[2]) description = singleLine[2].trim();
      }
    }

    const invocableMatch = normalized.match(/^user-invocable\s*=\s*(.+)$/m);
    let userInvocable = true;
    if (invocableMatch) {
      const raw = invocableMatch[1]!.trim().toLowerCase();
      if (raw === "false" || raw === "no") userInvocable = false;
    }

    return { description, userInvocable };
  } catch {
    return { description: null, userInvocable: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Recursively collect files with `extension`, skipping hidden entries. */
async function scanRecursiveFiles(
  rootDir: string,
  extension: string,
  read: (filePath: string) => Promise<{ description: string | null; userInvocable: boolean }>
): Promise<RawCompletionEntry[]> {
  const results: RawCompletionEntry[] = [];

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
        if (path.extname(entry.name).toLowerCase() !== extension) return;

        const relPath = path.relative(rootDir, fullPath);
        const relNoExt = relPath.slice(0, relPath.length - path.extname(relPath).length);
        const nameParts = relNoExt.split(path.sep);
        const { description, userInvocable } = await read(fullPath);

        results.push({ nameParts, relativeSourcePath: relPath, description, userInvocable });
      })
    );
  };

  await walk(rootDir);
  return sortByPath(results);
}

/** Immediate child directories that contain a `SKILL.md`, skipping hidden. */
async function scanSkillDirectories(rootDir: string): Promise<RawCompletionEntry[]> {
  let entries: Array<import("fs").Dirent> = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: RawCompletionEntry[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      if (!entry.isDirectory()) return;

      const skillFile = path.join(rootDir, entry.name, "SKILL.md");
      try {
        const stat = await fs.stat(skillFile);
        if (!stat.isFile()) return;
      } catch {
        return;
      }

      const { description, userInvocable } = await readYamlFrontmatter(skillFile);
      results.push({
        nameParts: [entry.name],
        relativeSourcePath: path.join(entry.name, "SKILL.md"),
        description,
        userInvocable,
      });
    })
  );

  return sortByPath(results);
}

/** Deterministic order — filesystem enumeration order is not portable. */
function sortByPath(entries: RawCompletionEntry[]): RawCompletionEntry[] {
  return entries.sort((a, b) => a.relativeSourcePath.localeCompare(b.relativeSourcePath));
}

/** The closed allow-list of named parsers, resolved from config strings. */
export const COMPLETION_PARSERS: Record<CompletionParserName, CompletionParser> = {
  "markdown-frontmatter": (rootDir) => scanRecursiveFiles(rootDir, ".md", readYamlFrontmatter),
  toml: (rootDir) => scanRecursiveFiles(rootDir, ".toml", readTomlDescription),
  "skill-dir": (rootDir) => scanSkillDirectories(rootDir),
};

export function getCompletionParser(name: CompletionParserName): CompletionParser | undefined {
  return COMPLETION_PARSERS[name];
}
