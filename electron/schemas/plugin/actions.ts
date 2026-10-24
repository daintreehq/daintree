// Action-dispatching contributions: commands, menu items, keybindings, context menus and event routes.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  PLUGIN_EVENT_ROUTE_EVENTS,
} from "../../../shared/types/plugin.js";
import { PLUGIN_ACTION_CATEGORY_MAX_LENGTH } from "../../../shared/config/actionCategories.js";
import {
  BUILT_IN_ACTION_IDS,
  DENY_PLUGIN_DISPATCH_ACTION_IDS,
} from "../../../shared/config/actionIds.js";
import { KEY_ACTION_VALUES } from "../../../shared/types/keymap.js";
import {
  FILE_EDITOR_MAX_PATH_PATTERNS,
  FileEditorPathPatternSchema,
  FileExtensionListSchema,
} from "./providers.js";

// The full set of built-in action ids a plugin contribution may reference:
// `BuiltInActionId = BuiltInKeyAction | BuiltInRuntimeActionId`
// (shared/types/actions.ts). `BUILT_IN_ACTION_IDS` covers only the runtime
// half — keybinding-driven ids (nav.*, tab.*, app.settings, layout.undo, …)
// live in `KEY_ACTION_VALUES` and are equally valid dispatch targets, so both
// must seed the allowlist or a legitimate keybinding contribution is rejected.
export const BUILT_IN_ACTION_ID_SET: ReadonlySet<string> = new Set([
  ...BUILT_IN_ACTION_IDS,
  ...KEY_ACTION_VALUES,
]);

/** Whether `actionId` names a built-in action, runtime or keybinding-driven. */
export function isBuiltInActionId(actionId: string): boolean {
  return BUILT_IN_ACTION_ID_SET.has(actionId);
}

// Built-in actions a plugin contribution may never dispatch (terminal input
// injection, fleet command relays). The host refuses these at runtime, so a
// contribution wired to one is a dead button — reject it at parse time (#10580).
export const DENY_PLUGIN_DISPATCH_SET: ReadonlySet<string> = new Set(
  DENY_PLUGIN_DISPATCH_ACTION_IDS
);

// The whole-id grammar the host's action registration enforces
// (`PLUGIN_ACTION_ID_RE` in PluginService), so a panel menu accepts exactly
// the ids a plugin can actually register.
export const PANEL_MENU_ACTION_ID = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;

export const MenuItemContributionSchema = z
  .object({
    label: z.string().min(1),
    actionId: z.string().min(1),
    location: z.enum(["terminal", "file", "view", "help"]),
    accelerator: z.string().optional(),
    when: z.string().min(1).optional(),
  })
  .strict();

export const KeybindingContributionSchema = z
  .object({
    actionId: z.string().min(1),
    combo: z.string().min(1),
    // Closed to the renderer's KeyScope union (src/services/keybindingUtils.ts).
    // An unknown scope would never match the active scope and silently produce an
    // inert binding, so reject it at the manifest gate instead. Defaults to
    // "global" in the renderer hook when omitted. The former "terminal",
    // "modal", and "worktreeList" scopes were removed — they were never
    // activated, so bindings declared under them could not fire.
    scope: z
      .enum(["global", "portal", "worktreeGrid", "dev-preview"], {
        error: (issue) => {
          switch (issue.input) {
            case "terminal":
              return 'keybinding scope "terminal" was removed — use scope "global" with when: "terminalFocused"';
            case "modal":
              return 'keybinding scope "modal" was removed — use scope "global" with when: "modalOpen"';
            case "worktreeList":
              return 'keybinding scope "worktreeList" was removed — worktree-list navigation keys are fixed and not bindable';
            default:
              return undefined;
          }
        },
      })
      .optional(),
    description: z.string().min(1).optional(),
    when: z.string().min(1).optional(),
  })
  .strict();

export const ContextMenuContributionSchema = z
  .object({
    actionId: z.string().min(1),
    // `"panel"` removed (#10512) — no renderer surface consumed it, so a
    // contributed panel context-menu item was dead. Reject it at the manifest
    // gate so authors get a clear error instead of a silently-ignored item.
    location: z.enum(["worktree", "terminal", "file", "browser", "project"]),
    label: z.string().min(1),
    when: z.string().min(1).optional(),
    // Host-evaluated row match for `location: "file"`, AND-ed with `when`.
    // Omitted keys match everything.
    kind: z.enum(["file", "folder"]).optional(),
    extensions: FileExtensionListSchema.optional(),
    paths: z
      .array(FileEditorPathPatternSchema)
      .min(1)
      .max(FILE_EDITOR_MAX_PATH_PATTERNS)
      .optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    for (const key of ["kind", "extensions", "paths"] as const) {
      if (item[key] !== undefined && item.location !== "file") {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `"${key}" only applies to location "file"`,
        });
      }
    }
    if (item.kind === "folder" && item.extensions !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["extensions"],
        message: 'a folder has no extension — drop "extensions" or use kind "file"',
      });
    }
  });

/**
 * Declared here rather than beside the other manifest-level schemas because
 * {@link CommandContributionSchema} below references it for `requires`, and a
 * `const` referenced above its declaration is a TDZ error at module init.
 */
export const PluginCapabilitySchema = z.enum(BUILT_IN_PLUGIN_CAPABILITIES);

/**
 * `contributes.commands` manifest entry. The bare command `id` is namespaced
 * by `PluginService` at load time as `{pluginId}.{id}` so the descriptor key
 * matches the {@link PluginActionDescriptor.id} format used by the imperative
 * `host.registerAction` path. `danger: "restricted"` is rejected — plugins
 * may only contribute `"safe"` or `"confirm"` commands. Strict so an
 * unrecognised field surfaces as a manifest error instead of silently dropping
 * (e.g. a typo on `keywords` would otherwise vanish on a permissive schema).
 */
export const CommandContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().min(1),
    description: z.string(),
    category: z.string().min(1).max(PLUGIN_ACTION_CATEGORY_MAX_LENGTH),
    kind: z.enum(["command", "query"]),
    danger: z.enum(["safe", "confirm"]),
    keywords: z.array(z.string().min(1)).optional(),
    when: z.string().min(1).optional(),
    enablement: z.string().min(1).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    // Only the root is checked here. The full compile (dialect, local refs,
    // formats) runs when the descriptor is built, which runtime registrations
    // reach without passing through this schema.
    resultSchema: z.looseObject({ type: z.literal("object") }).optional(),
    // Per-action capability intent (#11299). Deliberately NOT `.min(1)`: an
    // empty array is the meaningful "this command exercises no capability"
    // declaration that keeps it one-click in an otherwise high-authority
    // plugin. Omitting the field keeps whole-manifest danger derivation.
    // PluginService re-checks the subset against manifest.capabilities.
    requires: z.array(PluginCapabilitySchema).optional(),
  })
  .strict();

/**
 * One manifest `eventRoutes` entry (#13816): an event from the host's closed
 * list and the bare id of one of the plugin's own `contributes.commands`. The
 * manifest-level `superRefine` resolves the command and checks the event's
 * capability, since both depend on other fields.
 */
export const EventRouteSchema = z.strictObject({
  event: z.enum(PLUGIN_EVENT_ROUTE_EVENTS),
  command: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
});
