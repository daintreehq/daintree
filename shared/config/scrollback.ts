export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 10000;
export const SCROLLBACK_DEFAULT = 1000;
export const SCROLLBACK_BACKGROUND = 500;
// The most scrollback a plain-shell renderer can ever keep, whatever the base
// setting or project override. The pty-host mirror for a plain shell is sized
// to this so restore never has more to give than the renderer can hold.
export const PLAIN_SHELL_SCROLLBACK_MAX = 2000;

// Lines an agent terminal's pty-host headless mirror keeps (plain shells keep
// PLAIN_SHELL_SCROLLBACK_MAX until promoted). Restores (cold switch, view
// eviction, app restart, poisoned-terminal rebuild) replay from this mirror, so
// it is also the most history a renderer terminal can ever get back — the
// renderer's agent ceiling is pinned to it rather than sized independently.
export const PTY_MIRROR_SCROLLBACK = 5000;

export function normalizeScrollbackLines(value: unknown): number {
  const coerced =
    typeof value === "string" && value.trim() !== "" ? Number(value) : (value as number);

  if (!Number.isFinite(coerced)) {
    return SCROLLBACK_DEFAULT;
  }

  const intValue = Math.trunc(coerced);

  // Both -1 and 0 are "use max" sentinels: -1 is the explicit user intent for
  // "unlimited", and 0 is a backwards-compatible alias preserved because
  // earlier persisted configs may still contain it. xterm.js itself rejects 0
  // as a scrollback value, so we never pass either through unchanged.
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
