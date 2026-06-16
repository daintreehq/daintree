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
import type {
  ActionDispatchResult,
  ActionId,
  PluginActionManifestEntry,
  PluginCanDispatchResult,
} from "./actions.js";
import type { AgentState, WaitingReason } from "./agent.js";
import type { AgentDetectionConfig } from "../config/agentRegistry.js";
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
  actionId: ActionId;
  priority?: 1 | 2 | 3 | 4 | 5;
}

/**
 * Semantic color for a {@link PluginPanelBadge}. Maps to the app's status
 * palette in the renderer — plugins pick intent, not a raw hex value, so badges
 * stay theme-consistent. `"default"` is the neutral accent-free tint.
 */
export type PluginPanelBadgeColor = "default" | "success" | "warning" | "error";

/**
 * A small live indicator a plugin overlays on a panel's title chrome via
 * {@link PluginHostApi.setPanelBadge}, keyed by panel id. Lets per-worktree /
 * per-agent state (notes present, CI pass/fail, review status) surface without
 * opening the panel. Two shapes: a bare status `dot`, or a short `label`
 * (text capped at 6 characters host-side so it can't overflow the header).
 */
export type PluginPanelBadge =
  | { kind: "dot"; color?: PluginPanelBadgeColor; tooltip?: string }
  | { kind: "label"; text: string; color?: PluginPanelBadgeColor; tooltip?: string };

/** Max length of a {@link PluginPanelBadge} `label` text, enforced host-side. */
export const PLUGIN_PANEL_BADGE_LABEL_MAX = 6;

export type MenuItemLocation = "terminal" | "file" | "view" | "help";
// `"panel"` was removed (#10512): no renderer surface ever mounted
// `usePluginContextMenuItems("panel")`, so a contributed panel context-menu item
// was silently dead. Only `worktree` / `terminal` / `file` have live consumers.
export type ContextMenuLocation = "worktree" | "terminal" | "file";

export const BUILT_IN_PLUGIN_CAPABILITIES = [
  "fs:project-read",
  "fs:project-write",
  "fs:user-data-read",
  "fs:user-data-write",
  "network:fetch",
  "agent:invoke",
  "agent:read",
  "agent:register",
  "agent:input",
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
  actionId: ActionId;
  location: MenuItemLocation;
  accelerator?: string;
  when?: string;
}

export interface KeybindingContribution {
  actionId: ActionId;
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
  actionId: ActionId;
  location: ContextMenuLocation;
  label: string;
  when?: string;
}

/**
 * View contribution location. Only `panel` is supported — it registers a panel
 * kind at plugin load with `showInPalette: true` so the view is spawnable from
 * the panel palette. It is wired today by the inline renderer host (#9229); see
 * `docs/plugins/architecture.md` for the renderer host design. `sidebar` is
 * rejected at the manifest gate (`ViewContributionSchema`) because the sidebar
 * host does not exist yet — accepting it would validate a contribution the
 * runtime cannot honor. The `experimental_` prefix on the contribution point
 * signals that the shape may still change before the feature exits experiment
 * status.
 */
export type ViewLocation = "panel";

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
  /**
   * Opaque argument bag handed to the view when the panel is spawned with one
   * — e.g. `{ path }` from a "open file in plugin panel" intent. Sourced from
   * the panel's `extensionState` (the same bag that survives the save/restore
   * round-trip), so a restored panel sees the args it was originally spawned
   * with. Empty (no key) for panels opened without an initial argument. The
   * host never mutates it; plugins should treat the contents as read-only.
   */
  readonly initialArgs?: Record<string, unknown>;
}

/**
 * Lazily-spawned MCP server contribution (#9235). The declared `command` is
 * launched as a real subprocess the first time its tools are enumerated (not at
 * load time), inheriting `args` and `env`. `${settings:*}` templates inside
 * `args` are resolved from user-scope settings at spawn and on restart, so a
 * contributed command does run with the plugin author's wiring — treat it as
 * trust-gated, not inert. Shape intentionally mirrors the Claude Desktop /
 * Cursor MCP server config format (stdio only; remote servers via `url` are out
 * of scope and deliberately excluded). The `experimental_` prefix on the
 * contributes field signals the shape may still change.
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
   * Allowlist of absolute filesystem paths the plugin's `fs:*` capabilities may
   * touch. Each entry is schema-validated at parse time (must be an absolute
   * path containing no `..` segment and no `*`/`**` glob — literal-path
   * allowlist only).
   *
   * Enforced at runtime by the host-mediated {@link PluginFsApi} ({@link
   * PluginHostApi.fs}): every path argument is realpath-resolved and contained
   * to one of these roots (traversal and symlink-escape rejected), mirroring the
   * `plugin://` protocol handler's containment discipline. It does NOT gate the
   * compound-capability lattice — `scopes.network` is the only bucket the lattice
   * consults today.
   *
   * Honest scope note: this gates `host.fs`/`host.git` only. A plugin's `main`
   * still runs in-process and can call raw `node:fs` directly, which the host
   * cannot intercept until the sandbox/trust model changes (D3). `host.fs` gives
   * a sanctioned, contained, audited path; it does not seal the in-process one.
   */
  allowedPaths: string[];
}

export interface PluginManifestScopes {
  network?: PluginNetworkScope;
  fs?: PluginFsScope;
}

/**
 * A plugin-contributed agent entry (#9560). Lets a plugin teach Daintree about
 * a launchable agent CLI it doesn't ship, so the CLI shows up as a named,
 * selectable agent rather than a generic shell. Requires the `agent:register`
 * capability (enforced at the manifest gate). Plugin agent IDs are additive for
 * new IDs only — a contribution whose `id` collides with a built-in is rejected
 * at parse time, and built-in entries always shadow plugin entries in
 * `getEffectiveRegistry`. Cross-plugin ID conflicts resolve first-registered-wins.
 *
 * Plugin agents launch as named, untracked terminals: the schema surfaces
 * `id`, `name`, `command`, `args`, `color`, `iconId`,
 * `supportsContextInjection`, and an optional `detection` block. The
 * `detection` field (#10587) lets a contributed agent describe its
 * working/waiting/completed output patterns so it participates in the
 * agent-state UI like a built-in — output-volume state already works from the
 * launch hint, and declared patterns add the richer prompt/completion cues.
 * Threaded onto the resolved {@link AgentConfig} by `contributionToAgentConfig`
 * and consumed by the pty-host activity monitor.
 */
export interface PluginAgentContribution {
  id: string;
  name: string;
  command: string;
  args?: string[];
  color: string;
  iconId: string;
  supportsContextInjection?: boolean;
  /**
   * Optional output-pattern detection config (#10587). Passive observation
   * only — patterns are matched against terminal output to drive the
   * working/waiting/completed state machine, consistent with the agent-config
   * boundary (Daintree never modifies the agent's own config).
   */
  detection?: AgentDetectionConfig;
}

/**
 * Closed set of catalog categories a plugin can declare via
 * `manifest.category`. The plugin manager groups its list by these (#9554
 * successor) — a closed enum rather than free-form tags so the catalog can't
 * fragment into orphan one-off groups. Display labels, ordering, and the
 * contributes-based fallback derivation live in
 * `shared/config/pluginCategoryRegistry.ts`.
 */
export const PLUGIN_CATEGORY_IDS = ["forge", "ai", "workspace", "other"] as const;

export type PluginCategoryId = (typeof PLUGIN_CATEGORY_IDS)[number];

/**
 * A single attribution entry in {@link PluginManifest.authors}. `name` is
 * required; the rest are optional. `url` (when present) is validated to the
 * same https-only, no-credentials, no-private-host discipline as network
 * scopes — see `PluginAuthorUrlSchema` in `electron/schemas/plugin.ts` — since
 * it surfaces as a user-clickable link in the detail pane.
 */
export interface PluginAuthor {
  name: string;
  url?: string;
  email?: string;
  role?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  /**
   * One-line value proposition shown in catalog rows and cards. `description`
   * stays the long-form copy for the detail pane.
   */
  tagline?: string;
  /**
   * Optional attribution credits shown in the detail pane's "Contributors"
   * block. Each entry credits a person who worked on the plugin.
   */
  authors?: PluginAuthor[];
  /**
   * Declared catalog category. Optional — when absent the manager derives one
   * from `contributes` (see `resolvePluginCategory`).
   */
  category?: PluginCategoryId;
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
    views: ViewContribution[];
    mcpServers: McpServerContribution[];
    forgeProviders: ForgeProviderContribution[];
    fileDecorationProviders: FileDecorationContribution[];
    /**
     * Plugin-contributed launchable agents (#9560). Each entry registers an
     * {@link PluginAgentContribution} into the effective agent registry at load
     * time so the CLI is selectable as a named agent. Requires the
     * `agent:register` capability. Empty unless the plugin opts in.
     */
    agents: PluginAgentContribution[];
    /**
     * Declared plugin settings. When absent or empty, `host.settings.set()`
     * accepts any key (permissive for plugins that declare none). When non-empty,
     * `set()` (and the settings-UI write/reset paths) reject keys not declared
     * here and enforce each setting's declared scope — see `assertSettingDeclared`
     * in `electron/services/plugin/PluginSettingsManager.ts`.
     */
    settings?: SettingDefinition[];
  };
}

/**
 * Field control kind for a {@link SettingDefinition}. Drives which input the
 * generated settings form renders (#9301):
 * - `string` → single-line text input (default when `type` is omitted)
 * - `number` → numeric input, optionally range-bounded by `min`/`max`
 * - `boolean` → toggle switch
 * - `enum` → select, choices from `options`
 * - `json` → multi-line textarea, validated as JSON on blur
 * - `secret` → password input, never rendered with its stored value until the
 *   user explicitly reveals it
 * - `path` / `directory` / `file` → read-only text input + a "Browse" button
 *   that opens the native chooser via `window.electron.plugin.pickPath`. The
 *   stored value is an absolute filesystem path. `path` and `directory` choose a
 *   folder; `file` chooses a single file (narrowable by `extensions`). When
 *   `mustExist` is set the form flags a stored path that no longer resolves.
 */
export type SettingFieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "json"
  | "secret"
  | "path"
  | "directory"
  | "file";

/**
 * Declaration for a single plugin setting under `contributes.settings` (#9301).
 * Rendered as a generated form field in Preferences → Plugins and persisted via
 * {@link SettingsApi}. `id` is the storage key; `type` selects the control. The
 * manifest schema coerces the legacy `secret: true` flag to `type: "secret"`, so
 * consumers only need to switch on `type`.
 */
export interface SettingDefinition {
  id: string;
  type?: SettingFieldType;
  label?: string;
  description?: string;
  default?: unknown;
  /** Where the value is stored. Defaults to `"user"`. */
  scope?: PluginSettingsScope;
  /** Allowed values for `type: "enum"`. Ignored for other types. */
  options?: string[];
  /** Inclusive lower bound for `type: "number"`. */
  min?: number;
  /** Inclusive upper bound for `type: "number"`. */
  max?: number;
  /**
   * For `type: "path" | "directory" | "file"` — when `true`, the settings form
   * flags a stored path that no longer resolves on disk. Advisory: it does not
   * block saving (the chooser only returns existing paths), but a path that was
   * valid at pick time can later be moved or deleted. Ignored for other types.
   */
  mustExist?: boolean;
  /**
   * For `type: "file"` — restrict the native chooser to these file extensions
   * (without the leading dot, e.g. `["json", "md"]`). Maps to an Electron
   * dialog filter. Ignored for `path` / `directory` (folders are unfiltered)
   * and all other types.
   */
  extensions?: string[];
  /**
   * Legacy plaintext-secret hint (F19). The manifest schema normalizes
   * `secret: true` to `type: "secret"`; new manifests should use the type.
   * Storage is always plaintext JSON regardless of this flag (#9167).
   */
  secret?: boolean;
}

/**
 * Request for the plugin-reachable native folder/file chooser
 * (`window.electron.plugin.pickPath`). Driven by the generated settings form's
 * "Browse" button for `path` / `directory` / `file` fields, so it is
 * user-initiated and not capability-gated — but it is scoped to a valid
 * `pluginId` at the IPC boundary. `kind: "directory"` chooses a single folder;
 * `kind: "file"` chooses a single file, optionally narrowed by `filters`.
 */
export interface PluginPickPathRequest {
  kind: "directory" | "file";
  /** Pre-select this absolute path in the chooser. Ignored when not absolute. */
  defaultPath?: string;
  /** File-type filters for `kind: "file"` (extensions without the dot). Ignored for directories. */
  filters?: PluginPickPathFilter[];
}

/** One named extension group for the `kind: "file"` chooser. */
export interface PluginPickPathFilter {
  name: string;
  /** Extensions without the leading dot, e.g. `["json", "md"]`. `["*"]` allows all. */
  extensions: string[];
}

export type PluginSettingsScope = "user" | "project";

/**
 * Scope for the private {@link StorageApi} key/value store. Unlike
 * {@link PluginSettingsScope} this adds a `"worktree"` scope that auto-resolves
 * the currently-active worktree at call time (parallel to how `"project"`
 * resolves the active project), so a plugin can keep per-worktree machine state
 * without hand-rolling its own per-worktree keying inside a project blob. Kept a
 * distinct type from `PluginSettingsScope` so the settings UI / manifest schema
 * never has to reason about `"worktree"`.
 */
export type PluginStorageScope = "user" | "project" | "worktree";

/**
 * Snapshot of one plugin's stored setting values for a single scope, returned to
 * the settings UI (#9301). Secret values are deliberately never included —
 * `secretsSet` only reports *which* secret keys have a stored value so the form
 * can show a "saved" affordance without exposing the secret. Revealing a secret
 * requires a separate, explicit `revealSecretSetting` call.
 */
export interface PluginSettingsUiValues {
  /** Stored non-secret values keyed by setting id. A missing key means unset. */
  values: Record<string, unknown>;
  /** Ids of secret-typed settings that currently have a stored value. */
  secretsSet: string[];
  /**
   * At-rest tier new secret writes will use right now (#9167). `"keychain"` when
   * the OS keychain (Electron `safeStorage`) is available, `"plaintext"` when it
   * is not (e.g. a headless Linux box) and secrets fall back to `chmod 0o600`
   * JSON. The settings UI discloses this honestly per secret field.
   */
  secretTier: PluginSecretStorageTier;
  /**
   * Ids of secret settings whose *currently stored* value is still plaintext —
   * either written before a keychain was available, or not yet migrated. A value
   * here that's absent from a `"keychain"` tier means the UI should nudge the
   * user to re-save it. Migration happens automatically on the next write.
   */
  secretsPlaintext: string[];
}

/** At-rest storage tier for a secret setting value (#9167). */
export type PluginSecretStorageTier = "keychain" | "plaintext";

/**
 * Persistent, plugin-scoped key/value settings exposed on
 * {@link PluginHostApi.settings}. Values are stored as JSON at
 * `~/.daintree/plugin-settings/{pluginId}.json` (user scope) or
 * `<projectRoot>/.daintree/plugin-settings/{pluginId}.json` (project scope),
 * with `chmod 0o600` applied on POSIX. Settings declared `type: "secret"` are
 * encrypted at rest through the OS keychain (Electron `safeStorage`) when one is
 * available, falling back to the same plaintext-0600 path when it is not (#9167);
 * the `get`/`set` API shape is identical either way. Non-secret values are always
 * plaintext JSON — do not store credentials in non-secret keys.
 *
 * `scope` defaults to `"user"`. Project scope resolves the active project at
 * call time, so it tracks project switches: `get` returns `undefined` and `set`
 * throws when no project is active.
 */
/**
 * Options accepted by long-running host calls (filesystem reads/writes, git
 * reads and mutations, the on-demand worktree-status accessor). Carries an
 * optional {@link AbortSignal} so a plugin can cancel a call it no longer needs
 * — e.g. when a panel the read was feeding has unmounted. An already-aborted
 * signal rejects the call before any I/O; aborting mid-flight rejects with the
 * signal's reason. Always the trailing argument so it never collides with a
 * method's positional parameters.
 */
export interface PluginHostCallOptions {
  signal?: AbortSignal;
}

/**
 * Options accepted by high-frequency event subscriptions (today
 * {@link PluginActivationApi.onDidChangeWorktrees}). `debounceMs` coalesces a
 * burst of change events into a single trailing callback fired `debounceMs`
 * after the last event — the host re-emits the worktree set on every git-status
 * poll, so a UI-updating plugin can opt into far fewer callbacks. Values below a
 * small floor (~50ms) are clamped up; `0` / omitted means no debounce (fire on
 * every change). The coalesced callback receives the most recent snapshot list.
 */
export interface PluginHostSubscriptionOptions {
  debounceMs?: number;
}

export interface SettingsApi {
  /**
   * Read a setting. Resolves to `undefined` when the key is unset, or (for
   * `"project"` scope) when no project is active.
   *
   * When the key is declared in `contributes.settings`, its declared `scope`
   * (default `"user"`) is authoritative: omitting `scope` reads from the declared
   * scope, and passing a `scope` that conflicts with the declaration throws — the
   * read counterpart to the `set`/`onDidChange` scope guards. Undeclared keys (or
   * manifests with no declarations) fall back to the supplied `scope` or `"user"`.
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
   * reloads. Must be called during `activate()` — subscribing is revoke-guarded.
   * Resolves to a disposer; calling it more than once is a no-op. All
   * subscriptions are automatically disposed when the plugin is unloaded.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected (the promise rejects).
   */
  onDidChange<T = unknown>(
    key: string,
    callback: (value: T | undefined) => void,
    scope?: PluginSettingsScope
  ): Promise<() => void>;
}

/**
 * Private, plugin-scoped key/value storage exposed on
 * {@link PluginHostApi.storage}. This is the machine-owned counterpart to
 * {@link SettingsApi}: values never surface in the plugin settings UI and are
 * NOT gated by `contributes.settings` declarations, so a plugin can persist its
 * own working state freely without declaring every key. Values are stored as
 * plaintext JSON (no secret encryption — never store credentials here) at
 * `~/.daintree/plugin-storage/{pluginId}.json` (user scope),
 * `<projectRoot>/.daintree/plugin-storage/{pluginId}.json` (project scope), or
 * `<worktreePath>/.daintree/plugin-storage/{pluginId}.json` (worktree scope),
 * with `chmod 0o600` applied on POSIX.
 *
 * `scope` defaults to `"user"`. The `"project"` and `"worktree"` scopes resolve
 * the active project / active worktree at call time, so they track switches:
 * `get` and `delete` resolve to a no-op (returning `undefined` / void) and
 * `set` throws when no project / worktree is active.
 */
export interface StorageApi {
  /**
   * Read a stored value. Resolves to `undefined` when the key is unset, or when
   * the requested `"project"` / `"worktree"` scope has no active target.
   */
  get<T = unknown>(key: string, scope?: PluginStorageScope): Promise<T | undefined>;
  /**
   * Persist a value. Rejects `undefined` and non-JSON-serializable values. For
   * `"project"` / `"worktree"` scope with no active target, throws.
   */
  set<T = unknown>(key: string, value: T, scope?: PluginStorageScope): Promise<void>;
  /**
   * Remove a stored value. A missing key (or a `"project"` / `"worktree"` scope
   * with no active target) resolves to a no-op rather than throwing.
   */
  delete(key: string, scope?: PluginStorageScope): Promise<void>;
  /**
   * Subscribe to in-process writes of `key` in `scope` (default `"user"`). The
   * callback fires with the new value after each `set`/`delete` that changes it.
   * Edits made to the JSON file by other processes do NOT fire until the plugin
   * reloads. Must be called during `activate()` — subscribing is revoke-guarded.
   * Resolves to a disposer; calling it more than once is a no-op. All
   * subscriptions are automatically disposed when the plugin is unloaded.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected (the promise rejects).
   */
  onDidChange<T = unknown>(
    key: string,
    callback: (value: T | undefined) => void,
    scope?: PluginStorageScope
  ): Promise<() => void>;
}

export type PluginInstallSource = "builtin" | "sideload" | "url" | "catalog";

/**
 * Parsed intent of a `daintree://` deep link (#9559). The OS hands the raw URI
 * to the main process via `open-url` (macOS) or `second-instance` / `process.argv`
 * (Windows/Linux); `parseDaintreeUrl` validates and narrows it to one of these
 * shapes before it crosses to the renderer.
 *
 * - `install` — `daintree://plugin/install?url=<https-or-http-archive-url>`: opens
 *   the Plugin Manager with the URL pre-filled in the install dialog. The user
 *   still presses install, so the existing HTTP-warning and security gates fire;
 *   a deep link never installs silently.
 * - `open` — `daintree://plugin/open?id=<publisher.name>`: opens the Plugin
 *   Manager scrolled to the named plugin.
 */
export type PluginDeepLinkIntent =
  | { action: "install"; url: string }
  | { action: "open"; pluginId: string };

/**
 * Discriminant for {@link PluginCheckUpdateResult}. A manual update check
 * (`plugin:check-for-update`) re-fetches the plugin's `originalUrl`, hashes the
 * archive, and compares it against the installed `archiveHash` — the check is
 * purely informational and never installs. Manual reinstall (preserving
 * settings, never auto) is the user's follow-up action.
 *
 * - `up-to-date` — the re-fetched archive hashes identically to the installed one
 * - `available` — the hashes differ; the result carries the new manifest preview
 * - `invalid-id` — no installed record, or the record has no `originalUrl`
 *   (sideload/builtin); the UI gate makes the no-URL case unreachable in practice
 * - `fetch-failed` — network error, non-2xx response, bad content-type, or an
 *   archive that exceeds the size cap / fails to parse; carries a `message`
 */
export type PluginUpdateCheckStatus = "available" | "up-to-date" | "invalid-id" | "fetch-failed";

/**
 * Outcome of a manual update check. Returned as plain data (never thrown) so the
 * structured result survives Electron's structured-clone IPC boundary (#3769) —
 * domain failures (`fetch-failed`) come back as data, not as a rejected promise.
 */
export type PluginCheckUpdateResult =
  | { status: "up-to-date" }
  | {
      status: "available";
      name: string;
      version: string;
      displayName?: string;
      capabilities: PluginCapability[];
    }
  | { status: "invalid-id" }
  | { status: "fetch-failed"; message: string };

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
  /**
   * When the plugin was last reinstalled over an existing install (the #9292
   * swap path). Absent on first install — `installedAt` alone marks an untouched
   * install. Preserved separately from `installedAt` so a manual update keeps
   * the original install date while recording the upgrade.
   */
  updatedAt?: number;
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
 * - `name_collision` — the id matches a built-in or a launch-reserved plugin name; rejected before the swap so no broken dir is left
 * - `hash_failed` — couldn't compute the archive SHA-256
 * - `unload_failed` — the existing plugin's disposer cascade threw
 * - `swap_failed` — atomic rename failed but the prior state was restored
 * - `swap_unrecoverable` — rename failed AND rollback failed; on-disk state is inconsistent
 * - `load_failed` — swap committed but the new plugin failed to load
 *
 * Install-from-URL bounded-fetch failures (F24), produced before the archive
 * reaches `PluginService.installPlugin`:
 * - `fetch_failed` — non-2xx HTTP status or a network/transport error
 * - `fetch_timeout` — the download exceeded the shared `PLUGIN_DOWNLOAD_TIMEOUT_MS` deadline (30s)
 * - `size_exceeded` — declared `Content-Length` or the streamed bytes exceeded 30 MB
 * - `content_type_rejected` — response wasn't a plugin archive (bad MIME and the URL doesn't end in `.dntr`)
 */
export type PluginInstallErrorCode =
  | "lock_failed"
  | "archive_invalid"
  | "manifest_invalid"
  | "engine_incompatible"
  | "namespace_unauthorized"
  | "name_collision"
  | "hash_failed"
  | "unload_failed"
  | "swap_failed"
  | "swap_unrecoverable"
  | "load_failed"
  | "fetch_failed"
  | "fetch_timeout"
  | "size_exceeded"
  | "content_type_rejected";

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
 * Result of a plugin install attempt. Returned as plain data (never thrown) so
 * structured validation errors survive Electron's structured-clone IPC boundary
 * intact (#3769). The discriminant is `status` rather than `ok` because
 * `ok`/`success` keys collide with the IPC success envelope and are rejected by
 * `ForbidIpcEnvelopeKeys` at the handler boundary.
 *
 * `installed`/`failed` are the terminal outcomes of {@link
 * PluginService.installPlugin}, reached by both the install-from-path
 * (drag-and-drop, #9295) and install-from-URL (F24) entry points, which run the
 * full atomic flow. The remaining statuses are produced by the thin install
 * entry points before that flow runs: `cancelled` is a user-dismissed file
 * picker (no message to show), `invalid-url` is a malformed or rejected URL, and
 * `not-implemented` is returned only by the native-file-picker path
 * (install-from-file, F21/F23) — the picker is wired but does not yet route the
 * chosen path into the installer.
 */
export type PluginInstallResult =
  | { status: "installed"; pluginId: string }
  | { status: "failed"; errors: PluginInstallError[] }
  | { status: "cancelled" }
  | { status: "invalid-url" }
  | { status: "not-implemented" };

/**
 * The `status` discriminant of {@link PluginInstallResult}. Exported so the
 * `daintree-plugin` CLI can type its install-response branches against the host
 * contract instead of a bare `string`, keeping the two sides from drifting.
 */
export type PluginInstallStatus = PluginInstallResult["status"];

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
  /**
   * When the plugin was last reinstalled over an existing install. `undefined`
   * for builtins and for plugins that have never been upgraded.
   */
  updatedAt?: number;
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
  /**
   * Aggregate danger verdict for the plugin's declared capabilities, computed
   * once in the main process by `PluginService.listPlugins` from the flat
   * `CONFIRM_TRIGGERING_CAPABILITIES` set plus the compound-capability lattice
   * (`manifestTriggersCompoundElevation`). `"confirm"` means the plugin holds at
   * least one individually high-risk capability, or a compound pair the lattice
   * elevates (e.g. a sensitive read + an unconstrained network sink). The
   * renderer reads this for the manager's effective-danger summary instead of
   * re-deriving the lattice — the security logic stays single-source on main.
   * The flat high-risk set lives in `shared/config/pluginCapabilities.ts`
   * (`CONFIRM_TRIGGERING_CAPABILITIES`), shared with the MCP tier cap in
   * `PluginMcpTierAuth`; do not re-declare it anywhere else.
   */
  pluginDanger: "safe" | "confirm";
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
 * Normalized change state for a single file in a worktree's git status,
 * exposed to plugins. Collapses the internal {@link import("./git.js").GitStatus}
 * vocabulary down to the five states a decoration/lint plugin acts on:
 * `copied` → `added`, `conflicted` → `modified`, and `ignored` files are
 * dropped from the projection entirely (a plugin scanning "what changed" never
 * wants ignored noise).
 */
export type PluginWorktreeFileState = "added" | "modified" | "deleted" | "untracked" | "renamed";

/** A single changed file in {@link PluginWorktreeStatus.files}. */
export interface PluginWorktreeStatusFile {
  /** Path relative to the worktree root, as git reports it. */
  readonly path: string;
  readonly state: PluginWorktreeFileState;
}

/**
 * Read-only projection of a worktree's polled git status — the *which files
 * changed* companion to {@link PluginWorktreeSnapshot}, sourced from the same
 * status the host already polls (no extra shell-out). Lets a plugin scan only
 * what changed instead of hand-rolling `git status`. `files` is sorted by path
 * for stable diffing; `counts` is the per-state tally over `files`.
 */
export interface PluginWorktreeStatus {
  readonly files: readonly PluginWorktreeStatusFile[];
  /** Total entries in `files` (post-`ignored` filtering). */
  readonly changedFileCount: number;
  readonly counts: Readonly<Record<PluginWorktreeFileState, number>>;
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
  /**
   * Projection of the worktree's polled git status — which files changed and a
   * per-state tally. Sourced from the host's existing status poll, so a plugin
   * can scan only the changed set without shelling out to `git status`.
   * `null` when the host hasn't computed a status for this worktree yet.
   */
  readonly status: PluginWorktreeStatus | null;
}

/**
 * Read-only, frozen projection of an agent session's coarse state, exposed to
 * plugins behind the `agent:read` capability. This is an explicit allowlist of
 * fields from the internal `agent:state-changed` event payload; do NOT add
 * fields by spreading — every field must be intentionally exposed so internal
 * shape changes (and internal routing identifiers) don't leak to third-party
 * plugins. Observation only: nothing on this surface can drive, pause, resume,
 * or inject into an agent session.
 *
 * Deliberately omits the internal routing ids (`terminalId`, `worktreeId`,
 * `cwd`) and the activity-detector internals (`trigger`, `confidence`,
 * `temperature`, …): a plugin holding only `agent:read` has no declared
 * capability to access PTY/worktree internals, so exposing them here would let
 * it cross-reference state it can't otherwise reach.
 */
export interface PluginAgentSnapshot {
  /**
   * Stable id of the agent session, when the host could attribute the
   * transition to one. Absent for runtime-detected-only flows that route by
   * terminal rather than a resolved agent id.
   */
  readonly agentId?: string;
  /** Coarse lifecycle state: idle | working | waiting | directing | completed | exited. */
  readonly state: AgentState;
  /** The state the session transitioned away from. */
  readonly previousState: AgentState;
  /**
   * Convenience flag — `true` while the session is doing in-flight work
   * (`working` | `waiting` | `directing`), `false` otherwise. Derived from the
   * same `ACTIVE_AGENT_STATES` set the host uses, so a plugin doesn't have to
   * re-maintain the membership list.
   */
  readonly running: boolean;
  /** Why the session is waiting; present only when `state === "waiting"`. */
  readonly waitingReason?: WaitingReason;
  /** Cumulative session cost in USD; present only on `completed`/`exited` transitions. */
  readonly sessionCost?: number;
  /** Cumulative session token count; present only on `completed`/`exited` transitions. */
  readonly sessionTokens?: number;
  /** Unix timestamp in milliseconds when the transition was committed. */
  readonly timestamp: number;
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
 * One selectable row in a {@link PluginHostApi.showQuickPick} list. `id` is the
 * stable identity used for selection tracking and search keys; `label` is the
 * primary line. `description` renders inline after the label (dimmed) and
 * `detail` on a second muted line — both are optional and searched when
 * {@link PluginQuickPickOptions.matchOnDescription} is set. All fields are plain
 * strings so the item survives the structured-clone IPC boundary.
 */
export interface PluginQuickPickItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
}

/** Options for {@link PluginHostApi.showQuickPick}. */
export interface PluginQuickPickOptions {
  /** Dialog title line. Defaults to a generic "Select an option". */
  title?: string;
  /** Search-input placeholder. */
  placeholder?: string;
  /** Allow selecting multiple items. Changes the resolved value to an array. */
  canSelectMany?: boolean;
  /** Also fuzzy-match against each item's `description`/`detail`, not just `label`. */
  matchOnDescription?: boolean;
}

/** Options for {@link PluginHostApi.showInputBox}. */
export interface PluginInputBoxOptions {
  /** Dialog title line. Defaults to a generic "Enter a value". */
  title?: string;
  /** Prompt text shown above the input describing what to enter. */
  prompt?: string;
  /** Placeholder shown in the empty input. */
  placeholder?: string;
  /** Pre-filled initial value. */
  value?: string;
  /** Render the input as a password field (masked). */
  password?: boolean;
  /**
   * Regular-expression source string the entered value must match before the
   * input can be submitted. Validated client-side at submit time (no per-keystroke
   * IPC round-trip); an invalid pattern is ignored rather than blocking the user.
   */
  validationPattern?: string;
  /** Message shown when {@link validationPattern} fails. Defaults to a generic hint. */
  validationMessage?: string;
}

/** Options for {@link PluginHostApi.showConfirm}. */
export interface PluginConfirmOptions {
  /** Dialog title — a sentence-case question naming the entity (e.g. `Delete 'foo'?`). */
  title: string;
  /** Body text stating the specific consequence of confirming. */
  message?: string;
  /**
   * Primary-button label. For a {@link destructive} confirm use a verb-noun
   * label (e.g. `Delete file`), never a bare `OK`/`Confirm`. Defaults to `Confirm`.
   */
  confirmLabel?: string;
  /** Secondary-button label. Defaults to `Cancel`. */
  cancelLabel?: string;
  /** Style the primary button as destructive (red) to signal an irreversible action. */
  destructive?: boolean;
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

/**
 * Options for {@link PluginProcessApi.spawn}. All fields are optional; `command`
 * is the positional first argument. The host anchors a relative spawn against
 * `cwd` (defaulting to the active worktree path, then the process cwd) and
 * merges `env` over the host environment — a plugin cannot blank the inherited
 * env, only add to / override it.
 */
export interface PluginProcessSpawnOptions {
  /** Argument vector. Each entry is passed verbatim — no shell interpolation. */
  args?: string[];
  /** Working directory for the child. Defaults to the active worktree, then the host cwd. */
  cwd?: string;
  /** Extra environment variables, merged over (not replacing) the host environment. */
  env?: Record<string, string>;
}

/**
 * Live handle to a process spawned via {@link PluginProcessApi.spawn}. The
 * handle's `id` keys the stream events fanned out to the plugin's panels over
 * `postToPanel("process", …)` (see {@link import("./ipc/pluginProcess.js").PluginProcessStreamEvent}).
 *
 * `kill()` SIGTERMs the child and escalates to SIGKILL after a grace period;
 * `restart()` kills the current child and respawns it with the same
 * command/args/cwd/env, reusing the same handle id and bumping its restart
 * counter. Both are safe to call after the process has already exited (no-op).
 * `onExit`/`onCrash` register lifecycle callbacks carrying the real exit
 * code/signal — `onCrash` fires only on a non-zero / signalled exit the plugin
 * did not request, `onExit` fires on every termination. Callbacks registered
 * after the process has already terminated are invoked on the next microtask
 * with the recorded outcome, so a late subscriber never misses the event.
 */
export interface PluginProcessHandle {
  /** Host-assigned opaque id, stable across `restart()`. */
  readonly id: string;
  /**
   * Terminate the process: clean `SIGTERM`, then `SIGKILL` after the host grace
   * period if it hasn't exited. No-op if already terminated.
   */
  kill(): void;
  /**
   * Kill the current child (if any) and respawn with the same
   * command/args/cwd/env. Resolves once the new child is spawned. Reuses this
   * handle id and increments its restart counter.
   */
  restart(): Promise<void>;
  /** Register a callback fired on any termination. Returns a disposer. */
  onExit(callback: (info: { exitCode: number | null; signal: string | null }) => void): () => void;
  /**
   * Register a callback fired only on an unexpected termination (non-zero exit
   * code or a signal the plugin did not request via `kill()`). Returns a disposer.
   */
  onCrash(callback: (info: { exitCode: number | null; signal: string | null }) => void): () => void;
}

/**
 * Managed-process surface on {@link PluginHostApi.process}. Gated on the
 * declared `shell:exec` capability — `spawn` from a plugin that did not declare
 * it rejects with a `PERMISSION_REQUIRED:` error (the first runtime enforcement
 * of a scope capability). Spawns are surfaced in the plugin audit trail.
 *
 * NOT revoke-guarded: a process orchestrator spawns and respawns from timers
 * and subscription callbacks long after `activate()`. Liveness is plugin
 * membership — once the plugin unloads every outstanding process is torn down
 * and a further `spawn` rejects.
 */
export interface PluginProcessApi {
  /**
   * Spawn a child process on the plugin's behalf and return a live handle. The
   * child's stdout/stderr stream to the plugin's panels over
   * `postToPanel("process", …)` keyed by the handle id. Rejects when the plugin
   * lacks `shell:exec`, when the per-plugin concurrency cap is reached, or when
   * the plugin has been unloaded.
   */
  spawn(command: string, options?: PluginProcessSpawnOptions): Promise<PluginProcessHandle>;
}

/** One directory entry returned by {@link PluginFsApi.readdir}. */
export interface PluginFsDirEntry {
  /** Entry name (basename only — never a path). */
  name: string;
  /** True when the entry is a directory. */
  isDirectory: boolean;
  /** True when the entry is a regular file. */
  isFile: boolean;
  /** True when the entry is a symbolic link (resolved containment still applies on read). */
  isSymbolicLink: boolean;
}

/** File metadata returned by {@link PluginFsApi.stat}. */
export interface PluginFsStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  /** Size in bytes. */
  size: number;
  /** Last-modified time, epoch milliseconds. */
  mtimeMs: number;
}

/**
 * Host-mediated, scope-contained filesystem surface on {@link PluginHostApi.fs}.
 *
 * Every path argument is resolved against the plugin's declared
 * `scopes.fs.allowedPaths` and realpath-contained to one of those roots before
 * any I/O — a traversal (`..`) or a symlink that escapes a root is rejected,
 * mirroring the `plugin://` protocol handler's discipline. This is the runtime
 * enforcement of `scopes.fs.allowedPaths` (previously advisory-only).
 *
 * Reads are gated on `fs:project-read` / `fs:user-data-read`; writes on
 * `fs:project-write` / `fs:user-data-write`. A plugin missing the relevant
 * capability is rejected with a `PERMISSION_REQUIRED:` prefix (the same prefix
 * `useHostChannel` discriminates on); a path outside every allowed root is
 * rejected with a `PATH_NOT_ALLOWED:` prefix. Writes are recorded in the plugin
 * audit trail.
 *
 * Unlike the global `files.read` IPC, {@link readFile} carries NO 500KB / binary
 * cap — it is a deliberate plugin API, not the size-limited preview path.
 *
 * NOT revoke-guarded: a plugin reads/writes from timers and subscription
 * callbacks long after `activate()`. Liveness is plugin membership — once the
 * plugin unloads every method rejects and any active {@link watch} is torn down.
 */
export interface PluginFsApi {
  /**
   * Read a file as UTF-8 text. Resolves the contained absolute path; rejects on
   * a missing read capability, an out-of-scope path, or a non-file target. Pass
   * `options.signal` to cancel a read that is no longer needed.
   */
  readFile(filePath: string, options?: PluginHostCallOptions): Promise<string>;
  /**
   * Write UTF-8 text to a file, creating it if absent (parent directories must
   * already exist within scope). Rejects on a missing write capability or an
   * out-of-scope path. Recorded in the audit trail. No cancellation signal —
   * partial-write semantics are deliberately out of scope.
   */
  writeFile(filePath: string, contents: string): Promise<void>;
  /** List a directory's immediate children. Rejects on a missing read capability or an out-of-scope path. */
  readdir(dirPath: string, options?: PluginHostCallOptions): Promise<PluginFsDirEntry[]>;
  /** Stat a path. Rejects on a missing read capability or an out-of-scope path. */
  stat(targetPath: string, options?: PluginHostCallOptions): Promise<PluginFsStat>;
  /**
   * Watch one or more contained paths for changes, invoking `callback` with the
   * changed absolute path. `paths` are each resolved and contained at
   * subscription time; an out-of-scope or missing-capability path rejects.
   * Resolves to a disposer that tears the watcher down; all watchers are
   * automatically torn down on unload. Rejects on a missing read capability so
   * authoring mistakes surface loudly. Pass `options.signal` to abort the
   * subscription attempt before it is wired.
   */
  watch(
    paths: string[],
    callback: (changedPath: string) => void,
    options?: PluginHostCallOptions
  ): Promise<() => void>;
}

/** A single changed file in {@link PluginGitApi.status}. Mirrors {@link PluginWorktreeStatusFile}. */
export type PluginGitStatusFile = PluginWorktreeStatusFile;

/** Result of {@link PluginGitApi.status}. */
export interface PluginGitStatus {
  /** Absolute worktree path the status was read for. */
  worktreePath: string;
  files: PluginGitStatusFile[];
  changedFileCount: number;
}

/**
 * Options for {@link PluginGitApi.commit}. The host enforces the #7880 / D2
 * change-preview safeguard at the host layer: `commit` refuses without an
 * explicit, non-empty `message` — there is no silent fallback to a derived
 * commit message — and the host computes the real staged diff as the preview
 * (returned in {@link PluginGitCommitResult}) before mutating.
 */
export interface PluginGitCommitOptions {
  /**
   * Commit message. MUST be a non-empty string the plugin explicitly authored —
   * the host rejects an empty/whitespace message rather than substituting a
   * derived one (the #7880 root-cause guard).
   */
  message: string;
}

/** Result of {@link PluginGitApi.commit}. */
export interface PluginGitCommitResult {
  /** Short SHA of the new commit. */
  commit: string;
  /** The committed message (echoed back for confirmation). */
  message: string;
  /**
   * The host-computed staged diff that was committed — the real change preview
   * the D2 safeguard requires. A plugin UI can surface this to the user.
   */
  preview: string;
}

/**
 * Host-mediated git surface on {@link PluginHostApi.git}, scoped to a worktree
 * the plugin may access (the `worktreePath` must resolve inside the plugin's
 * `scopes.fs.allowedPaths`). Implemented over the existing hardened simple-git
 * service — not a reinvented git layer.
 *
 * Reads ({@link status}, {@link diff}) are gated on `git:read`; mutations
 * ({@link add}, {@link commit}) on `git:write`. A missing capability rejects
 * with a `PERMISSION_REQUIRED:` prefix; an out-of-scope `worktreePath` with a
 * `PATH_NOT_ALLOWED:` prefix. {@link commit} additionally enforces the host-side
 * change-preview safeguard (see {@link PluginGitCommitOptions}). Mutations are
 * recorded in the plugin audit trail.
 *
 * NOT revoke-guarded — same lifetime/membership semantics as {@link PluginFsApi}.
 */
export interface PluginGitApi {
  /** Changed-file status for the worktree. Gated on `git:read`. Pass `options.signal` to cancel. */
  status(worktreePath: string, options?: PluginHostCallOptions): Promise<PluginGitStatus>;
  /**
   * Unified diff for the worktree (or one `filePath` relative to it). Returns
   * the raw diff text. Gated on `git:read`. Pass `options.signal` to cancel.
   */
  diff(worktreePath: string, filePath?: string, options?: PluginHostCallOptions): Promise<string>;
  /**
   * Stage paths (relative to `worktreePath`, or all changes when omitted).
   * Gated on `git:write`. Recorded in the audit trail. Pass `options.signal` to cancel.
   */
  add(worktreePath: string, paths?: string[], options?: PluginHostCallOptions): Promise<void>;
  /**
   * Commit staged changes. Gated on `git:write`. Refuses without an explicit
   * non-empty {@link PluginGitCommitOptions.message} — no silent fallback (the
   * #7880 guard) — and returns the real staged diff as a change preview.
   * Recorded in the audit trail. Pass `callOptions.signal` to cancel before the
   * commit is created.
   */
  commit(
    worktreePath: string,
    options: PluginGitCommitOptions,
    callOptions?: PluginHostCallOptions
  ): Promise<PluginGitCommitResult>;
}

/**
 * Host-mediated access to the OS clipboard, backing the `clipboard:read` /
 * `clipboard:write` capability tokens. Text-only — the surface deliberately
 * omits image/HTML/file-list variants so a plugin cannot read or smuggle
 * richer payloads than it declared. Both methods run in the main process
 * (Electron's `clipboard` module is unavailable in the plugin utility worker),
 * so they remain callable from a headless plugin with no mounted panel.
 *
 * Like {@link PluginFsApi} and {@link PluginGitApi} this is NOT revoke-guarded:
 * plugins read/write from post-activation timers and callbacks. Once the plugin
 * is unloaded every method rejects.
 */
export interface PluginClipboardApi {
  /**
   * Replace the clipboard's contents with `text`. Gated on `clipboard:write`.
   * Rejects with a `PAYLOAD_TOO_LARGE:` prefix when `text` exceeds 8 MiB by
   * UTF-8 byte count (mirroring the renderer IPC clipboard guard).
   */
  writeText(text: string): Promise<void>;
  /**
   * Read the clipboard's text contents. Gated on `clipboard:read`. Resolves to
   * `""` when the clipboard is empty or holds non-text content (image, file
   * list) — it never rejects on content type.
   */
  readText(): Promise<string>;
}

/**
 * The revoke-guarded slice of {@link PluginHostApi}: the registration methods
 * that are only valid during `activate()`. The host revokes this surface once
 * activation resolves or times out — every method here throws if called
 * afterward (e.g. from a subscription callback or timer). The split is
 * extracted into its own interface so the activation-window contract is visible
 * at the type level, not only in JSDoc and prose docs.
 *
 * {@link PluginHostApi} extends this, so the `host` handed to `activate()`
 * exposes both these registration methods and the post-activation-safe methods.
 * Type a helper that should only ever register-during-activation as
 * `PluginActivationApi` to make the narrower contract explicit at its call
 * sites. The post-activation-safe methods ({@link PluginHostApi.showToast},
 * {@link PluginHostApi.dispatch}, {@link PluginHostApi.invalidateFileDecorations},
 * {@link PluginHostApi.logger}, and the worktree accessors `getActiveWorktree`
 * /`getWorktrees`) live on {@link PluginHostApi} directly and remain callable
 * for the plugin's whole lifetime. Note the worktree *subscriptions*
 * (`onDidChangeActiveWorktree`/`onDidChangeWorktrees`) and `settings.onDidChange`
 * are revoke-guarded — subscribing is an activation-window operation even though
 * the callbacks fire later.
 */
export interface PluginActivationApi {
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
   *
   * Resolves once the registration is accepted. The revoke / validation guard
   * still throws synchronously, so a rejected registration surfaces both as a
   * synchronous throw at the call site and is reflected by the promise.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerAction(descriptor: PluginActionContribution, handler: ActionHandler): Promise<void>;
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
   *
   * Must be called during `activate()`.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerHandler<TArgs, TResult>(
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>
  ): Promise<void>;
  /**
   * Legacy untyped overload: a variadic handler with no host-side validation.
   * Retained for plugins that haven't migrated to per-channel schemas. The
   * typed overload above is preferred for new code. Also revoke-guarded — must
   * be called during `activate()`.
   */
  registerHandler(channel: string, handler: PluginIpcHandler): Promise<void>;
  /**
   * Push a fire-and-forget payload to all renderers listening on `channel`.
   * Intended for the activation window — wiring up the renderer-side view of a
   * plugin's state before `activate()` returns.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the broadcast is rejected.
   */
  broadcastToRenderer(channel: string, payload: unknown): Promise<void>;
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
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerForgeProvider(
    descriptor: ForgeProviderDescriptor,
    impl: ForgeProviderImpl
  ): Promise<() => void>;
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
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerFileDecorationProvider(
    descriptor: FileDecorationProviderDescriptor,
    impl: FileDecorationProviderImpl
  ): Promise<() => void>;
  /**
   * Subscribe to active-worktree changes. The callback fires with the new
   * active snapshot (or `null` when none is active). Returns a disposer;
   * calling it more than once is a no-op. All subscriptions are automatically
   * disposed when the plugin is unloaded.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void
  ): Promise<() => void>;
  /**
   * Subscribe to the worktree set changing. The callback fires with the full
   * current list on any worktree add/update/remove. Resolves to a disposer;
   * calling it more than once is a no-op. All subscriptions are automatically
   * disposed when the plugin is unloaded.
   *
   * Pass `options.debounceMs` to coalesce bursts (the host re-emits on every
   * git-status poll) into a single trailing callback — see
   * {@link PluginHostSubscriptionOptions}. Omitted means fire on every change.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidChangeWorktrees(
    callback: (snapshots: PluginWorktreeSnapshot[]) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  /**
   * Subscribe to agent-session state changes, gated on the `agent:read`
   * capability. The callback fires with a frozen {@link PluginAgentSnapshot}
   * on every accepted agent state transition across all sessions (unscoped,
   * like {@link onDidChangeWorktrees} — a plugin filters by `snapshot.agentId`
   * if it cares about one session). Resolves to a disposer; calling it more
   * than once is a no-op. All subscriptions are automatically disposed when the
   * plugin is unloaded.
   *
   * Observation only — there is no companion method to drive, pause, resume, or
   * inject into a session.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare the
   *   `agent:read` capability, or if called after activation resolves or times
   *   out (the host is revoked).
   */
  onDidChangeAgentState(callback: (snapshot: PluginAgentSnapshot) => void): Promise<() => void>;
}

/**
 * The full host surface handed to a plugin's `activate()`. Extends
 * {@link PluginActivationApi} (the revoke-guarded registration methods, valid
 * only during activation) with the post-activation-safe methods below, which
 * remain callable from subscription callbacks and timers for the plugin's whole
 * lifetime and degrade to a no-op once the plugin is unloaded.
 */
/**
 * Built-in action catalog surface on {@link PluginHostApi.actions} (#10561).
 * Projects the app's `ActionService` manifest to plugins so an orchestration
 * plugin can discover what `host.dispatch()` accepts — the ids, arg schemas, and
 * danger classification — without reading Daintree's source.
 *
 * Like {@link PluginHostApi.dispatch} this is NOT revoke-guarded: plugins
 * introspect from post-activation command handlers and timers. Once the plugin
 * is unloaded `list()` resolves `[]` and `get()` / `canDispatch()` resolve as if
 * the action were absent (`null` / `"restricted"`) — these never throw.
 */
export interface PluginHostActionsApi {
  /**
   * List every plugin-dispatchable action as a slim
   * {@link PluginActionManifestEntry}. Mirrors `ActionService.list()`:
   * `danger:"restricted"` actions are filtered out, so listed entries are always
   * `"safe"` or `"confirm"`. Resolves `[]` when no renderer is available or the
   * plugin has been unloaded.
   */
  list(): Promise<PluginActionManifestEntry[]>;
  /**
   * Look up a single action by id, or `null` when it doesn't exist or is
   * `danger:"restricted"` (restricted actions are invisible to plugins, matching
   * {@link list}). Prefer this over {@link list} for a single lookup — it avoids
   * projecting the whole catalog.
   */
  get(actionId: ActionId): Promise<PluginActionManifestEntry | null>;
  /**
   * Pre-flight a dispatch without triggering it: `"ok"` for a safe action,
   * `"confirm"` for a confirm-gated one (which {@link PluginHostApi.dispatch}
   * would reject with `CONFIRMATION_REQUIRED`), and `"restricted"` for an
   * unknown or `danger:"restricted"` action. Lets a plugin warn the user before
   * triggering a confirm prompt. See {@link PluginCanDispatchResult}.
   */
  canDispatch(actionId: ActionId): Promise<PluginCanDispatchResult>;
}

export interface PluginHostApi extends PluginActivationApi {
  readonly pluginId: string;
  /**
   * Push a fire-and-forget payload to every renderer subscribed to
   * `(pluginId, channel)` via `window.electron.plugin.on(...)`. This is the
   * post-activation-safe sibling of {@link broadcastToRenderer}: it fans out
   * over the exact same `plugin:{pluginId}:{channel}` transport, but unlike the
   * revoke-guarded activation broadcast it remains callable from the plugin's
   * own timers, polls, and subscription callbacks long after `activate()`
   * resolves — so a plugin can stream live data into its panels without the
   * renderer degrading to `invoke()` polling.
   *
   * Like {@link invalidateFileDecorations}, {@link showToast}, and
   * {@link dispatch} this is NOT revoke-guarded: liveness is plugin membership,
   * so it becomes a silent no-op once the plugin is unloaded. `channel` must be
   * a non-empty string without colons (the namespace separator); an invalid
   * channel throws so authoring mistakes surface loudly.
   */
  postToPanel(channel: string, payload: unknown): Promise<void>;
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
   * Returns the changed-file / git-status projection for the worktree at the
   * given absolute `path` (the same {@link PluginWorktreeStatus} carried on
   * {@link PluginWorktreeSnapshot.status}), or `null` when no worktree matches
   * or the host hasn't polled a status yet. Reads the host's already-polled
   * status — it does NOT trigger a fresh `git status`.
   *
   * Like {@link postToPanel} this is NOT revoke-guarded: it stays callable from
   * the plugin's timers and subscription callbacks and degrades to `null` once
   * the plugin is unloaded. Pass `options.signal` to cancel.
   */
  getWorktreeStatus(
    path: string,
    options?: PluginHostCallOptions
  ): Promise<PluginWorktreeStatus | null>;
  /**
   * Returns the most recent agent-session state observed since the plugin
   * subscribed via {@link onDidChangeAgentState}, as a frozen
   * {@link PluginAgentSnapshot}, or `null` when no transition has been observed
   * yet (the host keeps no pre-subscription history). Gated on the `agent:read`
   * capability.
   *
   * Like {@link postToPanel} this is NOT revoke-guarded: it stays callable from
   * the plugin's timers and subscription callbacks and degrades to `null` once
   * the plugin is unloaded. Observation only.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare the
   *   `agent:read` capability.
   */
  getAgentState(): Promise<PluginAgentSnapshot | null>;
  /**
   * Send `text` to the currently-active agent terminal, gated on the
   * `agent:input` capability. The host resolves the target itself (focused /
   * visible agent terminal first, then a `waiting` agent, then the most recently
   * active agent terminal in the active project) so plugins stop reinventing
   * `terminal.list`-based selection heuristics that drift (#10558). The raw
   * `terminal.sendCommand` action is closed to plugin dispatch — this is the
   * sanctioned injection path.
   *
   * `options.submit` controls whether the text is executed. It defaults to
   * `false` — the **stage-only** default-safe mode: the text is pasted into the
   * agent's input for the user to review and submit, with no Enter appended.
   * Pass `{ submit: true }` to append Enter and run it immediately.
   *
   * First use raises a just-in-time consent prompt (like `shell:exec`); a
   * granted consent covers later calls. Like {@link dispatch} this is NOT
   * revoke-guarded: liveness is plugin membership, so it becomes a no-op once the
   * plugin is unloaded.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare the
   *   `agent:input` capability, or if the user denies the consent prompt.
   * @throws {Error} `NO_ACTIVE_AGENT:` if no agent terminal is available to
   *   receive the input.
   */
  sendToActiveAgent(text: string, options?: { submit?: boolean }): Promise<void>;
  /**
   * Signal that decorations for `scope` (optionally narrowed to `paths`) have
   * changed and any renderer showing them should re-pull. Unlike the
   * `register*` methods this is NOT revoke-guarded: it is called from the
   * plugin's own subscription callbacks (worktree changes, polling timers)
   * which fire long after `activate()` resolves, and must remain callable for
   * the plugin's whole lifetime. It becomes a silent no-op once the plugin is
   * unloaded.
   */
  invalidateFileDecorations(scope: string, paths?: string[]): Promise<void>;
  /**
   * Set (or clear) a small live badge on the title chrome of the panel with the
   * given `panelId` — a status `dot` or a short `label` — so per-worktree /
   * per-agent state surfaces without opening the panel. Pass `null` to clear
   * this plugin's badge on that panel. Badges are keyed by `(pluginId, panelId)`,
   * so plugins never clobber each other's badge on the same panel.
   *
   * Like {@link invalidateFileDecorations} this is NOT revoke-guarded: plugins
   * call it from post-activation subscription callbacks and timers, and it
   * becomes a silent no-op once the plugin is unloaded (all of the plugin's
   * badges are cleared on unload). An invalid `panelId` or badge shape (e.g. a
   * `label` longer than {@link PLUGIN_PANEL_BADGE_LABEL_MAX} characters) rejects
   * so authoring mistakes surface loudly.
   */
  setPanelBadge(panelId: string, badge: PluginPanelBadge | null): Promise<void>;
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
  dispatch(actionId: ActionId, args?: unknown): Promise<ActionDispatchResult>;
  /**
   * Built-in action catalog: discover what `dispatch()` accepts (ids, arg
   * schemas, danger) and pre-flight a dispatch. Projects the app's
   * `ActionService` manifest to plugins (#10561). See {@link PluginHostActionsApi}.
   *
   * Like {@link dispatch} this is NOT revoke-guarded — it stays callable from
   * post-activation callbacks and degrades to empty/absent results once the
   * plugin is unloaded.
   */
  readonly actions: PluginHostActionsApi;
  /**
   * Imperatively prompt the user to pick from a list, rendered through the app's
   * searchable command-palette surface. Resolves with the chosen item (or an
   * array when `options.canSelectMany` is set), or `undefined` if the user
   * dismisses the palette (Escape / click-away).
   *
   * Like {@link showToast} this is async and NOT revoke-guarded: plugins call it
   * from command handlers that run long after `activate()` resolves. If the
   * plugin is unloaded while the palette is open the pending call resolves
   * `undefined` (it never throws). Invalid items reject so authoring mistakes
   * surface loudly.
   */
  showQuickPick(
    items: PluginQuickPickItem[],
    options: PluginQuickPickOptions & { canSelectMany: true }
  ): Promise<PluginQuickPickItem[] | undefined>;
  showQuickPick(
    items: PluginQuickPickItem[],
    options?: PluginQuickPickOptions
  ): Promise<PluginQuickPickItem | undefined>;
  /**
   * Imperatively prompt the user for a line of text, rendered through the app's
   * dialog surface. Resolves with the entered string, or `undefined` if the user
   * cancels (Escape / Cancel). A non-empty {@link PluginInputBoxOptions.validationPattern}
   * is enforced client-side at submit time.
   *
   * Async and NOT revoke-guarded for the same reason as {@link showQuickPick};
   * resolves `undefined` if the plugin is unloaded while the dialog is open.
   */
  showInputBox(options?: PluginInputBoxOptions): Promise<string | undefined>;
  /**
   * Imperatively ask the user to confirm an action, rendered through the app's
   * `ConfirmDialog`. Resolves `true` if confirmed, `false` if cancelled,
   * dismissed, or the plugin is unloaded while the dialog is open.
   *
   * Async and NOT revoke-guarded for the same reason as {@link showQuickPick}.
   * For an irreversible action set {@link PluginConfirmOptions.destructive} and
   * use a verb-noun `confirmLabel`.
   */
  showConfirm(options: PluginConfirmOptions): Promise<boolean>;
  /**
   * Persistent, plugin-scoped key/value settings. Plaintext JSON storage with
   * `chmod 0o600` on POSIX — no OS keychain (#9167). See {@link SettingsApi}.
   */
  readonly settings: SettingsApi;
  /**
   * Private, plugin-scoped key/value storage — the machine-owned counterpart to
   * {@link settings}. Values never surface in the settings UI and are not gated
   * by `contributes.settings` declarations. Plaintext JSON, three scopes
   * (`"user"`, `"project"`, `"worktree"`). See {@link StorageApi}.
   *
   * Like {@link settings} this is NOT revoke-guarded: plugins read/write storage
   * throughout their lifetime. The store is the source of truth, so a late call
   * is harmless. `onDidChange` is the one revoke-guarded member (subscribe only
   * during `activate()`).
   */
  readonly storage: StorageApi;
  /**
   * Structured diagnostic logger backed by a bounded per-plugin ring buffer in
   * the main process. Lines are forwarded to the host console (prefixed
   * `[plugin:{pluginId}]`) and retained for the most recent ~500 entries so
   * they can be folded into an error report on demand. See {@link PluginLogger}.
   *
   * Like {@link invalidateFileDecorations}, {@link showToast}, and
   * {@link dispatch} this is NOT revoke-guarded: plugins log from
   * post-activation callbacks and timers. Writes become a silent no-op once the
   * plugin is unloaded.
   */
  readonly logger: PluginLogger;
  /**
   * Managed child-process lifecycle, gated on the declared `shell:exec`
   * capability. Spawns processes tied to the plugin's lifetime: every
   * outstanding process is killed (clean SIGTERM, then SIGKILL after a grace
   * period) on unload/disable/revoke, and a per-plugin concurrency cap bounds
   * how many can run at once. See {@link PluginProcessApi}.
   *
   * Like {@link postToPanel} this is NOT revoke-guarded: a process orchestrator
   * spawns from post-activation timers and callbacks. Once the plugin is
   * unloaded `spawn` rejects.
   */
  readonly process: PluginProcessApi;
  /**
   * Host-mediated filesystem surface contained to the plugin's declared
   * `scopes.fs.allowedPaths` — the runtime enforcement of those paths (formerly
   * advisory-only). Reads gated on `fs:*-read`, writes on `fs:*-write`. See
   * {@link PluginFsApi}.
   *
   * NOT revoke-guarded: plugins read/write from post-activation timers and
   * callbacks. Once the plugin unloads every method rejects and active watchers
   * are torn down.
   */
  readonly fs: PluginFsApi;
  /**
   * Host-mediated git surface scoped to a worktree inside the plugin's
   * `scopes.fs.allowedPaths`, implemented over the existing hardened git
   * service. Reads gated on `git:read`, mutations on `git:write`; `commit`
   * enforces the host-side change-preview safeguard. See {@link PluginGitApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}.
   */
  readonly git: PluginGitApi;
  /**
   * Host-mediated OS clipboard surface. Reads gated on `clipboard:read`, writes
   * on `clipboard:write`. Text-only; runs in the main process so it works from a
   * headless plugin. See {@link PluginClipboardApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}.
   */
  readonly clipboard: PluginClipboardApi;
}

/**
 * Synchronous, fire-and-forget diagnostic logger handed to a plugin via
 * {@link PluginHostApi.logger}. Each call appends one line to the plugin's
 * ring buffer and mirrors it to the host console. `fields` is an optional
 * structured payload serialized alongside the message; an unserializable
 * payload is coerced to a string rather than thrown. Calls return `void` — the
 * write is enqueued internally and never rejects.
 *
 * Deliberate carve-out: every other host method is Promise-returning (#10519),
 * but the logger stays synchronous. Logging happens from error handlers and
 * sync callbacks where forcing `await` is ergonomic noise, the write genuinely
 * cannot fail (it is enqueued, never awaited), and the precedent — VS Code's
 * own `OutputChannel.appendLine` — is synchronous. Do not "complete" the async
 * conversion by making these return `Promise<void>`.
 */
export interface PluginLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
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
