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

export const BUILT_IN_PLUGIN_PERMISSIONS = [
  "fs:project-read",
  "fs:project-write",
  "fs:user-data-read",
  "fs:user-data-write",
  "network:fetch",
  "agent:invoke",
  "agent:read",
  "git:read",
  "git:write",
  "clipboard:read",
  "clipboard:write",
  "shell:exec",
  "notes:read",
  "notes:write",
] as const;

export type BuiltInPluginPermission = (typeof BUILT_IN_PLUGIN_PERMISSIONS)[number];

export type PluginPermission = BuiltInPluginPermission | (string & {});

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
  /**
   * @deprecated Use main instead. Renderer entry points are no longer supported.
   */
  renderer?: string;
  engines?: {
    daintree?: string;
  };
  permissions?: PluginPermission[];
  contributes: {
    panels: PanelContribution[];
    toolbarButtons: ToolbarButtonContribution[];
    menuItems: MenuItemContribution[];
  };
}

export interface LoadedPluginInfo {
  manifest: PluginManifest;
  dir: string;
  loadedAt: number;
}

export interface PluginIpcContext {
  projectId: string | null;
  worktreeId: string | null;
  webContentsId: number;
  pluginId: string;
}

export type PluginIpcHandler = (
  ctx: PluginIpcContext,
  ...args: unknown[]
) => unknown | Promise<unknown>;

export interface PluginHostApi {
  readonly pluginId: string;
  registerHandler(channel: string, handler: PluginIpcHandler): void;
  broadcastToRenderer(channel: string, payload: unknown): void;
}

export type PluginActivate = (
  host: PluginHostApi
) => void | (() => void) | Promise<void | (() => void)>;

/**
 * Serializable shape a plugin uses to register an action at runtime via the
 * host API. The renderer converts this into a synthetic ActionDefinition
 * whose run() dispatches back into main via plugin:invoke. Action handlers
 * themselves live in main and cannot cross the IPC boundary, so only
 * metadata travels here. `danger: "restricted"` is rejected server-side
 * — plugins cannot register restricted-danger actions.
 */
export interface PluginActionContribution {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: "command" | "query";
  danger: "safe" | "confirm";
  keywords?: string[];
  inputSchema?: Record<string, unknown>;
}

export interface PluginActionDescriptor extends PluginActionContribution {
  pluginId: string;
}
