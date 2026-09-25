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
 * The default clone destination: the project's path relative to home on the
 * Shell, when that is free here; otherwise the host's projects folder plus
 * the repository's name, stepping to `<name>-N` past anything in the way.
 */
export async function suggestDestination(input: {
  homeDir: string;
  projectsDir: string;
  homeRelativePath: string | null;
  repoName: string;
  remoteUrls: string[];
}): Promise<DestinationCheck> {
  const rel = input.homeRelativePath;
  if (rel && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes("..")) {
    const mirrored = path.join(input.homeDir, ...rel.split(/[\\/]/).filter(Boolean));
    const check = await checkDestination(mirrored, input.remoteUrls);
    if (check.status === "free" || check.status === "same-repository") return check;
  }
  const fallback = path.join(input.projectsDir, input.repoName);
  const check = await checkDestination(fallback, input.remoteUrls);
  if (check.status === "occupied" && check.suggestion) {
    return checkDestination(check.suggestion, input.remoteUrls);
  }
  return check;
}
