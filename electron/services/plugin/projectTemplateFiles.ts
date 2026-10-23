import { createHash } from "crypto";
import { constants as fsConstants, promises as fs } from "fs";
import path from "path";
import type {
  ProjectTemplateFile,
  ProjectTemplateFileKind,
  ProjectTemplatePreview,
} from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
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

/** Names that are never copied, at any depth, compared case-insensitively. */
const DENIED_SEGMENTS: ReadonlyMap<string, string> = new Map([
  // `git~1` is the 8.3 short name NTFS can give `.git`.
  [".git", "repository metadata"],
  ["git~1", "repository metadata"],
  [".gitmodules", "repository metadata"],
  ["node_modules", "installed dependencies"],
  // Agent configuration: settings, permissions, hooks and MCP servers for the
  // agent CLIs Daintree runs. Instruction files stay allowed (below).
  [".mcp.json", "agent configuration"],
  [".codex", "agent configuration"],
  [".gemini", "agent configuration"],
  [".cursor", "agent configuration"],
  [".opencode", "agent configuration"],
  ["opencode.json", "agent configuration"],
  ["opencode.jsonc", "agent configuration"],
  [".crush", "agent configuration"],
  ["crush.json", "agent configuration"],
  [".crush.json", "agent configuration"],
  [".aider.conf.yml", "agent configuration"],
  [".amp", "agent configuration"],
  [".copilot", "agent configuration"],
  [".goose", "agent configuration"],
  [".grok", "agent configuration"],
  [".kimi", "agent configuration"],
  [".kiro", "agent configuration"],
  [".qwen", "agent configuration"],
  [".vibe", "agent configuration"],
]);

/**
 * Agent configuration that lives beside instruction content in the same
 * folder: `.claude/` also holds commands, agents and skills, which are allowed,
 * and `.vscode/` holds editor settings.
 */
function deniedNested(segments: readonly string[]): string | null {
  for (let i = 0; i < segments.length - 1; i++) {
    const next = segments[i + 1];
    if (segments[i] === ".claude") {
      if (next === "hooks") return "agent configuration";
      if (i + 1 === segments.length - 1 && next.startsWith("settings")) {
        return "agent configuration";
      }
    }
    if (segments[i] === ".vscode" && next === "mcp.json") return "agent configuration";
  }
  return null;
}

function deniedReason(relPath: string): string | null {
  const segments = relPath.toLowerCase().split("/");
  for (const segment of segments) {
    const reason = DENIED_SEGMENTS.get(segment);
    if (reason) return reason;
  }
  return deniedNested(segments);
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

function classify(relPath: string): ProjectTemplateFileKind {
  const lower = relPath.toLowerCase();
  if (lower.startsWith(".daintree/plugins/")) return "project-plugin";
  const segments = lower.split("/");
  if (INSTRUCTION_FILES.has(segments[segments.length - 1]) || segments.includes(".claude")) {
    return "instructions";
  }
  return "file";
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const NON_PORTABLE_CHARACTER = /[\\/:*?"<>|]/;

/**
 * Why a file or folder name can't be written on every platform Daintree runs
 * on, or null. Held to the strictest of the three so a template behaves the
 * same wherever it is used.
 */
function nameProblem(name: string): string | null {
  if (name === "" || name === "." || name === "..") return "isn't a usable name";
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "has a control character in its name";
  }
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

  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    const names = (await fs.readdir(absDir)).sort();
    for (const name of names) {
      const relPath = relDir ? `${relDir}/${name}` : name;
      const problem = nameProblem(name);
      if (problem) throw new ProjectTemplateError(`"${relPath}" ${problem}.`);

      const denied = deniedReason(relPath);
      if (denied) {
        throw new ProjectTemplateError(
          `"${relPath}" is ${denied}, which a template never copies into a new project.`
        );
      }

      const key = relPath.normalize("NFC").toLowerCase();
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
        await walk(absPath, relPath, depth + 1);
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
      totalBytes += content.length;
      if (totalBytes > PROJECT_TEMPLATE_LIMITS.totalBytes) {
        throw new ProjectTemplateError(
          `The template's files add up to more than ${formatMegabytes(PROJECT_TEMPLATE_LIMITS.totalBytes)}.`
        );
      }
      files.push({ path: relPath, size: content.length, kind: classify(relPath), content });
    }
  };

  await walk(templateDir, "", 0);
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
    return {
      status: "unusable",
      reason: `Couldn't read this template's files: ${formatErrorMessage(err, "unknown error")}`,
    };
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

/**
 * Write the inventory into `destRoot`, which must be the empty folder the user
 * just created. Every folder and file is created exclusively, so nothing that
 * appeared there in the meantime is overwritten; on failure everything this
 * call created is removed again — and nothing else — before the error is
 * rethrown.
 */
export async function writeProjectTemplate(
  destRoot: string,
  inventory: ProjectTemplateInventory
): Promise<void> {
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  try {
    if ((await fs.readdir(destRoot)).length > 0) {
      throw new ProjectTemplateError("The new folder isn't empty, so the template wasn't copied.");
    }
    const dirs = new Set<string>();
    for (const file of inventory.files) {
      const segments = file.path.split("/");
      for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
    }
    // A parent sorts before its children because it is their prefix.
    for (const dir of [...dirs].sort()) {
      const absDir = path.join(destRoot, ...dir.split("/"));
      await fs.mkdir(absDir);
      createdDirs.push(absDir);
    }
    for (const file of inventory.files) {
      const absFile = path.join(destRoot, ...file.path.split("/"));
      // Recorded once created and before writing, so a write that fails part
      // way (a full disk) still gets its half-written file removed.
      const handle = await fs.open(absFile, "wx", 0o644);
      createdFiles.push(absFile);
      try {
        await handle.writeFile(file.content);
      } finally {
        await handle.close();
      }
    }
  } catch (err) {
    for (const absFile of createdFiles.reverse()) {
      await fs.unlink(absFile).catch(() => {});
    }
    for (const absDir of createdDirs.reverse()) {
      await fs.rmdir(absDir).catch(() => {});
    }
    throw err;
  }
}
