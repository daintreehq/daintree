import {
  PLUGIN_CATEGORY_IDS,
  type PluginCategoryId,
  type PluginManifest,
} from "../types/plugin.js";

export interface PluginCategoryMeta {
  id: PluginCategoryId;
  /** Section header / chip label. Sentence case per UI microcopy rules. */
  label: string;
  /** One-line blurb under the category header in the catalog pane. */
  blurb: string;
}

/**
 * Catalog category metadata in render order. The plugin manager groups its
 * master list and catalog cards by these; `other` is the terminal fallback and
 * always sorts last. Keep this list small — a category should only exist once
 * it can plausibly hold multiple plugins (orphan one-item groups read as
 * over-engineering, see the plugin-manager research run 2026-06-10).
 */
export const PLUGIN_CATEGORIES: readonly PluginCategoryMeta[] = [
  {
    id: "forge",
    label: "Forge providers",
    blurb: "Issues, pull requests, and CI from code hosts",
  },
  {
    id: "ai",
    label: "AI & agents",
    blurb: "Agent integrations, context tools, and MCP servers",
  },
  {
    id: "workspace",
    label: "Workspace",
    blurb: "Panels, notes, and tools that live in your workspace",
  },
  {
    id: "other",
    label: "Other",
    blurb: "Commands, decorations, and everything else",
  },
];

const CATEGORY_ID_SET: ReadonlySet<string> = new Set(PLUGIN_CATEGORY_IDS);

export function isPluginCategoryId(value: unknown): value is PluginCategoryId {
  return typeof value === "string" && CATEGORY_ID_SET.has(value);
}

export function getPluginCategoryMeta(id: PluginCategoryId): PluginCategoryMeta {
  // PLUGIN_CATEGORIES covers every id; the fallback only guards a registry edit
  // that forgets to add the meta entry alongside a new id.
  return (
    PLUGIN_CATEGORIES.find((c) => c.id === id) ?? PLUGIN_CATEGORIES[PLUGIN_CATEGORIES.length - 1]!
  );
}

/**
 * Effective catalog category for a manifest: the declared `category` when
 * present, else derived from what the plugin actually contributes. Declaration
 * wins because derivation misclassifies multi-contribution plugins (the GitHub
 * plugin contributes file decorations as well as a forge provider). The
 * derivation order checks the most identity-defining contribution first.
 */
export function resolvePluginCategory(manifest: PluginManifest): PluginCategoryId {
  if (isPluginCategoryId(manifest.category)) return manifest.category;
  const c = manifest.contributes;
  if (c.forgeProviders.length > 0) return "forge";
  if (c.agents.length > 0 || c.mcpServers.length > 0 || c.skills.length > 0) return "ai";
  if (c.panels.length > 0 || c.views.length > 0) return "workspace";
  return "other";
}
