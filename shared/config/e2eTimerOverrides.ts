// E2E-only overrides for product timers that a spec would otherwise have to
// sleep through. Callers gate on a literal `process.env.DAINTREE_E2E_MODE ===
// "1"` written inline (not behind a helper), so a production build — which
// defines DAINTREE_E2E_MODE as "" — constant-folds the gate and drops the
// override read entirely. This module only validates the raw value.

const MIN_OVERRIDE_MS = 100;
const MAX_OVERRIDE_MS = 10 * 60_000;

/** Parse a positive integer millisecond override, or null when absent/invalid. */
export function parseE2ETimerOverrideMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < MIN_OVERRIDE_MS || value > MAX_OVERRIDE_MS) {
    return null;
  }
  return value;
}
