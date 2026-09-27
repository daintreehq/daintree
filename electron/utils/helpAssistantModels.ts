import { hasShellMetachar } from "../../shared/utils/shellEscape.js";

// A model ID is a single CLI token (e.g. "claude-sonnet-4-6"); cap well above
// any realistic ID so a corrupted store value can't bloat the launch command.
const MODEL_ID_MAX_LEN = 200;
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

// A valid model ID is a single shell-safe token. `null` means "the agent's
// recommended model" and the empty string means "use the CLI default" (no
// `--model` injected). Anything with internal
// whitespace, control characters, a leading `-` (would inject a bare flag), or
// shell metacharacters is rejected outright rather than coerced — the picker
// only ever emits clean IDs, so a dirty value is corruption, not a near-miss to
// salvage. Whitespace/control chars are checked, not stripped, so a tab or
// newline can't be silently collapsed into a bogus token.
export function sanitizeModelId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return "";
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  if (trimmed.startsWith("-")) return undefined;
  if (hasShellMetachar(trimmed)) return undefined;
  return trimmed.slice(0, MODEL_ID_MAX_LEN);
}

export function isSafeAgentKey(key: string): boolean {
  return AGENT_ID_PATTERN.test(key) && !RESERVED_KEYS.has(key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A stored per-agent model map with every unsafe key and invalid entry dropped.
 * Stored maps never hold `null` — an absent entry is the recommended model.
 * Returns `undefined` when the value isn't a map at all.
 */
export function sanitizeModelIdMap(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isSafeAgentKey(key)) continue;
    const sanitized = sanitizeModelId(raw);
    if (typeof sanitized === "string") out[key] = sanitized;
  }
  return out;
}

/**
 * Applies a per-agent patch to a stored map: a string sets that agent's
 * entry, `null` removes it, and agents the patch doesn't name are untouched.
 * Invalid entries are skipped so a bad value can't clobber a good one.
 * Returns `undefined` when the patch changes nothing, so there's nothing to write.
 */
export function applyModelIdPatch(
  current: Record<string, string>,
  patch: unknown
): Record<string, string> | undefined {
  if (!isPlainRecord(patch)) return undefined;
  const next: Record<string, string> = { ...current };
  let changed = false;
  for (const [key, raw] of Object.entries(patch)) {
    if (!isSafeAgentKey(key)) continue;
    const sanitized = sanitizeModelId(raw);
    if (sanitized === undefined) continue;
    const had = Object.prototype.hasOwnProperty.call(next, key);
    if (sanitized === null) {
      if (!had) continue;
      delete next[key];
    } else {
      if (had && next[key] === sanitized) continue;
      next[key] = sanitized;
    }
    changed = true;
  }
  return changed ? next : undefined;
}
