import fs from "node:fs/promises";
import path from "node:path";
import type {
  FindProjectMatchPayload,
  ProjectMatchCandidate,
} from "../../../shared/types/ipc/projectMatch.js";
import type { Project } from "../../../shared/types/project.js";
import {
  normalizeGitRemoteUrls,
  stripRemoteListCredentials,
} from "../../../shared/utils/gitRemoteUrl.js";
import { gitServiceCache } from "../GitServiceCache.js";
import { parseConfigRemotes } from "./gitOps.js";
import type { ProjectAcrossHostsDeps } from "./types.js";

const REMOTE_READ_CONCURRENCY = 8;
const SCAN_MAX_DEPTH = 2;
const SCAN_MAX_DIRECTORIES = 4000;
const SCAN_MAX_ROOTS = 8;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "Library", "vendor", "target", "dist"]);

export type RemoteLister = (repoPath: string) => Promise<Array<{ name: string; url: string }>>;

export const listRegisteredRemotes: RemoteLister = async (repoPath) => {
  const remotes = await gitServiceCache.getGitService(repoPath).listRemotes(repoPath);
  return remotes
    .filter((remote) => remote.fetchUrl.length > 0)
    .map((remote) => ({ name: remote.name, url: remote.fetchUrl }));
};

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function sharesRemote(wanted: Set<string>, remotes: Array<{ url: string }>): boolean {
  for (const normalized of normalizeGitRemoteUrls(remotes.map((r) => r.url))) {
    if (wanted.has(normalized)) return true;
  }
  return false;
}

function byPreference(a: ProjectMatchCandidate, b: ProjectMatchCandidate): number {
  if (a.matchedBy !== b.matchedBy) return a.matchedBy === "remote-url" ? -1 : 1;
  return (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
}

/**
 * Registered projects on this host that are the same repository: any of
 * their remotes equals any of the asked-for ones once normalised. A shared
 * committed project id only makes a project a candidate — clones and forks
 * inherit that id — so those rank after every remote match.
 */
export async function findRegisteredMatches(
  payload: FindProjectMatchPayload,
  deps: Pick<ProjectAcrossHostsDeps, "listProjects" | "readCommittedProjectId">,
  listRemotes: RemoteLister = listRegisteredRemotes
): Promise<ProjectMatchCandidate[]> {
  const wanted = normalizeGitRemoteUrls(payload.remoteUrls);
  const committedId = payload.committedProjectId;
  const projects = deps.listProjects().filter((project) => project.gitBacked !== false);
  const results = await mapLimited(
    projects,
    REMOTE_READ_CONCURRENCY,
    async (project: Project): Promise<ProjectMatchCandidate | null> => {
      // Candidates go to the Shell and its dialog: never a remote's embedded credentials.
      const remotes = stripRemoteListCredentials(await listRemotes(project.path).catch(() => []));
      const base = {
        projectId: project.id,
        path: project.path,
        name: project.name,
        remotes,
        source: "registered" as const,
        lastOpenedAt: project.lastOpened ?? null,
      };
      if (wanted.size > 0 && sharesRemote(wanted, remotes)) {
        return { ...base, matchedBy: "remote-url" as const };
      }
      if (committedId) {
        const id = await deps.readCommittedProjectId(project.path).catch(() => null);
        if (id === committedId) return { ...base, matchedBy: "committed-id" as const };
      }
      return null;
    }
  );
  return results.filter((c): c is ProjectMatchCandidate => c !== null).sort(byPreference);
}

async function readRepoConfig(dir: string): Promise<string | null> {
  const dotGit = path.join(dir, ".git");
  const stat = await fs.lstat(dotGit).catch(() => null);
  // A `.git` file is a worktree or submodule pointer: its repository is elsewhere.
  if (!stat?.isDirectory()) return null;
  return fs.readFile(path.join(dotGit, "config"), "utf8").catch(() => null);
}

/**
 * Unregistered clones of the repository under `roots`, at most two levels
 * down, read from each folder's git config without running git. Symlinks
 * are not followed and registered projects are left to the matcher.
 */
export async function scanForClones(
  remoteUrls: string[],
  roots: string[],
  exclude: Set<string>
): Promise<ProjectMatchCandidate[]> {
  const wanted = normalizeGitRemoteUrls(remoteUrls);
  if (wanted.size === 0) return [];
  const found: ProjectMatchCandidate[] = [];
  const seen = new Set<string>();
  let visited = 0;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (visited >= SCAN_MAX_DIRECTORIES || seen.has(dir)) return;
    seen.add(dir);
    visited++;
    const config = depth > 0 ? await readRepoConfig(dir) : null;
    if (config !== null) {
      if (!exclude.has(path.resolve(dir))) {
        const remotes = stripRemoteListCredentials(parseConfigRemotes(config));
        if (sharesRemote(wanted, remotes)) {
          const stat = await fs.stat(dir).catch(() => null);
          found.push({
            projectId: null,
            path: dir,
            name: path.basename(dir),
            remotes,
            source: "on-disk",
            matchedBy: "remote-url",
            lastOpenedAt: stat ? Math.round(stat.mtimeMs) : null,
          });
        }
      }
      // A repository's own subfolders are its content, not more clones.
      return;
    }
    if (depth >= SCAN_MAX_DEPTH) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await visit(path.join(dir, entry.name), depth + 1);
    }
  };

  for (const root of roots.slice(0, SCAN_MAX_ROOTS)) {
    await visit(path.resolve(root), 0);
  }
  return found.sort(byPreference);
}

/**
 * Where this host keeps its projects: the folder most of its registered
 * projects share, else `~/Projects` when it exists, else home.
 */
export async function hostProjectsDir(
  deps: Pick<ProjectAcrossHostsDeps, "listProjects" | "homeDir">
): Promise<string> {
  const counts = new Map<string, number>();
  for (const project of deps.listProjects()) {
    const parent = path.dirname(project.path);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [parent, count] of counts) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  if (best) return best;
  const conventional = path.join(deps.homeDir(), "Projects");
  const stat = await fs.stat(conventional).catch(() => null);
  return stat?.isDirectory() ? conventional : deps.homeDir();
}

/** The folders scanned for unregistered clones: the projects folder and every registered project's parent. */
export async function scanRoots(
  deps: Pick<ProjectAcrossHostsDeps, "listProjects" | "homeDir">
): Promise<string[]> {
  const roots = [await hostProjectsDir(deps)];
  for (const project of deps.listProjects()) {
    const parent = path.dirname(project.path);
    if (!roots.includes(parent)) roots.push(parent);
  }
  const home = path.resolve(deps.homeDir());
  // Home itself is never walked: two levels of it is most of the disk.
  return roots.filter((root) => path.resolve(root) !== home).slice(0, SCAN_MAX_ROOTS);
}
