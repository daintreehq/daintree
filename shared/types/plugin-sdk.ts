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
  PluginLocalSocketScope,
} from "./plugin.js";

// ── View component props ────────────────────────────────────────────

export type { PanelViewProps } from "./plugin.js";

// ── Panel lifecycle (worker-facing) ─────────────────────────────────

export type { PluginPanelLifecycleEvent, PluginPanelLifecyclePhase } from "./plugin.js";

// ── Manifest root ───────────────────────────────────────────────────

export type { PluginManifest, PluginAuthor } from "./plugin.js";

// ── Activation contract ─────────────────────────────────────────────

export type {
  PluginActivate,
  PluginHostApi,
  PluginHostActionsApi,
  PluginActivationApi,
  PluginHostCallOptions,
  PluginHostSubscriptionOptions,
  ActionHandler,
  PluginToastOptions,
  PluginPanelBadge,
  PluginPanelBadgeColor,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginInputBoxOptions,
  PluginConfirmOptions,
  PluginLogger,
  PluginProcessApi,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessMode,
  PluginProcessDataChunk,
  PluginDuplexProcessHandle,
  PluginDuplexProcessSpawnOptions,
  PluginPtyProcessHandle,
  PluginPtyProcessSpawnOptions,
  PluginFsApi,
  PluginFsDirEntry,
  PluginFsStat,
  PluginGitApi,
  PluginGitStatus,
  PluginGitStatusFile,
  PluginGitCommitOptions,
  PluginGitCommitResult,
  PluginClipboardApi,
  PluginSystemApi,
} from "./plugin.js";

// ── Settings (host.settings) ────────────────────────────────────────

export type {
  SettingsApi,
  PluginSettingsScope,
  SettingDefinition,
  SettingFieldType,
} from "./plugin.js";

// ── Storage (host.storage) ──────────────────────────────────────────

export type { StorageApi, PluginStorageScope } from "./plugin.js";

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
  PluginWorktreesResult,
  PluginWorktreesUnavailableReason,
  PluginWorktreeLinked,
  PluginWorktreeLinkedIssue,
  PluginWorktreeLinkedPR,
  PluginWorktreeStatus,
  PluginWorktreeStatusFile,
  PluginWorktreeFileState,
} from "./plugin.js";

// ── Agent observability ─────────────────────────────────────────────

export type { PluginAgentSnapshot } from "./plugin.js";
export type { AgentState, WaitingReason } from "./agent.js";

// ── Forge provider contract ─────────────────────────────────────────

export type {
  ForgeProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderContribution,
  ForgeProviderKind,
} from "./forge.js";

// `localAuthStubs` is a runtime value (the no-op auth methods a local/offline
// provider spreads into its impl), so it is a value export — `export type`
// would strip the binding and break `{ ...localAuthStubs }` at runtime.
export { localAuthStubs } from "../utils/forgeProviderHelpers.js";

// ── File decoration provider contract ───────────────────────────────

export type {
  FileDecorationProviderImpl,
  FileDecorationProviderDescriptor,
  FileDecorationContribution,
} from "./forge.js";

// ── Forge types appearing in worktree projections ───────────────────

export type { NormalizedPRState, ResourceRef, CIStatus } from "./forge.js";

// ── Forge domain types (ForgeProviderImpl method params & returns) ──
// A forge-provider author writing named `toIssue`/`toPR` helpers and typing
// the provider's method signatures must be able to name these from the public
// SDK without reaching into internal app paths. FetchOptions and FileDecoration
// appear directly in ForgeProviderImpl / FileDecorationProviderImpl signatures.

export type {
  Issue,
  PR,
  RepoRef,
  Page,
  Credentials,
  AuthValidation,
  FetchOptions,
  ListOptions,
  RepoMetadata,
  CreateIssueInput,
  ForgeUser,
  ForgeLabel,
  NormalizedIssueState,
  RateLimitInfo,
  FileDecoration,
  ChecksCapability,
  CheckRun,
  CheckRunStatus,
  CheckRunConclusion,
} from "./forge.js";

// ── Plugin-managed process stream events ────────────────────────────
// A panel author subscribing via `plugin.on(pluginId, PLUGIN_PROCESS_STREAM_CHANNEL)`
// discriminates the streamed events on `kind`. PLUGIN_PROCESS_STREAM_CHANNEL is a
// runtime constant, so it is a value export (not `export type`) — type-only would
// strip the value and break `plugin.on(pluginId, PLUGIN_PROCESS_STREAM_CHANNEL)`.

export type { PluginProcessStreamEvent } from "./ipc/pluginProcess.js";
export { PLUGIN_PROCESS_STREAM_CHANNEL } from "./ipc/pluginProcess.js";

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

// ── Built-in action catalog (host.actions.*) — #10561, #10581 ───────
// host.actions.list()/get() project the ActionService manifest to plugins. The
// dispatch surface is typed against ActionId, which narrows to BuiltInActionId
// for IDE autocomplete while staying open to plugin-authored ids (no cast
// needed). ActionKind/ActionDanger/ActionExample appear on the projected entry,
// so authors must be able to name them too.

export type {
  PluginActionManifestEntry,
  PluginCanDispatchResult,
  BuiltInActionId,
  ActionId,
  ActionKind,
  ActionDanger,
  ActionExample,
} from "./actions.js";
