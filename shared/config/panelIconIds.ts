/**
 * Icon ids that render to a real glyph for a plugin-contributed panel or view.
 *
 * Panel icons are resolved by two renderers, neither of which does a dynamic
 * Lucide-by-name lookup: `src/components/PanelPalette/PanelKindIcon.tsx`
 * (`ICON_MAP`) for the palette, and `src/components/Terminal/TerminalIcon.tsx`
 * (hardcoded id conditionals) for panel headers/tabs. An `iconId` outside this
 * set silently falls back to the generic terminal icon — so the manifest schema
 * accepts any string, but a plugin author gets no warning that their chosen icon
 * won't show. This list is the union of both renderers' recognized ids and is
 * kept in `shared/` so the offline `daintree-plugin validate` CLI can advise on
 * it without importing renderer/React code.
 *
 * Advisory only: this is NOT wired into the Zod manifest schema as an enum.
 * Validation stays non-fatal because the renderer is the runtime authority and
 * a future panel-icon registry could broaden the set; a hard schema enum would
 * reject manifests the runtime could otherwise grow to honor.
 */
export const VALID_PANEL_ICON_IDS = [
  "terminal",
  "globe",
  "file-text",
  "git-branch",
  "monitor",
  "monitor-play",
  "sticky-note",
  "daintree",
  "puzzle",
  "git-pull-request",
] as const satisfies readonly string[];

export type ValidPanelIconId = (typeof VALID_PANEL_ICON_IDS)[number];

/** True when `id` renders to a real panel glyph (rather than the terminal fallback). */
export function isValidPanelIconId(id: string): boolean {
  return (VALID_PANEL_ICON_IDS as readonly string[]).includes(id);
}
