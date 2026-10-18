import { realpath } from "fs/promises";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

async function canonicalize(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * Resolve the directory a project command may start in: the project root when
 * none is named, otherwise the root or one of the repo's registered worktrees —
 * resolved through git, never trusted as a path. Both sides are canonicalized
 * so a symlinked worktree root still matches.
 *
 * This decides where a command starts, not what it can reach: a command is
 * free to `cd` anywhere its user can.
 */
export async function resolveProjectCwd(
  projectPath: string,
  requested: string | undefined,
  createError: (message: string) => Error
): Promise<string> {
  const projectRoot = await canonicalize(projectPath);
  if (!projectRoot) {
    throw createError(`Project directory does not exist: ${projectPath}`);
  }
  if (requested === undefined || requested.trim() === "") return projectRoot;

  const candidate = await canonicalize(requested);
  if (!candidate) {
    throw createError(`Directory does not exist: ${requested}`);
  }
  if (candidate === projectRoot) return candidate;

  const { GitService } = await import("./GitService.js");
  let worktrees: Array<{ path: string; bare: boolean }>;
  try {
    worktrees = await new GitService(projectRoot).listWorktrees();
  } catch (err) {
    throw createError(
      `Could not list worktrees for ${projectRoot} to validate cwd: ${formatErrorMessage(err, "unknown error")}`
    );
  }

  const allowed: string[] = [projectRoot];
  for (const wt of worktrees) {
    if (wt.bare) continue;
    const resolved = await canonicalize(wt.path);
    if (resolved) allowed.push(resolved);
  }

  if (!allowed.includes(candidate)) {
    throw createError(
      `${requested} is not the project root or one of its worktrees. Allowed: ${allowed.join(", ")}.`
    );
  }
  return candidate;
}
