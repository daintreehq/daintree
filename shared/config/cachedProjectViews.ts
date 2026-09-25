const GIB = 1024 ** 3;

export function computeDefaultCachedViews(totalMemBytes: number): number {
  // The cap counts the active view, so N means N-1 warm background views.
  // Frozen+invisible cached renderers (setVisible(false) releases their GPU
  // tile textures) are cheap enough to keep more around, and evictStaleViews()
  // still drops to 1 when free RAM is genuinely low — so a higher default keeps
  // rapid project switching warm without unbounded memory growth. The tiers
  // scale with RAM so capable machines keep a realistic rotation hot: a cold
  // start reloads a renderer (~100–500 MB) and reads as a multi-hundred-ms
  // pause, whereas a cached "warm swap" reveals in ~60 ms, so every extra warm
  // view converts a cold switch into an instant one. Capped at the cache
  // ceiling (5) honored by isValidCachedProjectViews / setCachedViewLimit.
  // Shared so the settings page can mark a stored value that differs from the
  // hardware default without a round trip.
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return 2;
  if (totalMemBytes >= 64 * GIB) return 5;
  if (totalMemBytes >= 32 * GIB) return 4;
  if (totalMemBytes >= 16 * GIB) return 3;
  return 2;
}
