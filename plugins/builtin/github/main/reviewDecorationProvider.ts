import type {
  FileDecoration,
  FileDecorationProviderImpl,
  ForgeProviderImpl,
} from "../../../../shared/types/forge.js";
import type { PluginHostApi, PluginWorktreeLinked } from "../../../../shared/types/plugin.js";
import { getETagCacheVersion, REVIEW_THREADS_TTL_MS } from "./GitHubCaches.js";
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
  provider: ForgeProviderImpl,
  getCachedLinked?: (worktreePath: string) => PluginWorktreeLinked | null | undefined
): FileDecorationProviderImpl {
  return {
    async provideDecorations(scope, paths) {
      if (!scope.startsWith(SCOPE_PREFIX)) return {};
      const worktreePath = scope.slice(SCOPE_PREFIX.length);
      if (worktreePath.length === 0 || paths.length === 0) return {};

      // Prefer the linkage cache fed by `onDidChangeWorktrees` (undefined =
      // not seeded yet); fall back to a full snapshot round-trip on cold start.
      let linked = getCachedLinked?.(worktreePath);
      if (linked === undefined) {
        const worktrees = await host.getWorktrees();
        linked = worktrees.find((w) => w.path === worktreePath)?.linked ?? null;
      }
      const prRef = linked?.pr?.ref;
      const prNumber = prRef?.number;
      if (typeof prNumber !== "number" || prRef === undefined) return {};

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
export async function registerReviewDecorationProvider(
  host: PluginHostApi,
  provider: ForgeProviderImpl
): Promise<() => void> {
  // Linkage cache (null until the first snapshots event seeds it) doubles as
  // the previous-state baseline for diffing. Invalidations fire only when a
  // scope's PR linkage changes (added / removed / renumbered / repo moved) or
  // when the review-threads cache TTL has elapsed since the scope's last
  // invalidation — `worktree-update` fires per git-status change in any
  // worktree, and blanket invalidation re-pulled identical cached counts.
  let linkedByPath: Map<string, PluginWorktreeLinked | null> | null = null;
  const lastInvalidatedAt = new Map<string, number>();
  // A manual refresh (`clearPRCaches`) drops `reviewThreadsCache` and bumps
  // the ETag cache version — the unchanged+fresh suppression must not survive
  // that bump or an open Review Hub keeps stale badges until the TTL elapses.
  let lastSeenCacheVersion = getETagCacheVersion();

  const prKey = (linked: PluginWorktreeLinked | null | undefined): string | undefined => {
    const ref = linked?.pr?.ref;
    if (ref === undefined || typeof ref.number !== "number") return undefined;
    return `${ref.owner}/${ref.repo}#${ref.number}`;
  };

  const disposeProvider = await host.registerFileDecorationProvider(
    { id: "worktree-diff-review" },
    createReviewDecorationProvider(host, provider, (worktreePath) =>
      linkedByPath === null ? undefined : (linkedByPath.get(worktreePath) ?? null)
    )
  );

  // `onDidChangeWorktrees` fires after `activate()` resolves; that is exactly
  // why `invalidateFileDecorations` is not revoke-guarded on the host side.
  const disposeWatch = await host.onDidChangeWorktrees((snapshots) => {
    const previous = linkedByPath;
    const next = new Map<string, PluginWorktreeLinked | null>();
    for (const wt of snapshots) next.set(wt.path, wt.linked);
    linkedByPath = next;

    const now = Date.now();
    const cacheVersion = getETagCacheVersion();
    const cachesCleared = cacheVersion !== lastSeenCacheVersion;
    lastSeenCacheVersion = cacheVersion;
    for (const wt of snapshots) {
      if (!wt.linked?.pr) continue;
      const unchanged = previous !== null && prKey(wt.linked) === prKey(previous.get(wt.path));
      const fresh = now - (lastInvalidatedAt.get(wt.path) ?? 0) < REVIEW_THREADS_TTL_MS;
      if (unchanged && fresh && !cachesCleared) continue;
      lastInvalidatedAt.set(wt.path, now);
      // Fire-and-forget: this runs from a post-activation subscription callback.
      void host.invalidateFileDecorations(`${SCOPE_PREFIX}${wt.path}`);
    }
    if (previous !== null) {
      for (const [path, linked] of previous) {
        if (prKey(linked) !== undefined && prKey(next.get(path)) === undefined) {
          lastInvalidatedAt.delete(path);
          void host.invalidateFileDecorations(`${SCOPE_PREFIX}${path}`);
        }
      }
    }
    for (const path of lastInvalidatedAt.keys()) {
      if (!next.has(path)) lastInvalidatedAt.delete(path);
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
