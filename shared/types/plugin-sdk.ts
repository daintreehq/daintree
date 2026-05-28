/**
 * Public export boundary for `@daintreehq/plugin-sdk`.
 *
 * This module is the single source of truth for the plugin SDK's public type
 * surface. Every symbol re-exported here is a frozen contract — additions are
 * non-breaking, removals are breaking. Plugin authors import from this module
 * (or from `@daintreehq/plugin-sdk` once the package is published in F31).
 *
 * Host-internal types (LoadedPluginInfo, PluginActionDescriptor,
 * BUILT_IN_PLUGIN_PERMISSIONS) live in `./plugin.js` and are intentionally NOT
 * re-exported here. If you add a new forge.js import to `./plugin.js`, you must
 * classify it here first — see docs/plugins/architecture.md#sdk-surface.
 *
 * Note: `permissions` is expected to be renamed to `capabilities` in #9268.
 * Plugin authors should treat the current `permissions` field name as subject
 * to change in a future SDK release.
 *
 * Entry points:
 *   - `@daintreehq/plugin-sdk`        — this module
 *   - `@daintreehq/plugin-sdk/react`  — reserved for F15/F36 (see plugin-sdk-react.ts)
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
} from "./plugin.js";

// ── Manifest root ───────────────────────────────────────────────────

export type { PluginManifest } from "./plugin.js";

// ── Activation contract ─────────────────────────────────────────────

export type { PluginActivate, PluginHostApi, ActionHandler } from "./plugin.js";

// ── Settings (host.settings) ────────────────────────────────────────

export type { SettingsApi, PluginSettingsScope, SettingDefinition } from "./plugin.js";

// ── IPC (registerHandler, broadcastToRenderer) — ships in v1 ────────

export type { PluginIpcContext, PluginIpcHandler } from "./plugin.js";

// ── Worktree observability ──────────────────────────────────────────

export type {
  PluginWorktreeSnapshot,
  PluginWorktreeLinked,
  PluginWorktreeLinkedIssue,
  PluginWorktreeLinkedPR,
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
