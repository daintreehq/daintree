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
] as const;

export type BuiltInPluginPermission = (typeof BUILT_IN_PLUGIN_PERMISSIONS)[number];

export type PluginPermission = BuiltInPluginPermission;

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

/**
 * Read-only, deep-frozen projection of a worktree exposed to plugins.
 * This is an explicit allowlist of fields from the internal WorktreeSnapshot;
 * do not add fields by spreading — every field must be intentionally exposed
 * so internal shape changes don't leak to third-party plugins.
 */
export interface PluginWorktreeSnapshot {
  readonly id: string;
  readonly worktreeId: string;
  readonly path: string;
  readonly name: string;
  readonly isCurrent: boolean;
  readonly branch?: string;
  readonly isMainWorktree?: boolean;
  readonly aheadCount?: number;
  readonly behindCount?: number;
  readonly issueNumber?: number;
  readonly issueTitle?: string;
  readonly prNumber?: number;
  readonly prUrl?: string;
  readonly prState?: "open" | "merged" | "closed";
  readonly prTitle?: string;
  readonly mood?: "stable" | "active" | "stale" | "error";
  readonly lastActivityTimestamp?: number | null;
  readonly createdAt?: number;
}

export interface PluginHostApi {
  readonly pluginId: string;
  registerHandler(channel: string, handler: PluginIpcHandler): void;
  broadcastToRenderer(channel: string, payload: unknown): void;
  /**
   * Returns the currently-active worktree (`isCurrent === true`) across all
   * projects as a frozen snapshot, or `null` if none is active. In multi-project
   * sessions this returns the first match; plugins needing per-project scoping
   * should filter from `getWorktrees()`.
   */
  getActiveWorktree(): Promise<PluginWorktreeSnapshot | null>;
  /** Returns all worktrees across all loaded projects as frozen snapshots. */
  getWorktrees(): Promise<PluginWorktreeSnapshot[]>;
  /**
   * Subscribe to active-worktree changes. The callback fires with the new
   * active snapshot (or `null` when none is active). Returns a disposer;
   * calling it more than once is a no-op. All subscriptions are automatically
   * disposed when the plugin is unloaded.
   */
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void
  ): () => void;
  /**
   * Subscribe to the worktree set changing. The callback fires with the full
   * current list on any worktree add/update/remove. Returns a disposer;
   * calling it more than once is a no-op. All subscriptions are automatically
   * disposed when the plugin is unloaded.
   */
  onDidChangeWorktrees(callback: (snapshots: PluginWorktreeSnapshot[]) => void): () => void;
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
