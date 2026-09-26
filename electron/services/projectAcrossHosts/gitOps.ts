import type { SimpleGit } from "simple-git";
import { createAuthenticatedGit, createHardenedGit } from "../../utils/hardenedGit.js";

/**
 * How this module reaches git. Local reads go through the hardened client;
 * anything that talks to a remote runs with the machine's own credentials,
 * which is the point: each host fetches, pushes and clones as itself.
 */
export interface GitFactory {
  local(cwd: string): Promise<Pick<SimpleGit, "raw">>;
  network(cwd: string, signal?: AbortSignal): Promise<Pick<SimpleGit, "raw">>;
}

export const defaultGitFactory: GitFactory = {
  local: (cwd) => createHardenedGit(cwd),
  network: (cwd, signal) => createAuthenticatedGit(cwd, signal ? { signal } : {}),
};

export async function tryRaw(git: Pick<SimpleGit, "raw">, args: string[]): Promise<string | null> {
  try {
    return await git.raw(args);
  } catch {
    return null;
  }
}

export async function readConfigValue(
  git: Pick<SimpleGit, "raw">,
  key: string
): Promise<string | null> {
  const out = await tryRaw(git, ["config", "--get", key]);
  const value = out?.trim() ?? "";
  return value.length > 0 ? value : null;
}

/**
 * Whether `ref` names a commit. Judged by output, not by rejection: git's
 * `--quiet` misses exit non-zero with nothing on stderr, which the client
 * doesn't always treat as an error.
 */
export async function refExists(git: Pick<SimpleGit, "raw">, ref: string): Promise<boolean> {
  const out = await tryRaw(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return (out?.trim().length ?? 0) > 0;
}

export async function hasCommit(git: Pick<SimpleGit, "raw">, sha: string): Promise<boolean> {
  const out = await tryRaw(git, ["cat-file", "-t", sha]);
  return out?.trim() === "commit";
}

export async function countCommits(
  git: Pick<SimpleGit, "raw">,
  range: string
): Promise<number | null> {
  const out = await tryRaw(git, ["rev-list", "--count", range, "--"]);
  if (out === null) return null;
  const count = Number.parseInt(out.trim(), 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * Remotes from a repository's `config` file, for folders that are only
 * scanned (not registered), where spawning git per folder would be wasteful.
 */
export function parseConfigRemotes(configText: string): Array<{ name: string; url: string }> {
  const remotes: Array<{ name: string; url: string }> = [];
  let current: string | null = null;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*remote\s+"((?:[^"\\]|\\.)*)"\s*\]$/i.exec(line);
    if (section) {
      current = section[1]!.replace(/\\(.)/g, "$1");
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (current === null) continue;
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (!entry) continue;
    let url = entry[1]!.trim();
    if (url.startsWith('"') && url.endsWith('"') && url.length >= 2) url = url.slice(1, -1);
    if (url.length > 0 && !remotes.some((r) => r.name === current)) {
      remotes.push({ name: current, url });
    }
  }
  return remotes;
}
