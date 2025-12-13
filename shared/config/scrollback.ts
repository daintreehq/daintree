export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 10000;
export const SCROLLBACK_DEFAULT = 1000;

export function normalizeScrollbackLines(value: unknown): number {
  const coerced =
    typeof value === "string" && value.trim() !== "" ? Number(value) : (value as number);

  if (!Number.isFinite(coerced)) {
    return SCROLLBACK_DEFAULT;
  }

  const intValue = Math.trunc(coerced);

  if (intValue === -1 || intValue === 0) {
    return SCROLLBACK_MAX;
  }

  if (intValue < SCROLLBACK_MIN) {
    return SCROLLBACK_MIN;
  }

  if (intValue > SCROLLBACK_MAX) {
    return SCROLLBACK_MAX;
  }

  return intValue;
}
