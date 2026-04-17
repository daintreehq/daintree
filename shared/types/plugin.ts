export interface PanelContribution {
  id: string;
  name: string;
  iconId: string;
  color: string;
  hasPty: boolean;
  canRestart: boolean;
  canConvert: boolean;
  showInPalette: boolean;
}

export interface ToolbarButtonContribution {
  id: string;
  label: string;
  iconId: string;
  actionId: string;
  priority?: 1 | 2 | 3 | 4 | 5;
}

export type MenuItemLocation = "terminal" | "file" | "view" | "help";

export interface MenuItemContribution {
  label: string;
  actionId: string;
  location: MenuItemLocation;
  accelerator?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  main?: string;
  renderer?: string;
  engines?: {
    daintree?: string;
  };
  contributes: {
    panels: PanelContribution[];
    toolbarButtons: ToolbarButtonContribution[];
    menuItems: MenuItemContribution[];
  };
}

export interface LoadedPluginInfo {
  manifest: PluginManifest;
  dir: string;
  resolvedRenderer?: string;
  loadedAt: number;
}

export type PluginIpcHandler = (...args: unknown[]) => unknown | Promise<unknown>;
