import type {
  FileDecoration,
  FileDecorationProviderImpl,
  ForgeProviderImpl,
} from "../../../../shared/types/forge.js";
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
 * thread counts, and maps each to a badge/tooltip/color decoration plus an
 * optional `url` deep-link authored by the active forge provider.
 */
export function createReviewDecorationProvider(
  host: PluginHostApi,
  provider: ForgeProviderImpl
): FileDecorationProviderImpl {
  return {
    async provideDecorations(scope, paths) {
      if (!scope.startsWith(SCOPE_PREFIX)) return {};
      const worktreePath = scope.slice(SCOPE_PREFIX.length);
      if (worktreePath.length === 0 || paths.length === 0) return {};

      const worktrees = await host.getWorktrees();
      const worktree = worktrees.find((w) => w.path === worktreePath);
      const prRef = worktree?.linked?.pr?.ref;
      const prNumber = prRef?.number;
      if (typeof prNumber !== "number") return {};

      const counts = await getPRReviewThreads(worktreePath, prNumber);
      const { __clampedAt: _clamped, ...pathCounts } = counts as Record<string, number> & {
        __clampedAt?: number;
      };
      const isClamped = typeof _clamped === "number";
      const wanted = new Set(paths);
      // Capability guard: only set `url` when the provider implements the
      // builder. `in` would falsely report it for a property explicitly set
      // to `undefined` (forge.ts:463-466). The renderer mirrors this guard
      // so unloaded providers don't throw at click time.
      const buildFileUrl = provider.buildPRFileUrl;
      // Guard the deep-link on the data it requires. Legacy snapshots
      // synthesized by `toPluginWorktreeSnapshot` can carry a `prNumber`
      // without populating the canonical `owner`/`repo` — building a URL
      // from empty strings would produce `https://github.com///pull/N/...`
      // which the host can't recover from. Omit `url` so the badge stays
      // as an indicator but the click target is disabled.
      const hasRepoRef =
        typeof prRef.owner === "string" &&
        prRef.owner.length > 0 &&
        typeof prRef.repo === "string" &&
        prRef.repo.length > 0;
      const out: Record<string, FileDecoration> = {};
      for (const [path, count] of Object.entries(pathCounts)) {
        if (count > 0 && wanted.has(path)) {
          const base = `${count} unresolved review comment${count !== 1 ? "s" : ""}`;
          const decoration: FileDecoration = {
            badge: String(count),
            tooltip: isClamped ? `${base} (partial count)` : base,
            color: "text-status-warning",
          };
          if (buildFileUrl && hasRepoRef) {
            decoration.url = buildFileUrl(
              { host: "github.com", owner: prRef.owner, repo: prRef.repo, rawData: prRef.rawData },
              prNumber,
              path
            );
          }
          out[path] = decoration;
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
export function registerReviewDecorationProvider(
  host: PluginHostApi,
  provider: ForgeProviderImpl
): () => void {
  const disposeProvider = host.registerFileDecorationProvider(
    { id: "worktree-diff-review" },
    createReviewDecorationProvider(host, provider)
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
