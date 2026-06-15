/**
 * Public export boundary for `@daintreehq/plugin-sdk`.
 *
 * This module is the single source of truth for the plugin SDK's public type
 * surface. Every symbol re-exported here is a frozen contract — additions are
 * non-breaking, removals are breaking. Plugin authors import from this module
 * (or from `@daintreehq/plugin-sdk` once the package is published in F31).
 *
 * Host-internal types (LoadedPluginInfo, PluginActionDescriptor,
 * BUILT_IN_PLUGIN_CAPABILITIES) live in `./plugin.js` and are intentionally NOT
 * re-exported here. If you add a new forge.js import to `./plugin.js`, you must
 * classify it here first — see docs/plugins/architecture.md#sdk-surface.
 *
 * Entry points:
 *   - `@daintreehq/plugin-sdk`        — this module
 *   - `@daintreehq/plugin-sdk/react`  — the renderer hooks useHostChannel /
 *     usePluginEvent (see plugin-sdk-react.ts)
 */

// ── Manifest authoring ──────────────────────────────────────────────

export type {
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  MenuItemLocation,
  ViewContribution,
  ViewLocation,
  McpServerContribution,
  PluginCapability,
  BuiltInPluginCapability,
  PluginActionContribution,
  KeybindingContribution,
  ContextMenuContribution,
  ContextMenuLocation,
  PluginManifestScopes,
  PluginNetworkScope,
  PluginFsScope,
} from "./plugin.js";

// ── View component props ────────────────────────────────────────────

export type { PanelViewProps } from "./plugin.js";

// ── Manifest root ───────────────────────────────────────────────────

export type { PluginManifest, PluginAuthor } from "./plugin.js";

// ── Activation contract ─────────────────────────────────────────────

export type {
  PluginActivate,
  PluginHostApi,
  PluginActivationApi,
  ActionHandler,
  PluginToastOptions,
  PluginLogger,
  PluginProcessApi,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginFsApi,
  PluginFsDirEntry,
  PluginFsStat,
  PluginGitApi,
  PluginGitStatus,
  PluginGitStatusFile,
  PluginGitCommitOptions,
  PluginGitCommitResult,
} from "./plugin.js";

// ── Settings (host.settings) ────────────────────────────────────────

export type {
  SettingsApi,
  PluginSettingsScope,
  SettingDefinition,
  SettingFieldType,
} from "./plugin.js";

// ── IPC (registerHandler, broadcastToRenderer) — ships in v1 ────────

export type {
  PluginIpcContext,
  PluginIpcHandler,
  PluginChannelSchema,
  PluginTypedIpcHandler,
} from "./plugin.js";

// ── Worktree observability ──────────────────────────────────────────

export type {
  PluginWorktreeSnapshot,
  PluginWorktreeLinked,
  PluginWorktreeLinkedIssue,
  PluginWorktreeLinkedPR,
  PluginWorktreeStatus,
  PluginWorktreeStatusFile,
  PluginWorktreeFileState,
} from "./plugin.js";

// ── Forge provider contract ─────────────────────────────────────────

export type {
  ForgeProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderContribution,
} from "./forge.js";

// ── File decoration provider contract ───────────────────────────────

export type {
  FileDecorationProviderImpl,
  FileDecorationProviderDescriptor,
  FileDecorationContribution,
} from "./forge.js";

// ── Forge types appearing in worktree projections ───────────────────

export type { NormalizedPRState, ResourceRef, CIStatus } from "./forge.js";

// ── Action dispatch result (host.dispatch return type) ──────────────
// host.dispatch() resolves to ActionDispatchResult, so plugin authors must be
// able to name it and narrow on its error codes from the public SDK.

export type {
  ActionDispatchResult,
  ActionDispatchSuccess,
  ActionDispatchError,
  ActionError,
  ActionErrorCode,
} from "./actions.js";
