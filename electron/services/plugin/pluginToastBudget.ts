/**
 * Toasts one plugin may raise through its host, `showToast` and `notify`
 * alike and whatever the tone, taken in main before the push so a plugin can
 * buy no more by switching tone or by reaching more windows (#13766). It sits
 * above each renderer's own per-plugin gate (a burst of three, then one every
 * ten seconds) rather than mirroring it, so that gate still folds an overflow
 * into its inbox summary and a replacement still lands in its inbox row;
 * this one only bounds what crosses IPC.
 */
export const PLUGIN_TOAST_BURST = 6;
export const PLUGIN_TOAST_REFILL_MS = 1_000;

// Keyed by the plugin's id and never cleared on unload, so a plugin that
// restarts its own worker comes back to the budget it left.
const buckets = new Map<string, { tokens: number; at: number }>();

function refilled(bucket: { tokens: number; at: number }, now: number): number {
  // A clock that went backwards refills nothing rather than draining.
  const elapsed = Math.max(0, now - bucket.at);
  return Math.min(PLUGIN_TOAST_BURST, bucket.tokens + elapsed / PLUGIN_TOAST_REFILL_MS);
}

/** Whether `pluginId` may raise a toast now; spends a token when it may. */
export function admitPluginToast(pluginId: string, now = Date.now()): boolean {
  // A full bucket is the same as none, so idle plugins cost nothing.
  for (const [id, bucket] of buckets) {
    if (id !== pluginId && refilled(bucket, now) >= PLUGIN_TOAST_BURST) buckets.delete(id);
  }
  const bucket = buckets.get(pluginId) ?? { tokens: PLUGIN_TOAST_BURST, at: now };
  bucket.tokens = refilled(bucket, now);
  bucket.at = now;
  buckets.set(pluginId, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Forget every plugin's recent toasts (tests). */
export function resetPluginToastBudget(): void {
  buckets.clear();
}
