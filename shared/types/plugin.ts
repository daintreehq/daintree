// SDK BOUNDARY: New imports from ./forge.js must be classified in
// shared/types/plugin-sdk.ts. See docs/plugins/architecture.md#sdk-surface.
// eslint-disable-next-line no-restricted-imports -- existing forge imports are classified; the lint guard covers new additions
import type {
  FileDecorationContribution,
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderContribution,
  ForgeProviderDescriptor,
  ForgeProviderImpl,
  NormalizedPRState,
  ResourceRef,
} from "./forge.js";
import type { NotificationType } from "./notification.js";

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
export type ContextMenuLocation = "worktree" | "terminal" | "panel" | "file";

export const BUILT_IN_PLUGIN_CAPABILITIES = [
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

export type BuiltInPluginCapability = (typeof BUILT_IN_PLUGIN_CAPABILITIES)[number];

export type PluginCapability = BuiltInPluginCapability;

export interface MenuItemContribution {
  label: string;
  actionId: string;
  location: MenuItemLocation;
  accelerator?: string;
  when?: string;
}

export interface KeybindingContribution {
  actionId: string;
  combo: string;
  when?: string;
}

export interface ContextMenuContribution {
  actionId: string;
  location: ContextMenuLocation;
  label: string;
  when?: string;
}

/**
 * Reserved contribution point — validated by the manifest schema but ignored
 * at load time with a "not yet implemented" warning. The `experimental_`
 * prefix signals that the shape may change before the feature ships.
 * See `docs/plugins/architecture.md` for the renderer host design.
 */
export type ViewLocation = "panel" | "sidebar";

export interface ViewContribution {
  id: string;
  name: string;
  componentPath: string;
  location: ViewLocation;
  iconId?: string;
  description?: string;
}

/**
 * Reserved contribution point — validated by the manifest schema but ignored
 * at load time with a "not yet implemented" warning. Shape intentionally
 * mirrors the Claude Desktop / Cursor MCP server config format (stdio only;
 * remote servers via `url` are out of scope and deliberately excluded).
 */
export interface McpServerContribution {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
  capabilities?: PluginCapability[];
  activationEvents?: "onStartupFinished"[];
  contributes: {
    panels: PanelContribution[];
    toolbarButtons: ToolbarButtonContribution[];
    menuItems: MenuItemContribution[];
    keybindings: KeybindingContribution[];
    contextMenus: ContextMenuContribution[];
    experimental_views: ViewContribution[];
    experimental_mcpServers: McpServerContribution[];
    forgeProviders: ForgeProviderContribution[];
    fileDecorationProviders: FileDecorationContribution[];
  };
}

export type PluginInstallSource = "builtin" | "sideload" | "url" | "catalog";

export interface PluginLoadError {
  message: string;
  stack?: string;
  at: number;
}

export interface PluginUpdateAvailable {
  version: string;
  channel: "manual";
}

/**
 * Persisted provenance record for a non-builtin plugin. Keyed by
 * `manifest.name` in `plugins.installed`. Runtime fields (`manifest`, `dir`,
 * `loadedAt`, `isBuiltin`) are reconstructed at load time and not stored here.
 */
export interface InstalledPluginRecord {
  source: PluginInstallSource;
  installedAt: number;
  archiveHash: string | null;
  originalUrl: string | null;
  disabled: boolean;
  updateAvailable: PluginUpdateAvailable | null;
  devMode: boolean;
  loadError: PluginLoadError | null;
}

export interface LoadedPluginInfo {
  manifest: PluginManifest;
  dir: string;
  loadedAt: number;
  /**
   * True for plugins loaded from the app-bundled `plugins/builtin/` directory.
   * Built-ins skip the install-time capability disclosure dialog and cannot be
   * uninstalled — they can only be disabled (effect on next startup).
   * Determined by load path, never declared in the manifest.
   */
  isBuiltin: boolean;
  /** How the plugin was installed. Built-ins always return `"builtin"`. */
  source: PluginInstallSource;
  /** When the plugin was first installed (record created). `0` for builtins. */
  installedAt: number;
  /** SHA-256 of the `.dntr` archive at install time. `null` for builtins and dev-mode dir loads. */
  archiveHash: string | null;
  /** Original install URL. `null` for builtins and sideloads. Never logged to console. */
  originalUrl: string | null;
  /** Most recent activation error, or `null` if the last load succeeded. */
  loadError: PluginLoadError | null;
  /** Per-plugin disable state for non-builtins. Builtins use `disabledBuiltins` instead. */
  disabled: boolean;
  /** Set by the update-check job (F25). Reserved slot — `null` until F25 lands. */
  updateAvailable: PluginUpdateAvailable | null;
  /** Loaded from a directory outside the managed plugins dir (e.g. via `daintree-plugin` CLI dev command). */
  devMode: boolean;
  /**
   * True when the desired state (`disabled`) diverges from what's actually
   * running this session — i.e. the user toggled the plugin but the change
   * (load or unload) only takes effect on next launch. Drives the
   * "Restart required" cue. Recomputed on every `listPlugins()` call, so it
   * survives a Preferences-tab remount.
   */
  pendingRestart?: boolean;
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
 * Provider-agnostic projection of a worktree's linked forge resources (issue
 * and/or PR), exposed on {@link PluginWorktreeSnapshot.linked}. Replaces the
 * GitHub-shaped flat fields that previously leaked onto the snapshot —
 * plugins consuming linkage now route through a provider id and the shared
 * {@link ResourceRef} shape.
 */
export interface PluginWorktreeLinkedIssue {
  readonly ref: ResourceRef;
  readonly title?: string;
}

export interface PluginWorktreeLinkedPR {
  readonly ref: ResourceRef;
  readonly title?: string;
  readonly url: string;
  readonly state: NormalizedPRState;
  readonly ciStatus?: import("./forge.js").CIStatus;
  /** Branch this PR merges into (e.g. "develop"). Drives base-branch divergence display. */
  readonly baseRef?: string;
}

export interface PluginWorktreeLinked {
  readonly providerId: string;
  readonly issue?: PluginWorktreeLinkedIssue;
  readonly pr?: PluginWorktreeLinkedPR;
}

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
  /**
   * Provider-agnostic projection of the worktree's linked forge resources
   * (issue and/or PR), or `null` when no resource is linked. Replaces the
   * removed GitHub-shaped `issueNumber` / `issueTitle` / `prNumber` / `prUrl`
   * / `prState` / `prTitle` fields.
   */
  readonly linked: PluginWorktreeLinked | null;
  readonly mood?: "stable" | "active" | "stale" | "error";
  readonly lastActivityTimestamp?: number | null;
  readonly createdAt?: number;
}

/**
 * Options for {@link PluginHostApi.showToast}. Intentionally narrower than the
 * app's internal `notify()` surface: plugins cannot set `priority` (a
 * `priority:"low"` + `type:"error"` toast silently drops — see the lint rule at
 * `eslint.config.js`), pass a `ReactNode` message, or attach an action button
 * (plugins have no IPC channel to wire one to). `message` is namespaced with the
 * plugin's id (`{pluginId}: {message}`) by the host for provenance.
 */
export interface PluginToastOptions {
  /** Toast body. String only across the IPC boundary — no `ReactNode`. */
  message: string;
  /** Maps directly to the app's `NotificationType`. Defaults to `"info"`. */
  type?: NotificationType;
  /** Auto-dismiss delay in milliseconds. Defaults to the app's per-type default. */
  durationMs?: number;
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
  /**
   * Bind a runtime {@link ForgeProviderImpl} to the descriptor declared in
   * `contributes.forgeProviders`. The descriptor's `id` is namespaced to the
   * plugin at runtime as `{pluginId}.{descriptor.id}`. Returns a disposer that
   * unbinds the single implementation; all bindings are automatically removed
   * when the plugin is unloaded. Must be called during `activate()` — the
   * host is revoked once activation resolves or times out.
   *
   * The `descriptor.id` must match an entry declared in
   * `contributes.forgeProviders`; an undeclared id is rejected so the impl
   * cannot drift away from the manifest-driven routing table. Calling this
   * method twice with the same `descriptor.id` overwrites the prior binding;
   * the older disposer becomes inert and will not remove the newer impl when
   * later invoked.
   */
  registerForgeProvider(descriptor: ForgeProviderDescriptor, impl: ForgeProviderImpl): () => void;
  /**
   * Bind a runtime {@link FileDecorationProviderImpl} to a descriptor declared
   * in `contributes.fileDecorationProviders`. The descriptor's `id` is
   * namespaced at runtime as `{pluginId}.{descriptor.id}` and must match an
   * entry in the manifest — an undeclared id is rejected so the impl cannot
   * drift away from the manifest-driven scope-routing table. Returns a
   * disposer that unbinds the single implementation; all bindings are
   * automatically removed when the plugin is unloaded. Must be called during
   * `activate()` — the host is revoked once activation resolves or times out.
   * Calling this twice with the same `descriptor.id` overwrites the prior
   * binding; the older disposer becomes inert.
   */
  registerFileDecorationProvider(
    descriptor: FileDecorationProviderDescriptor,
    impl: FileDecorationProviderImpl
  ): () => void;
  /**
   * Signal that decorations for `scope` (optionally narrowed to `paths`) have
   * changed and any renderer showing them should re-pull. Unlike the
   * `register*` methods this is NOT revoke-guarded: it is called from the
   * plugin's own subscription callbacks (worktree changes, polling timers)
   * which fire long after `activate()` resolves, and must remain callable for
   * the plugin's whole lifetime. It becomes a silent no-op once the plugin is
   * unloaded.
   */
  invalidateFileDecorations(scope: string, paths?: string[]): void;
  /**
   * Surface a toast notification. The host namespaces the message as
   * `{pluginId}: {message}` for provenance — a plugin cannot spoof another
   * plugin's id since `pluginId` is bound to the host at activation. Routes
   * through the app's `notify()` path so rate-limit, quiet-hours, and
   * inbox-history semantics apply identically to plugin toasts.
   *
   * Like {@link invalidateFileDecorations} this is NOT revoke-guarded: plugins
   * call it from post-activation subscription callbacks and timers. It becomes
   * a silent no-op once the plugin is unloaded. Invalid options (empty message,
   * unknown `type`) reject so authoring mistakes surface loudly.
   */
  showToast(options: PluginToastOptions): Promise<void>;
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
  /**
   * Host-authoritative danger classification, computed in the main process by
   * {@link PluginService.registerPluginAction} from the plugin's declared
   * manifest capabilities. The plugin's self-reported `danger` is advisory
   * only — the host raises it (never lowers it) when the plugin holds a
   * high-risk capability, so a plugin cannot self-declare `"safe"` on a
   * destructive action to bypass MRU exclusion, repeatLast eligibility, and
   * the user-source confirm dialog. The renderer must read this field — not
   * `danger` — for any classification decision, and fail safe to `"confirm"`
   * if it is absent (e.g. a stale descriptor from a pre-migration cache).
   */
  effectiveDanger: "safe" | "confirm";
}
