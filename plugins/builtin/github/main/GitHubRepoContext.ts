import { GitService } from "../../../../electron/services/GitService.js";
import { repoContextCache } from "./GitHubCaches.js";
import type { RepoContext } from "./types.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { githubWebBase, isServedGitHubHost } from "./GitHubHost.js";

/**
 * Parse a git remote (or a pasted repository page URL) on a GitHub host this
 * provider serves — github.com, or the configured Enterprise Server host —
 * into its host, owner and repository. Any other host is null: its remote is
 * no repository this provider can read.
 */
export function parseGitHubRepoUrl(
  url: string
): { host: string; owner: string; repo: string } | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();

  // SCP-like `[user@]host:owner/repo.git` has no scheme for URL to parse.
  const scp = /^(?:[^@/:\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(trimmed);
  const normalized =
    scp && !trimmed.includes("://") ? `ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}` : trimmed;

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (!isServedGitHubHost(host)) {
      return null;
    }

    const pathname = parsed.pathname
      .replace(/^\//, "")
      .replace(/\/$/, "")
      .replace(/\.git$/, "");

    const parts = pathname.split("/");

    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return null;
    }

    return { host, owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

export async function getRepoContext(cwd: string): Promise<RepoContext | null> {
  const cached = repoContextCache.get(cwd);
  if (cached) return cached;

  try {
    const gitService = new GitService(cwd);

    let fetchUrl: string | null = null;
    // Set once we know the project named a remote, so a lookup miss below
    // stays a miss instead of quietly resolving against origin (#11408).
    let remoteWasConfigured = false;

    try {
      const { projectStore } = await import("../../../../electron/services/ProjectStore.js");
      const repoRoot = await gitService.getRepositoryRoot(cwd);
      const project = await projectStore.getProjectByPath(repoRoot);
      if (project) {
        const settings = await projectStore.getProjectSettings(project.id);
        const selectedRemote = settings.forgeRemote ?? settings.githubRemote;
        if (selectedRemote) {
          remoteWasConfigured = true;
          const remotes = await gitService.listRemotes(cwd);
          const match = remotes.find((r) => r.name === selectedRemote);
          if (match?.fetchUrl) {
            fetchUrl = match.fetchUrl;
          }
        }
      }
    } catch {
      // Fall through to default origin lookup
    }

    if (!fetchUrl && !remoteWasConfigured) {
      fetchUrl = await gitService.getRemoteUrl(cwd);
    }

    if (!fetchUrl) return null;

    const parsed = parseGitHubRepoUrl(fetchUrl);
    if (!parsed) return null;

    const context = { host: parsed.host, owner: parsed.owner, repo: parsed.repo };
    repoContextCache.set(cwd, context);
    return context;
  } catch {
    return null;
  }
}

export function isRepoNotFoundError(error: unknown): boolean {
  const message = formatErrorMessage(error, "Failed to access GitHub repository");
  const lower = message.toLowerCase();
  return lower.includes("not found") || lower.includes("could not resolve");
}

export async function withRepoContextRetry<T>(
  cwd: string,
  fn: (context: RepoContext) => Promise<T>
): Promise<T> {
  const context = await getRepoContext(cwd);
  if (!context) throw new Error("Not a GitHub repository");

  try {
    return await fn(context);
  } catch (error) {
    if (isRepoNotFoundError(error)) {
      repoContextCache.invalidate(cwd);
      const freshContext = await getRepoContext(cwd);
      if (
        freshContext &&
        (freshContext.host !== context.host ||
          freshContext.owner !== context.owner ||
          freshContext.repo !== context.repo)
      ) {
        return await fn(freshContext);
      }
    }
    throw error;
  }
}

export async function getRepoInfo(cwd: string): Promise<RepoContext | null> {
  return getRepoContext(cwd);
}

export async function getRepoUrl(cwd: string): Promise<string | null> {
  const context = await getRepoContext(cwd);
  if (!context) return null;
  return `${githubWebBase(context.host)}/${context.owner}/${context.repo}`;
}

export async function getIssueUrl(cwd: string, issueNumber: number): Promise<string | null> {
  const repoUrl = await getRepoUrl(cwd);
  if (!repoUrl) return null;
  return `${repoUrl}/issues/${issueNumber}`;
}
