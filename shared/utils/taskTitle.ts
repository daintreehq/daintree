/**
 * Cosmetic cleanup for agent-emitted OSC task titles before display.
 *
 * Agents decorate their window titles with status glyphs: leading spinner
 * sets (Claude's `✳ ✻ ✶ …`, the braille spinners U+2800–U+28FF used by Codex
 * and Grok) and trailing state glyphs (Gemini's `✦/◇/✋`). Daintree renders
 * its own agent state indicators, so the glyph is noise — and it flips with
 * agent state, which would make composed tab titles churn. Strip glyph
 * clusters from both ends for display; the raw title stays in
 * `lastObservedTitle` and session history records.
 */
const STATUS_GLYPHS = "✢✳✶✻✽✼✾✦✧⟡◇◆○●★☆✋⏺∙∘◎◉⠀-⣿🌑-🌘";
// `· • *` are plausible trailing text ("document glob *"), so they only
// count as spinner noise in the leading position.
const LEADING_ONLY_GLYPHS = "·•*░█";
const LEADING_STATUS_GLYPHS = new RegExp(
  `^(?:[${LEADING_ONLY_GLYPHS}${STATUS_GLYPHS}]+\\s*)+`,
  "u"
);
const TRAILING_STATUS_GLYPHS = new RegExp(`(?:\\s*[${STATUS_GLYPHS}]+)+$`, "u");

export function cleanTaskTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(LEADING_STATUS_GLYPHS, "").replace(TRAILING_STATUS_GLYPHS, "").trim();
}

/**
 * Agents also decorate real task titles with identity affixes: Grok appends
 * `" - grok"` to every title, OpenCode prepends `"OC | "`. The segment
 * between separators is the unit — a leading or trailing segment the caller
 * classifies as noise is dropped, along with bare separator runs left at
 * either end (Grok's busy title is `"⣿ - Responding - grok"`). Interior
 * segments are never touched, so a real task like `"fix auth - update
 * tests"` survives even when a noise suffix is stripped after it.
 *
 * `isNoiseSegment` decides; callers must keep it strict (whole identity
 * labels, not token overlap) or leading segments of real tasks like
 * `"Terminal: preserve OSC title"` get eaten.
 */
const AFFIX_SEPARATORS = "-–—|·:";
const LEADING_AFFIX = new RegExp(`^([^${AFFIX_SEPARATORS}]{1,60}?)\\s*[${AFFIX_SEPARATORS}]+\\s+`);
const TRAILING_AFFIX = new RegExp(`\\s+[${AFFIX_SEPARATORS}]+\\s*([^${AFFIX_SEPARATORS}]{1,60})$`);
const BARE_LEADING_SEPARATORS = new RegExp(`^(?:[${AFFIX_SEPARATORS}]+\\s+)+`);
const BARE_TRAILING_SEPARATORS = new RegExp(`(?:\\s+[${AFFIX_SEPARATORS}]+)+$`);

export function stripIdentityAffixes(
  task: string,
  isNoiseSegment: (segment: string) => boolean
): string {
  let out = task;
  for (;;) {
    out = out.replace(BARE_LEADING_SEPARATORS, "").replace(BARE_TRAILING_SEPARATORS, "").trim();
    const leading = out.match(LEADING_AFFIX);
    if (leading?.[1] !== undefined && isNoiseSegment(leading[1])) {
      out = out.slice(leading[0].length);
      continue;
    }
    const trailing = out.match(TRAILING_AFFIX);
    if (
      trailing?.[1] !== undefined &&
      trailing.index !== undefined &&
      isNoiseSegment(trailing[1])
    ) {
      out = out.slice(0, trailing.index);
      continue;
    }
    return out;
  }
}
