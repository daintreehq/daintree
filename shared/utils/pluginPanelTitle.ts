import { PANEL_VIEW_TITLE_MAX } from "../types/plugin.js";

/**
 * Vet a title a plugin view set through `PanelViewProps.setTitle`. It arrives
 * as plugin code wrote it, so it is held to one line a tab can draw: control
 * characters become spaces, whitespace runs collapse, and the result is cut at
 * {@link PANEL_VIEW_TITLE_MAX}.
 *
 * @returns The title, `""` for `null` or a blank title (back to the kind's
 * name), or `null` for a value that is not a title at all, which the host
 * ignores.
 */
export function normalizePluginPanelTitle(value: unknown): string | null {
  if (value === null) return "";
  if (typeof value !== "string") return null;
  let line = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    line += isControl ? " " : value[i];
  }
  return line.replace(/\s+/g, " ").trim().slice(0, PANEL_VIEW_TITLE_MAX).trimEnd();
}
