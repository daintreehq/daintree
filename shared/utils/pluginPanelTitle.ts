import { PANEL_VIEW_TITLE_MAX } from "../types/plugin.js";

/**
 * C0/C1 controls; the bidi embedding, override and isolate controls, which
 * would let a title reorder the text drawn after it in the tab strip; the
 * invisible spacers (zero-width space, word joiner, BOM), which would let a
 * title look blank without resetting; and a lone surrogate half. The zero-width
 * joiners stay: emoji sequences and several scripts need them.
 */
function isTitleControl(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200b ||
    (code >= 0x202a && code <= 0x202e) ||
    code === 0x2060 ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfeff
  );
}

/**
 * Vet a title a plugin view set through `PanelViewProps.setTitle`. It arrives
 * as plugin code wrote it, so it is held to one line a tab can draw: control and
 * invisible formatting characters become spaces, whitespace runs collapse, and
 * the result is cut at {@link PANEL_VIEW_TITLE_MAX} characters, never inside a
 * surrogate pair.
 *
 * @returns The title, `""` for `null` or a blank title (back to the kind's
 * name), or `null` for a value that is not a title at all, which the host
 * ignores.
 */
export function normalizePluginPanelTitle(value: unknown): string | null {
  if (value === null) return "";
  if (typeof value !== "string") return null;
  let line = "";
  for (const char of value) {
    line += isTitleControl(char.codePointAt(0) ?? 0) ? " " : char;
  }
  return Array.from(line.replace(/\s+/g, " ").trim())
    .slice(0, PANEL_VIEW_TITLE_MAX)
    .join("")
    .trimEnd();
}
