import type { PanelKindOrigin } from "@shared/config/panelKindRegistry";

/**
 * How each origin tier is named to the user, in the launcher, the launcher's
 * context menu and the panel palette.
 *
 * Built-in is deliberately `undefined`. It is the launcher's default and the
 * overwhelming majority of rows, and the plugin manager already settled the
 * rule this follows: provenance only earns a marker when it differs from the
 * default (`PluginManagerView.tsx`). Tagging five rows "Built-in" to explain
 * one is the trade that rule exists to refuse.
 *
 * Both plugin tiers are marked. "Plugin" alone answers where the kind came
 * from; "Project plugin" also answers how long it will be there, borrowing the
 * plugin manager's own `Project` scope word (`ProjectPluginSection.tsx`) so the
 * two surfaces name the same thing the same way.
 */
export const PANEL_KIND_ORIGIN_LABELS: Record<PanelKindOrigin, string | undefined> = {
  builtin: undefined,
  plugin: "Plugin",
  "project-plugin": "Project plugin",
};
