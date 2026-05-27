import type { ToolbarButtonPriority, PluginToolbarButtonId } from "../types/toolbar.js";

export interface ToolbarButtonConfig {
  id: PluginToolbarButtonId;
  label: string;
  iconId: string;
  actionId: string;
  priority: ToolbarButtonPriority;
  pluginId: string;
}

const TOOLBAR_BUTTON_REGISTRY: Record<string, ToolbarButtonConfig> = {};

export function registerToolbarButton(config: ToolbarButtonConfig): void {
  if (TOOLBAR_BUTTON_REGISTRY[config.id]) {
    console.warn(`Toolbar button "${config.id}" already registered, overwriting`);
  }
  TOOLBAR_BUTTON_REGISTRY[config.id] = config;
}

export function getToolbarButtonConfig(id: string): ToolbarButtonConfig | undefined {
  return TOOLBAR_BUTTON_REGISTRY[id];
}

export function getPluginToolbarButtonIds(): PluginToolbarButtonId[] {
  return Object.keys(TOOLBAR_BUTTON_REGISTRY) as PluginToolbarButtonId[];
}

export function getAllPluginToolbarButtonConfigs(): ToolbarButtonConfig[] {
  return Object.values(TOOLBAR_BUTTON_REGISTRY);
}

export function isRegisteredPluginButton(id: string): boolean {
  // Every entry in the registry is a plugin-contributed button by definition,
  // so registry membership is the sole discriminator now that button ids no
  // longer carry a `plugin.` prefix.
  return id in TOOLBAR_BUTTON_REGISTRY;
}

export function unregisterPluginToolbarButtons(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  for (const [key, config] of Object.entries(TOOLBAR_BUTTON_REGISTRY)) {
    if (config.pluginId === pluginId) {
      delete TOOLBAR_BUTTON_REGISTRY[key];
    }
  }
}

export function clearToolbarButtonRegistry(): void {
  for (const key of Object.keys(TOOLBAR_BUTTON_REGISTRY)) {
    delete TOOLBAR_BUTTON_REGISTRY[key];
  }
}
