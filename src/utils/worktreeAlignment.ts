import { inferWorktreeIdFromCwd } from "./worktreePaths";

/**
 * Where a panel's process was launched, relative to the worktree the panel is
 * (or is about to be) filed under.
 *
 * Deliberately not "PWD divergence": there is no live PWD to read. Agents don't
 * emit shell prompts, so OSC 7 never fires when it matters (#1605). This is a
 * launch-root check and nothing more.
 */
export type LaunchRootAlignment = "aligned" | "launch-root-mismatch" | "unknown";

function normalizeForComparison(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Reconcile the renderer's mirrored `panel.cwd` against the backend's
 * authoritative launch cwd from `terminal.getInfo`.
 *
 * A disagreement returns `undefined` rather than picking a winner: neither value
 * has earned the right to speak for the process, and `undefined` classifies as
 * `unknown`, which asks the user instead of assuming.
 */
export function resolveLaunchCwd(
  panelCwd: string | undefined,
  backendCwd: string | undefined
): string | undefined {
  const panel = panelCwd?.trim() ? panelCwd : undefined;
  const backend = backendCwd?.trim() ? backendCwd : undefined;
  if (!backend) return panel;
  if (!panel) return backend;
  return normalizeForComparison(panel) === normalizeForComparison(backend) ? backend : undefined;
}

/**
 * Classify a launch cwd against a worktree id.
 *
 * Built on `inferWorktreeIdFromCwd` rather than string equality: it is
 * segment-aware, normalizes separators and trailing slashes, and takes the
 * longest match, so a subdirectory launch and a nested worktree path both
 * resolve correctly where `===` or `startsWith` would not.
 *
 * Anything unprovable is `unknown` — an empty cwd, a cwd under no worktree, a
 * panel with no worktree of its own. Callers must treat `unknown` as "ask",
 * never as "aligned".
 */
export function classifyLaunchRootAlignment(
  cwd: string | undefined,
  worktrees: ReadonlyArray<{ id: string; path: string }> | undefined,
  worktreeId: string | undefined
): LaunchRootAlignment {
  if (!worktreeId) return "unknown";
  const inferred = inferWorktreeIdFromCwd(cwd, worktrees);
  if (inferred === undefined) return "unknown";
  return inferred === worktreeId ? "aligned" : "launch-root-mismatch";
}
