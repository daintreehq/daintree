import type { ToolbarButtonPriority, PluginToolbarButtonId } from "../types/toolbar.js";

/**
 * The popover a button opens, resolved by main to the runtime panel-kind id of
 * the view it names — a project plugin's kind is project-qualified, so the
 * renderer never rebuilds the id from the manifest's own.
 */
export interface ToolbarButtonPopoverConfig {
  viewId: string;
  panelKindId: string;
}

export interface ToolbarButtonConfig {
  id: PluginToolbarButtonId;
  label: string;
  iconId: string;
  /** Dispatched on click. Exactly one of this and {@link popover} is set. */
  actionId?: string;
  /** Opened on click, in place of an action (#13784). */
  popover?: ToolbarButtonPopoverConfig;
  priority: ToolbarButtonPriority;
  pluginId: string;
  /** Visibility clause, evaluated live against the renderer's chrome context. */
  when?: string;
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
  // Plugin button ids use the canonical `{pluginId}.{btn}` namespace (#9281),
  // so registry membership alone is the discriminator — built-in ids never
  // appear in this registry. The pre-#9281 `plugin.` prefix check is gone.
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
