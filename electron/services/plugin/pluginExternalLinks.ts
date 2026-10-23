/** How often one plugin may open links in the user's browser. */
export const PLUGIN_EXTERNAL_LINK_BURST = 3;
export const PLUGIN_EXTERNAL_LINK_REFILL_MS = 10_000;

// Keyed by the plugin's id and never cleared on unload, so a plugin that
// restarts its own worker comes back to the budget it left.
const buckets = new Map<string, { tokens: number; at: number }>();

function refilled(bucket: { tokens: number; at: number }, now: number): number {
  const elapsed = Math.max(0, now - bucket.at);
  return Math.min(
    PLUGIN_EXTERNAL_LINK_BURST,
    bucket.tokens + elapsed / PLUGIN_EXTERNAL_LINK_REFILL_MS
  );
}

/** Whether `pluginId` may open a link now; spends a token when it may. */
export function admitPluginExternalLink(pluginId: string, now = performance.now()): boolean {
  for (const [id, bucket] of buckets) {
    if (id !== pluginId && refilled(bucket, now) >= PLUGIN_EXTERNAL_LINK_BURST) buckets.delete(id);
  }
  const bucket = buckets.get(pluginId) ?? { tokens: PLUGIN_EXTERNAL_LINK_BURST, at: now };
  bucket.tokens = refilled(bucket, now);
  // Never wound back, or an earlier `now` would count the same stretch twice.
  bucket.at = Math.max(bucket.at, now);
  buckets.set(pluginId, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Forget every plugin's recent opens (tests). */
export function resetPluginExternalLinkBudget(): void {
  buckets.clear();
}
