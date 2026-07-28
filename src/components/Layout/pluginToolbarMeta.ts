import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import { resolvePluginIcon } from "@/components/icons/pluginIconRegistry";
import type { ToolbarButtonMetadata } from "./toolbarButtonMetadata";

/**
 * Display metadata for plugin-contributed toolbar buttons, derived from the
 * manifest rather than hardcoded. Shared by the toolbar's overflow menu and the
 * toolbar settings tab so a button looks the same everywhere it appears; an
 * `iconId` outside the shared registry resolves to the generic plugin glyph.
 */
export function buildPluginToolbarMeta(
  buttonIds: readonly string[],
  configs: { get(id: string): ToolbarButtonConfig | undefined }
): Record<string, ToolbarButtonMetadata> {
  const meta: Record<string, ToolbarButtonMetadata> = {};
  for (const id of buttonIds) {
    const config = configs.get(id);
    if (!config) continue;
    meta[id] = {
      label: config.label,
      icon: resolvePluginIcon(config.iconId),
      description: `Plugin button (${config.pluginId})`,
    };
  }
  return meta;
}
