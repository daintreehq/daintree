import type { FileDecoration, FileDecorationProviderImpl } from "../../../../shared/types/forge.js";
import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { getPRReviewThreads } from "./GitHubPRs.js";

const SCOPE_PREFIX = "worktree-diff:";

/**
 * Built-in GitHub `fileDecorationProvider` for the `worktree-diff:*` scope.
 *
 * Replaces the renderer's old direct `getPRReviewThreads` coupling in
 * `ReviewHubContent`: the host now pulls decorations generically and never
 * learns what a review thread is. The scope string carries the worktree path
 * (`worktree-diff:/abs/path`); the provider resolves that worktree's linked
 * PR number from the host's worktree snapshots, fetches unresolved review
 * thread counts, and maps each to a badge/tooltip/color decoration.
 */
export function createReviewDecorationProvider(host: PluginHostApi): FileDecorationProviderImpl {
  return {
    async provideDecorations(scope, paths) {
      if (!scope.startsWith(SCOPE_PREFIX)) return {};
      const worktreePath = scope.slice(SCOPE_PREFIX.length);
      if (worktreePath.length === 0 || paths.length === 0) return {};

      const worktrees = await host.getWorktrees();
      const worktree = worktrees.find((w) => w.path === worktreePath);
      const prNumber = worktree?.linked?.pr?.ref.number;
      if (typeof prNumber !== "number") return {};

      const counts = await getPRReviewThreads(worktreePath, prNumber);
      const wanted = new Set(paths);
      const out: Record<string, FileDecoration> = {};
      for (const [path, count] of Object.entries(counts)) {
        if (count > 0 && wanted.has(path)) {
          out[path] = {
            badge: String(count),
            tooltip: `${count} unresolved review comment${count !== 1 ? "s" : ""}`,
            color: "text-status-warning",
          };
        }
      }
      return out;
    },
  };
}

/**
 * Wire the provider plus a worktree-change subscription that invalidates the
 * affected scopes so an open Review Hub re-pulls when PR linkage changes.
 * Returns a disposer covering both.
 */
export function registerReviewDecorationProvider(host: PluginHostApi): () => void {
  const disposeProvider = host.registerFileDecorationProvider(
    { id: "worktree-diff-review" },
    createReviewDecorationProvider(host)
  );

  // `onDidChangeWorktrees` fires after `activate()` resolves; that is exactly
  // why `invalidateFileDecorations` is not revoke-guarded on the host side.
  const disposeWatch = host.onDidChangeWorktrees((snapshots) => {
    for (const wt of snapshots) {
      if (wt.linked?.pr) {
        host.invalidateFileDecorations(`${SCOPE_PREFIX}${wt.path}`);
      }
    }
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    disposeProvider();
    disposeWatch();
  };
}
