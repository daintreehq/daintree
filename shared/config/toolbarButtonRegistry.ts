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

export function isRegisteredPluginButton(id: string): boolean {
  return id.startsWith("plugin.") && id in TOOLBAR_BUTTON_REGISTRY;
}

export function clearToolbarButtonRegistry(): void {
  for (const key of Object.keys(TOOLBAR_BUTTON_REGISTRY)) {
    delete TOOLBAR_BUTTON_REGISTRY[key];
  }
}
