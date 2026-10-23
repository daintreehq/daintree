import path from "node:path";
import * as semver from "semver";
import { z } from "zod";
import {
  SAFE_ID_PATTERN,
  SCOPED_PLUGIN_NAME_PATTERN,
  isPrivateOrLoopbackHostname,
} from "./pluginIdentifiers.js";
import {
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
  AGENT_MCP_MAX_ENDPOINTS_PER_PLUGIN,
  AGENT_MCP_MAX_TOOLS_PER_ENDPOINT,
  AGENT_MCP_TOOL_NAME_PATTERN,
  BUILT_IN_PLUGIN_CAPABILITIES,
  PANEL_MENU_MAX_ITEMS,
  PANEL_TOOLBAR_MAX_ITEMS,
  PLUGIN_CATEGORY_IDS,
  PLUGIN_EVENT_ROUTE_EVENTS,
  PLUGIN_NOTIFY_MAX_ACTIONS,
  PLUGIN_PANEL_BADGE_LABEL_MAX,
  PLUGIN_TOOLBAR_BUTTON_STATE_TEXT_MAX,
  PLUGIN_WORKTREE_SETUP_STEP_LABEL_MAX,
  PLUGIN_WORKTREE_SETUP_STEP_MAX_TIMEOUT_MS,
  PLUGIN_WORKTREE_SETUP_STEP_MIN_TIMEOUT_MS,
  PLUGIN_APPLICATION_DESTINATIONS,
  PLUGIN_APPLICATION_ARRANGEMENTS,
  PLUGIN_APPLICATION_NAVIGATION_LIMITS,
  PROJECT_SURFACE_SLOT_CATALOGUE,
  PROJECT_SURFACE_SLOTS,
  SIDEBAR_VIEW_NAME_MAX_LENGTH,
  SIDEBAR_VIEW_PRIORITY_MAX,
  SIDEBAR_VIEW_PRIORITY_MIN,
} from "../../shared/types/plugin.js";
import {
  ELEMENT_PICKER_DETECTION_KINDS,
  ELEMENT_PICKER_PROVIDER_LIMITS,
} from "../../shared/elementPicker/providers.js";
import { isCoreFramework } from "../../shared/elementPicker/source.js";
import { LAUNCH_MCP_FORMATS } from "../../shared/config/launchMcp.js";
import {
  PLUGIN_CONNECTION_ID_PATTERN,
  declaredPluginConnections,
} from "../../shared/utils/pluginConnections.js";
import {
  PRESENTATION_FEATURE_IDS,
  PRESENTATION_LEVELS,
  isLevelAllowed,
  isPresentationFeatureId,
} from "../../shared/config/presentationProfile.js";
import { isBuiltInAgentId } from "../../shared/config/agentIds.js";
import { PLUGIN_ACTION_CATEGORY_MAX_LENGTH } from "../../shared/config/actionCategories.js";
import {
  SEARCH_PROVIDER_KEYWORD_PATTERN,
  SEARCH_PROVIDER_TITLE_MAX_LENGTH,
} from "../../shared/config/pluginSearchProviders.js";
import {
  MAX_TERMINALS_PER_RECIPE,
  RECIPE_PANEL_ARGS_MAX_BYTES,
} from "../../shared/utils/recipeSanitizer.js";
import {
  MAX_PLUGIN_RECIPE_VARIABLES,
  PLUGIN_RECIPE_VARIABLE_NAME_MAX_LENGTH,
  PLUGIN_RECIPE_VARIABLE_NAME_PATTERN,
  pluginVariableReferences,
} from "../../shared/utils/pluginRecipeVariables.js";
import { isAgentRecipeType } from "../../shared/types/project.js";
import { SYSTEM_PROMPT_MAX_LENGTH } from "../../shared/utils/agentSystemPrompt.js";
import {
  CONTEXT_PROVIDER_PREFIX_PATTERN,
  CONTEXT_PROVIDER_RESERVED_PREFIXES,
} from "../../shared/utils/pluginContextReference.js";
import {
  PROMPT_TEMPLATE_ARG_NAME_PATTERN,
  PROMPT_TEMPLATE_MAX_ARGS,
  PROMPT_TEMPLATE_MAX_BODY_LENGTH,
  findPromptTemplatePlaceholders,
} from "../../shared/utils/pluginPromptTemplates.js";
import {
  TERMINAL_LINK_HOST_MAX_LENGTH,
  TERMINAL_LINK_MAX_PER_PLUGIN,
  TERMINAL_LINK_PATH_PREFIX_MAX_LENGTH,
  TERMINAL_LINK_PATTERN_MAX_LENGTH,
  checkTerminalLinkHost,
  checkTerminalLinkPathPrefix,
  checkTerminalLinkPattern,
} from "../../shared/utils/pluginTerminalLinks.js";
import { PROCESS_TOOL_ICON_BY_COMMAND } from "../../shared/config/processToolRegistry.js";
import { AGENT_CLI_NAMES } from "../services/ProcessDetector/registries.js";
import {
  BINARY_EXEC_SUBCOMMANDS,
  stripCommandExecutableExtension,
} from "../services/ProcessDetector/commandParser.js";
import { declaredQueryProblems } from "../services/pluginAgentMcp/declaredQueries.js";
import { RESERVED_AGENT_MCP_TOOL_NAMES } from "../services/pluginAgentMcp/types.js";
import {
  BUILT_IN_ACTION_IDS,
  DENY_PLUGIN_DISPATCH_ACTION_IDS,
} from "../../shared/config/actionIds.js";
import { KEY_ACTION_VALUES } from "../../shared/types/keymap.js";
import { parse as parseWhenClause } from "../../shared/utils/whenClause/parser.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { isReservedNavigationParamName } from "../../shared/utils/applicationNavigation.js";
import type { ASTNode as WhenClauseNode } from "../../shared/utils/whenClause/types.js";
import type {
  PluginManifest,
  PluginOrigin,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  SkillContribution,
  ThemeContribution,
  PromptTemplateContribution,
  PluginCapability,
} from "../../shared/types/plugin.js";
import type {
  FileDecorationContribution,
  ForgeProviderContribution,
} from "../../shared/types/forge.js";

// Identifier patterns + hostname classification live in the dependency-light
// `./pluginIdentifiers.ts` so boot-path modules can use them without pulling
// this file's zod schema construction into the eager graph. Re-exported here
// because the install/validate consumers of the schemas below use them too.
export { SAFE_ID_PATTERN, SCOPED_PLUGIN_NAME_PATTERN, isPrivateOrLoopbackHostname };

// The full set of built-in action ids a plugin contribution may reference:
// `BuiltInActionId = BuiltInKeyAction | BuiltInRuntimeActionId`
// (shared/types/actions.ts). `BUILT_IN_ACTION_IDS` covers only the runtime
// half — keybinding-driven ids (nav.*, tab.*, app.settings, layout.undo, …)
// live in `KEY_ACTION_VALUES` and are equally valid dispatch targets, so both
// must seed the allowlist or a legitimate keybinding contribution is rejected.
const BUILT_IN_ACTION_ID_SET: ReadonlySet<string> = new Set([
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
const DENY_PLUGIN_DISPATCH_SET: ReadonlySet<string> = new Set(DENY_PLUGIN_DISPATCH_ACTION_IDS);

// The whole-id grammar the host's action registration enforces
// (`PLUGIN_ACTION_ID_RE` in PluginService), so a panel menu accepts exactly
// the ids a plugin can actually register.
const PANEL_MENU_ACTION_ID = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;

/**
 * One `contributes.panels[].menu` entry. `actionId` must name one of the
 * plugin's own actions, enforced by the manifest-level `superRefine` below;
 * the host shows the entry while that action is registered and dispatches it
 * with `{ panelId }`.
 */
export const PanelMenuItemSchema = z
  .object({
    actionId: z.string().min(1).max(200),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/** Values of a manifest's `platforms`: Node's `process.platform` names. */
export const PLUGIN_PLATFORMS = ["darwin", "linux", "win32"] as const;

/**
 * One `contributes.panels[].toolbar` entry: a button in the panel header.
 * `actionId` is held to the plugin's own namespace by the same manifest-level
 * check as the menu; `iconId` takes what a panel's own `iconId` takes.
 */
export const PanelToolbarItemSchema = z
  .object({
    actionId: z.string().min(1).max(200),
    label: z.string().trim().min(1).max(80).optional(),
    iconId: z.string().min(1).max(200).optional(),
    status: z.boolean().optional(),
  })
  .strict();

/**
 * The unrefined object base — exported so the field-consumer contract test
 * (`manifestContributionConsumers.test.ts`) can enumerate `.shape` without
 * reaching through the `.superRefine` wrapper, mirroring
 * {@link SettingDefinitionObjectSchema}. Runtime validation goes through
 * {@link PanelContributionSchema} below.
 */
export const PanelContributionObjectSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    iconId: z.string().min(1),
    color: z.string().min(1),
    hasPty: z.boolean().default(false),
    canRestart: z.boolean().default(false),
    canConvert: z.boolean().default(false),
    showInPalette: z.boolean().default(true),
    // Dockable by default (undefined). Declare `false` to opt a panel kind out
    // of the dock — no default so absence flows through as `undefined` and
    // `panelKindIsDockable` treats it as dockable.
    dockable: z.boolean().optional(),
    // Version of the shape this panel writes through `persistState` (#12280).
    // No default: absence means "no opinion", and the host then hands a
    // persisted bag over unjudged exactly as it did before versioning existed.
    // Declaring one buys the migration contract — the host stamps this number
    // onto every write, tells the view which version it is reading via
    // `PanelViewProps.stateVersion`, and refuses to hand over a bag written by
    // a NEWER build of the plugin rather than let it be misread and rewritten.
    // Bump it when the shape changes incompatibly, never for an additive key.
    stateVersion: z.number().int().min(1).max(1_000_000).optional(),
    // What one panel of this kind belongs to (#13778). Absent means
    // `"worktree"`: each panel is tied to the worktree it was opened in.
    // `"project"` opens it with no worktree, so one panel serves the whole
    // project — its dock chip and its dialog show in every worktree. No default,
    // for the same reason as `dockable`: absence flows through as `undefined`.
    scope: z.enum(["worktree", "project"]).optional(),
    // Whether the plugin reports its own activity on panels of this kind
    // through `host.setPanelActivity` (#13820). Only `true` opens the method,
    // and the plugin manager says so; no default, like `dockable`.
    reportsActivity: z.boolean().optional(),
    // The plugin's own actions on this panel's ⋯ and right-click menus, in
    // declared order. Which actions may appear is checked at manifest level,
    // where the plugin's namespace and declared commands are known.
    menu: z.array(PanelMenuItemSchema).max(PANEL_MENU_MAX_ITEMS).optional(),
    // The plugin's own actions as buttons in this panel's header, in declared
    // order, held to the same namespace rule as `menu`.
    toolbar: z.array(PanelToolbarItemSchema).max(PANEL_TOOLBAR_MAX_ITEMS).optional(),
  })
  .strict();

/**
 * The validated `contributes.panels` entry: the object base plus cross-field
 * rules. `hasPty: true` with an explicit `dockable: false` is rejected — a
 * PTY-backed plugin kind renders through `TerminalPane` and its kind collapses
 * to the built-in dockable `terminal` at creation (`addPanel.ts`), so the
 * opt-out could never be honored and would silently vanish; surface the
 * conflict to the author at manifest-write time instead of swallowing it at
 * runtime (#11375). `hasPty` with toolbar entries is rejected for the same
 * reason: the terminal header has no room for a plugin's buttons. Menu entries
 * are allowed: the terminal's right-click menu draws the kind's own group
 * (#13213). `hasPty` has already defaulted to `false` here, so an omitted
 * `hasPty` never trips either.
 *
 * `scope: "project"` is rejected beside `hasPty` (the collapse to `terminal`
 * loses the kind, so nothing could keep the panel project-wide) and beside
 * `dockable: false` (a project panel lives in the dock, #13778).
 */
export const PanelContributionSchema = PanelContributionObjectSchema.superRefine((panel, ctx) => {
  if (panel.hasPty === true && panel.dockable === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dockable"],
      message:
        "A PTY-backed panel (hasPty: true) cannot opt out of the dock with dockable: false — plugin PTY panels render as terminals, which are always dockable. Remove the dockable flag.",
      params: { errorCode: "pty_panel_dock_opt_out_unsupported" },
    });
  }
  if (panel.scope === "project" && panel.hasPty === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope"],
      message:
        'A PTY-backed panel (hasPty: true) can\'t be scope: "project" — plugin PTY panels become ordinary terminals, which belong to a worktree. Remove the scope, or put the view on a panel without a PTY.',
      params: { errorCode: "pty_panel_project_scope_unsupported" },
    });
  }
  if (panel.scope === "project" && panel.dockable === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope"],
      message:
        'A scope: "project" panel opens in the dock, so it can\'t opt out of the dock with dockable: false. Remove one of the two.',
      params: { errorCode: "project_panel_dock_opt_out_unsupported" },
    });
  }
  if (panel.hasPty === true && panel.toolbar !== undefined && panel.toolbar.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["toolbar"],
      message:
        "A PTY-backed panel (hasPty: true) renders as a terminal and uses the terminal's header, so its toolbar buttons would never appear. Remove the toolbar, or put the actions on a view panel.",
      params: { errorCode: "pty_panel_toolbar_unsupported" },
    });
  }
  const seenToolbarActions = new Set<string>();
  panel.toolbar?.forEach((item, index) => {
    if (seenToolbarActions.has(item.actionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolbar", index, "actionId"],
        message: `Duplicate toolbar action "${item.actionId}" — each action appears at most once in a panel's toolbar.`,
        params: { errorCode: "panel_toolbar_duplicate_action" },
      });
    }
    seenToolbarActions.add(item.actionId);
  });
  const seenMenuActions = new Set<string>();
  panel.menu?.forEach((item, index) => {
    if (seenMenuActions.has(item.actionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["menu", index, "actionId"],
        message: `Duplicate menu action "${item.actionId}" — each action appears at most once in a panel's menu.`,
        params: { errorCode: "panel_menu_duplicate_action" },
      });
    }
    seenMenuActions.add(item.actionId);
  });
});

export const ToolbarButtonPopoverSchema = z
  .object({
    viewId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  })
  .strict();

/**
 * A toolbar button. `actionId` and `popover` are each optional here so the
 * object keeps a `.shape`; that exactly one is present is checked with the
 * manifest's cross-references (`toolbar_button_behavior_*`), alongside the
 * check that `popover.viewId` names a view the popover can mount.
 */
export const ToolbarButtonContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    label: z.string().min(1),
    iconId: z.string().min(1),
    actionId: z.string().min(1).optional(),
    popover: ToolbarButtonPopoverSchema.optional(),
    menu: z.array(PanelMenuItemSchema).max(PANEL_MENU_MAX_ITEMS).optional(),
    priority: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
    when: z.string().min(1).optional(),
  })
  .strict();

/** Most characters a launch entry's agent prompt may carry. */
export const LAUNCH_ENTRY_PROMPT_MAX_LENGTH = 4000;

/** Most bytes of JSON a launch entry's `args` may carry. */
export const LAUNCH_ENTRY_ARGS_MAX_BYTES = 8192;

/** The launch kinds `agent.launch` takes that are panels, not agents. */
const NON_AGENT_LAUNCH_IDS: ReadonlySet<string> = new Set(["terminal", "browser", "dev-preview"]);

const utf8 = new TextEncoder();

const LaunchEntryArgsSchema = z
  .record(z.string(), z.unknown())
  .refine((args) => utf8.encode(JSON.stringify(args)).length <= LAUNCH_ENTRY_ARGS_MAX_BYTES, {
    message: `args must be at most ${LAUNCH_ENTRY_ARGS_MAX_BYTES} bytes of JSON`,
  });

/**
 * A launch entry's panel target. `id` must name one of this plugin's own
 * `contributes.panels`, and `placement` must be one that panel can take; both
 * are checked with the manifest's cross-references.
 */
export const LaunchEntryPanelTargetSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    args: LaunchEntryArgsSchema.optional(),
    placement: z.enum(["dock", "grid", "dialog"]).optional(),
  })
  .strict();

/** A launch entry's command target, held to the plugin's own namespace by the manifest's cross-references. */
export const LaunchEntryCommandTargetSchema = z
  .object({
    actionId: z.string().min(1).max(200),
    args: LaunchEntryArgsSchema.optional(),
  })
  .strict();

/**
 * A launch entry's agent target: which agent, and its first turn. Nothing else
 * about the launch — flags, env, a preset — is the plugin's to choose, and a
 * prompt the CLI could read as an option is refused for the same reason
 * `agent.launch` refuses one from a plugin (#13762).
 */
export const LaunchEntryAgentTargetSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .refine((id) => !NON_AGENT_LAUNCH_IDS.has(id), {
        message: "agent.id must name an agent, not a panel kind",
      }),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(LAUNCH_ENTRY_PROMPT_MAX_LENGTH)
      .refine((prompt) => !prompt.startsWith("-"), {
        message: "agent.prompt must not start with '-', which an agent CLI could read as an option",
      }),
  })
  .strict();

/**
 * A launcher row (#13788). `panel`, `command` and `agent` are each optional
 * here so the object keeps a `.shape`; that exactly one is present is checked
 * with the manifest's cross-references (`launch_entry_target_*`).
 */
export const LaunchEntryContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    label: z.string().trim().min(1).max(80),
    iconId: z.string().min(1),
    description: z.string().trim().min(1).max(200).optional(),
    priority: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
    when: z.string().min(1).optional(),
    showInEmptyState: z.boolean().optional(),
    panel: LaunchEntryPanelTargetSchema.optional(),
    command: LaunchEntryCommandTargetSchema.optional(),
    agent: LaunchEntryAgentTargetSchema.optional(),
  })
  .strict();

/** Most entries one layout may arrange (#13780). */
export const LAYOUT_MAX_ENTRIES = 12;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * One entry of a named layout (#13780). `panel`, `browser` and `recipe` are
 * each optional so the object keeps a `.shape`; that exactly one is present,
 * and that a panel or recipe is this plugin's own, is checked with the
 * manifest's cross-references (`layout_*`).
 */
export const LayoutEntryContributionSchema = z
  .object({
    panel: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    browser: z
      .string()
      .min(1)
      .max(2048)
      .refine(isHttpUrl, { message: "browser must be an http: or https: URL" })
      .optional(),
    recipe: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    location: z.enum(["grid", "dock"]).optional(),
    tabGroup: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    maximized: z.boolean().optional(),
  })
  .strict();

/** A named layout (#13780): an ordered arrangement of this plugin's panels, browser pages and recipes. */
export const LayoutContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().trim().min(1).max(80),
    entries: z.array(LayoutEntryContributionSchema).min(1).max(LAYOUT_MAX_ENTRIES),
  })
  .strict();

/**
 * Where a search provider's results open (#13792): one of this plugin's own
 * panels or commands. Both are optional here so the object keeps a `.shape`;
 * that exactly one is present, and that it is this plugin's own, is checked
 * with the manifest's cross-references (`search_provider_target_*`).
 */
export const SearchProviderTargetSchema = z
  .object({
    panel: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    command: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * A quick switcher search provider (#13792). `kind` decides what answers it:
 * a declared read-only query (`query`) or a function bound in `activate()`.
 * Both kinds share one object so it keeps a `.shape`; the fields one kind
 * needs or refuses are checked with the manifest's cross-references.
 */
export const SearchProviderContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    kind: z.enum(["declarative", "runtime"]),
    title: z.string().trim().min(1).max(SEARCH_PROVIDER_TITLE_MAX_LENGTH),
    keyword: z.string().regex(SEARCH_PROVIDER_KEYWORD_PATTERN, {
      message:
        "keyword must be 1-24 lowercase letters, digits or '-', starting with a letter — the palettes' prefix characters (>, @, #, :, /) can't be keywords",
    }),
    iconId: z.string().min(1).optional(),
    blend: z.boolean().optional(),
    query: z.string().min(1).max(64).optional(),
    target: SearchProviderTargetSchema.optional(),
  })
  .strict();

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

/** Most `paths` patterns one `fileEditors` entry may declare. */
export const FILE_EDITOR_MAX_PATH_PATTERNS = 20;

/**
 * A project-relative glob a project plugin's file editor claims (#13809).
 * Forward slashes only, relative to the project or worktree root, and no way
 * out of it: no leading `/`, no drive letter, no `..` segment, no backslash,
 * no NUL, and no `!` negation (a claim says what it edits, never what it
 * doesn't).
 */
export const FileEditorPathPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (pattern) =>
      !pattern.startsWith("/") &&
      !pattern.startsWith("!") &&
      !/^[a-zA-Z]:/.test(pattern) &&
      !pattern.includes("\\") &&
      !pattern.includes("\0") &&
      !pattern.split("/").includes(".."),
    {
      message:
        "paths are project-relative globs with forward slashes — no leading /, drive letter, .. segment, backslash or ! negation",
    }
  );

/** Bare lower-case suffixes without the dot, shared by `fileEditors` and file context-menu matching. */
export const FileExtensionListSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(16)
      .regex(/^[a-z0-9]+$/, "extensions are bare lower-case suffixes without the dot")
  )
  .min(1)
  .max(20);

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
 * Validate a plugin-relative asset path (a view's `componentPath` #9229, or a
 * skill's markdown `path` #10892) at the manifest gate. Realpath containment at
 * read/request time is the security boundary (the `plugin://` protocol handler
 * for views; `resolveContainedPath` for skills); this check rejects an absolute
 * path, a Windows separator, an embedded URL scheme/query/fragment, a NUL, or a
 * `..` segment at parse time so the failure is a loud manifest-validation error,
 * not a silent 404 / read failure later. Accepts relative POSIX paths only — a
 * leading `./` is preserved.
 */
function isSafePluginAssetPath(componentPath: string): boolean {
  if (componentPath.startsWith("/")) return false;
  if (componentPath.includes("\\")) return false;
  if (componentPath.includes("\0")) return false;
  // Reject embedded URL structure markers — `https://...` (`:`), `?query`, or
  // `#fragment` — to catch typos early and avoid polluting the V8 module cache
  // with duplicate query-string variants.
  if (componentPath.includes(":")) return false;
  if (componentPath.includes("?")) return false;
  if (componentPath.includes("#")) return false;
  // A bare current-dir / root path (`.`, `./`) resolves to no module file — a
  // 404 from the protocol handler — so reject it at the manifest gate.
  const normalized = componentPath.startsWith("./") ? componentPath.slice(2) : componentPath;
  if (normalized === "" || normalized === ".") return false;
  return !componentPath.split("/").includes("..");
}

/** Whether a `when` expression reads `key`; an unparseable one reads nothing. */
function whenClauseReads(expression: string, key: string): boolean {
  let root: WhenClauseNode;
  try {
    root = parseWhenClause(expression);
  } catch {
    return false;
  }
  const visit = (node: WhenClauseNode): boolean => {
    switch (node.kind) {
      case "identifier":
        return node.path[0] === key;
      case "unary":
        return visit(node.operand);
      case "binary":
        return visit(node.left) || visit(node.right);
      default:
        return false;
    }
  };
  return visit(root);
}

/** Where a view other than a sidebar view takes its display from. */
const VIEW_DISPLAY_SOURCE: Record<Exclude<ViewContribution["location"], "sidebar">, string> = {
  panel: "the matching panel",
  settings: "the plugin's settings home",
  fileEditor: "the file panel, which labels it with the plugin's name",
};

/**
 * View contribution. A `location: "panel"` view renders into a
 * `contributes.panels` entry with a matching `id`; at plugin load
 * (`PluginService.loadPlugin`) the panels loop attaches the view's
 * `componentPath` to that panel kind. A panel view whose `id` matches no panel
 * is rejected by the manifest-level `superRefine` (#10620) — it would otherwise
 * silently never render. A `location: "settings"` view is the plugin's custom
 * settings section instead: it names no panel, and a manifest may declare at
 * most one. A `location: "fileEditor"` view backs a view-backed
 * `contributes.fileEditors` entry: it names no panel and mounts only inside the
 * file panel. A `location: "sidebar"` view is one of the sidebar's views, chosen
 * from the header switcher beside the built-in worktree list; it names no
 * panel either, and it alone carries the display fields a switcher entry
 * needs (`name`, `iconId`, `priority`, `when`). Contributed via the stable
 * `contributes.views` key (the pre-1.0 `experimental_views` name is still
 * accepted as a deprecated alias). See `docs/plugins/architecture.md`.
 */
const SETTINGS_VIEW_TITLE_MAX_LENGTH = 80;
const SETTINGS_VIEW_DESCRIPTION_MAX_LENGTH = 200;
const SETTINGS_VIEW_PAGES_MAX = 20;

/** One page of a settings view's `pages`: navigation inside the plugin's settings home. */
const SettingsViewPageSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().trim().min(1).max(SETTINGS_VIEW_TITLE_MAX_LENGTH),
    description: z.string().trim().min(1).max(SETTINGS_VIEW_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .strict();

export const ViewContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    componentPath: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "componentPath must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    // `"settings"` is the plugin's custom settings section: tied to no panel,
    // at most one per manifest (both checked in the manifest `superRefine`),
    // and mounted in the plugin's settings home below its declared fields.
    // `"fileEditor"` backs a view-backed `contributes.fileEditors` entry and
    // mounts only inside the file panel; `"sidebar"` mounts below the sidebar
    // header when chosen in its switcher.
    location: z.enum(["panel", "settings", "fileEditor", "sidebar"]),
    // For a panel view `iconId` is advisory only — the SDK `validate` command
    // flags an unrenderable id, but at runtime the matching `contributes.panels`
    // entry owns the rendered icon (the panels loop reads `panel.iconId`, never
    // the view's). A sidebar view has no panel, so its own `iconId` is the
    // switcher entry's glyph.
    iconId: z.string().min(1).optional(),
    // Sidebar views only (the manifest `superRefine` rejects them elsewhere): a
    // panel's display metadata belongs to the matching panel, which is why
    // these were removed from panel views in #10888, but a sidebar view has no
    // panel to borrow them from. `name` is required there.
    name: z.string().trim().min(1).max(SIDEBAR_VIEW_NAME_MAX_LENGTH).optional(),
    priority: z
      .number()
      .int()
      .min(SIDEBAR_VIEW_PRIORITY_MIN)
      .max(SIDEBAR_VIEW_PRIORITY_MAX)
      .optional(),
    when: z.string().min(1).optional(),
    // Settings views only (the manifest `superRefine` rejects them elsewhere):
    // what settings search shows for the custom section, and the pages the
    // host lists under it. Display and navigation only — no storage, scope or
    // permission rides on a page.
    title: z.string().trim().min(1).max(SETTINGS_VIEW_TITLE_MAX_LENGTH).optional(),
    description: z.string().trim().min(1).max(SETTINGS_VIEW_DESCRIPTION_MAX_LENGTH).optional(),
    pages: z
      .array(SettingsViewPageSchema)
      .min(1)
      .max(SETTINGS_VIEW_PAGES_MAX)
      .superRefine((pages, ctx) => {
        const seen = new Set<string>();
        pages.forEach((page, index) => {
          if (seen.has(page.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, "id"],
              message: `Settings page id "${page.id}" is declared twice — search and deep links name a page by its id.`,
              params: { errorCode: "settings_view_page_duplicate" },
            });
          }
          seen.add(page.id);
        });
      })
      .optional(),
  })
  .strict();

/**
 * Stdio-only MCP server contribution. Shape mirrors the Claude Desktop /
 * Cursor MCP server config. `url` is absent by design — HTTP/SSE transport
 * is rejected at the schema boundary. The MCP Authorization spec carves
 * stdio out of OAuth, and the official SDKs' HTTP transports have a
 * documented history of DNS-rebinding flaws (CVE-2025-66414,
 * CVE-2025-66416, CVE-2026-34742). Strict so unknown fields from plugin
 * authors are rejected loudly rather than silently dropped.
 */
export const McpServerContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * `contributes.agentMcp` manifest entry — an MCP tools endpoint the plugin
 * serves to terminal agents. Declarative only: the tool roster arrives at
 * activation through `host.mcp.registerTools`, so the manifest carries nothing
 * an agent sees beyond the name. Strict so a stray field (a `url`, a `command`)
 * is rejected rather than read as a transport the host will not honour.
 */
export const AgentMcpContributionSchema = z
  .object({
    // `.` and `..` pass the id grammar but are dot-segments in the endpoint's
    // URL path, which URL parsing removes — the endpoint would be unreachable.
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => id !== "." && id !== "..", {
        message: 'agentMcp id cannot be "." or ".."',
      }),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400).optional(),
    mode: z.literal("tools"),
  })
  .strict();

const DATABASE_FILE_EXTENSION = /\.(db|sqlite|sqlite3)$/;

/** Most params one declared query may take. */
export const DATABASE_QUERY_MAX_PARAMS = 16;

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/** The JSON Schema formats a declared string param may require; the host's validator knows each. */
export const DATABASE_QUERY_PARAM_FORMATS = [
  "date",
  "time",
  "date-time",
  "email",
  "uri",
  "uuid",
] as const;

const STRING_PARAM_CONSTRAINTS = ["minLength", "maxLength", "pattern", "format"] as const;
const NUMBER_PARAM_CONSTRAINTS = ["minimum", "maximum"] as const;

/** Whether `value` is a value of the declared param type, as the input schema checks it. */
function isParamValue(type: string, value: unknown): boolean {
  return type === "integer" ? Number.isSafeInteger(value) : typeof value === type;
}

/**
 * One param of a declared query: its JSON type, what it means, and the JSON
 * Schema constraints its value must meet. Each constraint is refused on a type
 * it cannot apply to, so a rule the author wrote is never silently skipped.
 */
export const DatabaseQueryParamSchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    description: z.string().min(1).max(400).optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    pattern: z.string().min(1).max(1024).optional(),
    format: z.enum(DATABASE_QUERY_PARAM_FORMATS).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    not: z
      .object({ const: z.union([z.string(), z.number(), z.boolean()]) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((param, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message,
        params: { errorCode: "database_query_param_constraint" },
      });
    };
    const numeric = param.type === "number" || param.type === "integer";
    for (const key of STRING_PARAM_CONSTRAINTS) {
      if (param[key] !== undefined && param.type !== "string") {
        fail(key, `${key} applies only to a "string" param, not "${param.type}"`);
      }
    }
    for (const key of NUMBER_PARAM_CONSTRAINTS) {
      const bound = param[key];
      if (bound === undefined) continue;
      if (!numeric) {
        fail(key, `${key} applies only to a "number" or "integer" param, not "${param.type}"`);
      } else if (param.type === "integer" && !Number.isSafeInteger(bound)) {
        fail(
          key,
          `${key} of an "integer" param must be an integer no larger than 2^53 - 1 in magnitude`
        );
      }
    }
    if (
      param.minLength !== undefined &&
      param.maxLength !== undefined &&
      param.minLength > param.maxLength
    ) {
      fail("minLength", `minLength ${param.minLength} is more than maxLength ${param.maxLength}`);
    }
    if (
      param.minimum !== undefined &&
      param.maximum !== undefined &&
      param.minimum > param.maximum
    ) {
      fail("minimum", `minimum ${param.minimum} is more than maximum ${param.maximum}`);
    }
    if (param.pattern !== undefined) {
      // The host's validator compiles a pattern as a Unicode expression.
      try {
        new RegExp(param.pattern, "u");
      } catch {
        fail("pattern", "pattern must be a valid Unicode regular expression");
      }
    }
    if (param.not !== undefined && !isParamValue(param.type, param.not.const)) {
      fail("not", `not.const must be a value of the param's type, "${param.type}"`);
    }
  });

/**
 * `contributes.databases[].queries` entry — one parameterised statement the
 * host serves to agents as a tool named `name`, with no plugin code. Whether
 * the host can serve it safely is decided here, from the SQL as written,
 * because the database need not exist yet: one statement, of the kind its
 * `mode` names, and placeholders that match `params` exactly. Each failure
 * names the query.
 */
export const DatabaseQueryContributionSchema = z
  .object({
    name: z.string().regex(AGENT_MCP_TOOL_NAME_PATTERN, {
      message:
        "query name must be 1-32 lowercase letters, digits and underscores, starting with a letter",
    }),
    mode: z.enum(["read", "write"]),
    description: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, { message: "description must not be blank" })
      .refine((value) => utf8Length(value) <= AGENT_MCP_MAX_DESCRIPTION_BYTES, {
        message: `description must be at most ${AGENT_MCP_MAX_DESCRIPTION_BYTES} UTF-8 bytes`,
      }),
    params: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, {
          message:
            "param names must be 1-64 letters, digits and underscores, not starting with a digit",
        }),
        DatabaseQueryParamSchema
      )
      .refine((params) => Object.keys(params).length <= DATABASE_QUERY_MAX_PARAMS, {
        message: `a query may take at most ${DATABASE_QUERY_MAX_PARAMS} params`,
      })
      .default({}),
    sql: z
      .string()
      .min(1)
      .max(65536)
      .refine((value) => !value.includes("\0"), { message: "sql must not contain NUL" }),
  })
  .strict()
  .superRefine((query, ctx) => {
    for (const problem of declaredQueryProblems(query)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [problem.field],
        message: problem.message,
        params: { errorCode: "database_query_unservable" },
      });
    }
  });

/**
 * `contributes.databases` manifest entry — a SQLite file the plugin opens
 * through `host.db`. The declaration is what names the file, discloses it, and
 * decides where it lives, so the host can resolve and contain the path before
 * the plugin ever sees it.
 *
 * `path` is only meaningful for a `"project"` database: it is relative to the
 * project root, so the committed data contract an agent reads can name the
 * same file. A `"local"` database always lives in the plugin's own data
 * directory. Strict, so a stray `url` or `driver` is refused rather than read
 * as a backend the host does not have.
 */
export const DatabaseContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    description: z.string().min(1).max(400).optional(),
    location: z.enum(["project", "local"]).default("project"),
    path: z
      .string()
      .min(1)
      .max(512)
      .refine(isSafePluginAssetPath, {
        message:
          "path must be a relative project path (no leading /, backslash, URL scheme, NUL, or .. segments)",
      })
      .refine((value) => !/(^|\/)\.git(\/|$)/i.test(value.replace(/^\.\//, "")), {
        message: "path must not be inside .git",
      })
      .refine((value) => DATABASE_FILE_EXTENSION.test(value), {
        message: "path must end in .db, .sqlite or .sqlite3",
      })
      .optional(),
    journalMode: z.enum(["delete", "wal"]).default("delete"),
    schemaVersion: z.number().int().min(0).max(100_000).optional(),
    // Capped across all of the plugin's databases by the manifest check, which
    // names the query past the limit; a per-entry cap would report first, and
    // name none.
    queries: z.array(DatabaseQueryContributionSchema).optional(),
  })
  .strict();

/**
 * `contributes.skills` manifest entry (#10892). A skill is a plugin-shipped
 * markdown file surfaced to agents via the built-in MCP server's
 * `skills.search` / `skills.load` tools. `path` reuses the shared asset-path
 * grammar guard ({@link isSafePluginAssetPath}) — the file is realpath-contained
 * to the plugin dir at read time (`resolveContainedPath` in the skill registry),
 * so this parse-time check only rejects the obviously-malformed shapes. Skills
 * are inert declarative content and carry no capability requirement. Strict so
 * unknown fields from plugin authors are rejected loudly.
 */
export const SkillContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    path: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "path must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    triggers: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

const ASSISTANT_KNOWLEDGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASSISTANT_KNOWLEDGE_PATH = z.string().min(1).max(512).refine(isSafePluginAssetPath, {
  message:
    "path must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
});
const ASSISTANT_KNOWLEDGE_MARKDOWN_PATH = ASSISTANT_KNOWLEDGE_PATH.refine(
  (value) => value.toLowerCase().endsWith(".md"),
  { message: "path must be a .md file" }
);

/**
 * One skill or reference file in `contributes.assistantKnowledge`. The id
 * becomes part of a skill's directory name, which Agent Skills limits to
 * lowercase letters, digits and single hyphens.
 */
export const AssistantKnowledgeSkillSchema = z
  .object({
    id: z.string().min(1).max(32).regex(ASSISTANT_KNOWLEDGE_ID_PATTERN),
    path: ASSISTANT_KNOWLEDGE_PATH,
  })
  .strict();

export const AssistantKnowledgeReferenceSchema = z
  .object({
    // `instructions` is where over-long instructions are handed over.
    id: z
      .string()
      .min(1)
      .max(32)
      .regex(ASSISTANT_KNOWLEDGE_ID_PATTERN)
      .refine((value) => value !== "instructions", {
        message: 'reference id "instructions" is reserved',
      }),
    path: ASSISTANT_KNOWLEDGE_MARKDOWN_PATH,
  })
  .strict();

/**
 * `contributes.assistantKnowledge` (#13828). Markdown only; every path is
 * realpath-contained to the plugin directory when it is read, as skills are.
 * Optional rather than defaulted, like `account`, so a manifest without it
 * parses exactly as before.
 */
export const AssistantKnowledgeContributionSchema = z
  .object({
    instructions: ASSISTANT_KNOWLEDGE_MARKDOWN_PATH.optional(),
    skills: z.array(AssistantKnowledgeSkillSchema).max(16).optional(),
    references: z.array(AssistantKnowledgeReferenceSchema).max(32).optional(),
  })
  .strict()
  .superRefine((knowledge, ctx) => {
    if (
      knowledge.instructions === undefined &&
      (knowledge.skills ?? []).length === 0 &&
      (knowledge.references ?? []).length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assistantKnowledge must declare instructions, skills or references",
      });
    }
    for (const list of ["skills", "references"] as const) {
      const seen = new Set<string>();
      (knowledge[list] ?? []).forEach((entry, index) => {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [list, index, "id"],
            message: `Duplicate assistantKnowledge ${list} id "${entry.id}"`,
            params: { errorCode: "duplicate_contribution_id" },
          });
        }
        seen.add(entry.id);
      });
    }
  });

/**
 * `contributes.themes` manifest entry (#13832). A theme is a palette file the
 * plugin ships, offered in Appearance under `plugin:{pluginId}:{id}` once it
 * clears the contrast gate. `path` uses the same asset-path guard as skills and
 * is realpath-contained at read time; the file's contents are validated by the
 * theme registry, which refuses the theme rather than the plugin when they
 * fail. `type` is the declared polarity the palette must match. Inert
 * declarative content, so no capability is required. Strict so unknown fields
 * fail loudly.
 */
export const ThemeContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1).max(80),
    type: z.enum(["dark", "light"]),
    path: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "path must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
  })
  .strict();

/**
 * One terminal inside a `contributes.recipes` entry (#11860). Only the
 * authorable fields — the transient per-launch overrides (`agentModelId`,
 * `agentLaunchFlags`, `location`) are session state that the recipe editor
 * already strips on persist, so a manifest declaring them is rejected loudly
 * rather than having them silently dropped.
 *
 * This validates SHAPE only. Content (control characters, an unknown `type`,
 * a non-string env value) is the sanitizer's job — `sanitizeRecipeTerminals`
 * runs over every contributed terminal at registration, which is also where a
 * `type` naming the same plugin's contributed agent is admitted.
 */
export const RecipeContributionTerminalSchema = z
  .object({
    type: z.string().min(1).max(64),
    title: z.string().max(200).optional(),
    command: z.string().max(4096).optional(),
    env: z.record(z.string(), z.string()).optional(),
    initialPrompt: z.string().max(8192).optional(),
    systemPrompt: z.string().max(SYSTEM_PROMPT_MAX_LENGTH).optional(),
    args: z.string().max(4096).optional(),
    devCommand: z.string().max(4096).optional(),
    exitBehavior: z.enum(["keep", "trash", "remove"]).optional(),
    panelId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    panelArgs: z
      .record(z.string(), z.unknown())
      .refine((args) => utf8.encode(JSON.stringify(args)).length <= RECIPE_PANEL_ARGS_MAX_BYTES, {
        message: `panelArgs must be at most ${RECIPE_PANEL_ARGS_MAX_BYTES} bytes of JSON`,
      })
      .optional(),
  })
  .strict();

/**
 * `contributes.recipes` manifest entry (#11860). A recipe is a named
 * multi-terminal launch layout registered under `{pluginId}.{id}` and merged
 * into the recipe list as a plugin-owned tier: in every project for an
 * installed plugin, in its own project only for a `scope: "project"` one.
 *
 * Terminals are inline rather than a path to a shipped JSON file: the
 * install-time confirmation reads the manifest WITHOUT extracting the archive,
 * so an out-of-line file could never be disclosed before the user approves.
 *
 * Like {@link SkillContributionSchema}, recipes carry no capability
 * requirement. `showInEmptyState` / `autoAssign` are defaults the user's
 * sidecar overrides. Strict so unknown fields fail loudly.
 */
export const RecipeContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1).max(200),
    terminals: z.array(RecipeContributionTerminalSchema).min(1).max(MAX_TERMINALS_PER_RECIPE),
    showInEmptyState: z.boolean().optional(),
    autoAssign: z.enum(["always", "never", "prompt"]).optional(),
    variables: z
      .array(
        z
          .string()
          .max(PLUGIN_RECIPE_VARIABLE_NAME_MAX_LENGTH)
          .regex(PLUGIN_RECIPE_VARIABLE_NAME_PATTERN, {
            message:
              "variable names are lowercase letters, digits and underscores, starting with a letter",
          })
      )
      .max(MAX_PLUGIN_RECIPE_VARIABLES)
      .refine((names) => new Set(names).size === names.length, {
        message: "variables must not repeat a name",
      })
      .optional(),
    requiresAgentTools: z.boolean().optional(),
  })
  .strict();

export const PromptTemplateArgumentSchema = z
  .object({
    name: z.string().regex(PROMPT_TEMPLATE_ARG_NAME_PATTERN, {
      message:
        "argument names are lowercase letters, digits and underscores, starting with a letter",
    }),
    label: z.string().min(1).max(80),
    required: z.boolean().optional(),
  })
  .strict();

/**
 * `contributes.promptTemplates` manifest entry (#13799). A template the
 * composer's command picker offers under the plugin's name; choosing it fills
 * the draft and never submits. The body's `{{name}}` references are checked
 * against `args` by the manifest-level `superRefine`. Inert declarative
 * content, so no capability is required. Strict so unknown fields fail loudly.
 */
export const PromptTemplateContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    body: z.string().min(1).max(PROMPT_TEMPLATE_MAX_BODY_LENGTH),
    args: z.array(PromptTemplateArgumentSchema).max(PROMPT_TEMPLATE_MAX_ARGS).default([]),
  })
  .strict();

/**
 * `contributes.worktreeSetupSteps` manifest entry (#13807). Declared here, not
 * at runtime, so the label and timeout the user allows are the ones that run:
 * the handler registers by id alone. Strict so unknown fields fail loudly.
 */
export const WorktreeSetupStepContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    label: z.string().trim().min(1).max(PLUGIN_WORKTREE_SETUP_STEP_LABEL_MAX),
    timeoutMs: z
      .number()
      .int()
      .min(PLUGIN_WORKTREE_SETUP_STEP_MIN_TIMEOUT_MS)
      .max(PLUGIN_WORKTREE_SETUP_STEP_MAX_TIMEOUT_MS)
      .optional(),
  })
  .strict();

/**
 * The URLs a `contributes.terminalLinks` entry claims (#13798). Host and path
 * rules that JSON Schema can't express — no IP, nothing loopback, private or
 * local-only — are applied by the manifest-level `superRefine`.
 */
export const TerminalLinkUrlSchema = z
  .object({
    scheme: z.enum(["https", "http"]).default("https"),
    host: z.string().min(1).max(TERMINAL_LINK_HOST_MAX_LENGTH),
    pathPrefix: z.string().min(1).max(TERMINAL_LINK_PATH_PREFIX_MAX_LENGTH).optional(),
  })
  .strict();

/**
 * `contributes.terminalLinks` manifest entry (#13798): terminal text a plugin
 * makes clickable, dispatching one of its own commands. Exactly one of
 * `pattern` or `url`; that rule, the pattern's safety rules and the action's
 * ownership are checked by the manifest-level `superRefine`. Declarative and
 * matched by the host on hover, so no capability is required. Strict so
 * unknown fields fail loudly.
 */
export const TerminalLinkContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    actionId: z.string().min(1).max(200),
    pattern: z.string().min(1).max(TERMINAL_LINK_PATTERN_MAX_LENGTH).optional(),
    ignoreCase: z.boolean().optional(),
    url: TerminalLinkUrlSchema.optional(),
  })
  .strict();

/**
 * Bare executable name a plugin process-tool detection matches, in the same key
 * space as the built-in `PROCESS_TOOL_REGISTRY` commands (`vite`, `redis-cli`,
 * `python3`, `gradlew`). Lowercase is enforced rather than normalized:
 * `ProcessDetector` lower-cases every candidate before lookup, so a mixed-case
 * key would silently never match — failing loudly at parse time beats a
 * detection that quietly does nothing.
 */
const PROCESS_TOOL_COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Command names that would index an inherited member on any prototype-bearing
 * lookup table. The registries this feeds are all null-prototype, so these are
 * inert in practice — rejected anyway so a manifest never advertises a command
 * whose detection depends on that invariant holding everywhere forever.
 * Mirrors {@link RESERVED_CREDENTIAL_FIELD_IDS}. (`__proto__` is already
 * excluded by the leading-alphanumeric rule above; listed for completeness.)
 */
const RESERVED_PROCESS_TOOL_COMMANDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Shells and launcher wrappers — names that identify the process *running* a
 * tool rather than a tool. None of them appear in `PROCESS_TOOL_ICON_BY_COMMAND`
 * or `AGENT_CLI_NAMES`, so the manifest-level built-in collision checks never
 * see them, yet claiming one is a wider version of the `exec`/`dlx`/`x` hole
 * {@link BINARY_EXEC_SUBCOMMANDS} already closes:
 *
 *   - `sudo vite` yields candidates `[sudo, vite]`, both at tool tier (an
 *     unregistered plugin icon id ranks there), and the leftmost wins the tie —
 *     the plugin reports itself instead of Vite.
 *   - `bash -c "vite build"` is worse: the quoted string never resolves to a
 *     registry key, so `bash` is the only match there is.
 *   - The process-tree walk turns every subshell node into a candidate, so a
 *     plugin owning `bash` tags nearly every pane and outranks the
 *     package-manager tier wherever it appears.
 *
 * Deliberately limited to shells and prefix runners. Tool-shaped launchers a
 * plugin could plausibly want to brand (`mise`, `direnv`, `npx`) stay claimable;
 * `exec`/`dlx`/`x` are handled by the neighbouring refinement.
 */
const RESERVED_PROCESS_TOOL_LAUNCHERS = new Set([
  // Shells. The process-tree walk sees these as the parent of everything a
  // user types, and `-c` hides the real command inside a quoted string.
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ash",
  "ksh",
  "csh",
  "tcsh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
  // Prefix runners: argv[0] is the wrapper, the tool sits somewhere right of it.
  "env",
  "sudo",
  "doas",
  "su",
  "command",
  "nohup",
  "setsid",
  "xargs",
  "time",
  "timeout",
  "nice",
  "stdbuf",
]);

/**
 * `contributes.processTools` manifest entry (#11613). One command name mapped
 * to the icon a terminal tab shows while that command runs. `iconId` is a
 * generic plugin icon id (`shared/config/pluginIconIds.ts`) — advisory, matching
 * `contributes.panels[].iconId`, so an unrecognized id renders a fallback glyph
 * rather than failing the load and a manifest written for a newer host degrades
 * safely. Inert declarative data, so no capability is required. Strict so
 * unknown fields (a `label` or `tier` the host would ignore) are rejected
 * loudly instead of reading as accepted.
 */
export const ProcessToolContributionSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(64)
      .regex(PROCESS_TOOL_COMMAND_PATTERN, {
        message:
          "command must be a bare lowercase executable name (letters, digits, dot, dash, underscore)",
      })
      .refine((command) => !RESERVED_PROCESS_TOOL_COMMANDS.has(command), {
        message: "command cannot be a reserved key (__proto__, constructor, prototype)",
      })
      // The detector strips launcher/script extensions off a process name before
      // looking it up, so `acme.exe` or `serve.py` would register under a key
      // nothing is ever looked up by — a detection that validates and then
      // silently never fires. Reject the non-canonical form and name the one
      // that works, rather than rewriting the author's value behind their back.
      .refine((command) => stripCommandExecutableExtension(command) === command, {
        message:
          'command must omit the executable/script extension (write "acme", not "acme.exe" or "acme.py") — detection strips it before matching',
      })
      // `npm exec vite` puts the launcher subcommand at argv[1] and the real
      // binary at argv[2]. A plugin owning `exec` would match first and win the
      // equal-tier tie by being leftmost, reporting itself for a process it
      // never launched.
      .refine((command) => !BINARY_EXEC_SUBCOMMANDS.has(command), {
        message:
          "command cannot be a package-manager exec subcommand (exec, dlx, x) — those name the launcher, not a tool",
      })
      // Same failure, wider blast radius: a shell or prefix runner sits to the
      // left of the real binary in argv and above it in the process tree, so a
      // plugin owning one wins the equal-tier tie for commands it never
      // launched — every pane, in the `bash` case.
      .refine((command) => !RESERVED_PROCESS_TOOL_LAUNCHERS.has(command), {
        message:
          "command cannot be a shell or launcher wrapper (sh, bash, zsh, cmd, env, sudo, xargs, …) — those name the process that runs a tool, not the tool",
      }),
    iconId: z.string().min(1).max(64),
  })
  .strict();

/**
 * One credential input rendered into the provider's settings form. `type` is a
 * free string (`"password"` masks the input; anything else renders plain
 * text). A provider may declare several fields, but only the primary value
 * reaches `validateToken` — see `ForgeProviderContribution.credentialFields`
 * in `shared/types/forge.ts` for the single-primary contract.
 */
const RESERVED_CREDENTIAL_FIELD_IDS = new Set(["__proto__", "constructor", "prototype"]);

export const CredentialFieldSchema = z
  .object({
    // A field id keys the entered value into a plain record at save time; a
    // reserved key (`__proto__` etc.) would resolve to the object prototype
    // rather than a stored string and crash the primary-value pick. Reject up
    // front, mirroring AgentContributionSchema.
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => !RESERVED_CREDENTIAL_FIELD_IDS.has(id), {
        message: "Credential field id cannot be a reserved key (__proto__, constructor, prototype)",
      }),
    label: z.string().min(1),
    type: z.string().min(1),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
  })
  .strict();

/**
 * `forgeProviders` manifest entry — wired: the registry populates Preferences
 * and remote-routing before any plugin code runs. See
 * `docs/architecture/forge-provider-abstraction.md`. `settingsScopeRef` and
 * `viewRefs` are cross-validated against `contributes.settings`/`contributes.views`
 * by the manifest-level `superRefine` (#10620) — a dangling ref is a parse
 * error. Two fields are validated for SHAPE only and carry no runtime authority
 * (frozen at 1.0):
 *   - `capabilities` is informational; the host gates behavior on the runtime
 *     `ForgeProviderImpl` field presence, never on these strings.
 *   - `slots` values are opaque renderer view-ids checked for non-emptiness
 *     only; the main process can't verify them against the renderer registry,
 *     and an unresolved ref renders a neutral fallback (not a parse error).
 */
export const ForgeProviderContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    matches: z.array(z.string().min(1)),
    roles: z
      .array(z.enum(["issues", "code"]))
      .min(1)
      .optional(),
    kind: z.enum(["local", "network"]).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    credentialFields: z.array(CredentialFieldSchema).optional(),
    settingsScopeRef: z.string().min(1).optional(),
    viewRefs: z.array(z.string().min(1)).optional(),
    slots: z
      .object({
        settingsTab: z.string().min(1).optional(),
        icon: z.string().min(1).optional(),
        statsDropdown: z.string().min(1).optional(),
        bulkCreateWorktreeDialog: z.string().min(1).optional(),
        issueSelector: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((contribution, ctx) => {
    const roles = contribution.roles;
    if (roles && new Set(roles).size !== roles.length) {
      ctx.addIssue({ code: "custom", path: ["roles"], message: "roles must not repeat a role" });
    }
    // Code-only isn't routable yet: every code surface reads a full provider,
    // and the workspace host fetches branch-linked issue titles from the code
    // provider. Issues-only (#13700) and both are the supported shapes.
    if (roles && !roles.includes("issues")) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: 'roles must include "issues" — a code-only provider is not supported',
      });
    }
    // Hostname matching routes the code role, so a provider serving code
    // must be reachable through it; an issues-only provider has no remote.
    const servesCode = !roles || roles.includes("code");
    // ...and an issues-only provider must not be: hostnames route the code
    // role, so a listed one would put it in the code forge's place.
    if (!servesCode && contribution.matches.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["matches"],
        message: "matches must be empty for an issues-only provider",
      });
    }
    if (servesCode && contribution.matches.length === 0) {
      ctx.addIssue({
        code: "too_small",
        origin: "array",
        minimum: 1,
        inclusive: true,
        path: ["matches"],
        message: "matches must list at least one hostname for a provider that serves code",
      });
    }
  });

/**
 * `elementPickerProviders` manifest entry (#14073): a framework the core
 * Element Picker can recognise, declared so it is known before any plugin code
 * runs. Detection is a flat list of marker names compared exactly or by prefix,
 * with no plugin-supplied regex, selector or script. `guestEntry` and
 * `resolverEntry` are packaged paths the host will load in later work. The local
 * `id` is lowercase and may not be a core framework name; the registry
 * namespaces it as `{manifest.name}.{id}`.
 */
const ELEMENT_PICKER_LOCAL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ELEMENT_PICKER_MARKER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$:.-]*$/;

export const ElementPickerDetectionRuleSchema = z
  .object({
    kind: z.enum(ELEMENT_PICKER_DETECTION_KINDS),
    name: z
      .string()
      .min(1)
      .max(ELEMENT_PICKER_PROVIDER_LIMITS.markerNameLength)
      .regex(ELEMENT_PICKER_MARKER_PATTERN, {
        message: "marker names use letters, digits and _ $ - : . only",
      }),
    match: z.enum(["exact", "prefix"]),
  })
  .strict();

export const ElementPickerProviderContributionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(ELEMENT_PICKER_LOCAL_ID_PATTERN, {
        message: "id is lowercase letters and digits, optionally hyphen-separated",
      })
      .refine((id) => !isCoreFramework(id), {
        message: "id can't be a core framework name, which Daintree reserves",
      }),
    name: z.string().trim().min(1).max(80),
    detection: z
      .array(ElementPickerDetectionRuleSchema)
      .min(1)
      .max(ELEMENT_PICKER_PROVIDER_LIMITS.rulesPerProvider),
    guestEntry: z
      .string()
      .min(1)
      .max(ELEMENT_PICKER_PROVIDER_LIMITS.entryPathLength)
      .refine(isSafePluginAssetPath, { message: "guestEntry must be a plugin-relative path" }),
    resolverEntry: z
      .string()
      .min(1)
      .max(ELEMENT_PICKER_PROVIDER_LIMITS.entryPathLength)
      .refine(isSafePluginAssetPath, { message: "resolverEntry must be a plugin-relative path" })
      .optional(),
  })
  .strict();

/**
 * `contextProviders` manifest entry (#13795): an `@{prefix}:` the agent
 * composer offers, answered by the impl the plugin binds through
 * `host.registerContextProvider`. Declared so a project's prefixes are known
 * before any plugin code runs. No capability: the host asks only after the
 * user picks, and nothing is ever sent without their Enter. Strict so unknown
 * fields fail loudly.
 */
export const ContextProviderContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    prefix: z
      .string()
      .regex(CONTEXT_PROVIDER_PREFIX_PATTERN, {
        message: "prefix is one to sixteen lowercase letters",
      })
      .refine((prefix) => !CONTEXT_PROVIDER_RESERVED_PREFIXES.has(prefix), {
        message: "prefix can't be diff, terminal or selection, which the composer reserves",
      }),
    label: z.string().min(1).max(60),
  })
  .strict();

/**
 * `fileDecorationProviders` manifest entry. Declares which scopes a plugin's
 * decoration provider handles so the host can route renderer pulls without
 * the plugin's code having run yet. Strict so unknown fields from plugin
 * authors are rejected loudly rather than silently ignored.
 */
export const FileDecorationContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    scopes: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * `worktreeDeleteNotes` manifest entry (#13805). Declared so the host can find,
 * and activate, the plugin that adds notes to a worktree's delete confirmation
 * before any of its code has run.
 */
export const WorktreeDeleteNotesContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  })
  .strict();

/**
 * Largest file a `contributes.fileEditors` entry may claim. Above this the
 * renderer holds the whole document in a CodeMirror buffer plus a draft copy,
 * so the ceiling is a memory bound, not a product limit — the built-in
 * Markdown editor asks for 2 MiB.
 */
export const FILE_EDITOR_MAX_BYTES_CEILING = 64 * 1024 * 1024;

/**
 * `fileEditors` manifest entry (#12323, #13809). Two forms, exactly one of
 * `slot` / `view`:
 *
 * - `slot` names the builtin view a built-in plugin's renderer registers for
 *   the file panel's Edit mode. Built-in plugins only — the slot resolves
 *   through the host-bundled builtin view registry. Enforced at load, where
 *   the origin is known.
 * - `view` names one of the plugin's own `location: "fileEditor"` views, and
 *   `mode` says what it fills: `"edit"` the file panel's Edit mode, `"view"`
 *   its Rendered mode for a type the host cannot render. Open to every origin.
 *
 * `extensions` are bare lower-case suffixes; `paths` are project-relative
 * globs, accepted from project plugins only (checked in the manifest
 * refinement). `default` makes a project plugin's Edit editor what its `paths`
 * open in (#13811), also checked there. Strict so a misspelt field is a
 * manifest error, not a silently missing mode.
 */
export const FileEditorContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    slot: z.string().min(1).max(128).regex(SAFE_ID_PATTERN).optional(),
    view: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    mode: z.enum(["edit", "view"]).optional(),
    extensions: FileExtensionListSchema.optional(),
    paths: z
      .array(FileEditorPathPatternSchema)
      .min(1)
      .max(FILE_EDITOR_MAX_PATH_PATTERNS)
      .optional(),
    default: z.boolean().optional(),
    maxBytes: z.number().int().positive().max(FILE_EDITOR_MAX_BYTES_CEILING).optional(),
  })
  .strict();

/**
 * One `contributes.agents` entry (#9560). `id` and `command` use the shared
 * safe-id pattern (no shell metacharacters); a contribution whose `id` collides
 * with a built-in agent is rejected by the manifest-level `superRefine`. Strict
 * so unknown fields are rejected loudly. The `agent:register` capability is
 * required — also enforced at the manifest level so the message can reference
 * the whole contribution set.
 */
const RESERVED_AGENT_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate a `contributes.agents` `command` before it is registered and later
 * spawned by node-pty. Two shapes are allowed: a bare PATH-resolvable binary
 * name (no path separators — the original `SAFE_ID_PATTERN` behavior), or an
 * explicit plugin-relative POSIX path prefixed with `./` that resolves against
 * the plugin's install dir at registration time (`pluginAgentRegistry`). The
 * `./` prefix is required for relative paths so intent is unambiguous — a bare
 * `bin/agent.mjs` would be ambiguous with a PATH name. Rejects absolute paths,
 * Windows separators, NUL, and any `..` traversal segment so the failure is a
 * loud manifest error rather than a spawn-time ENOENT or an escape from the
 * plugin dir. node-pty resolves the command before switching cwd, so the
 * relative form is resolved to an absolute path at registration, not spawn.
 */
function isSafePluginAgentCommand(command: string): boolean {
  // Bare PATH-resolvable binary name (e.g. "claude", "node") — original behavior.
  if (SAFE_ID_PATTERN.test(command)) return true;
  // Otherwise only an explicit plugin-relative POSIX path is allowed.
  if (!command.startsWith("./")) return false;
  if (command.includes("\\")) return false;
  if (command.includes("\0")) return false;
  const normalized = command.slice(2);
  if (normalized === "" || normalized === ".") return false;
  // Reject empty (`//`), current-dir (`.`), and traversal (`..`) segments so the
  // registration-time resolve cannot escape the plugin dir or normalize oddly.
  return normalized
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A single output-detection regex pattern (#10587). Compiled with `new RegExp`
 * by the pty-host activity monitor, so it must be a valid JS regex. Bounded to
 * 256 chars — the patterns run in the pty-host (a stall is observable, not a
 * web-server DoS vector), and the length cap plus the activity monitor's
 * bounded scan window keep catastrophic backtracking a contained risk without
 * pulling in a new linear-time regex dependency.
 */
const PluginDetectionPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (pattern) => {
      try {
        // Call form (not `new`) compiles and validates the pattern without a
        // constructed-but-unused instance — throws on a malformed regex.
        RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Detection pattern must be a valid regular expression" }
  );

/** A bounded array of detection regex patterns. Capped to keep a manifest from declaring an unbounded matcher set. */
const PluginDetectionPatternArraySchema = z.array(PluginDetectionPatternSchema).max(50);

/** Confidence weight in [0, 1] for a matched detection tier. */
const PluginDetectionConfidenceSchema = z.number().min(0).max(1);

/**
 * Optional output-pattern detection for a contributed agent (#10587). Mirrors
 * the host-internal `AgentDetectionConfig` (shared/config/agentRegistry.ts) so
 * a plugin agent can describe its working/waiting/completed states and join the
 * agent-state UI. Strict so a typo'd field is a loud manifest error. All
 * pattern arrays validate each entry as a compilable regex; numeric tuning
 * fields are bounded.
 */
export const AgentDetectionConfigSchema = z
  .object({
    // Required and non-empty, mirroring the host-internal `AgentDetectionConfig`
    // type (where `primaryPatterns` is non-optional): a detection block exists to
    // describe the working state, and an empty `primaryPatterns` makes
    // `buildPatternConfig` return undefined anyway. A "prompt/completion only"
    // agent without a working pattern is out of scope for the declared schema.
    primaryPatterns: PluginDetectionPatternArraySchema.min(1),
    fallbackPatterns: PluginDetectionPatternArraySchema.optional(),
    bootCompletePatterns: PluginDetectionPatternArraySchema.optional(),
    promptPatterns: PluginDetectionPatternArraySchema.optional(),
    promptHintPatterns: PluginDetectionPatternArraySchema.optional(),
    completionPatterns: PluginDetectionPatternArraySchema.optional(),
    scanLineCount: z.number().int().min(1).max(1000).optional(),
    promptScanLineCount: z.number().int().min(1).max(1000).optional(),
    debounceMs: z.number().int().min(0).max(600_000).optional(),
    promptFastPathMinQuietMs: z.number().int().min(0).max(600_000).optional(),
    primaryConfidence: PluginDetectionConfidenceSchema.optional(),
    fallbackConfidence: PluginDetectionConfidenceSchema.optional(),
    promptConfidence: PluginDetectionConfidenceSchema.optional(),
    completionConfidence: PluginDetectionConfidenceSchema.optional(),
    titleStatePatterns: z
      .object({
        working: z.array(z.string().min(1).max(256)).max(50),
        waiting: z.array(z.string().min(1).max(256)).max(50),
      })
      .strict()
      .optional(),
  })
  .strict();

/** One CLI argument a manifest hands to the agent: bounded, no line breaks or NUL. */
const PluginAgentArgSchema = z
  .string()
  .max(256)
  .refine((arg) => !/[\r\n\0]/.test(arg), {
    message: "Args cannot contain control characters (\\r, \\n, \\0)",
  });

const PluginAgentArgArraySchema = z.array(PluginAgentArgSchema).max(20);

/** The placeholder a `session-id` resume template expands to the captured id. */
const SESSION_ID_TOKEN = "{sessionId}";

const PluginAgentQuitCommandSchema = PluginAgentArgSchema.min(1).refine(
  (command) => !command.includes(SESSION_ID_TOKEN),
  { message: `A quit command can't carry ${SESSION_ID_TOKEN}` }
);

const PluginAgentStaticArgArraySchema = PluginAgentArgArraySchema.refine(
  (args) => args.every((arg) => !arg.includes(SESSION_ID_TOKEN)),
  { message: `Only a session-id resume's args can carry ${SESSION_ID_TOKEN}` }
);

/** Count the capture groups in a regex source, or `null` when it doesn't compile. */
function countCaptureGroups(source: string): number | null {
  try {
    // `|` makes the empty string match, and the match array then has one slot
    // per capture group — named, nested and escaped forms all counted by the
    // engine itself rather than by re-parsing the source here.
    return (new RegExp(`${source}|`).exec("")?.length ?? 1) - 1;
  } catch {
    return null;
  }
}

/**
 * Optional session resume for a contributed agent (#13687). Data only: the
 * `{sessionId}` template stays a string all the way into every process that
 * mirrors the plugin agent snapshot, and is expanded where a resume command is
 * built (`getEffectiveRegistry`). Only the two kinds a plugin CLI has needed are
 * exposed; `named-target` and launch-time id assignment wait for a real case.
 */
export const AgentResumeConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session-id"),
      // One occurrence across the whole template, so the id is substituted
      // exactly once whether the token is a whole arg or part of one.
      args: PluginAgentArgArraySchema.min(1).refine(
        (args) => args.join("\0").split(SESSION_ID_TOKEN).length === 2,
        { message: `A session-id resume's args must contain ${SESSION_ID_TOKEN} exactly once` }
      ),
      // Same bounds as a detection pattern, plus the single capture group the
      // teardown scrape reads the id from.
      sessionIdPattern: PluginDetectionPatternSchema.refine(
        (pattern) => countCaptureGroups(pattern) === 1,
        { message: "sessionIdPattern must have exactly one capture group" }
      )
        .refine((pattern) => !pattern.includes(SESSION_ID_TOKEN), {
          message: `sessionIdPattern can't carry ${SESSION_ID_TOKEN}`,
        })
        .optional(),
      quitCommand: PluginAgentQuitCommandSchema.optional(),
      resumeLatestArgs: PluginAgentStaticArgArraySchema.min(1).optional(),
    })
    .strict()
    // The pattern is read from what the agent prints after the quit command,
    // so a pattern with nothing to provoke it would report an exact-id capture
    // path that teardown can never run — and a bookmark would kill the pane
    // for an id it was never going to get.
    .refine((resume) => !resume.sessionIdPattern || resume.quitCommand !== undefined, {
      message: "sessionIdPattern needs a quitCommand to trigger the agent's resume hint",
      path: ["quitCommand"],
    }),
  z
    .object({
      kind: z.literal("project-scoped"),
      args: PluginAgentStaticArgArraySchema.min(1),
      quitCommand: PluginAgentQuitCommandSchema.optional(),
    })
    .strict(),
]);

export const AgentContributionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => !RESERVED_AGENT_IDS.has(id), {
        message: "Agent id cannot be a reserved key (__proto__, constructor, prototype)",
      }),
    name: z.string().min(1).max(100),
    command: z.string().min(1).max(256).refine(isSafePluginAgentCommand, {
      message:
        "command must be a bare PATH binary name or a plugin-relative path starting with ./ (no absolute path, backslash, NUL, or .. segments)",
    }),
    args: PluginAgentArgArraySchema.optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    iconId: z.string().min(1).max(64),
    supportsContextInjection: z.boolean().default(false),
    detection: AgentDetectionConfigSchema.optional(),
    resume: AgentResumeConfigSchema.optional(),
    launchMcp: z
      .object({ format: z.enum(LAUNCH_MCP_FORMATS) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Shared per-entry validator body for manifest URL fields. Each entry must:
 *
 * - Parse as a `https:` URL (no `http:`, `file:`, custom schemes).
 * - Contain no `*` substring (wildcards are rejected so a tightly-bound
 *   declaration cannot smuggle a permissive value past the manifest gate).
 * - Carry no embedded credentials (no `https://user:pass@host`).
 * - Target a multi-label hostname (at least one `.` after parse). Single-label
 *   intranet hosts are rejected to keep URLs auditable from the manifest.
 * - Not target a private/loopback/link-local address (SSRF mitigation).
 *
 * `fieldLabel` names the offending field in error messages so the same
 * discipline can back both `scopes.network.allowedUrls` and `authors[].url`
 * without leaking a misleading field name into the other's validation errors.
 */
function refinePluginHttpsUrl(value: string, ctx: z.RefinementCtx, fieldLabel: string): void {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in ${fieldLabel}: "${value}"`,
      params: { errorCode: "scope_wildcard_rejected" },
    });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entry is not a valid URL: "${value}"`,
      params: { errorCode: "scope_url_invalid" },
    });
    return;
  }
  if (parsed.protocol !== "https:") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entries must use https:// — got "${parsed.protocol}" in "${value}"`,
      params: { errorCode: "scope_url_not_https" },
    });
    return;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entries must not embed credentials: "${value}"`,
      params: { errorCode: "scope_url_has_credentials" },
    });
    return;
  }
  const hostname = parsed.hostname;
  if (isPrivateOrLoopbackHostname(hostname)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entry targets a private or loopback address: "${value}"`,
      params: { errorCode: "scope_url_private_target" },
    });
    return;
  }
  if (hostname === "" || !hostname.includes(".")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} hostnames must be multi-label (got "${hostname}" in "${value}")`,
      params: { errorCode: "scope_url_hostname_unqualified" },
    });
    return;
  }
}

/**
 * Per-entry validator for `scopes.network.allowedUrls`. See
 * {@link refinePluginHttpsUrl} for the enforced discipline.
 */
const PluginAllowedUrlSchema = z.string().superRefine((value, ctx) => {
  refinePluginHttpsUrl(value, ctx, "scopes.network.allowedUrls");
});

/**
 * Per-entry validator for `authors[].url`. Author homepage links surface as
 * user-clickable buttons in the plugin detail pane, so they carry the same
 * https-only, no-credentials, no-private-host discipline as network scopes
 * (anti-phishing / SSRF) — only the error-message field name differs.
 */
const PluginAuthorUrlSchema = z.string().superRefine((value, ctx) => {
  refinePluginHttpsUrl(value, ctx, "authors[].url");
});

/**
 * An endpoint of `contributes.account`. Fixed by the manifest so the host only
 * ever sends a code, a refresh token or an access token where the user can see
 * it would go. No fragment: a token endpoint is POSTed to, and an authorize URL
 * gets its own query appended.
 */
function accountUrlSchema(fieldLabel: string) {
  return z
    .string()
    .max(2048)
    .superRefine((value, ctx) => {
      refinePluginHttpsUrl(value, ctx, fieldLabel);
      if (value.includes("#")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldLabel} must not carry a fragment: "${value}"`,
          params: { errorCode: "account_url_fragment" },
        });
      }
    });
}

/**
 * Where "Connected as …" comes from: a GET with the access token as a bearer,
 * whose JSON response holds the name at `field` (a dotted path such as
 * `"viewer.login"`).
 */
const PluginAccountIdentitySchema = z
  .object({
    url: accountUrlSchema("contributes.account.identity.url"),
    field: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, {
        message: "identity.field must be a dotted path of plain keys, such as viewer.login",
      }),
  })
  .strict();

/** A connection test: a bearer GET to a fixed endpoint, judged by its status alone. */
const PluginAccountTestSchema = z
  .object({ url: accountUrlSchema("contributes.account.test.url") })
  .strict();

const PluginAccountBaseShape = {
  label: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(200).optional(),
  identity: PluginAccountIdentitySchema.optional(),
  test: PluginAccountTestSchema.optional(),
};

/**
 * `contributes.account` — one sign-in the host runs and stores for the plugin.
 * `oauth2` is an authorization-code flow with PKCE (S256) as a public client;
 * `token` is an API token the user pastes. The plugin only ever receives the
 * current access token.
 */
export const PluginAccountContributionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("oauth2"),
      ...PluginAccountBaseShape,
      authorizeUrl: accountUrlSchema("contributes.account.authorizeUrl"),
      tokenUrl: accountUrlSchema("contributes.account.tokenUrl"),
      clientId: z.string().trim().min(1).max(256),
      scopes: z
        .array(
          z
            .string()
            .min(1)
            .max(256)
            .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, {
              message: "scopes entries must be single OAuth scope tokens without spaces",
            })
        )
        .max(64)
        .default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("token"),
      ...PluginAccountBaseShape,
    })
    .strict(),
]);

/**
 * One `contributes.connections` entry (#14102): an account declaration plus the
 * id `host.account` and project bindings address it by.
 */
const PluginConnectionIdSchema = z.string().regex(PLUGIN_CONNECTION_ID_PATTERN, {
  message: "connection ids are 1-32 lowercase letters, digits or dashes, starting with a letter",
});

export const PluginConnectionContributionSchema = z.discriminatedUnion("kind", [
  PluginAccountContributionSchema.options[0].extend({ id: PluginConnectionIdSchema }),
  PluginAccountContributionSchema.options[1].extend({ id: PluginConnectionIdSchema }),
]);

/** Setting ids carry no length cap of their own, so a reference to one takes none either. */
const SetupSettingKeySchema = z.string().min(1).regex(SAFE_ID_PATTERN);

export const SetupStepSettingDoneSchema = z
  .object({ kind: z.literal("setting"), key: SetupSettingKeySchema })
  .strict();
export const SetupStepAccountDoneSchema = z
  .object({ kind: z.literal("account"), connection: PluginConnectionIdSchema.optional() })
  .strict();
export const SetupStepContextDoneSchema = z
  .object({ kind: z.literal("context"), when: z.string().trim().min(1).max(1024) })
  .strict();
export const SetupStepSettingsActionSchema = z
  .object({ kind: z.literal("settings"), key: SetupSettingKeySchema.optional() })
  .strict();
export const SetupStepCommandActionSchema = z
  .object({ kind: z.literal("command"), actionId: z.string().min(1).max(200) })
  .strict();

/**
 * `contributes.setup` manifest entry (#13824). A step names how the host tells
 * it's done and what clicking it does; whether those references resolve — a
 * declared setting, a declared account, a clause that parses, the plugin's own
 * command — is checked by the manifest-level `superRefine`.
 */
export const SetupStepContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(200).optional(),
    done: z.discriminatedUnion("kind", [
      SetupStepSettingDoneSchema,
      SetupStepAccountDoneSchema,
      SetupStepContextDoneSchema,
    ]),
    action: z
      .discriminatedUnion("kind", [SetupStepSettingsActionSchema, SetupStepCommandActionSchema])
      .optional(),
  })
  .strict();

/**
 * Upper bounds inside one `contributes.tours` entry. Like
 * {@link MANIFEST_CONTRIBUTION_CAPS} these reject pathological manifests rather
 * than shape authoring; a panel tour is expected to use a couple of chapters.
 * Exported so tests reference the values without magic numbers.
 */
export const TOUR_CONTRIBUTION_LIMITS = {
  chapters: 32,
  captionsPerChapter: 128,
  cuesPerChapter: 128,
  audioHosts: 8,
  chapterDurationSeconds: 600,
} as const;

/** Same shape the built-in tour's `narrationFingerprint` produces. */
const TOUR_NARRATION_HASH_PATTERN = /^[0-9a-f]{8}$/;

/** A string that opens with a URL scheme is remote audio; anything else is a bundled asset. */
const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A declared narration host is a bare, exact DNS hostname — the list is a
 * disclosure the user reads, so it must say precisely where audio comes from.
 * Round-tripping through `URL` rejects ports, paths, credentials and non-ASCII
 * spellings (their `host` differs from the input); IP literals and empty
 * labels (a leading, doubled or trailing dot) are rejected so matching stays a
 * plain case-insensitive string compare.
 * Every private/loopback literal is single-label or an IP, so those rules also
 * cover the SSRF check; `isPrivateOrLoopbackHostname` stays as a backstop.
 */
const TourAudioHostSchema = z
  .string()
  .min(1)
  .max(253)
  .superRefine((value, ctx) => {
    let host: string | null;
    try {
      host = new URL(`https://${value}/`).hostname;
    } catch {
      host = null;
    }
    const lower = value.toLowerCase();
    if (
      host !== lower ||
      value.includes("*") ||
      !value.includes(".") ||
      value.split(".").some((label) => label === "") ||
      value.startsWith("[") ||
      /^[\d.]+$/.test(value) ||
      isPrivateOrLoopbackHostname(lower)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `audioHosts entries must be bare public multi-label hostnames such as "cdn.example.com" (no scheme, port, path, wildcard or IP literal): "${value}"`,
        params: { errorCode: "tour_audio_host_invalid" },
      });
    }
  });

/**
 * A chapter's narration audio: a plugin-relative asset path, or an https URL
 * whose hostname the tour lists in `audioHosts` (checked on the tour, which
 * holds the list).
 */
const TourAudioUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((value, ctx) => {
    // URL parsing strips leading/trailing C0 controls and spaces (<= U+0020),
    // so " //host/a.mp3" would resolve remotely past the host declaration and a
    // padded https URL would not be the string the declaration was checked on.
    if (value.charCodeAt(0) <= 0x20 || value.charCodeAt(value.length - 1) <= 0x20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "audioUrl must not start or end with whitespace or control characters",
        params: { errorCode: "tour_audio_url_padded" },
      });
      return;
    }
    if (URL_SCHEME_PREFIX.test(value)) {
      refinePluginHttpsUrl(value, ctx, "tours[].chapters[].audioUrl");
      return;
    }
    if (!isSafePluginAssetPath(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "audioUrl must be an https URL or a relative plugin asset path (no leading /, backslash, NUL, or .. segments)",
        params: { errorCode: "tour_audio_path_unsafe" },
      });
    }
  });

/** One caption line, in seconds from the start of its chapter. */
export const TourCaptionSchema = z
  .object({
    start: z.number().min(0),
    end: z.number().positive(),
    text: z.string().min(1).max(500),
  })
  .strict();

/**
 * Timing for one tour chapter, mirroring the built-in tour's
 * `TourChapterTiming` plus its `narrationHash`. Cues are named scene triggers in
 * seconds; every cue and caption must fall inside the chapter's duration.
 */
export const TourChapterSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    duration: z.number().positive().max(TOUR_CONTRIBUTION_LIMITS.chapterDurationSeconds),
    cues: z.record(z.string().min(1).max(64).regex(SAFE_ID_PATTERN), z.number().min(0)).default({}),
    captions: z
      .array(TourCaptionSchema)
      .max(TOUR_CONTRIBUTION_LIMITS.captionsPerChapter)
      .default([]),
    audioUrl: TourAudioUrlSchema.nullable(),
    narrationHash: z.string().regex(TOUR_NARRATION_HASH_PATTERN, {
      message: "narrationHash must be the 8-character lowercase hex narration fingerprint",
    }),
  })
  .strict()
  .superRefine((chapter, ctx) => {
    const cues = Object.entries(chapter.cues);
    if (cues.length > TOUR_CONTRIBUTION_LIMITS.cuesPerChapter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cues"],
        message: `A chapter may declare at most ${TOUR_CONTRIBUTION_LIMITS.cuesPerChapter} cues.`,
        params: { errorCode: "tour_cues_too_many" },
      });
    }
    for (const [name, at] of cues) {
      if (at > chapter.duration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cues", name],
          message: `Cue "${name}" at ${at}s falls after the chapter's ${chapter.duration}s duration.`,
          params: { errorCode: "tour_cue_out_of_range" },
        });
      }
    }
    chapter.captions.forEach((caption, index) => {
      if (caption.end <= caption.start || caption.end > chapter.duration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["captions", index],
          message: `Caption ${index} must end after it starts and within the chapter's ${chapter.duration}s duration.`,
          params: { errorCode: "tour_caption_out_of_range" },
        });
      }
    });
  });

/**
 * What a tour's Finish does beyond closing (#14098): open this plugin's
 * settings, optionally at one setting, or run one of its own commands. The
 * same two targets a setup step offers, checked by the same manifest-level
 * rules, and dispatched as the user's click.
 */
export const TourFinishSchema = z
  .object({
    /** The line on the last end card that says what Finish will do. */
    hint: z.string().trim().min(1).max(120),
    action: z.discriminatedUnion("kind", [
      SetupStepSettingsActionSchema,
      SetupStepCommandActionSchema,
    ]),
  })
  .strict();

/**
 * One `contributes.tours` entry (#12768): a welcome tour that plays in the same
 * dialog as the Daintree tour. Without `panelKind` it is a plugin tour offered
 * from Help and the command palette; with one it is a panel tour opened from
 * that panel's menu, and the manifest-level `superRefine` requires the kind to
 * be one of this plugin's own `contributes.panels`. `componentPath` is the
 * module exporting the chapter scenes, validated like a view's.
 */
export const TourContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().min(1).max(120),
    componentPath: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "componentPath must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    panelKind: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    audioHosts: z.array(TourAudioHostSchema).max(TOUR_CONTRIBUTION_LIMITS.audioHosts).default([]),
    chapters: z.array(TourChapterSchema).min(1).max(TOUR_CONTRIBUTION_LIMITS.chapters),
    /**
     * The tour's content version. Saved progress resumes by chapter id only
     * while it matches; bump it when the content changes enough that a
     * half-watched run should start over.
     */
    version: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    finish: TourFinishSchema.optional(),
  })
  .strict()
  .superRefine((tour, ctx) => {
    const hosts = new Set<string>();
    tour.audioHosts.forEach((host, index) => {
      const lower = host.toLowerCase();
      if (hosts.has(lower)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audioHosts", index],
          message: `Duplicate audio host "${host}".`,
          params: { errorCode: "tour_audio_host_duplicate" },
        });
      }
      hosts.add(lower);
    });

    const chapterIds = new Set<string>();
    tour.chapters.forEach((chapter, index) => {
      if (chapterIds.has(chapter.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chapters", index, "id"],
          message: `Duplicate chapter id "${chapter.id}" in tour "${tour.id}".`,
          params: { errorCode: "tour_chapter_duplicate_id" },
        });
      }
      chapterIds.add(chapter.id);

      // Remote narration may only come from a host the tour declared, so the
      // list the user sees is the whole story. Malformed URLs were already
      // reported on the field itself.
      if (chapter.audioUrl === null || !URL_SCHEME_PREFIX.test(chapter.audioUrl)) return;
      let hostname: string;
      try {
        hostname = new URL(chapter.audioUrl).hostname;
      } catch {
        return;
      }
      if (!hosts.has(hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chapters", index, "audioUrl"],
          message: `audioUrl host "${hostname}" is not declared in this tour's audioHosts.`,
          params: { errorCode: "tour_audio_host_undeclared" },
        });
      }
    });
  });

/**
 * A template id names its payload folder, `project-templates/<id>/`, so it is
 * held to a portable directory name: lowercase letters, digits and single
 * hyphens. `SAFE_ID_PATTERN` would admit `.` and `..`.
 */
const PROJECT_TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One `contributes.projectTemplates` entry (#13825): a starting set of files the
 * Create project dialog offers. The files are the plugin's
 * `project-templates/<id>/` folder; the host lists them before writing and
 * copies them as they are, so nothing here names code to run.
 */
export const ProjectTemplateContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(PROJECT_TEMPLATE_ID_PATTERN, {
      message: "id must be lowercase letters, digits and single hyphens",
    }),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(300),
    iconId: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * A single attribution entry in the plugin manifest's `authors` array. `name`
 * is required; `url`, `email`, and `role` are optional. `strictObject` rejects
 * unknown keys so manifest typos surface loudly.
 */
export const PluginAuthorSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: PluginAuthorUrlSchema.optional(),
  email: z.email().optional(),
  role: z.string().trim().min(1).max(50).optional(),
});

/**
 * Matches a dynamic scope token (`${project}` / `${worktree}`) at the start of
 * an `allowedPaths` entry, with an optional `/sub/path` suffix. These expand at
 * call time against the live active project / worktree root (PluginService),
 * letting a plugin scope to "the active worktree" without a hardcoded path.
 */
const ALLOWED_PATH_TOKEN_RE = /^\$\{(?:project|worktree)\}(?:\/.*)?$/;

/**
 * Per-entry validator for `scopes.fs.allowedPaths`. Each entry must be either a
 * literal absolute path or a dynamic scope token (`${project}` / `${worktree}`,
 * optionally with a `/sub/path` suffix), with no `..` segment and no `*` glob —
 * the schema boundary is the load-bearing gate (#4593, #4702), so substring
 * `..` checks are insufficient (segment-by-segment rejection).
 */
const PluginAllowedPathSchema = z.string().superRefine((value, ctx) => {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in scopes.fs.allowedPaths: "${value}"`,
      params: { errorCode: "scope_wildcard_rejected" },
    });
    return;
  }
  const isToken = ALLOWED_PATH_TOKEN_RE.test(value);
  if (!isToken && !path.isAbsolute(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must be absolute paths or a "\${project}"/"\${worktree}" token: "${value}"`,
      params: { errorCode: "scope_path_relative" },
    });
    return;
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((seg) => seg === "..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must not contain ".." segments: "${value}"`,
      params: { errorCode: "scope_path_traversal" },
    });
    return;
  }
});

export const PluginNetworkScopeSchema = z
  .object({
    allowedUrls: z.array(PluginAllowedUrlSchema).min(1),
  })
  .strict();

/**
 * `scopes.fs.allowedPaths` is enforced at runtime: the host-mediated
 * `host.fs` / `host.git` surface realpath-contains every path argument to these
 * roots (PluginService), rejecting traversal and symlink escapes. Entries may be
 * literal absolute paths or `${project}` / `${worktree}` tokens that expand at
 * call time against the live active project / worktree. Independently, every
 * plugin is always granted an implicit per-plugin data root
 * (`~/.daintree/plugin-data/{pluginId}/`) so `allowedPaths` is optional.
 */
export const PluginFsScopeSchema = z
  .object({
    allowedPaths: z.array(PluginAllowedPathSchema).min(1),
  })
  .strict();

/**
 * A declared local socket endpoint: a Unix-domain socket path or a Windows
 * named pipe (`\\.\pipe\name`).
 *
 * Deliberately does NOT reuse {@link PluginAllowedPathSchema}: that validator
 * leans on `path.isAbsolute`, which is platform-dependent, so a manifest
 * declaring `\\.\pipe\docker_engine` would fail to parse on macOS and a
 * manifest declaring `/var/run/docker.sock` would fail on Windows. A manifest
 * must validate identically everywhere it's read — including when a Linux CI
 * box parses a plugin authored for Windows — so both forms are accepted on
 * every platform and the shape is checked explicitly.
 *
 * This is disclosure metadata, not an enforcement boundary (nothing intercepts
 * `node:net`), so the checks target author mistakes and misleading UI rather
 * than containment: no globs (a wildcard would render as a specific endpoint
 * while meaning any), no traversal segments, no NUL, no relative paths.
 */
const LOCAL_SOCKET_PATH_MAX = 512;
export const PluginAllowedSocketPathSchema = z
  .string()
  .min(1)
  .max(LOCAL_SOCKET_PATH_MAX)
  .superRefine((value, ctx) => {
    const addIssue = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (value.trim() !== value) {
      addIssue("Socket path must not have leading or trailing whitespace");
      return;
    }
    if (value.includes("\0")) {
      addIssue("Socket path must not contain a NUL character");
      return;
    }
    if (value.includes("*")) {
      addIssue("Socket path must not contain a wildcard — declare each endpoint literally");
      return;
    }
    const isWindowsPipe = /^\\\\[.?]\\pipe\\/i.test(value);
    if (isWindowsPipe) {
      if (value.length <= "\\\\.\\pipe\\".length) {
        addIssue("Windows named pipe must include a pipe name");
        return;
      }
    } else if (!value.startsWith("/")) {
      addIssue(
        "Socket path must be an absolute Unix-domain path (/var/run/docker.sock) or a Windows named pipe (\\\\.\\pipe\\name)"
      );
      return;
    }
    // Traversal is rejected for both forms. Splitting on either separator
    // matters because the check has to hold for a Windows pipe name parsed on
    // a POSIX host, where `path` would never treat `\` as a separator.
    if (value.split(/[/\\]/).includes("..")) {
      addIssue("Socket path must not contain a '..' segment");
    }
  });

/**
 * `scopes.socket.allowedPaths` — optional path intent for `socket:connect`
 * (#11299). Unlike `scopes.fs`, nothing enforces this: a plugin's `main` calls
 * `node:net` directly with no host interception point. It exists so the
 * Permissions tab can render "connects to /var/run/docker.sock" instead of the
 * bare capability, which is the whole value of the disclosure.
 */
export const PluginLocalSocketScopeSchema = z
  .object({
    allowedPaths: z.array(PluginAllowedSocketPathSchema).min(1),
  })
  .strict();

/**
 * Top-level `scopes` field on `PluginManifest`. Strict so a misspelled scope
 * bucket (e.g. `networking` instead of `network`) surfaces as a manifest error
 * rather than silently failing to attenuate the compound-capability lattice.
 */
export const PluginManifestScopesSchema = z
  .object({
    network: PluginNetworkScopeSchema.optional(),
    fs: PluginFsScopeSchema.optional(),
    socket: PluginLocalSocketScopeSchema.optional(),
  })
  .strict();

/**
 * Validates the options passed to `host.showToast`. Both the main-process path
 * (plugin `activate` code) and any future renderer path (SDK React hooks over
 * IPC) converge on this schema. `priority` and `action` are intentionally
 * absent — plugins cannot set them, so the banned `priority:"low"` +
 * `type:"error"` combo is structurally impossible. Strict so unknown fields
 * from plugin authors are rejected loudly rather than silently dropped.
 */
export const PluginToastOptionsSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    type: z.enum(["info", "success", "warning", "error"]).default("info"),
    durationMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

/** Serialized size cap for one `host.notify` action's `args`. */
const PLUGIN_NOTIFY_ARGS_MAX_BYTES = 4096;

const PluginNotifyActionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(40),
    actionId: z.string().min(1).max(200),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .refine(
        (args) => {
          if (args === undefined) return true;
          try {
            const json = JSON.stringify(args);
            return (
              json !== undefined &&
              new TextEncoder().encode(json).length <= PLUGIN_NOTIFY_ARGS_MAX_BYTES
            );
          } catch {
            return false;
          }
        },
        { message: `must be JSON-serializable and at most ${PLUGIN_NOTIFY_ARGS_MAX_BYTES} bytes` }
      ),
  })
  .strict();

const PluginNotifyTargetSchema = z.union([
  z.object({ panelId: z.string().min(1).max(256) }).strict(),
  z.object({ worktreeId: z.string().min(1).max(4096) }).strict(),
]);

/**
 * Validates `host.notify` options (#13505). Strict like the toast schema. The
 * action ids' namespace and the target's ownership are checked by the host,
 * which knows the caller.
 *
 * An error carries exactly one action, the same rule as the app's own error
 * toasts, and is never passive: a passive error would sit in the inbox with
 * nothing to say it happened (#13818).
 */
export const PluginNotifyOptionsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(2000),
    severity: z.enum(["info", "warning", "error"]).optional(),
    delivery: z.enum(["active", "passive"]).optional(),
    target: PluginNotifyTargetSchema.optional(),
    actions: z
      .array(PluginNotifyActionSchema)
      .max(PLUGIN_NOTIFY_MAX_ACTIONS)
      .optional()
      .refine((actions) => !actions || new Set(actions.map((a) => a.id)).size === actions.length, {
        message: "action ids must be unique",
      }),
    os: z.boolean().optional(),
    dedupeKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((options, ctx) => {
    if (options.severity === "error" && options.actions?.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["actions"],
        message: 'an "error" notification needs exactly one action, the way out of it',
      });
    }
    if (options.delivery === "passive" && options.severity === "error") {
      ctx.addIssue({
        code: "custom",
        path: ["delivery"],
        message: 'an "error" notification can\'t be passive',
      });
    }
    if (options.delivery === "passive" && options.os === true) {
      ctx.addIssue({
        code: "custom",
        path: ["os"],
        message: "a passive notification stays in the inbox and can't page the OS",
      });
    }
  });

const PluginPanelBadgeColorSchema = z.enum(["default", "success", "warning", "error"]);
const PluginPanelBadgeTooltipSchema = z.string().trim().min(1).max(200).optional();

/**
 * Validates a `host.setPanelBadge` badge at the host boundary. Discriminated on
 * `kind`; the `label` text is rejected (not truncated) past
 * {@link PLUGIN_PANEL_BADGE_LABEL_MAX} characters so it can't overflow the
 * panel header — consistent with the reject-on-overflow convention of the other
 * length-capped strings in this file. `null` (clear) is handled at the call
 * site, not here.
 */
export const PluginPanelBadgeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("dot"),
      color: PluginPanelBadgeColorSchema.optional(),
      tooltip: PluginPanelBadgeTooltipSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("label"),
      text: z.string().trim().min(1).max(PLUGIN_PANEL_BADGE_LABEL_MAX),
      color: PluginPanelBadgeColorSchema.optional(),
      tooltip: PluginPanelBadgeTooltipSchema,
    })
    .strict(),
]);

const PluginToolbarButtonStateTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(PLUGIN_TOOLBAR_BUTTON_STATE_TEXT_MAX)
  .optional();

/**
 * Validates a `host.setToolbarButtonState` state at the host boundary (#13785).
 * A disabled button must say why, and a reason without `disabled` is a mistake
 * rather than a no-op, so both are rejected. `null` (clear) is handled at the
 * call site, not here.
 */
export const PluginToolbarButtonRuntimeStateSchema = z
  .object({
    pressed: z.boolean().optional(),
    disabled: z.boolean().optional(),
    disabledReason: PluginToolbarButtonStateTextSchema,
    busy: z.boolean().optional(),
    tooltip: PluginToolbarButtonStateTextSchema,
    iconId: z.string().min(1).max(256).optional(),
    // Items are vetted (own namespace, no repeats) by `normalizePanelMenuItems`
    // at the call site, which also rewrites them into the instance namespace.
    menu: z.array(PanelMenuItemSchema).max(PANEL_MENU_MAX_ITEMS).optional(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.disabled === true && state.disabledReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disabledReason"],
        message: "a disabled button needs a disabledReason",
      });
    }
    if (state.disabled !== true && state.disabledReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disabledReason"],
        message: "disabledReason is only valid with disabled: true",
      });
    }
  });

/**
 * One `contributes.settings` field declaration (#9301). `type` is optional
 * (renders as a text field when omitted); the legacy `secret: true` flag is
 * normalized to `type: "secret"` by the transform so downstream consumers only
 * switch on `type`. A plain object (not `discriminatedUnion`) is used because
 * `type` is optional on the string/number/boolean branch. Strict so a misspelled
 * field key surfaces as a manifest error rather than silently dropping.
 */
export const SettingDefinitionObjectSchema = z
  .object({
    // Constrained to the shared safe-id grammar so a declared setting id can
    // always be referenced by a `${settings:id}` token — the MCP supervisor's
    // substitution gate (`SETTINGS_TEMPLATE_RE` in PluginMcpSupervisor.ts) only
    // matches `[a-zA-Z0-9._-]+`, so an id outside that grammar could be declared
    // but never resolved at runtime.
    id: z.string().min(1).regex(SAFE_ID_PATTERN),
    type: z
      .enum(["string", "number", "boolean", "enum", "json", "secret", "path", "directory", "file"])
      .optional(),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    default: z.unknown().optional(),
    scope: z.enum(["user", "project", "local"]).default("user"),
    options: z.array(z.string().min(1)).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    // Advisory existence check for path/directory/file fields — the form flags a
    // stored path that no longer resolves; it does not gate saving.
    mustExist: z.boolean().optional(),
    // File-extension filter for type: "file" (no leading dot). Non-empty when present.
    extensions: z.array(z.string().min(1)).min(1).optional(),
    secret: z.boolean().optional(),
    // Drives the panel "needs setup" strip and `host.settings.missingRequired`.
    required: z.boolean().optional(),
    // "view": the plugin's own settings section edits this value, so the
    // generated form leaves it out rather than showing it twice.
    editor: z.enum(["form", "view"]).optional(),
  })
  .strict();

/**
 * The validated `contributes.settings` entry: the object base plus the
 * cross-field refinement and the `secret → type: "secret"` normalization.
 * The unrefined {@link SettingDefinitionObjectSchema} is exported separately so
 * the field-consumer contract test can enumerate `.shape` without reaching
 * through the transform wrapper.
 */
export const SettingDefinitionSchema = SettingDefinitionObjectSchema.superRefine((val, ctx) => {
  const effectiveType = val.secret === true ? "secret" : (val.type ?? "string");
  if (effectiveType === "enum" && (!val.options || val.options.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Settings of type "enum" require a non-empty options array',
      path: ["options"],
    });
  }
  if (val.min !== undefined && val.max !== undefined && val.min > val.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Setting min cannot be greater than max",
      path: ["min"],
    });
  }
  // `extensions` narrows the native file chooser — it is only meaningful for
  // `type: "file"`. Reject it on every other type at the manifest gate so a
  // misplaced filter surfaces loudly instead of silently doing nothing.
  // A secret's default would ship in plugin.json — committed to the plugin's
  // repository and readable by anyone who has it — which is the one place a
  // credential must never live. It would also silently stand in for a key the
  // user never entered. Rejected at the gate rather than ignored.
  if (val.default !== undefined && effectiveType === "secret") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Settings of type "secret" cannot declare a default — it would ship in plugin.json. Leave it unset and mark it required instead.',
      path: ["default"],
    });
  }
  if (val.extensions !== undefined && effectiveType !== "file") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Setting "extensions" is only valid for type "file"',
      path: ["extensions"],
    });
  }
}).transform((val) => {
  if (val.secret === true && val.type !== "secret") {
    return { ...val, type: "secret" as const };
  }
  return val;
});

/**
 * A surface slot that renders a plugin view: `viewId` names an entry in this
 * manifest's own `contributes.views`, cross-checked in `superRefine` exactly
 * like `forgeProviders.viewRefs` (#10620) — a dangling id would mount nothing
 * and leave the slot blank with no diagnostic.
 */
export const SurfaceViewSlotSchema = z
  .object({
    viewId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  })
  .strict();

/**
 * `contributes.surfaces` (§7.8) — the project surfaces a project-local plugin
 * may own, so a project can present as a purpose-built application rather than
 * as a host with one extra panel.
 *
 * Additive and slot-replacing only. Nothing here removes host chrome: the
 * project switcher, the worktree dashboard and the stock launcher stay
 * reachable in every case, which is the boundary that keeps a broken plugin
 * from stranding the user with no way back. Available to `scope: "project"`
 * plugins alone — an installed plugin claiming a project's surfaces is exactly
 * what locality is supposed to rule out. Each key is a slot in
 * `PROJECT_SURFACE_SLOT_CATALOGUE`; at most one plugin holds an exclusive slot
 * per project, arbitrated at load by `PluginSurfaceRegistry` in a fixed order
 * (project plugins first, then the lower manifest id), and every other claimant
 * is refused by name.
 *
 * `emptyCanvas` stands in for the launcher while the grid is empty;
 * `projectHome` is a persistent Home the main area can switch to beside the
 * grid, which stays one click away; `worktreeCreate` opens a view as the New
 * worktree dialog, with the stock dialog one click away.
 *
 * `defaultLayout` (#13782) is not a slot: it replaces nothing the host draws.
 * It names one of this manifest's own `contributes.layouts`, which the host
 * opens once, on the project's first open on this machine, while the grid and
 * dock are still empty — and offers instead once the user has opened anything.
 * Its recipes never start on their own; they wait as click-to-start entries.
 */
export const SurfaceContributionsSchema = z
  .object({
    emptyCanvas: SurfaceViewSlotSchema.optional(),
    projectHome: SurfaceViewSlotSchema.optional(),
    worktreeCreate: SurfaceViewSlotSchema.optional(),
    defaultLayout: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
  })
  .strict();

/**
 * Per-array upper bounds for `contributes.*`. A crafted manifest with tens of
 * thousands of entries would otherwise exhaust the registration loops in
 * `PluginService.loadPlugin`. These caps are generous relative to any plausible
 * real plugin — they exist to reject pathological/adversarial manifests, not to
 * constrain legitimate authors. Exported so tests reference the values without
 * magic numbers. Keyed by the stable (canonical) contribution names — the
 * deprecated `experimental_*` aliases are normalized to these before the cap
 * check runs (see `normalizeDeprecatedContributionAliases`).
 */
export const MANIFEST_CONTRIBUTION_CAPS = {
  panels: 50,
  toolbarButtons: 100,
  // Small on purpose, unlike the rest: these are rows in a shared launcher, and
  // one plugin must not be able to bury everyone else's.
  launchEntries: 20,
  layouts: 20,
  // Each claims a keyword in a shared switcher, so a plugin gets a handful.
  searchProviders: 5,
  menuItems: 200,
  keybindings: 200,
  contextMenus: 200,
  commands: 200,
  views: 50,
  mcpServers: 20,
  skills: 50,
  themes: 20,
  promptTemplates: 50,
  terminalLinks: TERMINAL_LINK_MAX_PER_PLUGIN,
  contextProviders: 10,
  forgeProviders: 20,
  elementPickerProviders: 20,
  fileDecorationProviders: 50,
  // One check per plugin: the confirmation shows one attributed answer (or one
  // "didn't answer") per plugin, never a partial answer.
  worktreeDeleteNotes: 1,
  fileEditors: 10,
  agents: 50,
  processTools: 100,
  settings: 200,
  recipes: 50,
  agentMcp: AGENT_MCP_MAX_ENDPOINTS_PER_PLUGIN,
  tours: 10,
  // Each is a choice in the Create project dialog's template list.
  projectTemplates: 10,
  databases: 16,
  // Each one runs, in sequence, before a new worktree is ready.
  worktreeSetupSteps: 10,
  // A checklist the user reads through; a long one isn't setup any more.
  setup: 10,
  // Each is a row the user signs in to by hand.
  connections: 8,
} as const;

/**
 * Upper bound on the top-level `authors` array. Attribution is metadata, not a
 * registration loop, so the cap is small — generous for any real plugin's
 * credits list while rejecting pathological manifests. Exported so tests
 * reference it without a magic number.
 */
export const MANIFEST_AUTHORS_CAP = 10;

/**
 * Upper bound on the top-level `worksWith` array. It names plugins to disclose
 * beside this one, never ones the host loads, so a short list is all it needs.
 */
export const MANIFEST_WORKS_WITH_CAP = 16;

/**
 * Deprecated `contributes` keys promoted to stable names in the 1.0 freeze.
 * Old manifests are still accepted (the value is migrated to the canonical key);
 * `PluginService` surfaces a deprecation warning when an alias is encountered.
 */
export const DEPRECATED_CONTRIBUTION_ALIASES = {
  experimental_views: "views",
  experimental_mcpServers: "mcpServers",
} as const;

/**
 * Normalizes deprecated `contributes` aliases to their canonical names before
 * strict validation, so the frozen schema never carries an `experimental_*`
 * field while old manifests keep parsing. The canonical key wins when both are
 * present; the deprecated key is always stripped so `strictObject` accepts it.
 */
function normalizeDeprecatedContributionAliases(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const [deprecated, canonical] of Object.entries(DEPRECATED_CONTRIBUTION_ALIASES)) {
    if (!(deprecated in obj)) {
      continue;
    }
    next ??= { ...obj };
    // Canonical wins when present — an explicit `views: []` is canonical and is
    // NOT overwritten by a deprecated value. Only fall back to the deprecated
    // value when the canonical key is missing (`undefined`/`null`), so a manifest
    // mixing `views: null` with `experimental_views: [...]` recovers gracefully
    // instead of failing on the null.
    if (next[canonical] == null) {
      next[canonical] = next[deprecated];
    }
    delete next[deprecated];
  }
  return next ?? obj;
}

/**
 * `z.record` skips an own `__proto__` key before validating it, so a cue named
 * that would vanish from `contributes.tours[].chapters[].cues` without a word.
 * Refuse it while the raw JSON still carries it. This runs in the `contributes`
 * preprocess rather than on the `cues` field because a preprocess below a
 * `.default()` makes the JSON Schema emitter drop every default above it.
 */
function reportReservedTourCueNames(raw: unknown, ctx: z.RefinementCtx): void {
  const tours = (raw as { tours?: unknown } | null)?.tours;
  if (!Array.isArray(tours)) return;
  tours.forEach((tour, tourIndex) => {
    const chapters = (tour as { chapters?: unknown } | null)?.chapters;
    if (!Array.isArray(chapters)) return;
    chapters.forEach((chapter, chapterIndex) => {
      const cues = (chapter as { cues?: unknown } | null)?.cues;
      if (typeof cues === "object" && cues !== null && Object.hasOwn(cues, "__proto__")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tours", tourIndex, "chapters", chapterIndex, "cues"],
          message: 'Cue name "__proto__" is reserved.',
          params: { errorCode: "tour_cue_name_reserved" },
        });
      }
    });
  });
}

/**
 * `contributes.*` groups a `scope: "project"` plugin may not declare, each with
 * the structural reason it cannot yet be narrowed to one project.
 *
 * The dividing line is {@link
 * ../services/plugin/PluginContributionBroadcaster.js}: the groups it filters by
 * owning plugin id (panels, commands/actions, toolbarButtons, launchEntries, layouts,
 * keybindings, contextMenus, recipes) reach only the owning project's views, and `settings`
 * resolves through the bound instance handle. Everything here registers into a
 * registry with no project axis — a single app menu, one agent roster mirrored
 * into the shared pty-host, one detection table for every terminal — so the
 * contribution is published app-wide no matter which project loaded it.
 *
 * Exported so tests enumerate the set instead of restating it, and so a group
 * that later grows a project axis is removed in exactly one place.
 */
export const PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS = [
  [
    "menuItems",
    "the application menu is one OS-level menu shared by every window, with no per-project projection — the item would stay on the menu bar while a different project is focused and dispatch into it.",
  ],
  [
    "agents",
    "the plugin agent roster is a single app-wide registry mirrored into the shared pty-host, and an agent's launch identity is persisted into terminals and sessions that outlive the project binding — the agent would be launchable from every project.",
  ],
  [
    "processTools",
    "process-tool detections are mirrored into the shared pty-host as one detection table for every terminal in the app, so the icon mapping would apply to every project's processes.",
  ],
  [
    "mcpServers",
    "contributed MCP servers run under one app-wide supervisor whose tools Daintree and its in-app Assistant call with no project binding to check the contribution against. To serve tools to this project's agents, declare contributes.agentMcp instead.",
  ],
  [
    "themes",
    "the app theme is one machine-wide selection painted into every window and every project's view, so there is no per-project theme for the contribution to narrow to.",
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

/** The schema {@link getPluginManifestSchema} hands back, for the overloads. */
type PluginManifestSchema = ReturnType<typeof buildPluginManifestSchema>;

/**
 * Builds the manifest schema for a given discovery root.
 *
 * `origin` is what the three-way rules key off: the reserved `daintree.*`
 * namespace (builtin only), and the `scope: "project"` gate in both directions
 * (required under `"project"`, rejected under the other two).
 */
export function getPluginManifestSchema(origin: PluginOrigin): PluginManifestSchema;
/**
 * @deprecated Pass a {@link PluginOrigin}. Transitional bridge for call sites
 * still on the old two-valued flag — `true` maps to `"builtin"`, `false` to
 * `"user"`, which is exactly what the boolean meant. It cannot express
 * `"project"`, so every caller that needs to must move to the string form; the
 * overload goes away once the last boolean caller does.
 */
export function getPluginManifestSchema(isBuiltin: boolean): PluginManifestSchema;
export function getPluginManifestSchema(origin: PluginOrigin | boolean): PluginManifestSchema {
  const key = typeof origin === "boolean" ? (origin ? "builtin" : "user") : origin;
  let schema = manifestSchemaCache.get(key);
  if (!schema) {
    schema = buildPluginManifestSchema(key);
    manifestSchemaCache.set(key, schema);
  }
  return schema;
}

/**
 * One schema per origin. Zod schemas are immutable, and rebuilding the ~800-line
 * tree per parse also threw away the parser zod compiles on first use.
 */
const manifestSchemaCache = new Map<PluginOrigin, PluginManifestSchema>();

/**
 * Parse a manifest for loading, isolating malformed `contributes.tours` entries
 * (#12768): a tour is optional polish, so a bad one is dropped and its issues
 * returned as `droppedTourIssues` rather than refusing the whole plugin. Only
 * issues addressed to a single tour entry are isolated — a cap overflow or the
 * project-scope refusal sits on the array itself and still fails the parse, as
 * does any other issue. Authoring surfaces (`daintree-plugin validate`, the
 * installer) keep the strict parse so the author still sees every error.
 */
export function parsePluginManifestForLoad(
  origin: PluginOrigin,
  json: unknown
): {
  result: ReturnType<PluginManifestSchema["safeParse"]>;
  droppedTourIssues: z.core.$ZodIssue[];
} {
  const schema = getPluginManifestSchema(origin);
  const result = schema.safeParse(json);
  const raw = json as { contributes?: { tours?: unknown } } | null;
  if (result.success || !Array.isArray(raw?.contributes?.tours)) {
    return { result, droppedTourIssues: [] };
  }

  // Manifest-level refinements (duplicate ids, panelKind) may be withheld while
  // an entry is still malformed, so a drop can surface another round. Each
  // round removes at least one entry, which bounds the loop by the array length.
  let tours: unknown[] = raw.contributes.tours;
  let originalIndex = tours.map((_tour, index) => index);
  let current: ReturnType<PluginManifestSchema["safeParse"]> = result;
  const dropped: z.core.$ZodIssue[] = [];
  while (!current.success) {
    const bad = new Set<number>();
    for (const issue of current.error.issues) {
      const [root, group, index, ...rest] = issue.path;
      if (root !== "contributes" || group !== "tours" || typeof index !== "number") {
        return { result, droppedTourIssues: [] };
      }
      bad.add(index);
      dropped.push({ ...issue, path: ["contributes", "tours", originalIndex[index], ...rest] });
    }
    tours = tours.filter((_tour, index) => !bad.has(index));
    originalIndex = originalIndex.filter((_original, index) => !bad.has(index));
    current = schema.safeParse({ ...raw, contributes: { ...raw.contributes, tours } });
  }
  return { result: current, droppedTourIssues: dropped };
}

/**
 * Edit distance, capped: anything past `max` is "not a near miss" and the walk
 * can stop. Only ever run against the handful of manifest field names, so the
 * quadratic table is a few dozen cells.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The manifest field `key` was probably meant to be, or undefined when nothing
 * is close enough to be worth guessing at. A singular/plural slip counts
 * whatever its edit distance — `author` for `authors` is the one this was
 * written for (#12212) — and otherwise a short field name gets one edit of
 * latitude and a longer one gets two.
 */
export function suggestManifestKey(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  // Every candidate is scored before one is chosen. Returning on the first
  // acceptable match let a plural shortcut win over an exact one that came
  // later in the shape — `"Scopes"` matched `scope` and never reached `scopes`.
  let best: string | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const candidateLower = candidate.toLowerCase();
    // Rank, not distance: an exact match beats a plural slip beats an edit.
    const rank =
      candidateLower === lower
        ? 0
        : candidateLower === `${lower}s` || `${candidateLower}s` === lower
          ? 1
          : (() => {
              const budget = Math.min(candidate.length, key.length) >= 5 ? 2 : 1;
              const distance = editDistance(lower, candidateLower, budget);
              return distance <= budget ? 1 + distance : Number.POSITIVE_INFINITY;
            })();
    if (rank < bestRank) {
      best = candidate;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return best;
}

/**
 * Turn a rejected manifest into the one line a plugin author can act on.
 *
 * An unrecognized key wins over whatever Zod reported first, because a key the
 * schema has never heard of is almost always a typo, and a typo is the single
 * most fixable thing in the list — `"author"` for `authors` cost a real
 * debugging session with no signal anywhere but a red row in the plugin
 * manager (#12212). Everything else keeps the existing `path: message` shape.
 *
 * Pure formatting over data the parse already produced: it reads nothing from
 * disk and executes nothing, so it is safe on the pre-trust discovery path.
 */
export function describeManifestIssues(
  issues: readonly z.core.$ZodIssue[],
  schema: PluginManifestSchema
): string {
  // Only a ROOT unrecognized key can be scored against the manifest's own
  // shape. A stray key nested under `contributes` is a different vocabulary
  // entirely, and matching it against the root would suggest a field that is
  // invalid exactly where the author put it — `version` inside `contributes`
  // "did you mean version?" being the absurd case.
  // An explicit type predicate: narrowing on `code` alone would be inferred,
  // but adding the path test to the same expression loses it.
  const unrecognized = issues.find(
    (issue): issue is Extract<z.core.$ZodIssue, { code: "unrecognized_keys" }> =>
      issue.code === "unrecognized_keys" && issue.path.length === 0
  );
  if (unrecognized) {
    const suggestions = unrecognized.keys
      .map((key) => {
        const suggestion = suggestManifestKey(key, Object.keys(schema.shape));
        return suggestion ? `did you mean "${suggestion}" instead of "${key}"?` : null;
      })
      .filter((hint): hint is string => hint !== null);
    // A key nothing resembles is not more actionable than whatever Zod
    // reported first, so it does not get to displace it.
    if (suggestions.length > 0) {
      return `${unrecognized.message} — ${suggestions.join(" ")}`;
    }
  }

  const first = issues[0];
  const where = first?.path.length ? `${first.path.join(".")}: ` : "";
  return `${where}${first?.message ?? "manifest failed validation"}`;
}

// `docs` and `runbooks` would name a plugin's server `daintree-docs` or
// `daintree-runbooks`, the Daintree Assistant's own servers. Excluded in the
// pattern itself, not a refinement, so the generated JSON Schema rejects them too.
const PLUGIN_MCP_NAME_PATTERN = /^(?!(?:docs|runbooks)$)[a-z0-9][a-z0-9-]{0,15}$/;

/** `application.welcomeTour`: a tour of this plugin and its welcome revision. */
export const PluginApplicationTourRefSchema = z.strictObject({
  id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

const NAVIGATION = PLUGIN_APPLICATION_NAVIGATION_LIMITS;

const navigationParamFlags = {
  required: z.boolean().optional(),
  persist: z.boolean().optional(),
};

/** One declared section parameter: an identifier string, a safe integer or a flag (#14108). */
export const PluginApplicationNavigationParamSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    ...navigationParamFlags,
    maxLength: z.number().int().min(1).max(NAVIGATION.maxStringLength).optional(),
  }),
  z.strictObject({ type: z.literal("integer"), ...navigationParamFlags }),
  z.strictObject({ type: z.literal("boolean"), ...navigationParamFlags }),
]);

export const PluginApplicationSectionSchema = z.strictObject({
  id: z.string().min(1).max(NAVIGATION.maxIdLength).regex(SAFE_ID_PATTERN),
  title: z.string().trim().min(1).max(NAVIGATION.maxTitleLength),
  params: z
    .record(
      z
        .string()
        .min(1)
        .max(NAVIGATION.maxParamNameLength)
        .regex(SAFE_ID_PATTERN)
        .refine((name) => !isReservedNavigationParamName(name), {
          message: "A parameter can't be named __proto__, constructor or prototype.",
        }),
      PluginApplicationNavigationParamSchema
    )
    .refine((params) => Object.keys(params).length <= NAVIGATION.maxParamsPerSection, {
      message: `A section declares at most ${NAVIGATION.maxParamsPerSection} parameters.`,
    })
    .optional(),
});

/**
 * `application.navigation` (#14108): the sections the application's views
 * navigate between. Self-contained — a section names no view or command, so
 * it is checked here rather than against the rest of the manifest.
 */
export const PluginApplicationNavigationSchema = z
  .strictObject({
    version: z.number().int().min(1).max(NAVIGATION.maxVersion),
    defaultSectionId: z.string().min(1).max(NAVIGATION.maxIdLength).regex(SAFE_ID_PATTERN),
    sections: z.array(PluginApplicationSectionSchema).min(1).max(NAVIGATION.maxSections),
  })
  .superRefine((navigation, ctx) => {
    const seen = new Set<string>();
    navigation.sections.forEach((section, index) => {
      if (seen.has(section.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sections", index, "id"],
          message: `application.navigation declares section "${section.id}" twice.`,
          params: { errorCode: "application_navigation_section_duplicate" },
        });
      }
      seen.add(section.id);
    });
    const fallback = navigation.sections.find(
      (section) => section.id === navigation.defaultSectionId
    );
    if (fallback === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultSectionId"],
        message: `application.navigation.defaultSectionId "${navigation.defaultSectionId}" matches no section.`,
        params: { errorCode: "application_navigation_default_unknown" },
      });
    } else if (Object.values(fallback.params ?? {}).some((param) => param.required === true)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultSectionId"],
        message: `application.navigation.defaultSectionId "${fallback.id}" requires parameters — the default is where a location that no longer resolves lands, so it must open with none.`,
        params: { errorCode: "application_navigation_default_requires_params" },
      });
    }
  });

/** Longest `application.name`, matching a sidebar view's name. */
export const PLUGIN_APPLICATION_NAME_MAX = 64;

/**
 * The top-level `application` descriptor (#14097). Every reference is a bare
 * id the same manifest declares; the manifest `superRefine` resolves each one
 * and confines the block to `scope: "project"`. The presentation vocabulary
 * needs only the block itself, so it is checked here.
 */
export const PluginApplicationSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(PLUGIN_APPLICATION_NAME_MAX),
    iconId: z.string().min(1).max(200).optional(),
    destination: z.enum(PLUGIN_APPLICATION_DESTINATIONS),
    arrangement: z.enum(PLUGIN_APPLICATION_ARRANGEMENTS).optional(),
    sidebarViewId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    settingsViewId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    welcomeTour: PluginApplicationTourRefSchema.optional(),
    firstWorkflow: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    // Capped at the endpoints a plugin may declare, so each names a different one.
    requiredTools: z
      .array(z.string().min(1).max(64).regex(SAFE_ID_PATTERN))
      .max(AGENT_MCP_MAX_ENDPOINTS_PER_PLUGIN)
      .optional(),
    presentation: z.record(z.string(), z.enum(PRESENTATION_LEVELS)).optional(),
    navigation: PluginApplicationNavigationSchema.optional(),
  })
  .superRefine((application, ctx) => {
    if (application.arrangement !== undefined && application.destination !== "home") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arrangement"],
        message:
          'application.arrangement arranges a Home, so it needs destination "home"; a grid destination has nothing to arrange.',
        params: { errorCode: "application_arrangement_needs_home" },
      });
    }
    for (const [feature, level] of Object.entries(application.presentation ?? {})) {
      if (!isPresentationFeatureId(feature)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presentation", feature],
          message: `application.presentation names "${feature}", which is not a presentation feature (${PRESENTATION_FEATURE_IDS.join(", ")}).`,
          params: { errorCode: "application_presentation_unknown" },
        });
      } else if (!isLevelAllowed(feature, level)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presentation", feature],
          message: `application.presentation sets "${feature}" to "${level}", a level that feature does not offer.`,
          params: { errorCode: "application_presentation_level" },
        });
      }
    }
  });

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

function buildPluginManifestSchema(origin: PluginOrigin) {
  return z
    .strictObject({
      // Editors and agents key completion and inline validation off `$schema`,
      // and the object is strict, so without an explicit slot a manifest that
      // names its own contract is refused for naming it. Accepted, never read:
      // the host's authority is this schema, not whatever the URL resolves to.
      $schema: z.string().optional(),
      name: z.string().min(1).max(64).regex(SCOPED_PLUGIN_NAME_PATTERN, {
        error: 'Plugin name must be in publisher.name format (e.g. "acme.linear-context")',
      }),
      version: z
        .string()
        .trim()
        .min(1)
        .refine((val) => semver.valid(val) !== null, {
          message: "version must be a valid semver (e.g. 1.2.3)",
        }),
      displayName: z.string().optional(),
      // Agents see the plugin's MCP server as `daintree-<mcpName>`, which must
      // fit Claude's 25-character server key and be a bare TOML key for Codex.
      mcpName: z
        .string()
        .regex(PLUGIN_MCP_NAME_PATTERN, {
          error:
            'mcpName must be 1-16 lowercase letters, digits or hyphens, starting with a letter or digit, and not "docs" or "runbooks"',
        })
        .optional(),
      description: z.string().optional(),
      tagline: z.string().trim().min(1).max(120).optional(),
      authors: z.array(PluginAuthorSchema).max(MANIFEST_AUTHORS_CAP).optional(),
      // Other plugins this one works with, by manifest id. Disclosure only:
      // nothing is installed, loaded or ordered from it.
      worksWith: z
        .array(z.string().min(1).max(64).regex(SCOPED_PLUGIN_NAME_PATTERN))
        .max(MANIFEST_WORKS_WITH_CAP)
        .refine((list) => new Set(list).size === list.length, {
          message: "worksWith must not repeat an entry",
        })
        .optional(),
      category: z.enum(PLUGIN_CATEGORY_IDS).optional(),
      main: z.string().optional(),
      engines: z
        .object({
          daintree: z
            .string()
            .trim()
            .min(1)
            .refine((val) => semver.validRange(val) !== null, {
              message: "engines.daintree must be a valid semver range",
            })
            .optional(),
        })
        .optional(),
      // Declares the plugin is only ever loaded project-locally. Shape only
      // here — whether it is required, optional-but-rejected, or absent is a
      // function of the discovering `origin`, enforced in `superRefine`.
      scope: z.literal("project").optional(),
      // Project plugins only; its references are resolved in `superRefine`.
      application: PluginApplicationSchema.optional(),
      // Whether a window attached from another machine may use the plugin.
      // Absent means supported: plugin main code runs on the host either way.
      remote: z.enum(["supported", "unsupported"]).optional(),
      // The operating systems the package has a build for. Absent means any:
      // only a plugin shipping native modules for one OS needs to say so, and
      // installing it on another machine is refused before anything is copied.
      platforms: z
        .array(z.enum(PLUGIN_PLATFORMS))
        .min(1)
        .max(PLUGIN_PLATFORMS.length)
        .refine((list) => new Set(list).size === list.length, {
          message: "platforms must not repeat an entry",
        })
        .optional(),
      capabilities: z.array(PluginCapabilitySchema).default([]),
      scopes: PluginManifestScopesSchema.optional(),
      activationEvents: z.array(z.literal("onStartupFinished")).default([]),
      // One route per event at most, so the cap is the size of the closed list.
      // Cross-checks against `commands` and `capabilities` live in `superRefine`.
      eventRoutes: z.array(EventRouteSchema).max(PLUGIN_EVENT_ROUTE_EVENTS.length).default([]),
      contributes: z.preprocess(
        (raw, ctx) => {
          reportReservedTourCueNames(raw, ctx);
          return normalizeDeprecatedContributionAliases(raw);
        },
        z
          .strictObject({
            panels: z
              .array(PanelContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.panels)
              .default([]),
            toolbarButtons: z
              .array(ToolbarButtonContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.toolbarButtons)
              .default([]),
            launchEntries: z
              .array(LaunchEntryContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.launchEntries)
              .default([]),
            layouts: z
              .array(LayoutContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.layouts)
              .default([]),
            searchProviders: z
              .array(SearchProviderContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.searchProviders)
              .default([]),
            menuItems: z
              .array(MenuItemContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.menuItems)
              .default([]),
            keybindings: z
              .array(KeybindingContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.keybindings)
              .default([]),
            contextMenus: z
              .array(ContextMenuContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.contextMenus)
              .default([]),
            commands: z
              .array(CommandContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.commands)
              .default([]),
            views: z
              .array(ViewContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.views)
              .default([]),
            mcpServers: z
              .array(McpServerContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.mcpServers)
              .default([]),
            skills: z
              .array(SkillContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.skills)
              .default([]),
            assistantKnowledge: AssistantKnowledgeContributionSchema.optional(),
            themes: z
              .array(ThemeContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.themes)
              .default([]),
            contextProviders: z
              .array(ContextProviderContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.contextProviders)
              .default([]),
            forgeProviders: z
              .array(ForgeProviderContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.forgeProviders)
              .default([]),
            elementPickerProviders: z
              .array(ElementPickerProviderContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.elementPickerProviders)
              .default([]),
            fileDecorationProviders: z
              .array(FileDecorationContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.fileDecorationProviders)
              .default([]),
            worktreeDeleteNotes: z
              .array(WorktreeDeleteNotesContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.worktreeDeleteNotes)
              .default([]),
            fileEditors: z
              .array(FileEditorContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.fileEditors)
              .default([]),
            agents: z
              .array(AgentContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.agents)
              .default([]),
            processTools: z
              .array(ProcessToolContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.processTools)
              .default([]),
            settings: z
              .array(SettingDefinitionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.settings)
              .default([]),
            promptTemplates: z
              .array(PromptTemplateContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.promptTemplates)
              .default([]),
            terminalLinks: z
              .array(TerminalLinkContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.terminalLinks)
              .default([]),
            recipes: z
              .array(RecipeContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.recipes)
              .default([]),
            agentMcp: z
              .array(AgentMcpContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.agentMcp)
              .default([]),
            tours: z
              .array(TourContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.tours)
              .default([]),
            projectTemplates: z
              .array(ProjectTemplateContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.projectTemplates)
              .default([]),
            databases: z
              .array(DatabaseContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.databases)
              .default([]),
            worktreeSetupSteps: z
              .array(WorktreeSetupStepContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.worktreeSetupSteps)
              .default([]),
            setup: z
              .array(SetupStepContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.setup)
              .default([]),
            // Not an array, so it carries no MANIFEST_CONTRIBUTION_CAPS entry —
            // three optional fixed slots are structurally bounded already.
            surfaces: SurfaceContributionsSchema.default({}),
            account: PluginAccountContributionSchema.optional(),
            connections: z
              .array(PluginConnectionContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.connections)
              .optional(),
          })
          // A factory, not a literal: zod only shallow-clones a default value,
          // so a literal's arrays would be shared by every parse of the cached
          // schema.
          .default(() => ({
            panels: [],
            toolbarButtons: [],
            launchEntries: [],
            layouts: [],
            searchProviders: [],
            menuItems: [],
            keybindings: [],
            contextMenus: [],
            commands: [],
            views: [],
            mcpServers: [],
            skills: [],
            themes: [],
            promptTemplates: [],
            terminalLinks: [],
            contextProviders: [],
            forgeProviders: [],
            elementPickerProviders: [],
            fileDecorationProviders: [],
            worktreeDeleteNotes: [],
            fileEditors: [],
            agents: [],
            processTools: [],
            settings: [],
            recipes: [],
            agentMcp: [],
            tours: [],
            projectTemplates: [],
            databases: [],
            worktreeSetupSteps: [],
            setup: [],
            surfaces: {},
          }))
      ),
    })
    .superRefine((manifest, ctx) => {
      // `scope: "project"` and the discovering root must agree, in BOTH
      // directions. A project plugin copied into the user directory would
      // otherwise load app-globally with project-shaped assumptions (its fs
      // containment root, its per-project settings tier), and a user plugin
      // dropped into `.daintree/plugins/` would load with none of the
      // project-local guarantees its author never opted into. Neither failure
      // is visible at runtime, so both are rejected at the gate.
      if (origin === "project" && manifest.scope !== "project") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope"],
          message:
            'A plugin discovered under a project\'s .daintree/plugins/ must declare "scope": "project" — the host will not load a project-local plugin that has not opted in.',
          params: { errorCode: "project_scope_required" },
        });
      } else if (origin !== "project" && manifest.scope === "project") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope"],
          message: `"scope": "project" declares a plugin that is only ever loaded from a project's .daintree/plugins/, but this manifest was discovered under the ${origin} plugins root.`,
          params: { errorCode: "project_scope_not_allowed" },
        });
      }

      const selfIndex = manifest.worksWith?.indexOf(manifest.name) ?? -1;
      if (selfIndex !== -1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["worksWith", selfIndex],
          message: "worksWith names other plugins; a plugin can't list itself",
          params: { errorCode: "works_with_self" },
        });
      }

      // A project-local plugin runs out-of-process in the plugin worker, and
      // `host.registerForgeProvider` is unavailable there: forge providers
      // require synchronous host methods (`parseRemote`, the URL builders) that
      // cannot cross the worker's async message port — see the same refusal in
      // `pluginDevWorkerHostProxy.registerForgeProvider`. The contribution
      // would register a descriptor that can never be given an implementation,
      // so the provider would sit in Preferences permanently unbacked. Reject
      // the declaration rather than ship a forge provider that cannot work.
      //
      // Deliberately scoped to `scope: "project"` and not to every non-builtin
      // origin, even though `PluginService.activatePlugin` routes user plugins
      // through the same worker and so leaves their forge providers equally
      // unbacked. That is a pre-existing gap with shipped manifests behind it;
      // widening the rule would reject plugins that install today, which is its
      // own decision with its own migration. Project scope is new surface, so
      // it starts closed.
      if (manifest.scope === "project" && manifest.contributes.forgeProviders.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "forgeProviders"],
          message:
            'contributes.forgeProviders is not available to a "scope": "project" plugin — forge providers need synchronous host methods (parseRemote, URL builders) that cannot cross the plugin worker\'s async message port, so host.registerForgeProvider would refuse the implementation and the provider could never resolve.',
          params: { errorCode: "forge_provider_project_scope_forbidden" },
        });
      }

      // The contribution groups that are still STRUCTURALLY GLOBAL. Contribution
      // scoping (`PluginContributionBroadcaster`) narrows panels, actions,
      // toolbar buttons, keybindings and context menus to the owning project's
      // views; every group below is registered into an app-wide registry that
      // has no project axis at all, so a project plugin declaring one publishes
      // it to every project in the app — the exact locality violation project
      // scope exists to prevent. That was harmless while nothing could be
      // project-scoped; it is a live leak now, so the declaration is rejected at
      // the gate rather than accepted and silently over-published.
      //
      // Each of these is deferred, not forbidden forever: the reason names the
      // structural obstacle so a later phase knows what it has to build first.
      // Installed and builtin plugins are unaffected — they ARE app-wide, which
      // is what the absent `scope` means.
      if (manifest.scope === "project") {
        for (const [group, reason] of PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS) {
          if (manifest.contributes[group].length === 0) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", group],
            message: `contributes.${group} is not available to a "scope": "project" plugin — ${reason}`,
            params: { errorCode: `${group}_project_scope_forbidden` },
          });
        }
        // Not deferred like the groups above: a template is offered while a
        // new folder is being created, before there is any project for a
        // project plugin to belong to.
        if (manifest.contributes.projectTemplates.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "projectTemplates"],
            message:
              'contributes.projectTemplates is not available to a "scope": "project" plugin — templates are offered when a new project folder is created, before any project exists for a project plugin to belong to. Ship the template from an installed plugin instead.',
            params: { errorCode: "projectTemplates_project_scope_forbidden" },
          });
        }
      }

      // A project database is a file in the repository, so it is disclosed
      // and gated like any other project write — and it needs a project to
      // resolve against, which an installed plugin does not have.
      manifest.contributes.databases.forEach((database, index) => {
        if (database.location === "project") {
          if (manifest.scope !== "project") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "databases", index, "location"],
              message:
                'a "project" database is available only to a "scope": "project" plugin — an installed plugin is bound to no project to put the file in. Use "location": "local".',
              params: { errorCode: "database_project_scope_only" },
            });
          } else if (!manifest.capabilities.includes("fs:project-write")) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "databases", index, "location"],
              message:
                'a "project" database writes into the repository and requires the "fs:project-write" capability to be declared in capabilities.',
              params: { errorCode: "database_project_write_required" },
            });
          }
        } else if (database.path !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "databases", index, "path"],
            message:
              'path applies only to a "project" database; a "local" database always lives in the plugin\'s own data directory.',
            params: { errorCode: "database_local_path_unsupported" },
          });
        }
      });

      // Every declared query is a tool on the plugin's one MCP server, beside
      // the host's own database tools, so names are unique across all of the
      // plugin's databases and the total stays inside the server's budget.
      const queryOwners = new Map<string, string>();
      let declaredQueries = 0;
      manifest.contributes.databases.forEach((database, index) => {
        (database.queries ?? []).forEach((query, queryIndex) => {
          declaredQueries += 1;
          const path = ["contributes", "databases", index, "queries", queryIndex, "name"];
          const owner = queryOwners.get(query.name);
          if (RESERVED_AGENT_MCP_TOOL_NAMES.has(query.name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `query "${query.name}" takes the name of one of the host's database tools (${[...RESERVED_AGENT_MCP_TOOL_NAMES].join(", ")}), which share the plugin's MCP server`,
              params: { errorCode: "database_query_name_reserved" },
            });
          } else if (owner !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `query "${query.name}" is declared twice (first on database "${owner}"); query names are tool names on one MCP server, so each must be unique across the plugin's databases`,
              params: { errorCode: "database_query_name_duplicate" },
            });
          } else {
            queryOwners.set(query.name, database.id);
          }
          if (declaredQueries === AGENT_MCP_MAX_TOOLS_PER_ENDPOINT + 1) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `query "${query.name}" is past the limit: a plugin may declare at most ${AGENT_MCP_MAX_TOOLS_PER_ENDPOINT} database queries in all`,
              params: { errorCode: "database_query_limit" },
            });
          }
        });
      });

      // An account exists to reach an online service, and the consent dialog
      // and plugin manager disclose that through `network:fetch`. Declaring
      // the account without it would hide the plugin's network use.
      if (manifest.contributes.account !== undefined && manifest.contributes.connections) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "connections"],
          message:
            'Declare contributes.account or contributes.connections, not both — account is shorthand for one connection named "default".',
          params: { errorCode: "account_and_connections" },
        });
      }
      const connectionIds = new Set<string>();
      (manifest.contributes.connections ?? []).forEach((connection, index) => {
        if (connectionIds.has(connection.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "connections", index, "id"],
            message: `Duplicate connection id "${connection.id}".`,
            params: { errorCode: "connection_duplicate_id" },
          });
        }
        connectionIds.add(connection.id);
      });
      if (
        (manifest.contributes.account !== undefined ||
          (manifest.contributes.connections?.length ?? 0) > 0) &&
        !manifest.capabilities.includes("network:fetch")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "account"],
          message:
            'contributes.account and contributes.connections require the "network:fetch" capability — an account is for an online service, and the capability is how the user is told the plugin reaches the network.',
          params: { errorCode: "account_requires_network_fetch" },
        });
      }

      // The inverse asymmetry: `contributes.surfaces` is available to project
      // plugins ALONE. An installed plugin taking over a project's empty canvas,
      // its home nav entry or its cold-open layout would be reshaping a project
      // it was never bound to, from a decision the user made globally — and
      // there would be no project whose slot registry could arbitrate the
      // claim. Locality is the whole point of the slot, so a manifest without
      // `scope: "project"` may not declare one.
      if (manifest.scope !== "project" && manifest.contributes.surfaces !== undefined) {
        const claimed = Object.entries(manifest.contributes.surfaces).filter(
          ([, value]) => value !== undefined
        );
        if (claimed.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces"],
            message:
              'contributes.surfaces is available only to a "scope": "project" plugin — a surface claim replaces one project\'s own chrome, and an installed plugin is bound to no project, so there is nothing to scope the claim to or to arbitrate a second claimant against.',
            params: { errorCode: "surfaces_project_scope_only" },
          });
        }
      }

      if (origin !== "builtin" && manifest.name.startsWith("daintree.")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["name"],
          message: `Plugin name "${manifest.name}" uses the reserved "daintree.*" namespace, which is restricted to first-party plugins.`,
          params: { errorCode: "namespace_reserved" },
        });
      }

      // A slot-backed file editor resolves through the builtin view registry
      // compiled into the host bundle, so only a built-in plugin can back one.
      // A view-backed editor mounts one of the plugin's own views and is open to
      // every origin (#13809); its `paths` claims are a project plugin's alone,
      // because only a project plugin is bound to a project they are relative to.
      manifest.contributes.fileEditors.forEach((entry, index) => {
        const at = (field: string) => ["contributes", "fileEditors", index, field];
        if ((entry.slot === undefined) === (entry.view === undefined)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at("view"),
            message: 'A file editor names exactly one of "slot" (built-in plugins) or "view".',
            params: { errorCode: "file_editor_backing_invalid" },
          });
        }
        if (entry.slot !== undefined && (entry.mode !== undefined || entry.paths !== undefined)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at("slot"),
            message:
              'A slot-backed file editor is always an Edit mode matched by extension — "mode" and "paths" belong to a view-backed one.',
            params: { errorCode: "file_editor_backing_invalid" },
          });
        }
        if (entry.view !== undefined && entry.mode === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at("mode"),
            message: 'A view-backed file editor declares "mode": "edit" or "view".',
            params: { errorCode: "file_editor_mode_missing" },
          });
        }
        if (entry.extensions === undefined && entry.paths === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: at("extensions"),
            message:
              'A file editor matches files by "extensions", "paths" or both — it declares neither.',
            params: { errorCode: "file_editor_match_missing" },
          });
        }
        if (entry.slot !== undefined && origin !== "builtin") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "fileEditors", index, "slot"],
            message:
              'contributes.fileEditors[].slot is only available to built-in plugins — the slot resolves through the host-bundled builtin view registry. Back the editor with one of your own views instead: "view" naming a location: "fileEditor" view.',
            params: { errorCode: "fileEditors_slot_builtin_only" },
          });
        }
        if (entry.paths !== undefined && manifest.scope !== "project") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "fileEditors", index, "paths"],
            message:
              'contributes.fileEditors[].paths is only available to a "scope": "project" plugin — the patterns are relative to the project it belongs to. Match by "extensions" instead.',
            params: { errorCode: "fileEditors_paths_project_only" },
          });
        }
        // A default reshapes how a project opens its own files, so it is a
        // project plugin's alone (#13811), and only ever by pattern: an
        // extension default would reach every file of that type.
        if (entry.default === true) {
          if (manifest.scope !== "project") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at("default"),
              message:
                'contributes.fileEditors[].default is only available to a "scope": "project" plugin — an installed plugin adds an editor, it never decides what a project\'s files open in.',
              params: { errorCode: "fileEditors_default_project_only" },
            });
          } else if (
            entry.view === undefined ||
            entry.mode !== "edit" ||
            entry.paths === undefined
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at("default"),
              message:
                'A default file editor is a view-backed "mode": "edit" editor with "paths" — the patterns it becomes the default for.',
              params: { errorCode: "fileEditors_default_invalid" },
            });
          }
        }
      });

      // One plugin, one editor per default pattern: two entries naming the same
      // pattern would claim one slot twice, and whichever loaded last would win.
      const defaultPatterns = new Set<string>();
      manifest.contributes.fileEditors.forEach((entry, index) => {
        if (entry.default !== true) return;
        for (const pattern of entry.paths ?? []) {
          if (defaultPatterns.has(pattern)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "fileEditors", index, "paths"],
              message: `"${pattern}" is already the default for another of this plugin's file editors — a pattern opens in one editor.`,
              params: { errorCode: "fileEditors_default_duplicate" },
            });
          }
          defaultPatterns.add(pattern);
        }
      });

      // A route runs one of the plugin's own manifest commands with nobody
      // present: the target must be declared (an imperative action dies with
      // the worker a route exists to outlive), must not ask for confirmation
      // no one is there to give, and an event must carry the same capability
      // its live subscription requires (#13816).
      const routedEvents = new Set<string>();
      manifest.eventRoutes.forEach((route, index) => {
        if (routedEvents.has(route.event)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["eventRoutes", index, "event"],
            message: `eventRoutes already routes "${route.event}"; each event may be routed once.`,
            params: { errorCode: "event_route_duplicate_event" },
          });
        }
        routedEvents.add(route.event);
        const command = manifest.contributes.commands.find((cmd) => cmd.id === route.command);
        if (!command) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["eventRoutes", index, "command"],
            message: `eventRoutes command "${route.command}" matches no entry in contributes.commands.`,
            params: { errorCode: "event_route_unknown_command" },
          });
        } else if (command.danger === "confirm") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["eventRoutes", index, "command"],
            message: `eventRoutes command "${route.command}" is declared danger "confirm", and a routed command runs without anyone to confirm it.`,
            params: { errorCode: "event_route_confirm_command" },
          });
        }
        if (route.event === "agentWaiting" && !manifest.capabilities.includes("agent:read")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["eventRoutes", index, "event"],
            message:
              'eventRoutes "agentWaiting" requires the "agent:read" capability to be declared in capabilities.',
            params: { errorCode: "event_route_capability_required" },
          });
        }
      });

      // `contributes.agents` registers a launchable agent CLI — gate it behind
      // the explicit `agent:register` capability so the contribution is
      // surfaced to the user at install time (#9560).
      const agents = manifest.contributes.agents;
      if (agents.length > 0 && !manifest.capabilities.includes("agent:register")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "agents"],
          message:
            'contributes.agents requires the "agent:register" capability to be declared in capabilities.',
          params: { errorCode: "agent_register_capability_required" },
        });
      }

      // A provider reads the previewed page's DOM and runtime, so it is
      // disclosed at install like any other capability. A source resolver
      // additionally reads the project's files to map what the page reported
      // onto authored source.
      manifest.contributes.elementPickerProviders.forEach((provider, index) => {
        if (!manifest.capabilities.includes("preview:inspect")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "elementPickerProviders", index],
            message:
              'contributes.elementPickerProviders requires the "preview:inspect" capability to be declared in capabilities.',
            params: { errorCode: "preview_inspect_capability_required" },
          });
        }
        if (
          provider.resolverEntry !== undefined &&
          !manifest.capabilities.includes("fs:project-read")
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "elementPickerProviders", index, "resolverEntry"],
            message:
              'An element picker provider with a resolverEntry requires the "fs:project-read" capability to be declared in capabilities.',
            params: { errorCode: "fs_project_read_capability_required" },
          });
        }
      });

      // An agent-facing tools endpoint is a new way for a plugin's data to reach
      // agents, so it is disclosed at install like any other capability. Unlike
      // `mcpServers` it is allowed under `scope: "project"`: every credential for
      // it is minted per terminal and bound to one project, so the surface has
      // the project axis those registries lack.
      if (
        manifest.contributes.agentMcp.length > 0 &&
        !manifest.capabilities.includes("mcp:expose")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "agentMcp"],
          message:
            'contributes.agentMcp requires the "mcp:expose" capability to be declared in capabilities.',
          params: { errorCode: "mcp_expose_capability_required" },
        });
      }

      // Assistant knowledge describes the plugin's agent tools and is only
      // delivered alongside them, so a plugin with none could never deliver it.
      if (
        manifest.contributes.assistantKnowledge !== undefined &&
        manifest.contributes.agentMcp.length === 0 &&
        manifest.contributes.databases.length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "assistantKnowledge"],
          message:
            "contributes.assistantKnowledge describes agent tools, but this plugin offers none — declare contributes.agentMcp or contributes.databases.",
          params: { errorCode: "assistant_knowledge_requires_agent_tools" },
        });
      }

      // Plugin agent IDs are additive for new IDs only — they may never shadow
      // or patch a built-in agent.
      agents.forEach((agent, index) => {
        if (isBuiltInAgentId(agent.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "agents", index, "id"],
            message: `Plugin agent id "${agent.id}" collides with a built-in agent — plugin agents must use new IDs.`,
            params: { errorCode: "agent_id_reserved" },
          });
        }
      });

      // Plugin process-tool commands are additive for new commands only (#11613).
      // A command already claimed by a built-in tool or by a built-in agent's CLI
      // would never win at runtime — the detector merges built-ins over the plugin
      // snapshot — so accepting it would register a detection that silently never
      // fires. Reject at parse time, mirroring the agent-id reservation above.
      // Cross-plugin collisions are deliberately NOT checked here: they resolve
      // first-registered-wins at runtime, and a manifest cannot know what else is
      // installed.
      const processTools = manifest.contributes.processTools;
      const seenProcessToolCommands = new Set<string>();
      processTools.forEach((tool, index) => {
        if (Object.hasOwn(PROCESS_TOOL_ICON_BY_COMMAND, tool.command)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "processTools", index, "command"],
            message: `Process-tool command "${tool.command}" collides with a built-in tool — plugin process tools must use new commands.`,
            params: { errorCode: "process_tool_command_reserved" },
          });
        } else if (Object.hasOwn(AGENT_CLI_NAMES, tool.command)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "processTools", index, "command"],
            message: `Process-tool command "${tool.command}" collides with a built-in agent CLI — plugin process tools must use new commands.`,
            params: { errorCode: "process_tool_command_reserved" },
          });
        }
        // A manifest declaring the same command twice is a typo, not a
        // precedence question — the registry's per-plugin map is last-wins, so
        // one of the two icons would silently disappear. Reject rather than
        // pick.
        if (seenProcessToolCommands.has(tool.command)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "processTools", index, "command"],
            message: `Duplicate process-tool command "${tool.command}" in this manifest.`,
            params: { errorCode: "process_tool_command_duplicate" },
          });
        }
        seenProcessToolCommands.add(tool.command);
      });

      // Every contributed `actionId` (toolbar buttons, menu items, keybindings,
      // context menus) must resolve to a real, dispatchable action at runtime,
      // else the contribution paints an inert button/binding that silently does
      // nothing when invoked (#10565, #10580). The resolution rules, in order:
      //
      //  1. A built-in flagged `denyPluginDispatch: true` is rejected outright —
      //     the host refuses plugin dispatch for it, so the button is dead even
      //     though the id exists (#10580). This precedes the allowlist check
      //     because these ids ARE in `BUILT_IN_ACTION_ID_SET`.
      //  2. Any other built-in action id resolves.
      //  3. An id in the plugin's own namespace is cross-checked against the
      //     declared `contributes.commands` (namespaced `{name}.{id}` at load).
      //     If commands are declared, an own-namespace id that matches none of
      //     them is a typo for a command that will never exist, so it is rejected
      //     (#10580). If NO commands are declared, the plugin registers actions
      //     imperatively via `host.registerAction` (invisible at parse time), so
      //     any own-namespace id is allowed — the imperative escape hatch.
      //  4. A reference into a foreign namespace can never resolve and is rejected.
      const ownNamespacePrefix = `${manifest.name}.`;
      const declaredCommandActionIds = new Set(
        manifest.contributes.commands.map((cmd) => `${manifest.name}.${cmd.id}`)
      );
      const actionIdContributions = [
        ["toolbarButtons", manifest.contributes.toolbarButtons],
        ["menuItems", manifest.contributes.menuItems],
        ["keybindings", manifest.contributes.keybindings],
        ["contextMenus", manifest.contributes.contextMenus],
      ] as const;
      for (const [arrayName, entries] of actionIdContributions) {
        entries.forEach((entry, index) => {
          const { actionId } = entry;
          // A popover button has no action; `toolbar_button_behavior_*` below
          // reports a button with neither.
          if (actionId === undefined) return;
          const issuePath = ["contributes", arrayName, index, "actionId"] as const;

          if (DENY_PLUGIN_DISPATCH_SET.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...issuePath],
              message: `Contributed actionId "${actionId}" is a built-in action closed to plugin dispatch — the host refuses it at runtime, so the contribution can never fire.`,
              params: { errorCode: "action_id_plugin_dispatch_denied" },
            });
            return;
          }

          if (BUILT_IN_ACTION_ID_SET.has(actionId)) {
            return;
          }

          if (actionId.startsWith(ownNamespacePrefix)) {
            // Cross-check own-namespace ids against declared commands only when
            // commands exist; an empty set means the plugin is fully imperative.
            if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...issuePath],
                message: `Contributed actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
                params: { errorCode: "action_id_undeclared_command" },
              });
            }
            return;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...issuePath],
            message: `Contributed actionId "${actionId}" does not reference a built-in action or an action in this plugin's "${manifest.name}" namespace — it can never resolve.`,
            params: { errorCode: "action_id_unknown_namespace" },
          });
        });
      }

      // A panel's `menu` offers only the plugin's OWN actions: each entry is
      // dispatched with `{ panelId }`, which no built-in takes, and the panel
      // menus already carry the host's commands. So a built-in id, allowed on
      // the surfaces above, is refused here; the own-namespace rules match
      // theirs, including the imperative escape hatch when no commands exist.
      // A panel's `toolbar` follows the same rule, for the same reason.
      manifest.contributes.panels.forEach((panel, panelIndex) => {
        const surfaces = [
          { key: "menu", noun: "menu", items: panel.menu ?? [] },
          { key: "toolbar", noun: "toolbar", items: panel.toolbar ?? [] },
        ] as const;
        for (const surface of surfaces) {
          surface.items.forEach((item, itemIndex) => {
            const { actionId } = item;
            const issuePath = [
              "contributes",
              "panels",
              panelIndex,
              surface.key,
              itemIndex,
              "actionId",
            ];
            if (
              !actionId.startsWith(ownNamespacePrefix) ||
              actionId.length === ownNamespacePrefix.length ||
              !PANEL_MENU_ACTION_ID.test(actionId)
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: issuePath,
                message: `Panel ${surface.noun} actionId "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a panel's ${surface.noun} can't offer built-in or other plugins' actions.`,
                params: { errorCode: `panel_${surface.key}_action_not_own` },
              });
              return;
            }
            if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: issuePath,
                message: `Panel ${surface.noun} actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
                params: { errorCode: "action_id_undeclared_command" },
              });
            }
          });
        }
      });

      // A terminal link hands the matched text to the plugin, so it may only
      // dispatch the plugin's OWN command — never a built-in or another
      // plugin's — under the same own-namespace rules as a panel menu.
      manifest.contributes.terminalLinks.forEach((link, index) => {
        const path = ["contributes", "terminalLinks", index] as const;
        const issue = (field: string, message: string, errorCode: string) =>
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, field],
            message,
            params: { errorCode },
          });
        const { actionId } = link;
        if (
          !actionId.startsWith(ownNamespacePrefix) ||
          actionId.length === ownNamespacePrefix.length ||
          !PANEL_MENU_ACTION_ID.test(actionId)
        ) {
          issue(
            "actionId",
            `Terminal link actionId "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a link's text can only go to the plugin that declared it.`,
            "terminal_link_action_not_own"
          );
        } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
          issue(
            "actionId",
            `Terminal link actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
            "action_id_undeclared_command"
          );
        }

        if ((link.pattern === undefined) === (link.url === undefined)) {
          issue(
            link.pattern === undefined ? "pattern" : "url",
            "A terminal link sets exactly one of pattern or url.",
            "terminal_link_target"
          );
          return;
        }
        if (link.url !== undefined) {
          if (link.ignoreCase !== undefined) {
            issue(
              "ignoreCase",
              "ignoreCase applies to a pattern; a URL's host is already matched without regard to case.",
              "terminal_link_ignore_case"
            );
          }
          const hostProblem = checkTerminalLinkHost(link.url.host);
          if (hostProblem !== null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "url", "host"],
              message: `Terminal link ${hostProblem}.`,
              params: { errorCode: "terminal_link_host" },
            });
          }
          const pathProblem =
            link.url.pathPrefix === undefined
              ? null
              : checkTerminalLinkPathPrefix(link.url.pathPrefix);
          if (pathProblem !== null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "url", "pathPrefix"],
              message: `Terminal link ${pathProblem}.`,
              params: { errorCode: "terminal_link_path_prefix" },
            });
          }
          return;
        }
        const patternProblem = checkTerminalLinkPattern(link.pattern!, link.ignoreCase === true);
        if (patternProblem !== null) {
          issue("pattern", `Terminal link ${patternProblem}.`, "terminal_link_pattern");
        }
      });

      // Duplicate contribution ids — within each contribution array, the bare
      // `id` is the lookup key the runtime keys its registries on (panel kind,
      // command descriptor, MCP server, agent, view, setting, forge provider,
      // file-decoration provider). A duplicate silently first-wins at load, so
      // the second contribution vanishes with no diagnostic. Reject it at the
      // manifest gate instead. The check is per-array (ids in different arrays
      // are namespaced independently and never collide).
      const reportDuplicateIds = (arrayName: string, entries: ReadonlyArray<{ id: string }>) => {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
          if (seen.has(entry.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", arrayName, index, "id"],
              message: `Duplicate id "${entry.id}" in contributes.${arrayName} — each contribution id must be unique within its array.`,
              params: { errorCode: "duplicate_contribution_id" },
            });
          } else {
            seen.add(entry.id);
          }
        });
      };
      reportDuplicateIds("panels", manifest.contributes.panels);
      reportDuplicateIds("toolbarButtons", manifest.contributes.toolbarButtons);
      reportDuplicateIds("launchEntries", manifest.contributes.launchEntries);
      reportDuplicateIds("layouts", manifest.contributes.layouts);
      reportDuplicateIds("searchProviders", manifest.contributes.searchProviders);
      reportDuplicateIds("commands", manifest.contributes.commands);
      reportDuplicateIds("views", manifest.contributes.views);
      reportDuplicateIds("mcpServers", manifest.contributes.mcpServers);
      reportDuplicateIds("skills", manifest.contributes.skills);
      reportDuplicateIds("themes", manifest.contributes.themes);
      reportDuplicateIds("promptTemplates", manifest.contributes.promptTemplates);
      reportDuplicateIds("terminalLinks", manifest.contributes.terminalLinks);
      manifest.contributes.promptTemplates.forEach((template, templateIndex) => {
        const declared = new Set<string>();
        template.args.forEach((arg, argIndex) => {
          if (declared.has(arg.name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "promptTemplates", templateIndex, "args", argIndex, "name"],
              message: `Duplicate argument "${arg.name}" in prompt template "${template.id}".`,
            });
          }
          declared.add(arg.name);
        });
        for (const reference of new Set(findPromptTemplatePlaceholders(template.body))) {
          if (declared.has(reference)) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "promptTemplates", templateIndex, "body"],
            message: `Prompt template "${template.id}" references {{${reference}}}, which is not a declared argument name.`,
          });
        }
      });
      reportDuplicateIds("contextProviders", manifest.contributes.contextProviders);
      // One plugin answering one prefix twice would leave the second provider
      // unreachable behind the first.
      const claimedPrefixes = new Set<string>();
      manifest.contributes.contextProviders.forEach((provider, index) => {
        if (claimedPrefixes.has(provider.prefix)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "contextProviders", index, "prefix"],
            message: `Prefix "${provider.prefix}" is claimed by more than one context provider.`,
          });
        }
        claimedPrefixes.add(provider.prefix);
      });
      reportDuplicateIds("forgeProviders", manifest.contributes.forgeProviders);
      reportDuplicateIds("elementPickerProviders", manifest.contributes.elementPickerProviders);
      reportDuplicateIds("fileDecorationProviders", manifest.contributes.fileDecorationProviders);
      reportDuplicateIds("fileEditors", manifest.contributes.fileEditors);
      reportDuplicateIds("projectTemplates", manifest.contributes.projectTemplates);
      reportDuplicateIds("agents", manifest.contributes.agents);
      reportDuplicateIds("settings", manifest.contributes.settings);
      reportDuplicateIds("recipes", manifest.contributes.recipes);
      reportDuplicateIds("agentMcp", manifest.contributes.agentMcp);
      reportDuplicateIds("tours", manifest.contributes.tours);
      reportDuplicateIds("databases", manifest.contributes.databases);
      reportDuplicateIds("worktreeSetupSteps", manifest.contributes.worktreeSetupSteps);
      reportDuplicateIds("setup", manifest.contributes.setup);

      // Cross-reference integrity — a contribution that names another by id must
      // point at one that exists in the same manifest, else the reference dangles
      // and the wiring silently no-ops at runtime.
      const settingIds = new Set(manifest.contributes.settings.map((setting) => setting.id));
      const viewIds = new Set(manifest.contributes.views.map((view) => view.id));
      const settingsViewIds = new Set(
        manifest.contributes.views.filter((view) => view.location === "settings").map((v) => v.id)
      );
      const fileEditorViewIds = new Set(
        manifest.contributes.views
          .filter((view) => view.location === "fileEditor")
          .map((view) => view.id)
      );
      const sidebarViewIds = new Set(
        manifest.contributes.views.filter((view) => view.location === "sidebar").map((v) => v.id)
      );
      const panelIds = new Set(manifest.contributes.panels.map((panel) => panel.id));

      // A setup step's check and action must each name something the host can
      // see or run, or the step could never be finished (#13824). A command is
      // the plugin's own, under the same rules as a panel menu's.
      manifest.contributes.setup.forEach((step, index) => {
        const path = ["contributes", "setup", index] as const;
        const { done, action } = step;
        if (done.kind === "setting" && !settingIds.has(done.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "done", "key"],
            message: `Setup step "${step.id}" is done when setting "${done.key}" is set, but no contributes.settings[].id matches it.`,
            params: { errorCode: "setup_setting_unknown" },
          });
        }
        if (done.kind === "account") {
          const declared = declaredPluginConnections(manifest);
          if (declared.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "done", "kind"],
              message: `Setup step "${step.id}" is done when the account is connected, but the plugin declares no contributes.account or contributes.connections.`,
              params: { errorCode: "setup_account_undeclared" },
            });
          } else if (
            done.connection !== undefined &&
            !declared.some((connection) => connection.id === done.connection)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "done", "connection"],
              message: `Setup step "${step.id}" is done when connection "${done.connection}" is connected, but no declared connection has that id.`,
              params: { errorCode: "setup_connection_unknown" },
            });
          }
        }
        if (done.kind === "context") {
          try {
            parseWhenClause(done.when);
          } catch (err) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "done", "when"],
              message: `Setup step "${step.id}" has a when clause that doesn't parse: ${formatErrorMessage(err, "unparseable expression")}`,
              params: { errorCode: "setup_when_invalid" },
            });
          }
        }
        if (
          action?.kind === "settings" &&
          action.key !== undefined &&
          !settingIds.has(action.key)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "action", "key"],
            message: `Setup step "${step.id}" opens setting "${action.key}", but no contributes.settings[].id matches it.`,
            params: { errorCode: "setup_setting_unknown" },
          });
        }
        if (action?.kind === "command") {
          const { actionId } = action;
          const actionPath = [...path, "action", "actionId"];
          if (
            !actionId.startsWith(ownNamespacePrefix) ||
            actionId.length === ownNamespacePrefix.length ||
            !PANEL_MENU_ACTION_ID.test(actionId)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: actionPath,
              message: `Setup step "${step.id}" action.actionId "${actionId}" must be one of this plugin's own commands, written "${manifest.name}.<id>".`,
              params: { errorCode: "setup_command_not_own" },
            });
          } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: actionPath,
              message: `Setup step "${step.id}" action.actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
              params: { errorCode: "action_id_undeclared_command" },
            });
          }
        }
      });

      // A tour's Finish opens the same two targets a setup step does, held to
      // the same rules: a declared setting, or one of this plugin's own commands.
      manifest.contributes.tours.forEach((tour, index) => {
        const action = tour.finish?.action;
        const path = ["contributes", "tours", index, "finish", "action"];
        if (
          action?.kind === "settings" &&
          action.key !== undefined &&
          !settingIds.has(action.key)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "key"],
            message: `Tour "${tour.id}" finishes by opening setting "${action.key}", but no contributes.settings[].id matches it.`,
            params: { errorCode: "tour_finish_setting_unknown" },
          });
        }
        if (action?.kind === "command") {
          const { actionId } = action;
          if (
            !actionId.startsWith(ownNamespacePrefix) ||
            actionId.length === ownNamespacePrefix.length ||
            !PANEL_MENU_ACTION_ID.test(actionId)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "actionId"],
              message: `Tour "${tour.id}" finish action.actionId "${actionId}" must be one of this plugin's own commands, written "${manifest.name}.<id>".`,
              params: { errorCode: "tour_finish_command_not_own" },
            });
          } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "actionId"],
              message: `Tour "${tour.id}" finish action.actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
              params: { errorCode: "action_id_undeclared_command" },
            });
          }
        }
      });

      // `forgeProvider.settingsScopeRef` → a declared setting; `viewRefs[]` →
      // declared views. Both were validated for shape only before (#10620).
      manifest.contributes.forgeProviders.forEach((provider, index) => {
        if (provider.settingsScopeRef !== undefined && !settingIds.has(provider.settingsScopeRef)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "forgeProviders", index, "settingsScopeRef"],
            message: `forgeProvider settingsScopeRef "${provider.settingsScopeRef}" matches no contributes.settings[].id.`,
            params: { errorCode: "forge_settings_scope_ref_unknown" },
          });
        }
        provider.viewRefs?.forEach((ref, refIndex) => {
          if (!viewIds.has(ref)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "forgeProviders", index, "viewRefs", refIndex],
              message: `forgeProvider viewRef "${ref}" matches no contributes.views[].id.`,
              params: { errorCode: "forge_view_ref_unknown" },
            });
          }
        });
      });

      // `surfaces.*.viewId` → a declared view, the same dangling-reference
      // treatment `forgeProviders.viewRefs` gets above: an id matching no
      // contributed view mounts nothing, so the slot the plugin claimed renders
      // blank with no diagnostic.
      const ptyPanelIds = new Set(
        manifest.contributes.panels.filter((p) => p.hasPty === true).map((p) => p.id)
      );
      for (const slot of PROJECT_SURFACE_SLOTS) {
        if (PROJECT_SURFACE_SLOT_CATALOGUE[slot].claim !== "view") continue;
        const claim = manifest.contributes.surfaces[slot];
        if (claim === undefined) continue;
        if (!viewIds.has(claim.viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces", slot, "viewId"],
            message: `surfaces.${slot}.viewId "${claim.viewId}" matches no contributes.views[].id.`,
            params: { errorCode: "surface_view_ref_unknown" },
          });
          continue;
        }
        // A surface mounts through the claimed view's panel kind, and a
        // settings view has none.
        if (settingsViewIds.has(claim.viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces", slot, "viewId"],
            message: `surfaces.${slot}.viewId "${claim.viewId}" names a location: "settings" view — a surface draws a panel view, and a settings view renders only in the plugin's settings.`,
            params: { errorCode: "surface_view_ref_settings" },
          });
          continue;
        }
        // Nor does a file editor view, which mounts only in the file panel.
        if (fileEditorViewIds.has(claim.viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces", slot, "viewId"],
            message: `surfaces.${slot}.viewId "${claim.viewId}" names a location: "fileEditor" view — a surface draws a panel view, and a file editor view renders only in the file panel.`,
            params: { errorCode: "surface_view_ref_file_editor" },
          });
          continue;
        }
        if (sidebarViewIds.has(claim.viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces", slot, "viewId"],
            message: `surfaces.${slot}.viewId "${claim.viewId}" names a location: "sidebar" view — a surface draws a panel view, and a sidebar view renders only in the sidebar.`,
            params: { errorCode: "surface_view_ref_sidebar" },
          });
          continue;
        }
        // A PTY panel is rendered by TerminalPane, so its matching view is
        // ignored at load and no component path is ever attached. The claim
        // would then hold the project's slot against every other plugin while
        // rendering nothing — worse than not claiming it at all.
        if (ptyPanelIds.has(claim.viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "surfaces", slot, "viewId"],
            message: `surfaces.${slot}.viewId "${claim.viewId}" names a panel with hasPty: true — PTY panels are rendered by the terminal host and never load the view module, so the surface would hold the slot and draw nothing.`,
            params: { errorCode: "surface_view_ref_pty" },
          });
        }
      }

      // `surfaces.defaultLayout` → a declared layout. A dangling id would leave
      // the project's first open blank with nothing to say why.
      const defaultLayout = manifest.contributes.surfaces.defaultLayout;
      if (
        defaultLayout !== undefined &&
        !manifest.contributes.layouts.some((layout) => layout.id === defaultLayout)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "surfaces", "defaultLayout"],
          message: `surfaces.defaultLayout "${defaultLayout}" matches no contributes.layouts[].id.`,
          params: { errorCode: "surface_default_layout_unknown" },
        });
      }

      // `application` (#14097) names one project's application and points at
      // what this manifest already contributes. Every reference resolves here,
      // before anything loads: one that dangles would leave the application
      // pointing at nothing with no diagnostic.
      const application = manifest.application;
      if (application !== undefined) {
        const issue = (path: (string | number)[], message: string, errorCode: string) =>
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["application", ...path],
            message,
            params: { errorCode },
          });
        if (manifest.scope !== "project") {
          issue(
            [],
            'application is available only to a "scope": "project" plugin — an application is one project\'s, and an installed plugin is bound to no project.',
            "application_project_scope_only"
          );
        }
        // Compatibility is checked against the running app before the
        // application is put in force, so it needs a range to check.
        if (manifest.engines?.daintree === undefined) {
          issue(
            [],
            "application requires engines.daintree, so the host can tell whether this Daintree runs it before putting it in force.",
            "application_engine_required"
          );
        }
        if (
          application.destination === "home" &&
          manifest.contributes.surfaces.projectHome === undefined
        ) {
          issue(
            ["destination"],
            'application.destination "home" needs contributes.surfaces.projectHome, the Home it opens on.',
            "application_home_unclaimed"
          );
        }
        if (
          application.sidebarViewId !== undefined &&
          !sidebarViewIds.has(application.sidebarViewId)
        ) {
          issue(
            ["sidebarViewId"],
            `application.sidebarViewId "${application.sidebarViewId}" matches no contributes.views[] entry with location "sidebar".`,
            "application_sidebar_view_unknown"
          );
        }
        if (
          application.settingsViewId !== undefined &&
          !settingsViewIds.has(application.settingsViewId)
        ) {
          issue(
            ["settingsViewId"],
            `application.settingsViewId "${application.settingsViewId}" matches no contributes.views[] entry with location "settings".`,
            "application_settings_view_unknown"
          );
        }
        if (application.welcomeTour !== undefined) {
          const tour = manifest.contributes.tours.find(
            (entry) => entry.id === application.welcomeTour?.id
          );
          if (tour === undefined) {
            issue(
              ["welcomeTour", "id"],
              `application.welcomeTour.id "${application.welcomeTour.id}" matches no contributes.tours[].id.`,
              "application_tour_unknown"
            );
          } else if (tour.panelKind !== undefined) {
            issue(
              ["welcomeTour", "id"],
              `application.welcomeTour.id "${tour.id}" is a tour of the "${tour.panelKind}" panel — a welcome tour introduces the whole application, so it can't be scoped to one panel.`,
              "application_tour_panel_scoped"
            );
          }
        }
        if (application.firstWorkflow !== undefined) {
          const command = manifest.contributes.commands.find(
            (entry) => entry.id === application.firstWorkflow
          );
          if (command === undefined) {
            issue(
              ["firstWorkflow"],
              `application.firstWorkflow "${application.firstWorkflow}" matches no contributes.commands[].id.`,
              "application_command_unknown"
            );
          } else if (command.kind !== "command") {
            issue(
              ["firstWorkflow"],
              `application.firstWorkflow "${command.id}" is a query — the first workflow is something the user does, so it must be a command of kind "command".`,
              "application_command_query"
            );
          }
        }
        const agentMcpIds = new Set(manifest.contributes.agentMcp.map((endpoint) => endpoint.id));
        application.requiredTools?.forEach((tool, index) => {
          if (!agentMcpIds.has(tool)) {
            issue(
              ["requiredTools", index],
              `application.requiredTools "${tool}" matches no contributes.agentMcp[].id.`,
              "application_tool_unknown"
            );
          }
        });
      }

      // A toolbar button does one thing on click. With neither it is a dead
      // button; with both, the host would have to pick one and silently drop
      // the other.
      manifest.contributes.toolbarButtons.forEach((button, index) => {
        const path = ["contributes", "toolbarButtons", index] as const;
        const menu = button.menu ?? [];
        // A menu is the button's whole behaviour when it has no action: the
        // button opens it instead of dispatching.
        if (button.actionId === undefined && button.popover === undefined && menu.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path],
            message: `Toolbar button "${button.id}" declares none of actionId, popover or menu — give it one, or it does nothing when clicked.`,
            params: { errorCode: "toolbar_button_behavior_missing" },
          });
          return;
        }
        if (button.popover !== undefined && menu.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "menu"],
            message: `Toolbar button "${button.id}" declares both popover and menu — a popover button's click opens its popover, so keep one.`,
            params: { errorCode: "toolbar_button_menu_popover_conflict" },
          });
          return;
        }
        // Held to the plugin's own actions exactly as a panel's menu is: each
        // item is dispatched on its own, with nothing the plugin supplies.
        const seenMenuActions = new Set<string>();
        let menuRejected = false;
        menu.forEach((item, itemIndex) => {
          const { actionId } = item;
          const issuePath = [...path, "menu", itemIndex, "actionId"];
          if (
            !actionId.startsWith(ownNamespacePrefix) ||
            actionId.length === ownNamespacePrefix.length ||
            !PANEL_MENU_ACTION_ID.test(actionId)
          ) {
            menuRejected = true;
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: issuePath,
              message: `Toolbar button menu actionId "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a button's menu can't offer built-in or other plugins' actions.`,
              params: { errorCode: "toolbar_button_menu_action_not_own" },
            });
            return;
          }
          if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: issuePath,
              message: `Toolbar button menu actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
              params: { errorCode: "action_id_undeclared_command" },
            });
          }
          if (seenMenuActions.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: issuePath,
              message: `Duplicate menu action "${actionId}" — each action appears at most once in a button's menu.`,
              params: { errorCode: "toolbar_button_menu_duplicate_action" },
            });
          }
          seenMenuActions.add(actionId);
        });
        if (menuRejected) return;
        if (button.actionId !== undefined && button.popover !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "popover"],
            message: `Toolbar button "${button.id}" declares both actionId and popover — a button either dispatches an action or opens a popover, so keep one.`,
            params: { errorCode: "toolbar_button_behavior_conflict" },
          });
          return;
        }
        if (button.popover === undefined) return;
        // The popover mounts the view's panel kind, exactly as a surface does,
        // so the same dead ends apply.
        const { viewId } = button.popover;
        const viewPath = [...path, "popover", "viewId"];
        if (!viewIds.has(viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: viewPath,
            message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" matches no contributes.views[].id.`,
            params: { errorCode: "toolbar_popover_view_unknown" },
          });
        } else if (settingsViewIds.has(viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: viewPath,
            message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" names a location: "settings" view — a popover draws a panel view, and a settings view renders only in the plugin's settings.`,
            params: { errorCode: "toolbar_popover_view_settings" },
          });
        } else if (sidebarViewIds.has(viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: viewPath,
            message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" names a location: "sidebar" view — a popover draws a panel view, and a sidebar view renders only in the sidebar.`,
            params: { errorCode: "toolbar_popover_view_sidebar" },
          });
        } else if (fileEditorViewIds.has(viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: viewPath,
            message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" names a location: "fileEditor" view — a popover draws a panel view, and a file editor view renders only in the file panel.`,
            params: { errorCode: "toolbar_popover_view_file_editor" },
          });
        } else if (ptyPanelIds.has(viewId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: viewPath,
            message: `toolbarButtons "${button.id}" popover.viewId "${viewId}" names a panel with hasPty: true — PTY panels are rendered by the terminal host and never load the view module, so the popover would open empty.`,
            params: { errorCode: "toolbar_popover_view_pty" },
          });
        }
      });

      // A launch entry targets exactly one thing, and only something of this
      // plugin's own (#13788): one of its panels, one of its commands, or an
      // agent given a prompt. A built-in or another plugin's action is never a
      // target — the launcher is not a side door to dispatch.
      manifest.contributes.launchEntries.forEach((entry, index) => {
        const path = ["contributes", "launchEntries", index] as const;
        const targets = [entry.panel, entry.command, entry.agent].filter(
          (target) => target !== undefined
        );
        if (targets.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path],
            message: `Launch entry "${entry.id}" declares no target — give it one of panel, command or agent.`,
            params: { errorCode: "launch_entry_target_missing" },
          });
          return;
        }
        if (targets.length > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path],
            message: `Launch entry "${entry.id}" declares more than one of panel, command and agent — an entry launches one thing, so keep one.`,
            params: { errorCode: "launch_entry_target_conflict" },
          });
          return;
        }

        if (entry.command !== undefined) {
          const { actionId } = entry.command;
          const actionPath = [...path, "command", "actionId"];
          // A built-in is refused even when it starts with the plugin's name: a
          // plugin named `env.global` must not reach `env.global.set` this way.
          if (
            !actionId.startsWith(ownNamespacePrefix) ||
            actionId.length === ownNamespacePrefix.length ||
            !PANEL_MENU_ACTION_ID.test(actionId) ||
            BUILT_IN_ACTION_ID_SET.has(actionId)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: actionPath,
              message: `Launch entry "${entry.id}" command.actionId "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a launch entry can't run built-in or other plugins' actions.`,
              params: { errorCode: "launch_entry_command_not_own" },
            });
          } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: actionPath,
              message: `Launch entry "${entry.id}" command.actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
              params: { errorCode: "action_id_undeclared_command" },
            });
          }
          return;
        }

        if (entry.panel === undefined) return;
        const { id: panelId, placement, args } = entry.panel;
        const panel = manifest.contributes.panels.find((candidate) => candidate.id === panelId);
        if (panel === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "panel", "id"],
            message: `Launch entry "${entry.id}" panel.id "${panelId}" matches no contributes.panels[].id — an entry opens only this plugin's own panels.`,
            params: { errorCode: "launch_entry_panel_unknown" },
          });
          return;
        }
        // The same refusals `panel.openPluginPanel` makes at runtime, moved to
        // the gate so the author hears about them before any user clicks.
        const placementProblem =
          placement === "grid" && panel.scope === "project"
            ? 'a scope: "project" panel opens in the dock or a dialog, never the grid'
            : placement === "dock" && panel.dockable === false
              ? "the panel opts out of the dock with dockable: false"
              : placement === "dialog" && panel.hasPty === true
                ? "a PTY-backed panel (hasPty: true) can't open as a dialog"
                : undefined;
        if (placementProblem !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "panel", "placement"],
            message: `Launch entry "${entry.id}" can't open panel "${panelId}" with placement "${placement}": ${placementProblem}.`,
            params: { errorCode: "launch_entry_panel_placement" },
          });
        }
        // A PTY panel becomes an ordinary terminal and has no view to hand
        // arguments to, so they would be dropped without a word.
        if (args !== undefined && panel.hasPty === true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "panel", "args"],
            message: `Launch entry "${entry.id}" passes args to panel "${panelId}", which is PTY-backed (hasPty: true) and has no view to receive them.`,
            params: { errorCode: "launch_entry_panel_args_pty" },
          });
        }
      });

      // Search providers (#13792): a declarative one names a read-only declared
      // query with one string parameter, a runtime one names none, and every
      // target opens only something of this plugin's own — the switcher is not
      // a side door to dispatch either.
      const seenKeywords = new Set<string>();
      manifest.contributes.searchProviders.forEach((provider, index) => {
        const path = ["contributes", "searchProviders", index] as const;
        if (seenKeywords.has(provider.keyword)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "keyword"],
            message: `Search provider "${provider.id}" keyword "${provider.keyword}" is already used by another of this plugin's search providers — each needs its own keyword.`,
            params: { errorCode: "search_provider_keyword_duplicate" },
          });
        }
        seenKeywords.add(provider.keyword);

        if (provider.kind === "declarative") {
          if (provider.query === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "query"],
              message: `Search provider "${provider.id}" is declarative but names no query — give it the name of one of contributes.databases[].queries.`,
              params: { errorCode: "search_provider_query_missing" },
            });
          } else {
            const query = manifest.contributes.databases
              .flatMap((database) => database.queries ?? [])
              .find((candidate) => candidate.name === provider.query);
            const params = query ? Object.values(query.params) : [];
            if (query === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "query"],
                message: `Search provider "${provider.id}" query "${provider.query}" matches no contributes.databases[].queries[].name.`,
                params: { errorCode: "search_provider_query_unknown" },
              });
            } else if (query.mode !== "read") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "query"],
                message: `Search provider "${provider.id}" query "${provider.query}" is a write — a search runs as the user types, so it may only name a mode: "read" query.`,
                params: { errorCode: "search_provider_query_not_read" },
              });
            } else if (params.length !== 1 || params[0]!.type !== "string") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "query"],
                message: `Search provider "${provider.id}" query "${provider.query}" must declare exactly one param, of type "string", to receive what the user typed.`,
                params: { errorCode: "search_provider_query_params" },
              });
            }
          }
          if (provider.target === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "target"],
              message: `Search provider "${provider.id}" is declarative but declares no target — its rows open one of this plugin's panels or commands, so name one.`,
              params: { errorCode: "search_provider_target_missing" },
            });
          }
        } else if (provider.query !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "query"],
            message: `Search provider "${provider.id}" is a runtime provider, so it can't also name a query — use kind: "declarative" to answer from the query instead.`,
            params: { errorCode: "search_provider_query_runtime" },
          });
        }

        const { target } = provider;
        if (target === undefined) return;
        if ((target.panel === undefined) === (target.command === undefined)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "target"],
            message: `Search provider "${provider.id}" target must name exactly one of panel and command.`,
            params: { errorCode: "search_provider_target_conflict" },
          });
          return;
        }
        if (target.command !== undefined) {
          const actionId = target.command;
          if (
            !actionId.startsWith(ownNamespacePrefix) ||
            actionId.length === ownNamespacePrefix.length ||
            !PANEL_MENU_ACTION_ID.test(actionId) ||
            BUILT_IN_ACTION_ID_SET.has(actionId)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "target", "command"],
              message: `Search provider "${provider.id}" target.command "${actionId}" must be one of this plugin's own actions, written "${manifest.name}.<id>" — a search result can't run built-in or other plugins' actions.`,
              params: { errorCode: "search_provider_command_not_own" },
            });
          } else if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "target", "command"],
              message: `Search provider "${provider.id}" target.command "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
              params: { errorCode: "action_id_undeclared_command" },
            });
          }
          return;
        }
        const panel = manifest.contributes.panels.find(
          (candidate) => candidate.id === target.panel
        );
        if (panel === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "target", "panel"],
            message: `Search provider "${provider.id}" target.panel "${target.panel}" matches no contributes.panels[].id — a search result opens only this plugin's own panels.`,
            params: { errorCode: "search_provider_panel_unknown" },
          });
        } else if (panel.hasPty === true) {
          // A result's args are the point of opening it, and a PTY panel has no
          // view to hand them to.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "target", "panel"],
            message: `Search provider "${provider.id}" target.panel "${target.panel}" is PTY-backed (hasPty: true) and has no view to receive a result's args.`,
            params: { errorCode: "search_provider_panel_pty" },
          });
        }
      });

      // Recipes (#13797): a `plugin-panel` step opens only this plugin's own
      // panels, the fields of one step kind are refused on another rather than
      // dropped, and every `{{plugin.<name>}}` is a declared variable.
      const declaresAgentTools =
        manifest.contributes.agentMcp.length > 0 || manifest.contributes.databases.length > 0;
      manifest.contributes.recipes.forEach((recipe, recipeIndex) => {
        const recipePath = ["contributes", "recipes", recipeIndex] as const;
        const declared = new Set(recipe.variables ?? []);
        let hasAgentStep = false;
        recipe.terminals.forEach((step, stepIndex) => {
          const path = [...recipePath, "terminals", stepIndex] as const;
          const isPanel = step.type === "plugin-panel";
          const isAgent = isAgentRecipeType(step.type);
          if (isAgent) hasAgentStep = true;
          if (isPanel) {
            const stray = (
              ["command", "env", "initialPrompt", "systemPrompt", "args", "devCommand"] as const
            ).filter((field) => step[field] !== undefined);
            if (stray.length > 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path],
                message: `Recipe "${recipe.id}" step ${stepIndex + 1} opens a panel, so ${stray.join(", ")} would never be used — a plugin-panel step takes panelId and panelArgs.`,
                params: { errorCode: "recipe_panel_step_fields" },
              });
            }
            const panel =
              step.panelId === undefined
                ? undefined
                : manifest.contributes.panels.find((candidate) => candidate.id === step.panelId);
            if (panel === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "panelId"],
                message:
                  step.panelId === undefined
                    ? `Recipe "${recipe.id}" step ${stepIndex + 1} is a plugin-panel step with no panelId.`
                    : `Recipe "${recipe.id}" step ${stepIndex + 1} panelId "${step.panelId}" matches no contributes.panels[].id — a recipe opens only this plugin's own panels.`,
                params: { errorCode: "recipe_panel_unknown" },
              });
            } else if (step.panelArgs !== undefined && panel.hasPty === true) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "panelArgs"],
                message: `Recipe "${recipe.id}" step ${stepIndex + 1} passes panelArgs to panel "${panel.id}", which is PTY-backed (hasPty: true) and has no view to receive them.`,
                params: { errorCode: "recipe_panel_args_pty" },
              });
            }
          } else if (step.panelId !== undefined || step.panelArgs !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path],
              message: `Recipe "${recipe.id}" step ${stepIndex + 1} sets panelId or panelArgs on a "${step.type}" step — only type "plugin-panel" opens a panel.`,
              params: { errorCode: "recipe_panel_step_fields" },
            });
          }
          if (step.systemPrompt !== undefined && !isAgent) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "systemPrompt"],
              message: `Recipe "${recipe.id}" step ${stepIndex + 1} sets systemPrompt on a "${step.type}" step — only an agent step has a system prompt.`,
              params: { errorCode: "recipe_system_prompt_not_agent" },
            });
          }
          for (const field of ["initialPrompt", "systemPrompt"] as const) {
            const text = step[field];
            if (text === undefined) continue;
            for (const name of pluginVariableReferences(text)) {
              if (declared.has(name)) continue;
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, field],
                message: `Recipe "${recipe.id}" step ${stepIndex + 1} uses {{plugin.${name}}}, which isn't in the recipe's variables.`,
                params: { errorCode: "recipe_variable_undeclared" },
              });
            }
          }
        });
        if (recipe.requiresAgentTools === true && !declaresAgentTools) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...recipePath, "requiresAgentTools"],
            message: `Recipe "${recipe.id}" requires agent tools, but this plugin offers none — declare contributes.agentMcp or contributes.databases.`,
            params: { errorCode: "recipe_requires_agent_tools_none" },
          });
        } else if (recipe.requiresAgentTools === true && !hasAgentStep) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...recipePath, "requiresAgentTools"],
            message: `Recipe "${recipe.id}" requires agent tools but starts no agent.`,
            params: { errorCode: "recipe_requires_agent_tools_no_agent" },
          });
        }
      });

      // A layout arranges only what this plugin owns (#13780), and terminals
      // reach it only through a recipe, which the user confirms before it
      // starts. The placement refusals are the ones the panel store would make
      // at apply time, moved here so the author hears about them first.
      manifest.contributes.layouts.forEach((layout, layoutIndex) => {
        const layoutPath = ["contributes", "layouts", layoutIndex] as const;
        const references = new Set<string>();
        const groups = new Map<
          string,
          { location: string; projectScoped: boolean; size: number; entryIndex: number }
        >();
        let maximizedSeen = false;
        layout.entries.forEach((entry, entryIndex) => {
          const path = [...layoutPath, "entries", entryIndex];
          const targets = [entry.panel, entry.browser, entry.recipe].filter(
            (target) => target !== undefined
          );
          if (targets.length !== 1) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message:
                targets.length === 0
                  ? `Layout "${layout.id}" entry ${entryIndex} declares no target — give it one of panel, browser or recipe.`
                  : `Layout "${layout.id}" entry ${entryIndex} declares more than one of panel, browser and recipe — an entry places one thing, so keep one.`,
              params: {
                errorCode:
                  targets.length === 0
                    ? "layout_entry_target_missing"
                    : "layout_entry_target_conflict",
              },
            });
            return;
          }

          let location = entry.location ?? "grid";
          let size = 1;
          let projectScoped = false;
          let reference: string;
          if (entry.panel !== undefined) {
            const panelId = entry.panel;
            const panel = manifest.contributes.panels.find((candidate) => candidate.id === panelId);
            if (panel === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "panel"],
                message: `Layout "${layout.id}" panel "${panelId}" matches no contributes.panels[].id — a layout arranges only this plugin's own panels.`,
                params: { errorCode: "layout_panel_unknown" },
              });
              return;
            }
            if (panel.hasPty === true) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "panel"],
                message: `Layout "${layout.id}" panel "${panelId}" is PTY-backed (hasPty: true) — a layout starts terminals only through a recipe, which the user confirms.`,
                params: { errorCode: "layout_panel_pty" },
              });
              return;
            }
            projectScoped = panel.scope === "project";
            location = entry.location ?? (projectScoped ? "dock" : "grid");
            const placementProblem =
              location === "grid" && projectScoped
                ? 'a scope: "project" panel opens in the dock, never the grid'
                : location === "dock" && panel.dockable === false
                  ? "the panel opts out of the dock with dockable: false"
                  : undefined;
            if (placementProblem !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "location"],
                message: `Layout "${layout.id}" can't place panel "${panelId}" that way: ${placementProblem}.`,
                params: { errorCode: "layout_panel_placement" },
              });
            }
            reference = `panel:${panelId}`;
          } else if (entry.recipe !== undefined) {
            const recipeId = entry.recipe;
            const recipe = manifest.contributes.recipes.find(
              (candidate) => candidate.id === recipeId
            );
            if (recipe === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "recipe"],
                message: `Layout "${layout.id}" recipe "${recipeId}" matches no contributes.recipes[].id — a layout runs only this plugin's own recipes.`,
                params: { errorCode: "layout_recipe_unknown" },
              });
              return;
            }
            size = recipe.terminals.length;
            reference = `recipe:${recipeId}`;
          } else if (entry.browser !== undefined) {
            // The field's own refinement has already reported a malformed URL,
            // and the manifest checks still run after it.
            if (!isHttpUrl(entry.browser)) return;
            reference = `browser:${new URL(entry.browser).href}`;
          } else {
            return;
          }

          if (references.has(reference)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `Layout "${layout.id}" lists the same ${reference.split(":")[0]} twice — each panel, page and recipe takes one place in a layout.`,
              params: { errorCode: "layout_entry_duplicate" },
            });
          }
          references.add(reference);

          if (entry.maximized === true) {
            if (maximizedSeen || location !== "grid") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "maximized"],
                message: maximizedSeen
                  ? `Layout "${layout.id}" maximizes more than one entry — only one panel or group can fill the grid.`
                  : `Layout "${layout.id}" maximizes an entry in the dock — only a grid panel can be maximized.`,
                params: { errorCode: "layout_maximized_invalid" },
              });
            }
            maximizedSeen = true;
          }

          if (entry.tabGroup !== undefined) {
            const group = groups.get(entry.tabGroup);
            if (group === undefined) {
              groups.set(entry.tabGroup, { location, projectScoped, size, entryIndex });
            } else if (group.projectScoped !== projectScoped) {
              // A group's tabs share one worktree, and a project panel belongs
              // to none: it can share a group only with other project panels.
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "tabGroup"],
                message: `Layout "${layout.id}" tab group "${entry.tabGroup}" mixes scope: "project" panels with worktree panels — a group's tabs belong to one worktree, or all to the project.`,
                params: { errorCode: "layout_tab_group_scope" },
              });
            } else if (group.location !== location) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, "location"],
                message: `Layout "${layout.id}" puts tab group "${entry.tabGroup}" in both the grid and the dock — a group's tabs share one place.`,
                params: { errorCode: "layout_tab_group_location" },
              });
            } else {
              group.size += size;
            }
          }
        });
        for (const [key, group] of groups) {
          if (group.size >= 2) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...layoutPath, "entries", group.entryIndex, "tabGroup"],
            message: `Layout "${layout.id}" tab group "${key}" holds a single panel — a tab group needs at least two.`,
            params: { errorCode: "layout_tab_group_single" },
          });
        }
      });

      // A view renders into a `contributes.panels` entry with a matching id; a
      // view whose id matches no panel can never be shown (#10620). This is a
      // hard error now — it previously silently no-op'd at load.
      // A panel tour opens from its panel's menu, so it may only name a panel
      // kind this plugin declares — never a built-in or another plugin's kind.
      manifest.contributes.tours.forEach((tour, index) => {
        if (tour.panelKind !== undefined && !panelIds.has(tour.panelKind)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "tours", index, "panelKind"],
            message: `Tour "${tour.id}" panelKind "${tour.panelKind}" matches no contributes.panels[].id — a panel tour can only attach to one of this plugin's own panels.`,
            params: { errorCode: "tour_panel_kind_unknown" },
          });
        }
      });

      // A view-backed file editor must name one of this plugin's own
      // `location: "fileEditor"` views — anything else would advertise a mode
      // that mounts nothing, or mount a panel or settings view somewhere it was
      // never written for.
      manifest.contributes.fileEditors.forEach((entry, index) => {
        if (entry.view === undefined || fileEditorViewIds.has(entry.view)) return;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "fileEditors", index, "view"],
          message: viewIds.has(entry.view)
            ? `File editor "${entry.id}" names view "${entry.view}", which is not a location: "fileEditor" view.`
            : `File editor "${entry.id}" names view "${entry.view}", which matches no contributes.views[].id.`,
          params: { errorCode: "file_editor_view_ref_unknown" },
        });
      });

      // A settings view is the plugin's one custom settings section. It renders
      // into the plugin's settings home, not a panel, so it may not share an id
      // with a panel (the panels loop would otherwise attach it as that panel's
      // view), and a second one has nowhere to go.
      let settingsViewSeen = false;
      manifest.contributes.views.forEach((view, index) => {
        // What only the settings home reads; a panel or file editor takes its
        // display from elsewhere and has no pages to list.
        if (view.location !== "settings") {
          for (const field of ["title", "description", "pages"] as const) {
            if (view[field] === undefined) continue;
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "views", index, field],
              message: `View "${view.id}" sets ${field}, which only a location: "settings" view uses — it describes the plugin's custom settings section, and a ${view.location} view is not one.`,
              params: { errorCode: "view_settings_field_misplaced" },
            });
          }
        }
        if (view.location === "sidebar") {
          if (view.name === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "views", index, "name"],
              message: `Sidebar view "${view.id}" has no name — the sidebar switcher lists it by name.`,
              params: { errorCode: "sidebar_view_name_missing" },
            });
          }
          // Same reason as a settings view: the panels loop would attach it as
          // that panel's view.
          if (panelIds.has(view.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "views", index, "id"],
              message: `Sidebar view "${view.id}" shares its id with a contributes.panels entry — a sidebar view renders in the sidebar, not a panel, so give it an id of its own.`,
              params: { errorCode: "sidebar_view_panel_id_collision" },
            });
          }
          // Which sidebar view shows is decided from which ones apply, so one
          // whose availability hangs on that answer has no stable answer.
          if (view.when !== undefined && whenClauseReads(view.when, "activeSidebarView")) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "views", index, "when"],
              message: `Sidebar view "${view.id}" has a when that reads activeSidebarView — which sidebar view shows depends on which ones apply, so a sidebar view's own when can't depend on it.`,
              params: { errorCode: "sidebar_view_when_reads_active_view" },
            });
          }
          return;
        }
        // Display fields only a sidebar switcher entry reads; elsewhere the
        // runtime would silently ignore them (#10888).
        for (const field of ["name", "priority", "when"] as const) {
          if (view[field] === undefined) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "views", index, field],
            message: `View "${view.id}" sets ${field}, which only a location: "sidebar" view uses — a ${view.location} view takes its display from ${VIEW_DISPLAY_SOURCE[view.location]}.`,
            params: { errorCode: "view_sidebar_field_misplaced" },
          });
        }
        if (view.location === "fileEditor") {
          // Mounted only inside the file panel, never as a panel, so it must
          // not share an id with one (the panels loop would attach it there).
          if (panelIds.has(view.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "views", index, "id"],
              message: `File editor view "${view.id}" shares its id with a contributes.panels entry — a file editor view renders in the file panel, not a panel of its own, so give it an id of its own.`,
              params: { errorCode: "file_editor_view_panel_id_collision" },
            });
          }
          return;
        }
        if (view.location === "settings") {
          if (settingsViewSeen) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "views", index, "location"],
              message: `View "${view.id}" is a second location: "settings" view — a plugin has one settings section, so declare at most one.`,
              params: { errorCode: "settings_view_duplicate" },
            });
          }
          settingsViewSeen = true;
          if (panelIds.has(view.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["contributes", "views", index, "id"],
              message: `Settings view "${view.id}" shares its id with a contributes.panels entry — a settings view renders in the plugin's settings, not a panel, so give it an id of its own.`,
              params: { errorCode: "settings_view_panel_id_collision" },
            });
          }
          return;
        }
        if (!panelIds.has(view.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "views", index, "id"],
            message: `View "${view.id}" has no matching contributes.panels[].id — a view renders into a panel of the same id, so it would never be shown.`,
            params: { errorCode: "view_panel_ref_unknown" },
          });
        }
      });

      // Every `${settings:<id>}` token in an MCP server's command/args/env must
      // name a declared setting — the supervisor substitutes only declared ids
      // (`SETTINGS_TEMPLATE_RE` in PluginMcpSupervisor.ts) and an unknown id
      // resolves to the empty string, silently dropping the value. Agent
      // command/args also resolve `${settings:*}` at spawn (via
      // `resolveSettingTemplate` in terminal/lifecycle.ts), but are deliberately
      // NOT validated here — that path throws `SettingTemplateError` for an
      // unset or empty value at launch, so this parse-time check stays scoped
      // to MCP contributions. The
      // scan matches any `${settings:...}` shape (broad inner pattern), then
      // classifies: a key outside the `${SAFE_ID_PATTERN}` grammar is malformed
      // (the supervisor's stricter regex would skip it, passing the literal
      // token to exec); a well-formed key naming no setting is unknown.
      const settingsTokenRe = /\$\{settings:([^}]*)\}/g;
      const reportUnknownSettingsTokens = (text: string, path: (string | number)[]) => {
        for (const match of text.matchAll(settingsTokenRe)) {
          const key = match[1]!;
          if (!SAFE_ID_PATTERN.test(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `Malformed settings token "${match[0]}" — the setting id must match ${SAFE_ID_PATTERN.source}.`,
              params: { errorCode: "settings_token_malformed" },
            });
            continue;
          }
          if (!settingIds.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `Reference to undeclared setting "\${settings:${key}}" — no contributes.settings[].id matches "${key}".`,
              params: { errorCode: "settings_token_unknown" },
            });
          }
        }
      };
      manifest.contributes.mcpServers.forEach((server, index) => {
        reportUnknownSettingsTokens(server.command, [
          "contributes",
          "mcpServers",
          index,
          "command",
        ]);
        server.args?.forEach((arg, argIndex) =>
          reportUnknownSettingsTokens(arg, ["contributes", "mcpServers", index, "args", argIndex])
        );
        for (const [envKey, envValue] of Object.entries(server.env ?? {})) {
          reportUnknownSettingsTokens(envValue, [
            "contributes",
            "mcpServers",
            index,
            "env",
            envKey,
          ]);
        }
      });
    });
}

export type {
  PluginManifest,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  SkillContribution,
  ThemeContribution,
  PromptTemplateContribution,
  PluginCapability,
};
export type { ForgeProviderContribution, FileDecorationContribution };
