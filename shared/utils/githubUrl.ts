/**
 * Detect github.com remotes in HTTPS or SSH form. Lives in `shared/` so both
 * the main-process workspace host (worktree monitoring) and the renderer
 * (clone dialog recovery banner) can import a single source of truth.
 */
const GITHUB_REMOTE_URL_PATTERN =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i;

export function isGitHubRemoteUrl(url: string | undefined): boolean {
  if (!url) return false;
  return GITHUB_REMOTE_URL_PATTERN.test(url.trim());
}
