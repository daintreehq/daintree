import { createHash } from "crypto";
import { constants as fsConstants, promises as fs } from "fs";
import path from "path";
import type {
  ProjectTemplateFile,
  ProjectTemplateFileKind,
  ProjectTemplatePreview,
} from "../../../shared/types/plugin.js";
import { load as parseYaml } from "js-yaml";
import { foldFileName } from "../../../shared/utils/fileNameFold.js";
import { logError } from "../../utils/logger.js";
import { YAML_MERGE_SCHEMA } from "../../utils/yamlMergeSchema.js";
import { PROJECT_TEMPLATES_DIR } from "../../utils/pluginArchiveConstants.js";
import { getPluginProjectTemplatePluginDir } from "./PluginProjectTemplateRegistry.js";

/**
 * Reading and copying a plugin's project template (#13825).
 *
 * The Create project dialog's file list and the copy itself come from the same
 * {@link buildProjectTemplateInventory} call, so the list is exactly what gets
 * written: anything the copy would refuse makes the whole template unusable
 * rather than quietly dropping a file. Files are read whole (the caps keep that
 * small) before the new folder exists, then written from those bytes, so what
 * lands on disk is what was hashed into the digest the user approved.
 */

export const PROJECT_TEMPLATE_LIMITS = {
  files: 1000,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  /** Folder nesting below the template root. */
  depth: 16,
  /** Files and folders walked, so a tree of empty folders is bounded too. */
  entries: 2000,
} as const;

/** A template problem worth showing the user as it is. */
export class ProjectTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectTemplateError";
  }
}

interface ProjectTemplateInventoryFile extends ProjectTemplateFile {
  content: Buffer;
}

export interface ProjectTemplateInventory {
  /** Sorted by path. Folders are implied by the files; empty ones aren't written. */
  files: ProjectTemplateInventoryFile[];
  totalBytes: number;
  digest: string;
}

const REPOSITORY = "repository metadata";
const DEPENDENCIES = "installed dependencies";
const AGENT_CONFIG = "agent configuration";

/** Names refused at any depth, as a file or a folder. */
const DENIED_NAMES: ReadonlyMap<string, string> = new Map([
  [".git", REPOSITORY],
  [".gitmodules", REPOSITORY],
  ["node_modules", DEPENDENCIES],
  [".mcp.json", AGENT_CONFIG],
  ["opencode.json", AGENT_CONFIG],
  ["opencode.jsonc", AGENT_CONFIG],
  ["crush.json", AGENT_CONFIG],
  [".crush.json", AGENT_CONFIG],
  [".aider.conf.yml", AGENT_CONFIG],
  [".aider.model.settings.yml", AGENT_CONFIG],
  [".aider.model.metadata.json", AGENT_CONFIG],
]);

/** NTFS 8.3 short names `.git` can be given (`GIT~1`, `GIT~2`, …). */
const GIT_SHORT_NAME = /^git~\d+$/;

/**
 * Folders an agent reads its settings, permissions, hooks or MCP servers from,
 * refused whole — except for the subfolders that only hold instructions.
 */
const AGENT_CONFIG_DIRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [".codex", new Set<string>()],
  [".gemini", new Set<string>()],
  [".cursor", new Set(["rules"])],
  [".opencode", new Set<string>()],
  [".crush", new Set<string>()],
  [".amp", new Set<string>()],
  [".copilot", new Set<string>()],
  [".goose", new Set<string>()],
  [".grok", new Set<string>()],
  [".kimi", new Set<string>()],
  [".kiro", new Set(["steering"])],
  [".qwen", new Set<string>()],
  [".vibe", new Set<string>()],
]);

/**
 * Configuration that sits beside instructions in a folder agents also read
 * instructions from: the entry directly inside `parent`, matched by name or,
 * ending in `*`, by prefix.
 */
const AGENT_CONFIG_ENTRIES: ReadonlyArray<{ parent: readonly string[]; entry: string }> = [
  { parent: [".claude"], entry: "settings*" },
  { parent: [".claude"], entry: "hooks" },
  { parent: [".vscode"], entry: "mcp.json" },
  { parent: [".github"], entry: "hooks" },
  { parent: [".github", "copilot"], entry: "settings*" },
  { parent: [".windsurf"], entry: "hooks.json" },
  { parent: [".devin"], entry: "hooks.json" },
  { parent: [".amazonq"], entry: "mcp.json" },
  { parent: [".amazonq"], entry: "default.json" },
  { parent: [".continue"], entry: "mcpservers" },
  { parent: [".roo"], entry: "mcp.json" },
  { parent: [".cline"], entry: "hooks" },
  { parent: [".clinerules"], entry: "hooks" },
];

function entryMatches(pattern: string, segment: string): boolean {
  return pattern.endsWith("*") ? segment.startsWith(pattern.slice(0, -1)) : segment === pattern;
}

/** Why `segments` (already folded) is never copied, or null. */
function deniedReason(segments: readonly string[]): string | null {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const named = DENIED_NAMES.get(segment) ?? (GIT_SHORT_NAME.test(segment) ? REPOSITORY : null);
    if (named) return named;
    // The folder itself may be entered; what is inside it is refused unless it
    // is one of its instruction subfolders.
    const instructionDirs = AGENT_CONFIG_DIRS.get(segment);
    const child = segments[i + 1];
    if (instructionDirs && child !== undefined && !instructionDirs.has(child)) return AGENT_CONFIG;
    for (const { parent, entry } of AGENT_CONFIG_ENTRIES) {
      const at = i + parent.length;
      if (
        at < segments.length &&
        parent.every((name, offset) => segments[i + offset] === name) &&
        entryMatches(entry, segments[at])
      ) {
        return AGENT_CONFIG;
      }
    }
  }
  return null;
}

/**
 * Front-matter keys that make an instruction file configuration: hooks, MCP
 * servers and pre-approved tools or permissions declared in a subagent, skill,
 * command or prompt file. Folded like names, so case doesn't matter.
 */
const DENIED_FRONT_MATTER_KEYS: ReadonlySet<string> = new Set([
  "hooks",
  "mcpservers",
  "mcp-servers",
  "mcp_servers",
  "allowed-tools",
  "allowed_tools",
  "allowedtools",
  "permissionmode",
  "permission-mode",
  "permissions",
]);

const FRONT_MATTER_BLOCK = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?=\r?\n|$)/;

/**
 * Why a Markdown file in an agent's folder can't be copied, or null: it
 * declares one of the refused keys at the top of its front matter, or its front
 * matter isn't YAML this can read — an agent might read it differently, so it
 * isn't assumed to be harmless. Only files inside a dot-folder are read this
 * way, since that's where agents look for subagents, skills, commands and
 * rules. Parsed with the same YAML schema as plugin skills, so indentation,
 * flow mappings, quoted keys and merge keys can't hide a key.
 */
function frontMatterProblem(segments: readonly string[], content: Buffer): string | null {
  const name = segments[segments.length - 1];
  if (!/\.(md|mdc)$/.test(name)) return null;
  if (!segments.slice(0, -1).some((segment) => segment.startsWith("."))) return null;
  const text = content.toString("utf8").replace(/^\uFEFF/, "");
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const block = FRONT_MATTER_BLOCK.exec(text);
  // An unclosed block is no front matter to an agent either: it reads as text.
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(block[1] ?? "", { schema: YAML_MERGE_SCHEMA });
  } catch {
    return "has front matter that isn't readable YAML, so it can't be checked for agent configuration";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const key = Object.keys(parsed).find((candidate) =>
    DENIED_FRONT_MATTER_KEYS.has(foldFileName(candidate))
  );
  return key === undefined
    ? null
    : `sets ${key} in its front matter. That's agent configuration, which a template never copies into a new project`;
}

const INSTRUCTION_FILES: ReadonlySet<string> = new Set([
  "agents.md",
  "claude.md",
  "claude.local.md",
  "gemini.md",
  "qwen.md",
  "copilot-instructions.md",
  ".cursorrules",
  ".goosehints",
]);

function classify(segments: readonly string[]): ProjectTemplateFileKind {
  if (segments[0] === ".daintree" && segments[1] === "plugins") return "project-plugin";
  if (
    INSTRUCTION_FILES.has(segments[segments.length - 1]) ||
    segments.includes(".claude") ||
    segments.some((segment, i) => AGENT_CONFIG_DIRS.get(segment)?.has(segments[i + 1] ?? ""))
  ) {
    return "instructions";
  }
  return "file";
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const NON_PORTABLE_CHARACTER = /[\\/:*?"<>|]/;
/**
 * Controls, and the formatting characters that are invisible or reorder the
 * text around them. A name holding one can read as a different name in the
 * dialog's list, and HFS+ ignores some of them outright, so `.g\u200Cit` is
 * `.git` on disk.
 */
const HIDDEN_CHARACTER =
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;

/**
 * Why a file or folder name can't be written on every platform Daintree runs
 * on, or shown as it is, or null. Held to the strictest of the three platforms
 * so a template behaves the same wherever it is used.
 */
function nameProblem(name: string): string | null {
  if (name === "" || name === "." || name === "..") return "isn't a usable name";
  if (HIDDEN_CHARACTER.test(name)) return "has an invisible or control character in its name";
  if (NON_PORTABLE_CHARACTER.test(name)) return "has a character Windows can't store in a name";
  if (/[. ]$/.test(name)) return "ends with a dot or a space, which Windows drops";
  if (WINDOWS_RESERVED_NAME.test(name)) return "is a reserved name on Windows";
  if (Buffer.byteLength(name) > 255) return "has a name longer than 255 bytes";
  return null;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * The template's folder inside the plugin, `project-templates/<templateId>/`.
 * Both levels must be real folders: a symlink here would let the plugin point
 * the copy anywhere on disk.
 */
export async function resolveProjectTemplateDir(
  pluginDir: string,
  templateId: string
): Promise<string> {
  let current = await fs.realpath(pluginDir);
  for (const segment of [PROJECT_TEMPLATES_DIR, templateId]) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) {
      throw new ProjectTemplateError(
        `The plugin has no ${PROJECT_TEMPLATES_DIR}/${templateId}/ folder for this template.`
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ProjectTemplateError(
        `${PROJECT_TEMPLATES_DIR}/${templateId} in the plugin isn't a folder.`
      );
    }
  }
  return current;
}

async function readTemplateFile(absPath: string, relPath: string): Promise<Buffer> {
  // O_NOFOLLOW refuses a symlink swapped in after the walk's lstat, and
  // O_NONBLOCK keeps a FIFO swapped in from wedging the open; the fd stat
  // below then rejects anything that isn't a regular file. Both are no-ops
  // where the platform lacks them.
  const handle = await fs.open(
    absPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0)
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ProjectTemplateError(`"${relPath}" isn't a regular file.`);
    }
    // The stat size is advisory — the file can grow while it is read — so the
    // cap is enforced on the bytes actually read.
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > PROJECT_TEMPLATE_LIMITS.fileBytes) {
        throw new ProjectTemplateError(
          `"${relPath}" is larger than ${formatMegabytes(PROJECT_TEMPLATE_LIMITS.fileBytes)}.`
        );
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/**
 * Every file the template would write, with its bytes, or a
 * {@link ProjectTemplateError} naming the first thing that stops it being
 * copied: a symlink or special file, a name that can't be written on every
 * platform, two names that are one file on a case-insensitive disk, repository
 * metadata, installed dependencies, agent configuration, or a cap.
 */
export async function buildProjectTemplateInventory(
  templateDir: string
): Promise<ProjectTemplateInventory> {
  const files: ProjectTemplateInventoryFile[] = [];
  const seen = new Map<string, string>();
  let entries = 0;
  let totalBytes = 0;

  const walk = async (
    absDir: string,
    relDir: string,
    foldedDir: readonly string[],
    depth: number
  ): Promise<void> => {
    const names = (await fs.readdir(absDir)).sort();
    for (const name of names) {
      const relPath = relDir ? `${relDir}/${name}` : name;
      const problem = nameProblem(name);
      if (problem) throw new ProjectTemplateError(`"${relPath}" ${problem}.`);

      const folded = [...foldedDir, foldFileName(name)];
      const denied = deniedReason(folded);
      if (denied) {
        throw new ProjectTemplateError(
          `"${relPath}" is ${denied}, which a template never copies into a new project.`
        );
      }

      const key = folded.join("/");
      const clash = seen.get(key);
      if (clash !== undefined) {
        throw new ProjectTemplateError(
          `"${relPath}" and "${clash}" would be the same file on macOS and Windows.`
        );
      }
      seen.set(key, relPath);

      entries += 1;
      if (entries > PROJECT_TEMPLATE_LIMITS.entries) {
        throw new ProjectTemplateError(
          `The template has more than ${PROJECT_TEMPLATE_LIMITS.entries} files and folders.`
        );
      }

      const absPath = path.join(absDir, name);
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink()) {
        throw new ProjectTemplateError(
          `"${relPath}" is a symbolic link. Templates copy files and folders only.`
        );
      }
      if (stat.isDirectory()) {
        if (depth + 1 > PROJECT_TEMPLATE_LIMITS.depth) {
          throw new ProjectTemplateError(
            `"${relPath}" is nested more than ${PROJECT_TEMPLATE_LIMITS.depth} folders deep.`
          );
        }
        await walk(absPath, relPath, folded, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw new ProjectTemplateError(`"${relPath}" isn't a regular file.`);
      }
      if (files.length >= PROJECT_TEMPLATE_LIMITS.files) {
        throw new ProjectTemplateError(
          `The template has more than ${PROJECT_TEMPLATE_LIMITS.files} files.`
        );
      }
      const content = await readTemplateFile(absPath, relPath);
      const frontMatter = frontMatterProblem(folded, content);
      if (frontMatter) {
        throw new ProjectTemplateError(`"${relPath}" ${frontMatter}.`);
      }
      totalBytes += content.length;
      if (totalBytes > PROJECT_TEMPLATE_LIMITS.totalBytes) {
        throw new ProjectTemplateError(
          `The template's files add up to more than ${formatMegabytes(PROJECT_TEMPLATE_LIMITS.totalBytes)}.`
        );
      }
      files.push({ path: relPath, size: content.length, kind: classify(folded), content });
    }
  };

  await walk(templateDir, "", [], 0);
  if (files.length === 0) {
    throw new ProjectTemplateError("The template has no files.");
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(createHash("sha256").update(file.content).digest());
  }
  return { files, totalBytes, digest: digest.digest("hex") };
}

/**
 * A registered template's inventory, read from the folder main recorded for
 * it. Throws a {@link ProjectTemplateError} when the plugin no longer offers it
 * (disabled, uninstalled, reloaded without it) or its files can't be copied.
 */
export async function loadProjectTemplateInventory(
  pluginId: string,
  templateId: string
): Promise<ProjectTemplateInventory> {
  const pluginDir = getPluginProjectTemplatePluginDir(pluginId, templateId);
  if (pluginDir === undefined) {
    throw new ProjectTemplateError("This template is no longer available.");
  }
  return buildProjectTemplateInventory(await resolveProjectTemplateDir(pluginDir, templateId));
}

/** {@link loadProjectTemplateInventory} for the dialog, with any failure as data. */
export async function previewProjectTemplate(
  pluginId: string,
  templateId: string
): Promise<ProjectTemplatePreview> {
  try {
    return toProjectTemplatePreview(await loadProjectTemplateInventory(pluginId, templateId));
  } catch (err) {
    if (err instanceof ProjectTemplateError) return { status: "unusable", reason: err.message };
    // A filesystem error names the errno and an absolute path: the log keeps
    // where it happened, the dialog says only what did (#15232).
    logError("Couldn't read a project template's files", err, { pluginId, templateId });
    return { status: "unusable", reason: "Couldn't read this template's files.", retryable: true };
  }
}

/** The inventory as the dialog sees it: paths, sizes and kinds, no bytes. */
export function toProjectTemplatePreview(
  inventory: ProjectTemplateInventory
): ProjectTemplatePreview {
  return {
    status: "ready",
    digest: inventory.digest,
    totalBytes: inventory.totalBytes,
    files: inventory.files.map(({ path: filePath, size, kind }) => ({
      path: filePath,
      size,
      kind,
    })),
  };
}

/** What a path on disk is, so it can be told apart from something put in its place. */
function identityOf(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Remove `absPath` only if it is still the entry this call created. Something
 * else swapped into its place — a link, another file — is left alone.
 */
async function removeIfOurs(absPath: string, identity: string, isDir: boolean): Promise<void> {
  const stat = await fs.lstat(absPath).catch(() => null);
  if (!stat || stat.isSymbolicLink() || identityOf(stat) !== identity) return;
  await (isDir ? fs.rmdir(absPath) : fs.unlink(absPath)).catch(() => {});
}

/**
 * Write the inventory into `destRoot`, which must be the empty folder the user
 * just created. Every folder and file is created exclusively, so nothing that
 * appeared there in the meantime is overwritten, and the folder each is created
 * in is first checked to still be the one this call recorded, so a folder
 * swapped for a link mid-copy stops the copy rather than redirecting it. On
 * failure everything this call created is removed again — checked the same
 * way, so nothing else is — and the error is rethrown.
 *
 * Node has no descriptor-relative `mkdirat`/`openat`/`unlinkat`, so each check
 * and the step after it are separate calls: a process already running as the
 * user, racing this one inside the folder it just made, still has a window.
 * The checks close everything short of that.
 */
export async function writeProjectTemplate(
  destRoot: string,
  inventory: ProjectTemplateInventory
): Promise<void> {
  const created: Array<{ absPath: string; identity: string; isDir: boolean }> = [];
  try {
    const rootStat = await fs.lstat(destRoot);
    if (!rootStat.isDirectory() || (await fs.readdir(destRoot)).length > 0) {
      throw new ProjectTemplateError("The new folder isn't empty, so the template wasn't copied.");
    }
    const dirIdentities = new Map<string, string>([["", identityOf(rootStat)]]);
    // Before anything is created in a folder, that folder must still be the one
    // this call recorded — the new root or a folder it made.
    const assertParentUnchanged = async (relPath: string): Promise<void> => {
      const slash = relPath.lastIndexOf("/");
      const parent = slash === -1 ? "" : relPath.slice(0, slash);
      const stat = await fs.lstat(path.join(destRoot, ...parent.split("/")));
      if (!stat.isDirectory() || identityOf(stat) !== dirIdentities.get(parent)) {
        throw new ProjectTemplateError(
          "The new folder changed while the template was being copied, so the copy stopped."
        );
      }
    };
    const dirs = new Set<string>();
    for (const file of inventory.files) {
      const segments = file.path.split("/");
      for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
    }
    // A parent sorts before its children because it is their prefix.
    for (const dir of [...dirs].sort()) {
      const absDir = path.join(destRoot, ...dir.split("/"));
      await assertParentUnchanged(dir);
      await fs.mkdir(absDir);
      const identity = identityOf(await fs.lstat(absDir));
      created.push({ absPath: absDir, identity, isDir: true });
      dirIdentities.set(dir, identity);
    }
    for (const file of inventory.files) {
      await assertParentUnchanged(file.path);
      const absFile = path.join(destRoot, ...file.path.split("/"));
      // Recorded once created and before writing, so a write that fails part
      // way (a full disk) still gets its half-written file removed.
      const handle = await fs.open(absFile, "wx", 0o644);
      try {
        created.push({ absPath: absFile, identity: identityOf(await handle.stat()), isDir: false });
        await handle.writeFile(file.content);
      } finally {
        await handle.close();
      }
    }
  } catch (err) {
    for (const entry of created.reverse()) {
      await removeIfOurs(entry.absPath, entry.identity, entry.isDir);
    }
    throw err;
  }
}
