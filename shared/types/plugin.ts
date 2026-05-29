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
import type { ActionDispatchResult } from "./actions.js";
import type { z } from "zod";

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
  scope?: string;
  description?: string;
  when?: string;
}

export interface PluginKeybindingDescriptor {
  pluginId: string;
  item: KeybindingContribution;
}

export interface ContextMenuContribution {
  actionId: string;
  location: ContextMenuLocation;
  label: string;
  when?: string;
}

/**
 * View contribution location. Both values register a panel kind at plugin
 * load time; the difference is palette visibility. `panel` sets
 * `showInPalette: true` so the view is spawnable from the panel palette.
 * `sidebar` registers silently with `showInPalette: false`, reserving the
 * kind for the future sidebar host without surfacing it as a spawn target.
 * `location: "panel"` is wired today by the inline renderer host (#9229); see
 * `docs/plugins/architecture.md` for the renderer host design. The
 * `experimental_` prefix on the contribution point signals that the shape may
 * still change before the feature exits experiment status.
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
 * Props every plugin-contributed panel view receives from the renderer host.
 * Intentionally narrower than the host-internal `PanelComponentProps` so the
 * SDK surface stays stable across a future `plugin://` → trusted-iframe
 * cutover (#9229).
 *
 * - `panelId` is the runtime panel instance id (the same value the host uses
 *   in `addPanelOptions` / IPC). Plugins should treat it as opaque.
 * - `pluginId` is the plugin's manifest `name` — useful for namespacing
 *   plugin-local storage keys and for logging.
 * - `disposeSignal` aborts on unmount AND when the host receives a
 *   `plugin:panel-kinds-changed` push that no longer contains this kind. The
 *   broadcast fires before the main process tears down plugin IPC handlers,
 *   so signal-driven cleanup (fetch aborts, subscription teardown) runs
 *   while the plugin host APIs are still live.
 */
export interface PanelViewProps {
  readonly panelId: string;
  readonly pluginId: string;
  readonly disposeSignal: AbortSignal;
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

/**
 * Per-capability scope binding that attenuates the compound-capability lattice
 * elevation in `PluginService.validateAndBuildActionDescriptor`. The lattice
 * elevates `effectiveDanger` to `"confirm"` when a plugin pairs a sensitive
 * source (sensitive reads, or `network:fetch` as a remote control channel)
 * with a sink (`network:fetch`, local writes, `shell:exec`). Tightly-bound
 * sinks skip elevation — a plugin that proves its `network:fetch` only talks
 * to one explicit HTTPS API is not a generic exfiltration channel.
 *
 * Wildcards (`*`, `**`) are rejected at schema parse time so a tightly-bound
 * declaration cannot smuggle a permissive value past the manifest gate.
 * SSRF targets (loopback, link-local, RFC1918) and embedded credentials are
 * also rejected at parse time. See `electron/schemas/plugin.ts` for the
 * canonical validation rules.
 */
export interface PluginNetworkScope {
  /**
   * Allowlist of HTTPS URLs the plugin's `network:fetch` capability may talk
   * to. Each entry must parse as a `https:` URL with a multi-segment hostname,
   * no embedded credentials, no wildcards, and no private/loopback target.
   */
  allowedUrls: string[];
}

export interface PluginFsScope {
  /**
   * Allowlist of absolute filesystem paths the plugin's `fs:*` capabilities
   * may touch. Each entry must be an absolute path containing no `..` segment
   * and no `*`/`**` glob (literal-path allowlist only). Reserved for future
   * compound rules that attenuate fs sinks; the current lattice only consults
   * `scopes.network` for compound elevation.
   */
  allowedPaths: string[];
}

export interface PluginManifestScopes {
  network?: PluginNetworkScope;
  fs?: PluginFsScope;
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
  /**
   * Per-capability scope bindings that attenuate the compound-capability
   * lattice. See {@link PluginManifestScopes}. Absent on most plugins —
   * the lattice still elevates compound pairs without scopes, so this field
   * is opt-in only for plugins that need to skip elevation.
   */
  scopes?: PluginManifestScopes;
  activationEvents?: "onStartupFinished"[];
  contributes: {
    panels: PanelContribution[];
    toolbarButtons: ToolbarButtonContribution[];
    menuItems: MenuItemContribution[];
    keybindings: KeybindingContribution[];
    contextMenus: ContextMenuContribution[];
    /**
     * Manifest-declared commands. Each entry registers a {@link PluginActionDescriptor}
     * at load time (so the command appears in the palette before the plugin
     * activates) and is lazily bound to `src/{id}.{ts,tsx,js,mjs}` on first
     * dispatch. `id` is the bare command id — the host namespaces it as
     * `{pluginId}.{id}` to match the {@link PluginActionDescriptor.id} convention.
     */
    commands: PluginActionContribution[];
    experimental_views: ViewContribution[];
    experimental_mcpServers: McpServerContribution[];
    forgeProviders: ForgeProviderContribution[];
    fileDecorationProviders: FileDecorationContribution[];
    /**
     * Declared plugin settings. Reserved for F29 — absent from parsed manifests
     * until that schema lands, so `host.settings.set()` accepts any key for now.
     * When present, `set()` rejects keys not declared here.
     */
    settings?: SettingDefinition[];
  };
}

/**
 * Declaration for a single plugin setting. Reserved for `contributes.settings`
 * (F29), which owns the canonical schema (types, defaults, UI metadata). The
 * shape here is intentionally permissive — only `id` is load-bearing today, used
 * by {@link SettingsApi.set} key validation.
 */
export interface SettingDefinition {
  id: string;
  type?: "string" | "number" | "boolean" | "object";
  label?: string;
  description?: string;
  default?: unknown;
  /**
   * UI-only hint (F19): the Settings tab renders a "stored in plaintext"
   * warning for the field. Does NOT change storage mechanics — values are
   * always plaintext JSON regardless of this flag (#9167).
   */
  secret?: boolean;
}

export type PluginSettingsScope = "user" | "project";

/**
 * Persistent, plugin-scoped key/value settings exposed on
 * {@link PluginHostApi.settings}. Values are stored as plaintext JSON at
 * `~/.daintree/plugin-settings/{pluginId}.json` (user scope) or
 * `<projectRoot>/.daintree/plugin-settings/{pluginId}.json` (project scope),
 * with `chmod 0o600` applied on POSIX. There is deliberately no OS-keychain
 * integration (#9167) — do not store secrets that must survive disk compromise.
 *
 * `scope` defaults to `"user"`. Project scope resolves the active project at
 * call time, so it tracks project switches: `get` returns `undefined` and `set`
 * throws when no project is active.
 */
export interface SettingsApi {
  /**
   * Read a setting. Resolves to `undefined` when the key is unset, or (for
   * `"project"` scope) when no project is active.
   */
  get<T = unknown>(key: string, scope?: PluginSettingsScope): Promise<T | undefined>;
  /**
   * Persist a setting. Rejects `undefined` and non-JSON-serializable values.
   * For `"project"` scope with no active project, throws. When the manifest
   * declares `contributes.settings`, an undeclared key is rejected.
   */
  set<T = unknown>(key: string, value: T, scope?: PluginSettingsScope): Promise<void>;
  /**
   * Subscribe to in-process writes of `key` in `scope` (default `"user"`). The
   * callback fires with the new value after each `set` that changes it. Edits
   * made to the JSON file by other processes do NOT fire until the plugin
   * reloads. Must be called during `activate()`. Returns a disposer; calling it
   * more than once is a no-op. All subscriptions are automatically disposed when
   * the plugin is unloaded.
   */
  onDidChange<T = unknown>(
    key: string,
    callback: (value: T | undefined) => void,
    scope?: PluginSettingsScope
  ): () => void;
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

/**
 * Discriminated failure code for {@link PluginInstallResult}. Each value maps
 * to a distinct failure branch in `PluginService.installPlugin` so the install
 * dialog (F22a/b/F23/F24) can render a tailored message instead of a raw
 * stringified error.
 *
 * - `lock_failed` — couldn't acquire the cross-process `install.lock`
 * - `archive_invalid` — `.dntr` extraction failed (bad zip, path traversal, oversize)
 * - `manifest_invalid` — `plugin.json` failed the strict Zod schema
 * - `engine_incompatible` — `engines.daintree` range doesn't satisfy the running version
 * - `namespace_unauthorized` — reserved `daintree.*` name or publisher/name disagreement
 * - `hash_failed` — couldn't compute the archive SHA-256
 * - `unload_failed` — the existing plugin's disposer cascade threw
 * - `swap_failed` — atomic rename failed but the prior state was restored
 * - `swap_unrecoverable` — rename failed AND rollback failed; on-disk state is inconsistent
 * - `load_failed` — swap committed but the new plugin failed to load
 */
export type PluginInstallErrorCode =
  | "lock_failed"
  | "archive_invalid"
  | "manifest_invalid"
  | "engine_incompatible"
  | "namespace_unauthorized"
  | "hash_failed"
  | "unload_failed"
  | "swap_failed"
  | "swap_unrecoverable"
  | "load_failed";

/**
 * Structured install validation error. `path` is the JSON pointer segments
 * into `plugin.json` for `manifest_invalid` failures (empty for non-manifest
 * errors) so the dialog can highlight the offending field.
 */
export interface PluginInstallError {
  code: PluginInstallErrorCode;
  path?: string[];
  message: string;
}

/**
 * Result of {@link PluginService.installPlugin}. Returned as plain data (never
 * thrown) so structured validation errors survive Electron's structured-clone
 * IPC boundary intact (#3769). The discriminant is `status` rather than `ok`
 * because `ok`/`success` keys collide with the IPC success envelope and are
 * rejected by `ForbidIpcEnvelopeKeys` at the handler boundary.
 */
export type PluginInstallResult =
  | { status: "installed"; pluginId: string }
  | { status: "failed"; errors: PluginInstallError[] };

/** Optional provenance hints recorded on a successful install. */
export interface PluginInstallOptions {
  /** How the install was initiated. Defaults to `"sideload"` when omitted. */
  source?: PluginInstallSource;
  /** Original download URL for catalog/url installs. Never logged. */
  originalUrl?: string | null;
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
 * Typed channel handler bound by the second overload of
 * {@link PluginHostApi.registerHandler}. Receives the IPC context and the
 * single parsed args payload (post-Zod-validation). The variadic
 * {@link PluginIpcHandler} stays the canonical legacy shape; typed handlers
 * are adapted to it at registration time so the dispatch path is unchanged.
 */
export type PluginTypedIpcHandler<TArgs, TResult> = (
  ctx: PluginIpcContext,
  args: TArgs
) => TResult | Promise<TResult>;

/**
 * Per-channel schema bundle for typed `registerHandler` registrations. `args`
 * validates the single-payload dispatch input (`window.electron.plugin.invoke(
 * pluginId, channel, args)` — only the first argument is parsed). `result`
 * validates the handler's return value before it crosses back to the renderer
 * so a plugin's contract drift surfaces at the boundary instead of as a
 * mysterious downstream TypeError. `requires` lists the
 * {@link BuiltInPluginCapability} values the channel needs; the host rejects
 * registration if any are missing from the plugin's declared
 * `manifest.capabilities`, and re-checks at dispatch as defense-in-depth.
 */
export interface PluginChannelSchema<TArgs, TResult> {
  args: z.ZodType<TArgs>;
  result: z.ZodType<TResult>;
  requires?: readonly BuiltInPluginCapability[];
}

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

/**
 * Runtime handler bound to a plugin-registered action via
 * {@link PluginHostApi.registerAction}. Receives the dispatch args payload
 * (the renderer-side synthetic action forwards a single args object) and
 * returns the action's result. Unlike {@link PluginIpcHandler} it does NOT
 * receive an IPC context — action handlers are addressed by action id, not by
 * a per-invocation channel context. The closure lives only in main and never
 * crosses the IPC boundary.
 */
export type ActionHandler = (args: unknown) => unknown | Promise<unknown>;

export interface PluginHostApi {
  readonly pluginId: string;
  /**
   * Imperatively register an action with a main-side handler. The
   * `descriptor.id` must NOT include the plugin prefix — the host namespaces
   * it as `{pluginId}.{descriptor.id}` at runtime. `descriptor.danger` accepts
   * `"safe"` or `"confirm"`; `"restricted"` is rejected. The host raises the
   * effective danger to `"confirm"` when the plugin holds a high-risk
   * capability, mirroring {@link PluginActionDescriptor.effectiveDanger}.
   * Calling with a previously-registered id replaces the prior descriptor and
   * handler. Must be called during `activate()` — the host is revoked once
   * activation resolves or times out. Unregistered automatically on unload.
   */
  registerAction(descriptor: PluginActionContribution, handler: ActionHandler): void;
  /**
   * Bind a typed IPC handler whose args and result are validated against the
   * provided Zod schemas, gated on the listed plugin capabilities. The host
   * rejects registration if any `schema.requires` capability is missing from
   * `manifest.capabilities` (fail-closed at the registration boundary). At
   * dispatch the args are `safeParse`d, the handler is invoked with the
   * parsed payload, and the result is `safeParse`d before returning to the
   * renderer. Schema failures throw with a `SCHEMA_ERROR:` prefix; missing
   * capabilities throw with a `PERMISSION_REQUIRED:` prefix — the
   * renderer-side `useHostChannel` hook discriminates on these prefixes.
   */
  registerHandler<TArgs, TResult>(
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>
  ): void;
  /**
   * Legacy untyped overload: a variadic handler with no host-side validation.
   * Retained for plugins that haven't migrated to per-channel schemas. The
   * typed overload above is preferred for new code.
   */
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
  /**
   * Dispatch an action by id through the app's `ActionService` with a `"plugin"`
   * source. Plugins use this to invoke their own registered actions, actions
   * contributed by other plugins, or any built-in action — always through the
   * audited, validated dispatch path rather than bypassing it.
   *
   * Args are validated against the action's `argsSchema` by `ActionService`;
   * the host does not re-validate. Actions classified `danger: "restricted"`
   * are rejected with `RESTRICTED`, and `danger: "confirm"` actions return
   * `CONFIRMATION_REQUIRED` (plugins cannot bypass confirm-gating — there is no
   * `confirmed` flag).
   *
   * Like {@link invalidateFileDecorations} and {@link showToast} this is NOT
   * revoke-guarded: plugins call it from post-activation subscription callbacks
   * and timers. Once the plugin is unloaded it returns
   * `{ ok: false, error: { code: "PLUGIN_UNLOADED" } }` without attempting a
   * dispatch.
   */
  dispatch(actionId: string, args?: unknown): Promise<ActionDispatchResult>;
  /**
   * Persistent, plugin-scoped key/value settings. Plaintext JSON storage with
   * `chmod 0o600` on POSIX — no OS keychain (#9167). See {@link SettingsApi}.
   */
  readonly settings: SettingsApi;
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
