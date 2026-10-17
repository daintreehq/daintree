import fs from "node:fs/promises";
import path from "node:path";
import type { DestinationCheck } from "../../../shared/types/ipc/projectMatch.js";
import { normalizeGitRemoteUrls } from "../../../shared/utils/gitRemoteUrl.js";
import { validateFolderName } from "../../../shared/utils/folderName.js";
import { parseConfigRemotes } from "./gitOps.js";

const MAX_SUFFIX = 50;

async function readRemotesAt(dir: string): Promise<Array<{ url: string }> | null> {
  const config = await fs.readFile(path.join(dir, ".git", "config"), "utf8").catch(() => null);
  return config === null ? null : parseConfigRemotes(config);
}

async function nextFreeSibling(target: string): Promise<string | null> {
  const parent = path.dirname(target);
  const base = path.basename(target);
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const candidate = path.join(parent, `${base}-${n}`);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat) return candidate;
  }
  return null;
}

/**
 * Whether `target` can take a clone of the repository named by `remoteUrls`:
 * free (absent, or an empty folder), already a clone of it, or taken by
 * something else — in which case a free `<name>-N` sibling is suggested.
 */
export async function checkDestination(
  target: string,
  remoteUrls: string[]
): Promise<DestinationCheck> {
  const invalid = (detail: string): DestinationCheck => ({
    path: target,
    status: "invalid",
    detail,
    suggestion: null,
  });
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    return invalid("Enter a folder path.");
  }
  if (!path.isAbsolute(target)) return invalid("Use a full path, starting from /.");
  const resolved = path.resolve(target);
  if (path.parse(resolved).root === resolved) return invalid("Pick a folder, not the disk root.");
  const nameError = validateFolderName(path.basename(resolved));
  if (nameError) return invalid(nameError);

  const stat = await fs.lstat(resolved).catch(() => null);
  if (!stat) return { path: resolved, status: "free", detail: null, suggestion: null };
  if (stat.isDirectory()) {
    const entries = await fs.readdir(resolved).catch(() => null);
    if (entries && entries.length === 0) {
      return { path: resolved, status: "free", detail: null, suggestion: null };
    }
    const remotes = await readRemotesAt(resolved);
    if (remotes) {
      const wanted = normalizeGitRemoteUrls(remoteUrls);
      const here = normalizeGitRemoteUrls(remotes.map((r) => r.url));
      if ([...here].some((url) => wanted.has(url))) {
        return {
          path: resolved,
          status: "same-repository",
          detail: "This folder is already a clone of the repository.",
          suggestion: null,
        };
      }
    }
  }
  return {
    path: resolved,
    status: "occupied",
    detail: "Something else is already in this folder.",
    suggestion: await nextFreeSibling(resolved),
  };
}

/**
 * Top-level home folders a mirrored project may sit under: where people keep
 * code. The source machine picks the path, so a folder outside these (or the
 * target's own projects folder) is never mirrored: `~/bin` lands on PATH,
 * `~/Library/LaunchAgents` and `~/.config/autostart` run at login.
 */
const CODE_HOME_FOLDERS = new Set([
  "projects",
  "code",
  "src",
  "source",
  "developer",
  "dev",
  "repos",
  "repositories",
  "git",
  "github",
  "gitlab",
  "work",
  "workspace",
  "workspaces",
  "sites",
]);

/**
 * Whether a source's home-relative project path may be mirrored on this
 * machine: no hidden or `..` segment anywhere, and under a folder where code
 * lives (or under `projectsRel`, the target's own projects folder relative to
 * home).
 */
export function isMirrorableHomePath(rel: string, projectsRel: string | null = null): boolean {
  if (path.isAbsolute(rel)) return false;
  const segments = rel.split(/[\\/]/).filter(Boolean);
  if (segments.length < 2) return false;
  if (segments.some((segment) => segment === ".." || segment.startsWith("."))) return false;
  const joined = segments.join("/");
  if (projectsRel && (joined === projectsRel || joined.startsWith(`${projectsRel}/`))) {
    return joined !== projectsRel;
  }
  return CODE_HOME_FOLDERS.has(segments[0]!.toLowerCase());
}

/**
 * A source-supplied repository name as one plain folder name: leading dots
 * dropped (".dotfiles" → "dotfiles"), and "project" when nothing plain is left.
 */
export function plainFolderName(name: string): string {
  const trimmed = name.trim().replace(/^\.+/, "");
  const plain =
    trimmed.length > 0 &&
    ![...trimmed].some((char) => {
      const code = char.charCodeAt(0);
      return char === "/" || char === "\\" || code < 0x20 || code === 0x7f;
    });
  return plain ? trimmed : "project";
}

/**
 * Whether a worktree path another machine chose, relative to the project
 * folder, may be used here: inside the project, or under the project's
 * `<project>-worktrees` sibling, with no hidden segment. Anything else
 * (`../bin`, `../Library/LaunchAgents` for a project in `~`) is left to this
 * machine's own worktree pattern.
 */
export function isPlacedWorktreePathSafe(rel: string, projectFolderName: string): boolean {
  if (path.isAbsolute(rel) || rel.includes("\\")) return false;
  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (
    segments.some((segment, index) => (segment === ".." ? index !== 0 : segment.startsWith(".")))
  ) {
    return false;
  }
  if (segments[0] !== "..") return true;
  return segments.length >= 3 && segments[1] === `${projectFolderName}-worktrees`;
}

/**
 * Where `target` really is: its nearest existing ancestor resolved through
 * any links, with the rest of the path below it. A link in a parent (one a
 * previous clone left, say) can't make a path look like somewhere else.
 */
export async function canonicalPath(target: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest.reverse());
    } catch (error) {
      // Only a missing segment justifies walking up; a real failure (EACCES,
      // ELOOP, EIO) must not quietly become a path taken at face value.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The default clone destination: the project's path relative to home on the
 * Shell, when that is free here, sits where code lives and stays there once
 * links are resolved; otherwise the host's projects folder plus the
 * repository's name, stepping to `<name>-N` past anything in the way.
 */
export async function suggestDestination(input: {
  homeDir: string;
  projectsDir: string;
  homeRelativePath: string | null;
  repoName: string;
  remoteUrls: string[];
}): Promise<DestinationCheck> {
  const rel = input.homeRelativePath;
  const realHome = await canonicalPath(input.homeDir);
  const realProjects = await canonicalPath(input.projectsDir);
  const projectsRel = path.relative(realHome, realProjects);
  const projectsUnderHome =
    projectsRel.length > 0 && !projectsRel.startsWith("..") && !path.isAbsolute(projectsRel)
      ? projectsRel.split(path.sep).join("/")
      : null;
  if (rel && isMirrorableHomePath(rel, projectsUnderHome)) {
    const mirrored = path.join(input.homeDir, ...rel.split(/[\\/]/).filter(Boolean));
    const real = path.relative(realHome, await canonicalPath(mirrored));
    if (
      !real.startsWith("..") &&
      isMirrorableHomePath(real.split(path.sep).join("/"), projectsUnderHome)
    ) {
      const check = await checkDestination(mirrored, input.remoteUrls);
      if (check.status === "free" || check.status === "same-repository") return check;
    }
  }
  // The name comes from the source machine: one plain folder name, never a path.
  const fallback = path.join(input.projectsDir, plainFolderName(input.repoName));
  const check = await checkDestination(fallback, input.remoteUrls);
  if (check.status === "occupied" && check.suggestion) {
    return checkDestination(check.suggestion, input.remoteUrls);
  }
  return check;
}
