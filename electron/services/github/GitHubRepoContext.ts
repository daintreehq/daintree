import { GitService } from "../GitService.js";
import { repoContextCache } from "./GitHubCaches.js";
import type { RepoContext } from "./types.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | null {
  const normalized = url.replace(/^git@github\.com:/, "https://github.com/");

  try {
    const parsed = new URL(normalized);

    if (parsed.hostname !== "github.com") {
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

    return { owner: parts[0], repo: parts[1] };
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

    try {
      const { projectStore } = await import("../ProjectStore.js");
      const repoRoot = await gitService.getRepositoryRoot(cwd);
      const project = await projectStore.getProjectByPath(repoRoot);
      if (project) {
        const settings = await projectStore.getProjectSettings(project.id);
        if (settings.githubRemote) {
          const remotes = await gitService.listRemotes(cwd);
          const match = remotes.find((r) => r.name === settings.githubRemote);
          if (match?.fetchUrl) {
            fetchUrl = match.fetchUrl;
          }
        }
      }
    } catch {
      // Fall through to default origin lookup
    }

    if (!fetchUrl) {
      fetchUrl = await gitService.getRemoteUrl(cwd);
    }

    if (!fetchUrl) return null;

    const parsed = parseGitHubRepoUrl(fetchUrl);
    if (!parsed) return null;

    const context = { owner: parsed.owner, repo: parsed.repo };
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
        (freshContext.owner !== context.owner || freshContext.repo !== context.repo)
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
  return `https://github.com/${context.owner}/${context.repo}`;
}

export async function getIssueUrl(cwd: string, issueNumber: number): Promise<string | null> {
  const repoUrl = await getRepoUrl(cwd);
  if (!repoUrl) return null;
  return `${repoUrl}/issues/${issueNumber}`;
}
