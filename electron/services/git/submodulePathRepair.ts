import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { logError } from "../../utils/logger.js";
import { rebaseAbsolutePath, isAbsoluteFsPath } from "../../../shared/utils/projectPathRelocation.js";

/**
 * Repair submodule metadata that a project-folder move/rename leaves stale
 * (#11282, phase 2). `git worktree repair` fixes linked worktrees but does
 * NOTHING for submodules, and neither does `git submodule sync`/`absorbgitdirs`:
 * an absolute path already baked into an absorbed submodule's `gitdir:` pointer
 * or its `core.worktree` config is invisible to git porcelain. Modern git writes
 * these RELATIVE by default, which survive a same-volume move untouched — so
 * only ABSOLUTE pointers under the old root are rewritten, via a literal prefix
 * substitution. Relative pointers are left byte-for-byte unchanged.
 *
 * Best-effort and per-file isolated: a malformed or unwritable config never
 * aborts the others, and the function never rejects — the DB row has already
 * moved and is authoritative, so a repair failure must not fail the relocation.
 */
export async function repairMovedSubmodulePaths(oldRoot: string, newRoot: string): Promise<void> {
  if (!oldRoot || !newRoot || oldRoot === newRoot) return;

  try {
    const commonGitDir = await resolveGitDir(newRoot);
    if (!commonGitDir) return;

    // Absorbed submodules live under `<git>/modules`; submodules owned by a
    // linked worktree live under `<git>/worktrees/<id>/modules`.
    const scanRoots = [path.join(commonGitDir, "modules")];
    const worktreesDir = path.join(commonGitDir, "worktrees");
    for (const entry of await safeReaddir(worktreesDir)) {
      scanRoots.push(path.join(worktreesDir, entry, "modules"));
    }

    const configFiles: string[] = [];
    for (const root of scanRoots) {
      await collectConfigFiles(root, configFiles);
    }

    for (const configFile of configFiles) {
      await repairOneModule(configFile, oldRoot, newRoot);
    }
  } catch (error) {
    logError(`Failed to repair submodule pointers under ${newRoot}`, error);
  }
}

/**
 * Resolve the repository's common git directory for a main worktree. Normally
 * `<root>/.git` is a directory; when it is a `gitdir:` file (root is itself a
 * linked worktree) we follow it and honour a `commondir` sibling.
 */
async function resolveGitDir(root: string): Promise<string | null> {
  const dotGit = path.join(root, ".git");
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    return null;
  }
  if (info.isDirectory()) return dotGit;
  if (!info.isFile()) return null;

  const pointer = await safeReadFile(dotGit);
  const match = pointer?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;
  const gitDir = path.resolve(root, match[1]);
  const commonDirFile = await safeReadFile(path.join(gitDir, "commondir"));
  if (commonDirFile) {
    return path.resolve(gitDir, commonDirFile.trim());
  }
  return gitDir;
}

async function collectConfigFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectConfigFiles(full, out);
    } else if (entry.isFile() && entry.name === "config") {
      out.push(full);
    }
  }
}

/**
 * Rewrite one module's `core.worktree` (in its config) and the submodule
 * checkout's `.git` gitlink pointer, when either holds an absolute path under
 * `oldRoot`. `moduleDir` is the config's directory — git resolves a relative
 * `core.worktree` against it.
 */
async function repairOneModule(configFile: string, oldRoot: string, newRoot: string): Promise<void> {
  try {
    const moduleDir = path.dirname(configFile);
    const original = await safeReadFile(configFile);
    if (original === null) return;

    let worktreeRaw: string | null = null;
    const rewrittenConfig = rewriteCoreWorktree(original, (value) => {
      worktreeRaw = value;
      return isAbsoluteFsPath(value) ? rebaseAbsolutePath(value, oldRoot, newRoot) : value;
    });
    if (rewrittenConfig.changed) {
      await resilientAtomicWriteFile(configFile, rewrittenConfig.text, "utf-8");
    }

    // Locate the submodule checkout to repair its `.git` pointer file. Use the
    // post-rewrite core.worktree so a just-fixed absolute value points at the
    // new location; a relative value resolves against the module dir.
    if (worktreeRaw === null) return;
    const effectiveWorktree = isAbsoluteFsPath(worktreeRaw)
      ? rebaseAbsolutePath(worktreeRaw, oldRoot, newRoot)
      : path.resolve(moduleDir, worktreeRaw);

    await repairGitlinkPointer(path.join(effectiveWorktree, ".git"), oldRoot, newRoot);
  } catch (error) {
    logError(`Failed to repair submodule config ${configFile}`, error);
  }
}

/** Rewrite an absolute `gitdir:` pointer in a submodule's `.git` file. */
async function repairGitlinkPointer(
  gitlinkFile: string,
  oldRoot: string,
  newRoot: string
): Promise<void> {
  const content = await safeReadFile(gitlinkFile);
  if (content === null) return;
  const match = content.match(/^(gitdir:\s*)(.+?)(\s*)$/m);
  if (!match) return;
  const target = match[2];
  if (!isAbsoluteFsPath(target)) return;
  const rebased = rebaseAbsolutePath(target, oldRoot, newRoot);
  if (rebased === target) return;
  const next = content.replace(match[0], `${match[1]}${rebased}${match[3]}`);
  await resilientAtomicWriteFile(gitlinkFile, next, "utf-8");
}

/**
 * Rewrite the `worktree` value inside the `[core]` section of a git config,
 * preserving all other content, whitespace, quoting and line endings. Handles
 * git's quoted-value form (`worktree = "with space"`).
 */
function rewriteCoreWorktree(
  text: string,
  transform: (value: string) => string
): { text: string; changed: boolean } {
  const lines = text.split("\n");
  let section: string | null = null;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      section = header[1].trim().toLowerCase().split(/\s+/)[0];
      continue;
    }
    if (section !== "core") continue;

    const kv = line.match(/^(\s*worktree\s*=\s*)(.*?)(\s*)$/i);
    if (!kv) continue;

    const { value, quoted } = decodeConfigValue(kv[2]);
    const next = transform(value);
    if (next !== value) {
      // kv[3] preserves the line's trailing whitespace — notably a CRLF's `\r`,
      // so a Windows-authored config keeps its line endings intact.
      lines[i] = kv[1] + encodeConfigValue(next, quoted) + kv[3];
      changed = true;
    }
    // Only the first core.worktree matters.
    break;
  }

  return { text: lines.join("\n"), changed };
}

function decodeConfigValue(raw: string): { value: string; quoted: boolean } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed
      .slice(1, -1)
      .replace(/\\(["\\tn])/g, (_m, c) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
    return { value: inner, quoted: true };
  }
  return { value: trimmed, quoted: false };
}

function encodeConfigValue(value: string, quoted: boolean): string {
  const needsQuote = quoted || /[\s"\\]/.test(value);
  if (!needsQuote) return value;
  const escaped = value.replace(/(["\\])/g, "\\$1").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

async function safeReadFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return null;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
