/**
 * The one place the workspace cwd chain lives (#11076).
 *
 * The active workspace is a project OR a scratch — switching to a scratch
 * clears the project pointer and vice versa. A scratch has no worktree, so any
 * chain that stops at the project silently strands its terminals in the home
 * dir. Project-first only guards the transient state where both pointers are
 * briefly set (a cached view that hasn't processed the switch broadcast yet);
 * callers that hand-rolled this disagreed on that order, which is why it now
 * lives here.
 *
 * Returns "" only when nothing at all resolves — main treats a falsy cwd as
 * "use the home dir".
 */
export function resolveWorkspaceCwd(paths: {
  worktreePath?: string | null;
  projectPath?: string | null;
  scratchPath?: string | null;
  homeDir?: string | null;
}): string {
  return paths.worktreePath ?? paths.projectPath ?? paths.scratchPath ?? paths.homeDir ?? "";
}
