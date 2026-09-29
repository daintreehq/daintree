/**
 * Token counts, rounded: "842", "4.2k", "45k", "1.2M". Thresholds are picked
 * off the *rounded* value so it can never print "1000k", and the one-decimal
 * form stops before it would round up to two digits. Upper-case M, matching
 * the SI-style "k"/"M" every model vendor prints beside a context window.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 999_500) {
    const thousands = tokens / 1000;
    return thousands < 9.95 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
