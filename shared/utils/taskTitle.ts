/**
 * Cosmetic cleanup for agent-emitted OSC task titles before display.
 *
 * Agents prefix their window titles with status glyphs (Claude's spinner set
 * `✳ ✻ ✶ …`, Gemini's `✦/◇/✋` state glyphs). Daintree renders its own agent
 * state indicators, so the glyph is noise — and for Gemini it flips with
 * agent state, which would make composed tab titles churn. Strip leading
 * glyph clusters for display; the raw title stays in `lastObservedTitle` and
 * session history records.
 */
const LEADING_STATUS_GLYPHS = /^(?:[·•*✢✳✶✻✽✼✾✦✧⟡◇◆○●★☆✋⏺]+\s*)+/u;

export function cleanTaskTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(LEADING_STATUS_GLYPHS, "").trim();
}
