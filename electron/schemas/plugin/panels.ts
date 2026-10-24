// Panel contributions and what opens them: toolbar buttons, launch entries, layouts and search providers.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import { PANEL_MENU_MAX_ITEMS, PANEL_TOOLBAR_MAX_ITEMS } from "../../../shared/types/plugin.js";
import {
  SEARCH_PROVIDER_KEYWORD_PATTERN,
  SEARCH_PROVIDER_TITLE_MAX_LENGTH,
} from "../../../shared/config/pluginSearchProviders.js";
import { utf8 } from "./common.js";

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

export function isHttpUrl(value: string): boolean {
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
