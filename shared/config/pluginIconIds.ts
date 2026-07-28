/**
 * The icon ids a plugin may name in `contributes.panels[].iconId` and
 * `contributes.toolbarButtons[].iconId`.
 *
 * This list is the single source of truth for *which* ids exist. The renderer
 * half — the id → component map — lives in
 * `src/components/icons/pluginIconRegistry.ts` and is typed against
 * {@link PluginIconId} so the two can't drift. The split is load-bearing:
 * `electron/` imports `shared/config/*` freely and `scripts/build-main.mjs`
 * bundles main with esbuild without externalizing `lucide-react`, so a React
 * component map here would pull React and Lucide into the main-process bundle.
 * Keep this module pure data with no imports.
 *
 * Advisory only: this is NOT wired into the Zod manifest schema as an enum. An
 * unrecognized id renders a fallback glyph rather than failing the load, so a
 * cosmetic mismatch never blocks an otherwise working plugin, and a manifest
 * written for a newer host degrades safely on an older one. The offline
 * `daintree-plugin validate` CLI warns about unrecognized ids instead.
 *
 * Plugin *agent* `iconId` is a different namespace — those resolve to bundled
 * brand marks via `AGENT_ICON_MAP`, not to any id here.
 */
export const PLUGIN_ICON_IDS = [
  "terminal",
  "package",
  "puzzle",
  "globe",
  "monitor",
  "monitor-play",
  "file-text",
  "file-diff",
  "folder-tree",
  "git-branch",
  "git-pull-request",
  "sticky-note",
  "gauge",
  "list",
  "sparkles",
  "layout-panel-top",
  "daintree",
] as const satisfies readonly string[];

export type PluginIconId = (typeof PLUGIN_ICON_IDS)[number];

/** True when `id` names a real glyph rather than falling back to a generic one. */
export function isPluginIconId(id: string): id is PluginIconId {
  return (PLUGIN_ICON_IDS as readonly string[]).includes(id);
}
