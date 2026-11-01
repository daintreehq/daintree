// SDK BOUNDARY: New imports from ./forge.js must be classified in
// shared/types/plugin-sdk.ts. See docs/plugins/architecture.md#sdk-surface.
// eslint-disable-next-line no-restricted-imports -- existing forge imports are classified; the lint guard covers new additions
import type {
  FileDecorationContribution,
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderContribution,
  AnyForgeProviderImpl,
  ForgeProviderDescriptor,
  NormalizedPRState,
  ResourceRef,
} from "./forge.js";
import type { PluginArtifactApi } from "./pluginArtifacts.js";
export type {
  PluginArtifact,
  PluginArtifactApi,
  PluginArtifactCreateOptions,
  PluginArtifactDownloadOptions,
  PluginArtifactDownloadRequest,
  PluginArtifactImportSource,
  PluginArtifactListOptions,
  PluginArtifactProgress,
  PluginArtifactSource,
  PluginArtifactUploadOptions,
  PluginArtifactUploadRequest,
  PluginArtifactUploadResult,
} from "./pluginArtifacts.js";
import type { NotificationType } from "./notification.js";
import type {
  ActionDispatchResult,
  ActionId,
  PluginActionManifestEntry,
  PluginCanDispatchResult,
} from "./actions.js";
import type { AgentState, WaitingReason } from "./agent.js";
import type { AgentDetectionConfig, AgentResumeTemplate } from "../config/agentRegistry.js";
import type { LaunchMcpFormat } from "../config/launchMcp.js";
import type {
  ContextProviderContribution,
  ContextProviderDescriptor,
  ContextProviderImpl,
} from "./pluginContextProvider.js";
import type { ElementPickerProviderContribution } from "../elementPicker/providers.js";
import type {
  PluginServiceHandlers,
  PluginServiceContract,
  PluginServicesApi,
  PluginServicesContribution,
} from "./pluginServices.js";
import type { z } from "zod";
import type {
  FileEditorContribution,
  PluginFileDocument,
  HostedFileEditorDescriptor,
} from "./plugin/fileEditors.js";
export {
  DEFAULT_FILE_EDITOR_MAX_BYTES,
  HOST_FILE_EDITOR_CHOICE,
  isFileEditorChoiceKey,
  fileEditorChoiceId,
  isFileEditorChoice,
} from "./plugin/fileEditors.js";
export type {
  FileEditorContribution,
  FileEditorMode,
  FileEditorChoiceKey,
  FileEditorChoice,
  FileEditorChoices,
  PluginFileDocumentReadResult,
  PluginFileDocumentSaveResult,
  PluginFileDocumentChange,
  PluginFileDocument,
  HostedFileEditorDescriptor,
} from "./plugin/fileEditors.js";
import type { SurfaceContributions } from "./plugin/projectSurfaces.js";
export {
  PROJECT_SURFACE_SLOT_CATALOGUE,
  PROJECT_SURFACE_SLOTS,
  isProjectSurfaceSlot,
  fileEditorSlotKey,
  isFileEditorSlotKey,
  fileEditorSlotPattern,
  isProjectSurfaceSlotKey,
  MAX_PROJECT_SURFACE_UPDATES,
  projectSurfaceSlotDescriptor,
  orderedProjectSurfaceSlots,
  fileEditorSlotClaimData,
  projectSurfaceClaimFromState,
  isProjectSurfaceChoice,
  resolveProjectSurfaceSelection,
} from "./plugin/projectSurfaces.js";
export type {
  ProjectSurfaceSlotMode,
  ProjectSurfaceClaimKind,
  ProjectSurfaceSlotDescriptor,
  ProjectSurfaceSlot,
  SurfaceViewSlot,
  SurfaceContributions,
  ProjectSurfaceClaim,
  ProjectSurfaceSnapshot,
  FileEditorSlotKey,
  ProjectSurfaceSlotKey,
  FileEditorSlotClaimData,
  ProjectSurfaceClaimValue,
  ProjectSurfaceSlotClaim,
  ProjectSurfaceRefusalReason,
  ProjectSurfaceRefusal,
  ProjectSurfaceSlotState,
  ProjectSurfacesSnapshot,
  ProjectSurfacesChangedEvent,
  ProjectSurfaceChoice,
  ProjectSurfaceChoiceRecord,
  ProjectSurfaceChoices,
  ProjectSurfaceChoiceUpdate,
} from "./plugin/projectSurfaces.js";
import type {
  PluginApplicationDescriptor,
  ProjectApplicationState,
} from "./plugin/projectApplication.js";
export {
  PLUGIN_APPLICATION_DESTINATIONS,
  PLUGIN_APPLICATION_ARRANGEMENTS,
  PLUGIN_APPLICATION_NAVIGATION_LIMITS,
} from "./plugin/projectApplication.js";
export type {
  PluginApplicationDestination,
  PluginApplicationArrangement,
  PluginApplicationTourRef,
  PluginApplicationNavigationParam,
  PluginApplicationSection,
  PluginApplicationNavigation,
  PluginApplicationDescriptor,
  ProjectApplicationStatus,
  ProjectApplicationReason,
  ProjectApplicationPreflightReason,
  ProjectApplicationState,
} from "./plugin/projectApplication.js";
export {
  PROJECT_PLUGIN_INSTANCE_PREFIX,
  makeProjectPluginInstanceKey,
  makeInstalledProjectInstanceKey,
  isInstalledProjectInstanceKey,
  parseProjectPluginInstanceKey,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "./plugin/instanceKeys.js";

export interface PanelContribution {
  id: string;
  name: string;
  /** A generic plugin icon id, or a `./…svg` path to the plugin's own icon (#13143). */
  iconId: string;
  color: string;
  hasPty: boolean;
  canRestart: boolean;
  canConvert: boolean;
  showInPalette: boolean;
  /**
   * Whether this panel kind can live in the dock. Dockable by default; set
   * `false` to opt out (for a kind with no meaningful compact chip-row form).
   */
  dockable?: boolean;
  /** Schema version stamped on every persisted panel-state write; bump only for an incompatible shape change. */
  stateVersion?: number;
  /**
   * What one panel of this kind belongs to. `"worktree"` (the default) ties each
   * panel to the worktree it was opened in. `"project"` opens it with no
   * worktree, so one panel serves the whole project: it opens in the dock by
   * default, and its dock chip and its dialog show in every worktree.
   */
  scope?: "worktree" | "project";
  /**
   * Set `true` to report your own work on panels of this kind with
   * `host.setPanelActivity` (working, waiting, finished, failed). The host
   * draws it the way it draws agent activity, attributed to your plugin, and
   * the plugin manager lists the kind as reporting activity.
   */
  reportsActivity?: boolean;
  /**
   * Up to five of your own actions, offered in this panel's ⋯ and right-click
   * menus in the order given. Each is dispatched with `{ panelId }` naming the
   * panel the menu was opened on.
   */
  menu?: PanelMenuItemContribution[];
  /**
   * Up to three of your own actions drawn as buttons in this panel's header,
   * in the order given. Each is dispatched with `{ panelId }` naming the panel
   * it was clicked on. The view sets a button's live state (busy, disabled,
   * tone, a status line, an "Updated" age) with `setToolbarItemState`.
   */
  toolbar?: PanelToolbarItemContribution[];
}

/** Most entries one panel's `menu` may declare. */
export const PANEL_MENU_MAX_ITEMS = 5;

/** Most entries one panel's `toolbar` may declare. */
export const PANEL_TOOLBAR_MAX_ITEMS = 3;

/** One entry of a panel's `toolbar`: a button in the panel header. */
export interface PanelToolbarItemContribution {
  /**
   * One of your own actions, in your plugin's namespace (`"{manifestId}.{id}"`),
   * from `contributes.commands` or `host.registerAction`. The button appears
   * while that action is registered.
   */
  actionId: string;
  /** The button's name, and its tooltip. Defaults to the action's title. */
  label?: string;
  /** A generic plugin icon id, or a `./…svg` path to the plugin's own icon. Omitted, the label is drawn as text. */
  iconId?: string;
  /**
   * Draws a status beside the button: the state's `text` and `updatedAt` age,
   * and its `tone`. Omitted (false), only the button is drawn and those
   * fields are ignored.
   */
  status?: boolean;
}

/**
 * The live state of one panel `toolbar` button, set by the view with
 * `setToolbarItemState`. Every field is optional; an omitted field is the
 * button's resting value.
 */
export interface PluginPanelToolbarItemState {
  /** Draws a spinner on the button and ignores clicks until it is cleared. */
  busy?: boolean;
  /** Announced unavailable and ignores clicks. */
  disabled?: boolean;
  /**
   * `warning` or `danger` colours the status and adds its glyph; colour is
   * never the only signal. Needs `status: true`. An explicit tone wins over
   * the age's own stale warning.
   */
  tone?: "default" | "warning" | "danger";
  /** A short status beside the button ("2 prices kept from cache"). Needs `status: true`. */
  text?: string;
  /** Epoch ms or an ISO string: drawn as "Updated 3h ago" on the host's shared clock. Needs `status: true`. */
  updatedAt?: number | string;
  /** Once `updatedAt` is older than this many ms the age reads as stale (warning glyph and colour) without another update. */
  staleAfterMs?: number;
  /** The button's tooltip, when it says more than the label ("Prices fetched 14:02"). */
  tooltip?: string;
}

/** Most characters a toolbar item's `text` or `tooltip` may carry; longer values are cut. */
export const PLUGIN_PANEL_TOOLBAR_TEXT_MAX = 120;

/** One entry of a panel's `menu`. */
export interface PanelMenuItemContribution {
  /**
   * One of your own actions, in your plugin's namespace (`"{manifestId}.{id}"`),
   * from `contributes.commands` or `host.registerAction`. The item appears
   * while that action is registered.
   */
  actionId: string;
  /** Menu label. Defaults to the action's title. */
  label?: string;
}

/**
 * Most entries one publisher may put on a panel's menu at runtime, through
 * `PanelViewProps.setMenuItems` or `host.setPanelMenuItems`. Separate from the
 * manifest's {@link PANEL_MENU_MAX_ITEMS}.
 */
export const PANEL_RUNTIME_MENU_MAX_ITEMS = 5;

/** Most characters a menu entry's label may carry; a longer runtime label is cut. */
export const PANEL_MENU_LABEL_MAX = 80;

/** Most characters a title set through `PanelViewProps.setTitle` may carry; a longer one is cut. */
export const PANEL_VIEW_TITLE_MAX = 80;

/**
 * What a toolbar button opens instead of dispatching an action: an anchored
 * popover the host draws, filled by one of the plugin's own views.
 */
export interface ToolbarButtonPopover {
  /**
   * A `contributes.views[].id` with `location: "panel"` whose panel is not
   * `hasPty`. The same view stays spawnable as a panel; in the popover it sees
   * `hostContext.kind === "popover"` and can close it with `hostContext.close`.
   */
  viewId: string;
}

/**
 * A toolbar button does one thing on click: dispatch `actionId`, or open
 * `popover`. Declaring both is a manifest error.
 *
 * `menu` adds a short list of the plugin's own commands (at most
 * {@link PANEL_MENU_MAX_ITEMS}). With an `actionId` the button is a split
 * button — the click runs the action and a chevron opens the menu; with
 * neither `actionId` nor `popover` it is a menu button that opens the menu.
 * A button with a `popover` can't also carry a menu. Each item is dispatched
 * on its own with nothing the plugin supplies, and shows only while its action
 * is registered. A plugin can replace the list at runtime with
 * {@link PluginToolbarButtonRuntimeState.menu}.
 */
export interface ToolbarButtonContribution {
  id: string;
  label: string;
  /** A generic plugin icon id, or a `./…svg` path to the plugin's own icon (#13143). */
  iconId: string;
  actionId?: ActionId;
  popover?: ToolbarButtonPopover;
  menu?: PanelMenuItemContribution[];
  priority?: 1 | 2 | 3 | 4 | 5;
}

/** Where a panel launch entry opens its panel. `grid` is the worktree's panel grid. */
export type PluginLaunchEntryPlacement = "dock" | "grid" | "dialog";

/** Opens one of the plugin's own panels, optionally with arguments. */
export interface PluginLaunchEntryPanelTarget {
  /** A `contributes.panels[].id` of this plugin. */
  id: string;
  /** Handed to the view as `initialArgs`, or as `openRequest` to a panel the open reuses. */
  args?: Record<string, unknown>;
  /** Omitted: where the launcher surface opens panels, and the dock for a project panel. */
  placement?: PluginLaunchEntryPlacement;
}

/** Dispatches one of the plugin's own commands. */
export interface PluginLaunchEntryCommandTarget {
  /** Written `{manifest name}.{command id}`; another namespace is a manifest error. */
  actionId: string;
  args?: Record<string, unknown>;
}

/** Starts an agent with a first turn. Nothing else about the launch is the plugin's to choose. */
export interface PluginLaunchEntryAgentTarget {
  /** An agent id from the agent registry. */
  id: string;
  prompt: string;
}

/**
 * A row a plugin adds to the launcher (#13788). Declaring exactly one of
 * `panel`, `command` and `agent` is required; none or several is a manifest
 * error.
 */
export interface PluginLaunchEntryContribution {
  id: string;
  label: string;
  /** A generic plugin icon id, or a `./…svg` path to the plugin's own icon. */
  iconId: string;
  description?: string;
  /** Order within the plugin's group, 1 first. Default 3. */
  priority?: 1 | 2 | 3 | 4 | 5;
  when?: string;
  /** Also list this entry as a tile in the empty canvas's "From <plugin>" band. */
  showInEmptyState?: boolean;
  panel?: PluginLaunchEntryPanelTarget;
  command?: PluginLaunchEntryCommandTarget;
  agent?: PluginLaunchEntryAgentTarget;
}

/** A launch entry's target as main resolved it, with runtime ids in place of manifest ones. */
export type PluginLaunchEntryTarget =
  | {
      type: "panel";
      /** The runtime panel kind id, project-qualified for a project plugin. */
      panelKindId: string;
      args?: Record<string, unknown>;
      placement?: PluginLaunchEntryPlacement;
    }
  | {
      type: "command";
      /** The runtime action id, in the plugin instance's own namespace. */
      actionId: string;
      args?: Record<string, unknown>;
    }
  | { type: "agent"; agentId: string; prompt: string };

/** A registered launch entry, as main broadcasts it to the renderer. */
export interface PluginLaunchEntryConfig {
  /** `{pluginId}.{entry id}`: the plugin instance id, so project-qualified for a project plugin. */
  id: string;
  pluginId: string;
  /** The plugin's display name, the group's heading. */
  pluginName: string;
  label: string;
  iconId: string;
  description?: string;
  priority: 1 | 2 | 3 | 4 | 5;
  when?: string;
  showInEmptyState?: boolean;
  target: PluginLaunchEntryTarget;
}

/** Where a layout entry puts its panels. `grid` is the active worktree's panel grid. */
export type PluginLayoutLocation = "grid" | "dock";

/**
 * One entry of a {@link LayoutContribution}. Declaring exactly one of `panel`,
 * `browser` and `recipe` is required; none or several is a manifest error.
 */
export interface LayoutEntryContribution {
  /** A `contributes.panels[].id` of this plugin. A PTY-backed panel is refused: terminals come from recipes. */
  panel?: string;
  /** An `http:` or `https:` URL, opened in a browser panel. */
  browser?: string;
  /** A `contributes.recipes[].id` of this plugin. Its terminals start only once the user confirms. */
  recipe?: string;
  /** Default `grid`, or `dock` for a `scope: "project"` panel. A recipe puts all its terminals here. */
  location?: PluginLayoutLocation;
  /** Entries sharing a key open as the tabs of one group, in entry order. */
  tabGroup?: string;
  /** Maximize this entry's panel, or its tab group, in the grid. At most one per layout. */
  maximized?: boolean;
}

/**
 * A named arrangement of the plugin's own panels, browser pages and recipes
 * (#13780). The user applies one from the palette and the plugin's commands
 * can apply their own through `layout.apply`. Applying is additive: it opens
 * or moves what it lists and leaves every other panel where it is.
 */
export interface LayoutContribution {
  id: string;
  name: string;
  entries: LayoutEntryContribution[];
}

/** A layout entry's target as main resolved it, with runtime ids in place of manifest ones. */
export type PluginLayoutTarget =
  | {
      type: "panel";
      /** The runtime panel kind id, project-qualified for a project plugin. */
      panelKindId: string;
    }
  | { type: "browser"; url: string }
  | {
      type: "recipe";
      /** The qualified recipe id, `{pluginId}.{recipe id}`. */
      recipeId: string;
    };

export interface PluginLayoutEntry {
  target: PluginLayoutTarget;
  location: PluginLayoutLocation;
  tabGroup?: string;
  maximized?: boolean;
}

/** A registered layout, as main broadcasts it to the renderer. */
export interface PluginLayoutConfig {
  /** `{pluginId}.{layout id}`: the plugin instance id, so project-qualified for a project plugin. */
  id: string;
  pluginId: string;
  /** The plugin's display name, shown beside the layout's own. */
  pluginName: string;
  name: string;
  entries: PluginLayoutEntry[];
  /** Set on the layout a project plugin names as `surfaces.defaultLayout` (#13782). */
  projectDefault?: true;
}

/**
 * Where a project's first-open layout seed stands on this machine (#13782).
 *
 * - `pending` — main saw the project's first open (no saved state, readable,
 *   not safe mode) and nothing has been opened since. A default layout that
 *   arrives while the grid and dock are empty is applied.
 * - `offered` — the user opened something first, so a default layout is only
 *   ever offered, never applied on its own.
 * - `applying` — one view claimed the seed and is opening the layout now.
 *   Written before anything opens (#14106), so an apply cut short is seen.
 * - `failed` — the apply threw, left entries unopened, or its view went away
 *   mid-apply (a crash, a reload, a quit). Waits for the user's Retry, which
 *   reuses whatever the earlier attempt already opened, or their dismissal.
 * - `settled` — used, declined, or never eligible. Nothing more happens.
 */
export type ProjectLayoutSeedStatus = "pending" | "offered" | "applying" | "failed" | "settled";

/** Why a seed settled, kept for diagnostics. */
export type ProjectLayoutSeedOutcome = "applied" | "opened" | "dismissed" | "ineligible";

export interface ProjectLayoutSeedRecord {
  status: ProjectLayoutSeedStatus;
  /**
   * Why a seed settled. While `applying` or `failed`, how the apply began —
   * `applied` on its own or `opened` from the offer — which it settles with.
   */
  outcome?: ProjectLayoutSeedOutcome;
  /** Epoch ms of the last change. */
  at: number;
}

/**
 * What the user did with a project application's welcome (#14106): skipped
 * it, or played it to the end. Either way it is not offered again until the
 * application declares a higher welcome revision.
 */
export type ProjectWelcomeStatus = "skipped" | "completed";

export interface ProjectWelcomeRecord {
  /** The `application.welcomeTour.version` the decision was made under. */
  version: number;
  status: ProjectWelcomeStatus;
  /** Epoch ms of the decision. */
  at: number;
}

/** A compare-and-set on a project's seed: whether this call moved it, and what is stored now. */
export interface ProjectLayoutSeedAdvance {
  advanced: boolean;
  /** `null` while the project's first hydrate has not been seen. */
  record: ProjectLayoutSeedRecord | null;
}

/**
 * Where a quick switcher search result opens, in manifest terms: one of the
 * plugin's own `contributes.panels[].id`, or one of its own commands written
 * `{manifest name}.{command id}`. Exactly one of the two.
 */
export interface PluginSearchResultTarget {
  panel?: string;
  command?: string;
}

/**
 * A search provider the plugin adds to the quick switcher (#13792). Typing
 * `keyword` then Tab scopes the switcher to it; with `blend` it also offers a
 * few results to the unscoped search.
 *
 * - `kind: "declarative"` names one of the plugin's read-only
 *   `contributes.databases[].queries` with exactly one string parameter, which
 *   the host runs with what the user typed. No plugin code runs. Result rows
 *   are read by column name: `id` and `label` (required), `description`,
 *   `iconId` and `args` (a JSON object as text). `target` is required.
 * - `kind: "runtime"` is answered by the function the plugin binds with
 *   {@link PluginHostApi.registerSearchProvider} during `activate()`. `target`
 *   is the default for results that carry none.
 */
export interface PluginSearchProviderContribution {
  id: string;
  kind: "declarative" | "runtime";
  /** Shown in the switcher's scope chip and in Settings. */
  title: string;
  /** Lowercase letters, digits and `-`, starting with a letter. Unique per project. */
  keyword: string;
  /** A generic plugin icon id, or a `./…svg` path to the plugin's own icon. Results without their own use it. */
  iconId?: string;
  /** Offer a few results to the unscoped search too. Default false. */
  blend?: boolean;
  /** For `declarative`: the `name` of one of the plugin's read-only declared queries. */
  query?: string;
  target?: PluginSearchResultTarget;
}

/** One result a runtime search provider returns. The host renders it; nothing here is markup. */
export interface PluginSearchResult {
  /** Stable within this provider; results with a repeated id are dropped. */
  id: string;
  label: string;
  description?: string;
  /** A generic plugin icon id or one of this plugin's registered custom icons. */
  iconId?: string;
  /** Omitted: the provider's manifest `target`. */
  target?: PluginSearchResultTarget;
  /** Handed to the target: the panel's `initialArgs` (or `openRequest`), or the command's args. */
  args?: Record<string, unknown>;
}

/** What a runtime search provider is told about the query it is answering. */
export interface PluginSearchContext {
  /** `scoped` when the user picked this provider by keyword; `blended` for the unscoped search. */
  mode: "scoped" | "blended";
  /** Most results the host will show; extra ones are dropped. */
  limit: number;
  /** Aborted when the user typed on, closed the switcher, or the deadline passed. */
  signal: AbortSignal;
}

/** A runtime search provider, bound with {@link PluginHostApi.registerSearchProvider}. */
export type PluginSearchProvider = (
  query: string,
  context: PluginSearchContext
) => PluginSearchResult[] | Promise<PluginSearchResult[]>;

/** A search result's target as main resolved it, with runtime ids in place of manifest ones. */
export type PluginSearchResolvedTarget =
  | {
      type: "panel";
      /** The runtime panel kind id, project-qualified for a project plugin. */
      panelKindId: string;
      args: Record<string, unknown>;
    }
  | {
      type: "command";
      /** The runtime action id, in the plugin instance's own namespace. */
      actionId: string;
      args: Record<string, unknown>;
    };

/** A search provider as the quick switcher and Settings see it, for one project. */
export interface PluginSearchProviderInfo {
  /** `{pluginId}.{provider id}`: the plugin instance id, so project-qualified for a project plugin. */
  key: string;
  pluginId: string;
  pluginName: string;
  title: string;
  keyword: string;
  iconId: string;
  blend: boolean;
  kind: "declarative" | "runtime";
  /** The user's "Show in quick switcher" choice. */
  shown: boolean;
  /** Another plugin's provider registered the same keyword first in this project; this one is refused. */
  keywordTakenBy?: string;
}

/** One validated result row, as main hands it to the quick switcher. */
export interface PluginSearchResultRow {
  id: string;
  label: string;
  description?: string;
  iconId: string;
  target: PluginSearchResolvedTarget;
}

/** What the quick switcher asks one provider. */
export interface PluginSearchQueryRequest {
  providerKey: string;
  query: string;
  mode: "scoped" | "blended";
}

/**
 * One provider's answer. `unavailable` is a provider that can't be asked now
 * (gone, hidden, refused, or not running for a blended search); `timeout` and
 * `error` are recorded in the plugin's diagnostics.
 */
export type PluginSearchQueryResponse =
  | { status: "ok"; results: PluginSearchResultRow[] }
  | { status: "cancelled" | "timeout" | "error" | "unavailable" };

/**
 * Semantic color for a {@link PluginPanelBadge}. Plugins pick intent, not a raw
 * hex value, so badges stay theme-consistent. `"warning"` and `"error"` map to
 * the app's status palette; `"default"` is the neutral accent-free tint.
 *
 * `"success"` does NOT render green. A badge stands for as long as the plugin
 * leaves it there, and the host cannot know what a given plugin means by
 * success, so it renders as emphasis on the neutral ramp instead of a health
 * hue (#12002) — still visually distinct from `"default"`, just not green.
 *
 * Only a panel of a kind the plugin contributed draws the color. On any other
 * panel the badge is drawn as `"default"` and its tooltip names the plugin, so
 * it can't pass for a failure Daintree observed (#13766).
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

/**
 * Live state a plugin sets on one of its own toolbar buttons via
 * {@link PluginHostApi.setToolbarButtonState} (#13785). Every field is optional
 * and each call replaces the whole state, so a field left out returns to the
 * manifest's default. The button's label never changes: a toggle reads the same
 * name in both positions and announces `pressed` as `aria-pressed`.
 */
export interface PluginToolbarButtonRuntimeState {
  /** Marks the button as a toggle and whether it is on. Leave out for a plain button. */
  pressed?: boolean;
  /** Blocks activation. Requires `disabledReason`, shown in place of the tooltip. */
  disabled?: boolean;
  /** Why the button is disabled, in a sentence the user can act on. Only with `disabled: true`. */
  disabledReason?: string;
  /** Work started by this button is running: shows a spinner and blocks activation. */
  busy?: boolean;
  /** Replaces the tooltip text. The accessible name stays the manifest `label`. */
  tooltip?: string;
  /** Replaces the icon, using the same ids as the manifest `iconId`. Unknown ids keep the manifest icon. */
  iconId?: string;
  /**
   * Replaces the button's manifest `menu` (#13786); `[]` removes it. Each
   * `actionId` must be one of this plugin's own actions, written
   * `"{manifestId}.{id}"`, at most {@link PANEL_MENU_MAX_ITEMS} of them. Not
   * for a button that opens a popover.
   */
  menu?: PanelMenuItemContribution[];
}

/** Max length of a {@link PluginToolbarButtonRuntimeState} `tooltip` or `disabledReason`, enforced host-side. */
export const PLUGIN_TOOLBAR_BUTTON_STATE_TEXT_MAX = 200;

/**
 * A short status a plugin shows on one worktree's card via
 * {@link PluginHostApi.setWorktreeCardStatus} (#13704): a one-line `label`
 * drawn as quiet metadata, an optional `tooltip` with the detail, and an
 * optional `command` the chip runs when clicked.
 */
export interface PluginWorktreeCardStatus {
  label: string;
  tooltip?: string;
  /**
   * One of this plugin's own actions, written `"{manifestId}.{id}"` as in the
   * manifest, dispatched with `{ worktreeId }` when the chip is clicked
   * (#13776). The chip stays a plain status until the action is registered.
   */
  command?: string;
}

/** Max length of a {@link PluginWorktreeCardStatus} `label`, enforced host-side. */
export const PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX = 32;

/** Max length of a {@link PluginWorktreeCardStatus} `tooltip`, enforced host-side. */
export const PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX = 512;

/**
 * One advisory readiness check a plugin shows in a worktree's Review Hub via
 * {@link PluginHostApi.setWorktreeReviewChecks} (#13806). Never a blocker: it
 * cannot change whether commit or push is ready.
 */
export interface PluginWorktreeReviewCheck {
  /** One line naming what the plugin found. */
  label: string;
  severity: "warning" | "info";
  detail?: string;
  /**
   * One of this plugin's own actions, written `"{manifestId}.{id}"`, offered
   * as a button and dispatched with `{ worktreeId }`. Until the action is
   * registered the check stays plain text.
   */
  command?: string;
}

/** Max length of a {@link PluginWorktreeReviewCheck} `label`, enforced host-side. */
export const PLUGIN_WORKTREE_REVIEW_CHECK_LABEL_MAX = 120;

/** Max length of a {@link PluginWorktreeReviewCheck} `detail`, enforced host-side. */
export const PLUGIN_WORKTREE_REVIEW_CHECK_DETAIL_MAX = 2048;

/** Most checks one plugin may hold on one worktree, enforced host-side. */
export const PLUGIN_WORKTREE_REVIEW_CHECKS_MAX = 10;

/**
 * One `contributes.worktreeSetupSteps` entry (#13807): work the plugin does
 * for each worktree Daintree creates, after the project's own setup script.
 * The handler is bound in `activate()` through
 * {@link PluginActivationApi.registerWorktreeSetupStep}.
 *
 * Declared in the manifest so the step can be shown and allowed before any
 * plugin code runs. The user allows each step once per project, and a new
 * label, timeout or plugin version asks again.
 */
export interface WorktreeSetupStepContribution {
  /** Unique within the plugin; the id the handler registers under. */
  id: string;
  /** Shown on the worktree card while the step runs, and when asking to allow it. */
  label: string;
  /**
   * How long the step may run before its signal aborts and it is recorded as
   * timed out. Defaults to {@link PLUGIN_WORKTREE_SETUP_STEP_DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/** Max length of a {@link WorktreeSetupStepContribution} `label`. */
export const PLUGIN_WORKTREE_SETUP_STEP_LABEL_MAX = 80;

/** Shortest {@link WorktreeSetupStepContribution} `timeoutMs` a manifest may declare. */
export const PLUGIN_WORKTREE_SETUP_STEP_MIN_TIMEOUT_MS = 1_000;

/** Longest {@link WorktreeSetupStepContribution} `timeoutMs` a manifest may declare. */
export const PLUGIN_WORKTREE_SETUP_STEP_MAX_TIMEOUT_MS = 30 * 60_000;

/** The timeout of a {@link WorktreeSetupStepContribution} that declares none. */
export const PLUGIN_WORKTREE_SETUP_STEP_DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** What a worktree setup step handler is told about the worktree it sets up. */
export interface PluginWorktreeSetupStepContext {
  /** The project the worktree belongs to. */
  readonly projectId: string;
  readonly worktreeId: string;
  /** Absolute path of the new worktree's checkout. */
  readonly worktreePath: string;
  /** The checked-out branch, or `null` when HEAD is detached. */
  readonly branch: string | null;
  /**
   * Aborted when the step times out or the worktree is deleted while it runs.
   * The host stops waiting either way; a handler that ignores it keeps running
   * unobserved.
   */
  readonly signal: AbortSignal;
}

/**
 * Runs one worktree setup step. Resolving is success; throwing, or rejecting,
 * is a failure the worktree card attributes to the plugin. A retry runs the
 * step again, so it must tolerate running more than once.
 */
export type PluginWorktreeSetupStepHandler = (
  context: PluginWorktreeSetupStepContext
) => void | Promise<void>;

/**
 * One note a plugin adds to a worktree's delete confirmation (#13805). Plain
 * text, shown attributed to the plugin. Annotation only: a note never cancels
 * the delete, changes its confirmation tier or alters the typed confirmation.
 */
export interface PluginWorktreeDeleteNote {
  severity: "warning" | "info";
  /** One line. Line breaks become spaces; control and bidi characters are removed. */
  text: string;
}

/** Max length of a {@link PluginWorktreeDeleteNote} `text`, in code points, enforced host-side. */
export const PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX = 200;

/** Most notes one plugin may return for one worktree, enforced host-side. */
export const PLUGIN_WORKTREE_DELETE_NOTES_MAX = 3;

/**
 * `contributes.worktreeDeleteNotes` entry (#13805). Declaring it is what lets
 * the host find, and activate, the plugin when a delete is confirmed; the
 * provider binds during `activate()` through
 * {@link PluginActivationApi.registerWorktreeDeleteNotesProvider}.
 */
export interface WorktreeDeleteNotesContribution {
  /** Must match the descriptor passed to `registerWorktreeDeleteNotesProvider`. */
  id: string;
}

/** Passed to {@link PluginActivationApi.registerWorktreeDeleteNotesProvider} alongside the impl. */
export interface WorktreeDeleteNotesProviderDescriptor {
  id: string;
}

/**
 * Runtime contract bound through
 * {@link PluginActivationApi.registerWorktreeDeleteNotesProvider}. The host
 * calls {@link provideNotes} each time a delete of a worktree in the plugin's
 * reach is confirmed, and shows what it returns in that confirmation.
 */
export interface WorktreeDeleteNotesProviderImpl {
  /**
   * Notes for the worktree about to be deleted, at most
   * {@link PLUGIN_WORKTREE_DELETE_NOTES_MAX}. Return `[]` when there is
   * nothing to say. An answer that misses the host's deadline, throws, or
   * breaks the note rules is shown as "<plugin> didn't answer".
   */
  provideNotes(
    worktree: PluginWorktreeSnapshot
  ): Promise<readonly PluginWorktreeDeleteNote[]> | readonly PluginWorktreeDeleteNote[];
}

/** A plugin asked for notes when a worktree delete is confirmed in a view (#13805). Host-internal. */
export interface WorktreeDeleteNoteSource {
  /** Instance id. */
  pluginId: string;
  /** Who the confirmation attributes the notes to. */
  pluginName: string;
}

/** One plugin's answer: its vetted notes, or that it missed the deadline, failed or broke the rules. */
export type WorktreeDeleteNotesAnswer =
  { status: "answered"; notes: PluginWorktreeDeleteNote[] } | { status: "no-answer" };

/** An answer with the plugin it came from, as the no-window confirmation collects them. */
export interface WorktreeDeleteNotesReport extends WorktreeDeleteNoteSource {
  answer: WorktreeDeleteNotesAnswer;
}

/**
 * A short status a plugin shows on one terminal's header via
 * {@link PluginHostApi.setTerminalStatus} (#13802): the same shape as a
 * worktree card's, drawn as a colourless chip named after the plugin.
 */
export interface PluginTerminalStatus {
  label: string;
  tooltip?: string;
  /**
   * One of this plugin's own actions, written `"{manifestId}.{id}"` as in the
   * manifest, dispatched with `{ terminalId, worktreeId? }` when the chip is
   * clicked. The chip stays a plain status until the action is registered.
   */
  command?: string;
}

/** Max length of a {@link PluginTerminalStatus} `label`, enforced host-side. */
export const PLUGIN_TERMINAL_STATUS_LABEL_MAX = PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX;

/** Max length of a {@link PluginTerminalStatus} `tooltip`, enforced host-side. */
export const PLUGIN_TERMINAL_STATUS_TOOLTIP_MAX = PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX;

/** Most terminals one plugin may hold a status on at once, per project. */
export const PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT = 256;

/** What a plugin says one of its own panels is doing, via {@link PluginHostApi.setPanelActivity}. */
export type PluginPanelActivityState = "working" | "waiting" | "finished" | "failed";

/**
 * A plugin's report of its own work on one of its own panels (#13820): its
 * state and an optional one-line `reason` ("Importing 3 of 12", "Pick a
 * branch to sync"). Drawn the way agent activity is drawn, always attributed
 * to the plugin.
 */
export interface PluginPanelActivity {
  state: PluginPanelActivityState;
  reason?: string;
}

/**
 * A {@link PluginPanelActivity} as main holds and sends it: `revision` is
 * assigned per accepted change, so a view can tell a replay of the report it
 * already showed from a new one. Never authored by a plugin.
 */
export interface PluginPanelActivityReport extends PluginPanelActivity {
  revision: number;
}

/** Max length of a {@link PluginPanelActivity} `reason`, enforced host-side. */
export const PLUGIN_PANEL_ACTIVITY_REASON_MAX = 120;

/** Most panels one plugin may hold an activity report on at once. */
export const PLUGIN_PANEL_ACTIVITY_MAX_PANELS = 256;

/** Value a plugin publishes to `when` clauses via {@link PluginHostApi.setContext}. */
export type PluginContextValue = boolean | string;

/** Most context keys one plugin may hold at once via {@link PluginHostApi.setContext}. */
export const PLUGIN_CONTEXT_KEYS_MAX = 32;

/** Max length of a {@link PluginHostApi.setContext} key. */
export const PLUGIN_CONTEXT_KEY_LENGTH_MAX = 64;

/** Max length of a string {@link PluginHostApi.setContext} value. */
export const PLUGIN_CONTEXT_VALUE_LENGTH_MAX = 256;

export type MenuItemLocation = "terminal" | "file" | "view" | "help";
// `"panel"` was removed (#10512): no renderer surface ever mounted
// `usePluginContextMenuItems("panel")`, so a contributed panel context-menu item
// was silently dead. Only `worktree` / `terminal` / `file` / `browser` /
// `project` have live consumers (`project` is the toolbar project pill).
export type ContextMenuLocation = "worktree" | "terminal" | "file" | "browser" | "project";

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
  // Read a terminal's current screen as plain text (`host.terminals.readScreen`).
  // Separate from `agent:read` on purpose: what a terminal shows routinely
  // includes tokens and env dumps, so it carries its own first-use consent.
  "terminal:read",
  "git:read",
  "git:write",
  "clipboard:read",
  "clipboard:write",
  "shell:exec",
  // Disclosure-only (#11299). A plugin's `main` runs Node-capable, so it can
  // already `net.connect()` a Unix-domain socket or Windows named pipe — the
  // Docker socket being the motivating case — with no host mediation possible.
  // This token doesn't add that power and doesn't gate it; it exists so the
  // Plugin Manager can *tell the user* the plugin claims it, and so the claim
  // can carry an optional `scopes.socket.allowedPaths` intent. Deliberately
  // excluded from CONFIRM_TRIGGERING_CAPABILITIES: elevating on a token the
  // host cannot enforce would buy friction without buying safety.
  "socket:connect",
  // Serve `contributes.agentMcp` tools to terminal agents over the host's MCP
  // listener. Declaring it exposes nothing by itself: each endpoint stays dark
  // until the user enables it for a specific project.
  "mcp:expose",
  // Name a target project on `host.dispatch(actionId, args, { projectId })`
  // (#13119). Declaring it enables nothing: targeting stays off until the user
  // turns on "Allow project targeting" for this plugin in the Plugin Manager.
  // Not confirm-triggering — it changes where a dispatch lands, not which
  // actions a plugin can reach.
  "project:dispatch",
  // Observe which kind of panel has focus (`host.onDidChangeFocusedPanel`,
  // #13221): the kind, an agent flag and the worktree id, never a panel's id,
  // title, URL or content. Disclosure-only and not confirm-triggering.
  "panel:focus-read",
  // Page the operating system from `host.notify({ os: true })` (#13505).
  // Declaring it enables nothing: banners stay off until the user turns on
  // "Allow OS notifications" for this plugin in the Plugin Manager. Not
  // confirm-triggering — it changes where a notification is shown, not what a
  // plugin can do.
  "notification:os",
  // Hold large files in the host's artifact cache (`host.artifacts`, #14100):
  // import a scoped or chosen file, download or upload a provider file, play
  // one in a view. Bytes stay in main. Not confirm-triggering on its own —
  // what reaches the cache is already gated by the fs read capabilities, the
  // person's own selection, or `network:fetch` with a declared URL scope.
  "artifact:store",
  // Read the DOM and runtime of a previewed page on behalf of a contributed
  // element picker provider (`contributes.elementPickerProviders`, #14073).
  // Disclosure-only like `panel:focus-read`: nothing runs until installed guest
  // execution lands, and the install-time list is where the user is told.
  "preview:inspect",
] as const;

export type BuiltInPluginCapability = (typeof BUILT_IN_PLUGIN_CAPABILITIES)[number];

const BUILT_IN_PLUGIN_CAPABILITY_SET: ReadonlySet<string> = new Set(BUILT_IN_PLUGIN_CAPABILITIES);

/**
 * Runtime narrowing for a capability token arriving from an untrusted source —
 * a manifest field or a `host.registerAction` argument, where the declared TS
 * type is a promise the plugin has not actually kept. Host-internal: the SDK
 * barrel deliberately omits the capability list, so plugins narrow against the
 * schema instead.
 */
export function isBuiltInPluginCapability(value: unknown): value is BuiltInPluginCapability {
  return typeof value === "string" && BUILT_IN_PLUGIN_CAPABILITY_SET.has(value);
}

export type PluginCapability = BuiltInPluginCapability;

/** Third argument to {@link PluginHostApi.dispatch} (#13119). */
export interface PluginDispatchOptions {
  /**
   * Run the action in this project's view rather than the focused one. Needs
   * the `project:dispatch` capability and the user's per-plugin switch. Ids
   * come from `host.dispatch("project.getAll")`.
   */
  projectId?: string;
}

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
  // Mirrors the manifest schema's scope enum (electron/schemas/plugin.ts) so
  // plugin authors can't compile against a scope the manifest gate rejects.
  scope?: import("./keybinding.js").KeyScope;
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
  /** `location: "file"` only: restrict to files or folders. Omitted matches both. */
  kind?: "file" | "folder";
  /** `location: "file"` only: bare lower-case suffixes a file must carry. */
  extensions?: string[];
  /** `location: "file"` only: worktree-relative globs, any of which must match. */
  paths?: string[];
}

/**
 * View contribution location.
 *
 * `panel` renders into the `contributes.panels` entry with the same id; it is
 * wired by the inline renderer host (#9229), see `docs/plugins/architecture.md`.
 *
 * `settings` is the plugin's custom settings section: at most one per plugin,
 * tied to no panel, and mounted by the host inside the plugin's settings home
 * below its declared `contributes.settings` fields (the plugin manager for an
 * installed plugin, Project settings → Plugins for a project plugin). It
 * receives {@link PanelViewProps.settingsContext}.
 *
 * `fileEditor` backs a view-backed `contributes.fileEditors` entry: tied to no
 * panel, mounted only inside the file panel for a file the editor matches, and
 * handed the host-owned {@link PanelViewProps.fileDocument} (#13809).
 *
 * `sidebar` is one of the sidebar's views: listed by `name` in the sidebar
 * header's switcher beside the built-in worktree list, ordered by `priority`,
 * gated by an optional `when`, and mounted below the header while chosen.
 */
export type ViewLocation = "panel" | "settings" | "fileEditor" | "sidebar";

/** Longest `name` a sidebar view may declare: it is the sidebar header's title. */
export const SIDEBAR_VIEW_NAME_MAX_LENGTH = 40;

/** The range a sidebar view's `priority` may take. Higher sorts first in the switcher. */
export const SIDEBAR_VIEW_PRIORITY_MIN = -1000;
export const SIDEBAR_VIEW_PRIORITY_MAX = 1000;

/**
 * The built-in worktree list's fixed priority, which every plugin sidebar
 * view's is compared against: a positive priority lists above it, zero or
 * negative below it, because the worktree list wins a tie.
 */
export const WORKTREES_SIDEBAR_VIEW_PRIORITY = 0;

/** A sidebar view that declares no `priority` ties the worktree list, so lists below it. */
export const SIDEBAR_VIEW_DEFAULT_PRIORITY = WORKTREES_SIDEBAR_VIEW_PRIORITY;

/**
 * Where a `location: "settings"` view is mounted, handed to it as
 * {@link PanelViewProps.settingsContext}. An installed plugin's section mounts
 * in the plugin manager with `scope: "user"` and in Project settings → Plugins
 * with `scope: "project"`, so it renders the rows that belong to that scope; a
 * project plugin's section always mounts with `scope: "project"`.
 */
export interface PluginSettingsViewContext {
  readonly scope: "user" | "project";
  /** The project the section is shown for; `null` in the `"user"` home. */
  readonly projectId: string | null;
  /**
   * The declared settings page (`pages[].id` on the settings view) the user
   * has open, or `null` on the section's own root. Absent on a host that
   * predates pages, and for a view that declares none.
   */
  readonly page?: string | null;
  /**
   * A deep link to one of the settings this view edits (`editor: "view"`),
   * present until it is answered. Focus that setting's control and call
   * `acknowledge(true)`; call `acknowledge(false)` when you can't show it. A
   * view that doesn't answer in time, or answers `false`, gets the host's
   * landing on the whole section instead, so ignoring this is always safe.
   */
  readonly focus?: PluginSettingsViewFocus;
}

/**
 * A request to land on one setting a custom settings view edits, handed to it
 * as {@link PluginSettingsViewContext.focus}. `key` is always a declared
 * `contributes.settings` id with `editor: "view"` that lives in this home; the
 * host checks it before passing it on. `nonce` changes for every request, so a
 * second link to the same key lands again.
 */
export interface PluginSettingsViewFocus {
  readonly key: string;
  readonly nonce: number;
  /**
   * Report whether the view landed on `key`. Only the first answer for a
   * request counts; one after the host has fallen back does nothing.
   */
  readonly acknowledge: (landed: boolean) => void;
}

/**
 * One declared page of a plugin's custom settings section (`pages` on a
 * `location: "settings"` view). The host lists the pages under the section,
 * opens one in place with its own title and a way back, and tells the view
 * which is open through {@link PluginSettingsViewContext.page}. Pages are
 * navigation only: the values on them are still the plugin's declared
 * settings, stored and scoped as declared.
 */
export interface PluginSettingsPageContribution {
  /** Unique within the view; what search and deep links name the page by. */
  id: string;
  title: string;
  description?: string;
}

/**
 * Where a plugin view is mounted, handed to it as
 * {@link PanelViewProps.hostContext}.
 *
 * `"panel"` is a panel in the grid, the dock or a dialog. `"surface"` is a
 * project surface slot (`contributes.surfaces`), which mounts one of the
 * plugin's panel views in place of the host's own content — so the same view
 * can see both and lay itself out for each. `"settings"` is the plugin's custom
 * settings section. `"sidebar"` is a sidebar view, below the sidebar header and
 * as narrow as the sidebar's minimum width. `"fileEditor"` is a view-backed
 * file editor inside the file panel. `"popover"` is the anchored popover
 * a toolbar button opens (`contributes.toolbarButtons[].popover`), again one of
 * the plugin's panel views.
 *
 * Open-ended: hosts added later arrive as new members, so a view that switches
 * on this must give unknown kinds a sensible default rather than treat the list
 * as exhaustive.
 */
export type PluginViewHostKind =
  "panel" | "surface" | "settings" | "sidebar" | "fileEditor" | "popover";

export interface PluginViewHostContext {
  readonly kind: PluginViewHostKind;
  /**
   * Dismiss the host the view is in. Present only where the view may end its
   * own mount — today the toolbar popover, after a "quick add" submits, say.
   * Focus goes back to the button that opened it.
   */
  readonly close?: () => void;
}

/**
 * A plugin view that mounts outside the panel grid — every `contributes.views`
 * entry whose location is not `"panel"`. Registered by main at plugin load,
 * never as a panel kind, so nothing can spawn it from the launcher, palette or
 * dock, and served only to the views of projects that may see the plugin.
 */
interface PluginHostedViewDescriptorBase {
  /** {@link pluginHostedViewKindId} of the plugin instance and view. */
  id: string;
  /** The plugin's RUNTIME instance key, as panel kinds carry it in `extensionId`. */
  pluginId: string;
  /** The view's own manifest id. */
  viewId: string;
  /** Display name for diagnostics: the plugin's name and what the view is for. */
  name: string;
  /** The `plugin://` module URL under the plugin's current load and generation. */
  componentPath: string;
  /** For a `location: "fileEditor"` view, the file editors it backs (#13809). */
  fileEditors?: readonly HostedFileEditorDescriptor[];
}

export interface PluginSettingsHostedViewDescriptor extends PluginHostedViewDescriptorBase {
  location: "settings";
}

/** A file editor view, mounted only inside the file panel for the editors it backs. */
export interface PluginFileEditorHostedViewDescriptor extends PluginHostedViewDescriptorBase {
  location: "fileEditor";
}

/** A sidebar view, carrying what its switcher entry needs. */
export interface PluginSidebarHostedViewDescriptor extends PluginHostedViewDescriptorBase {
  location: "sidebar";
  /** The manifest `name`: the switcher entry, and the header's title while it shows. */
  title: string;
  /** The plugin's display name, which attributes the entry. */
  pluginName: string;
  /** The manifest `iconId`, with a custom SVG reference resolved to its runtime key. */
  iconId?: string;
  /** The manifest `priority`, or {@link SIDEBAR_VIEW_DEFAULT_PRIORITY}. */
  priority: number;
  /** The manifest `when`, evaluated live against the chrome context. */
  when?: string;
}

export type PluginHostedViewDescriptor =
  | PluginSettingsHostedViewDescriptor
  | PluginFileEditorHostedViewDescriptor
  | PluginSidebarHostedViewDescriptor;

/**
 * The synthetic view-kind id a hosted view mounts under. It names no panel
 * kind: it lets the shared plugin-view loader activate the owning plugin and
 * key the view's state, and main resolves it in `activatePluginForView`.
 */
export const PLUGIN_HOSTED_VIEW_KIND_PREFIX = "plugin-view:";

/** The manifest grammar for a view id (`SAFE_ID_PATTERN`), which rules out `/`. */
const HOSTED_VIEW_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function pluginHostedViewKindId(pluginId: string, viewId: string): string {
  return `${PLUGIN_HOSTED_VIEW_KIND_PREFIX}${pluginId}/${viewId}`;
}

/**
 * The plugin instance key and view id a hosted-view kind id names, or `null`
 * for any other id. Split at the LAST `/`: a view id can never contain one,
 * while an instance key is not promised not to.
 */
export function parsePluginHostedViewKindId(
  kindId: string
): { pluginId: string; viewId: string } | null {
  if (typeof kindId !== "string" || !kindId.startsWith(PLUGIN_HOSTED_VIEW_KIND_PREFIX)) {
    return null;
  }
  const rest = kindId.slice(PLUGIN_HOSTED_VIEW_KIND_PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0) return null;
  const pluginId = rest.slice(0, slash);
  const viewId = rest.slice(slash + 1);
  if (!HOSTED_VIEW_ID_PATTERN.test(viewId)) return null;
  return { pluginId, viewId };
}

export interface ViewContribution {
  id: string;
  componentPath: string;
  location: ViewLocation;
  // Advisory only for a panel view — the matching `contributes.panels` entry
  // owns the rendered icon/name at runtime, which is why `name`/`description`
  // were removed from panel views (#10888). A sidebar view has no panel, so it
  // carries its own `iconId`, `name`, `priority` and `when`.
  iconId?: string;
  name?: string;
  priority?: number;
  when?: string;
  // Settings views only: what settings search shows for the custom section,
  // and the pages the host lists under it.
  title?: string;
  description?: string;
  pages?: PluginSettingsPageContribution[];
}

/**
 * The attribute the host stamps on the element a plugin view renders into, and
 * the only DOM attribute this styling contract adds.
 *
 * Daintree compiles the Tailwind classes a plugin uses at runtime and emits them
 * inside `@scope ([data-daintree-plugin-style-root])`, so the generated rules
 * apply within a plugin's own subtree and can never reach host chrome. The host
 * marks the view wrapper itself; the only place an author needs this is a
 * container rendered through `createPortal`, which escapes that subtree. See
 * {@link PanelViewProps.styleRootAttributes} for the spreadable form.
 */
export const PLUGIN_STYLE_ROOT_ATTRIBUTE = "data-daintree-plugin-style-root";

/**
 * Props every plugin-contributed panel view receives from the renderer host.
 * Intentionally narrower than the host-internal `PanelComponentProps` so the
 * SDK surface stays stable across a future `plugin://` → trusted-iframe
 * cutover (#9229).
 *
 * - `panelId` is the runtime panel instance id (the same value the host uses
 *   in `addPanelOptions` / IPC). Plugins should treat it as opaque.
 * - `pluginId` is the plugin's RUNTIME id, sourced from
 *   `PanelKindConfig.extensionId` — the bare manifest `name` for an installed
 *   or builtin plugin, but the instance key `project__{projectId}__{manifestId}`
 *   for a project plugin and `project__{projectId}__installed__{manifestId}`
 *   for an installed package's per-project instance. Pass it back verbatim to `window.electron.plugin.*`;
 *   a view that writes its own manifest name down instead addresses nothing.
 * - `disposeSignal` aborts on unmount AND when the host receives a
 *   `plugin:panel-kinds-changed` push that no longer contains this kind. The
 *   broadcast fires before the main process tears down plugin IPC handlers,
 *   so signal-driven cleanup (fetch aborts, subscription teardown) runs
 *   while the plugin host APIs are still live.
 * - `panelRemovedSignal` aborts ONLY when the panel is permanently gone.
 */
/** A value a navigation parameter holds: an identifier, a safe integer or a flag. */
export type PluginNavigationParamValue = string | number | boolean;

/** Where an application is: one of its declared sections, with its parameters. */
export interface PluginNavigationLocation {
  readonly sectionId: string;
  readonly params: Readonly<Record<string, PluginNavigationParamValue>>;
}

/** A request to go to a declared section (#14108). */
export interface PluginNavigationIntent {
  sectionId: string;
  /** Only parameters the section declares, each of its declared type. */
  params?: Record<string, PluginNavigationParamValue>;
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
  /**
   * Bring the application's destination forward (its Home, or the grid) as
   * well as moving the location. Defaults to `true`; `false` changes only the
   * shared selection.
   */
  reveal?: boolean;
}

/**
 * Why a navigation was refused. Nothing moved: not the location, the history,
 * the main area nor focus.
 *
 * - `invalid-intent` — not an intent object.
 * - `unknown-section` — the application declares no such section.
 * - `invalid-params` — a parameter is undeclared, missing, or not its declared type or bounds.
 * - `too-large` — the location is over the size cap.
 * - `unsaved` — a view of the application reports unsaved work; save or drop it, then retry.
 * - `no-history` — nothing to go back or forward to.
 * - `stale` — the call came from a view attempt that is gone, or an application no longer in force.
 */
export type PluginNavigationRefusal =
  | "invalid-intent"
  | "unknown-section"
  | "invalid-params"
  | "too-large"
  | "unsaved"
  | "no-history"
  | "stale";

export type PluginNavigationResult =
  | { readonly ok: true; readonly location: PluginNavigationLocation }
  | { readonly ok: false; readonly reason: PluginNavigationRefusal };

/**
 * The project application's shared navigation, as one of its views sees it
 * (#14108). Every view of the application in the project — its sidebar view,
 * its Home, its panels — holds the same location and re-renders when it moves,
 * so selection in one is selection in all.
 */
export interface PluginApplicationNavigationApi {
  /** The current location. A new object only when the location changes. */
  readonly location: PluginNavigationLocation;
  /** The declared sections, in manifest order. */
  readonly sections: readonly { readonly id: string; readonly title: string }[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  navigate(intent: PluginNavigationIntent): PluginNavigationResult;
  back(): PluginNavigationResult;
  forward(): PluginNavigationResult;
}

export interface PanelViewProps {
  readonly panelId: string;
  readonly pluginId: string;
  /**
   * Lifetime of THIS mounted view attempt — not of the panel (#11301).
   *
   * Aborts on React unmount, on "Try again", on an accepted
   * {@link requestReload}, and when a `plugin:panel-kinds-changed` push drops
   * this kind. Crucially, a temporary unmount aborts it too: maximizing a
   * sibling pane, switching away from a dock tab, or caching a background
   * project view all tear the subtree down while the panel itself lives on.
   * Tie only view-scoped work to it — in-flight `fetch`es, DOM observers,
   * `postToPanel` subscriptions. On unmount it aborts just after React has run
   * your effect cleanups, so a cleanup may still see it open.
   *
   * NEVER tie a durable resource (a spawned process, a long-lived session) to
   * this signal: it will be killed the first time the user maximizes another
   * pane. Durable resources belong in the plugin's worker, which observes the
   * panel across every remount via `host.onDidChangePanelLifecycle`.
   */
  readonly disposeSignal: AbortSignal;
  /**
   * Lifetime of the PANEL RECORD (#11301). The same `AbortSignal` object is
   * handed to every mount of a given `panelId`, so it survives remounts,
   * retries, trash-then-restore, and plugin view upgrades.
   *
   * Aborts exactly once, when the panel is permanently removed from the panel
   * store — never for a temporary unmount and never while a trashed panel is
   * still restorable. This is the signal to use for cleanup that must happen
   * once and only when the user is genuinely done with the panel.
   */
  readonly panelRemovedSignal: AbortSignal;
  /**
   * Opaque argument bag handed to the view when the panel is spawned with one
   * — e.g. `{ path }` from a "open file in plugin panel" intent. Sourced from
   * the panel's `extensionState` (the same bag that survives the save/restore
   * round-trip), so a restored panel sees the args it was originally spawned
   * with. Empty (no key) for panels opened without an initial argument.
   *
   * This is a snapshot taken at mount, not a live value: it does not update
   * while the view is mounted, including in response to your own
   * {@link persistState} calls. Treat the contents as read-only and hold your
   * working copy in React state seeded from here. Arguments from a later open
   * that reuses this panel arrive as {@link openRequest} instead.
   */
  readonly initialArgs?: Record<string, unknown>;
  /**
   * The latest `panel.openPluginPanel` call that reused this panel rather than
   * spawning a new one, carrying the `initialArgs` it was called with (#13779).
   * A fresh panel gets its arguments as {@link initialArgs}; every later "open
   * this in the panel" — a second context-menu click, a notification button, a
   * search result — lands here.
   *
   * Live: a mounted view re-renders with the new request, keeping its state,
   * its {@link disposeSignal} and its {@link initialArgs}. A request made while
   * no view is mounted (a hidden dock tab, a pane behind a maximized sibling, a
   * view still loading) waits and is handed to the next one. Only the latest
   * waits: a second call before the view sees the first replaces it.
   *
   * `seq` is new for every call, including one with the same `args`, so key
   * the effect that acts on it by the request itself:
   *
   * ```tsx
   * useEffect(() => {
   *   if (openRequest) showFile(String(openRequest.args.path));
   * }, [openRequest]);
   * ```
   *
   * Once a view has committed with a request it is delivered: it stays on
   * this attempt's props, but a later remount or reload does not see it again,
   * so persist whatever the request changed if it should survive one. Not
   * persisted itself, and not merged into {@link initialArgs}: it is held by
   * the project's window, so one still waiting when that window reloads,
   * closes or is evicted to save memory is lost.
   *
   * Absent until a reusing open supplies `initialArgs`, and always absent on a
   * host with no panel record (a project surface, a settings view).
   */
  readonly openRequest?: {
    readonly seq: number;
    readonly args: Record<string, unknown>;
  };
  /**
   * Which version of your `stateVersion` schema {@link initialArgs} was written
   * against — the other half of declaring one in `contributes.panels` (#12280).
   *
   * `0` means the bag predates versioning: it was persisted before the host
   * stamped anything, so its shape is whatever you were writing at the time.
   * Absent means you declared no `stateVersion`, so nothing was tracked and
   * nothing is promised.
   *
   * Migrate forward from whatever this says and persist the result; your next
   * {@link persistState} call re-stamps the bag at your current version. You
   * never have to handle a value ABOVE the version you declare — the host
   * refuses that bag rather than hand you state a newer build of your plugin
   * wrote, and shows the user an error naming both versions. The state is kept
   * on disk, so reinstalling the newer build brings it back intact.
   */
  readonly stateVersion?: number;
  /**
   * Persist view state onto the panel record, so the next mount of this panel
   * sees it in {@link initialArgs}.
   *
   * The two are one bag: spawn seeds it, this updates it, `initialArgs` reads
   * it back. That round trip is what lets a view survive the teardowns a panel
   * routinely outlives — maximizing a sibling pane, leaving a dock tab, a
   * cached project view, an app restart — without forgetting where the user
   * was. A file browser's expanded paths, selection, root and sort are exactly
   * this kind of state.
   *
   * The patch is **merged**, so two independent parts of a view can each
   * persist their own key without reading and rewriting the whole bag; setting
   * a key to `undefined` removes it. Writing state identical to what is already
   * stored is free — it neither churns the store nor schedules a save — so
   * calling this from a render-derived effect is fine.
   *
   * **Stored as JSON, canonically.** The host round-trips what you pass through
   * `JSON.stringify`/`parse` and keeps that, so the value is detached from any
   * object you still hold — mutating a patch afterwards changes nothing — and
   * what you read back on the next mount is exactly what you would read back
   * after a restart. A `NaN` becomes `null` and a `Date` becomes its ISO string
   * at the moment you persist, not silently at the next launch.
   *
   * Keep it small. The bag rides the panel record into the layout save, and the
   * host refuses an update whose serialized form exceeds 64KB. Anything larger,
   * anything not JSON round-trippable, and anything that should outlive the
   * panel belongs in `host.storage` instead. State here rides the panel
   * snapshot into the project's `state.json` as plaintext JSON, so it is not a
   * place for secrets.
   *
   * Returns whether the stored state is now what you asked for: `false` when
   * the host rejected the update (over the cap, or not serializable), `true`
   * when it was applied or already matched. Best-effort in the sense that
   * `true` means "accepted and scheduled" — the layout save is debounced, so it
   * is not a promise that bytes have reached disk.
   *
   * Outside the grid (a Home surface, a sidebar view, a settings section, a
   * toolbar popover) there is no panel record, so the bag is kept in the host's
   * durable view-state store instead, under the project, your plugin and the
   * view. The same cap, merge and version rules apply, the write is committed
   * without a debounce, so it survives the renderer going away the moment this
   * returns, and `false` also means storage refused it. A
   * user-scope settings section's bag follows the user across projects. The
   * least recently written of these bags are dropped beyond 200, so treat them
   * as state you can rebuild.
   *
   * Absent when the host does not support persistence for this panel; call it
   * optionally.
   */
  readonly persistState?: (patch: Record<string, unknown>) => boolean;
  /**
   * Ask the host to discard this view attempt and mount a fresh one for the
   * same panel (#12609) — for a view that has built up more than it can shed
   * and wants to start over without restarting the plugin's backend.
   *
   * A reload is a new React attempt using the module that is already loaded.
   * This attempt's {@link disposeSignal} aborts and its React cleanup runs;
   * the next attempt gets a new `disposeSignal`, the latest state accepted
   * through {@link persistState} as {@link initialArgs}, and the same
   * `panelId`, {@link panelRemovedSignal} and backend. Module-scope state,
   * document-wide registrations and anything attached to `window` survive it,
   * so a reload frees only what your cleanup releases. It does not promise to
   * reclaim memory, and it cannot rescue a view that is blocking the renderer.
   *
   * A request, not a command: the host may refuse it, and nothing reports
   * whether or when the next attempt mounted. Calls in the same tick coalesce
   * into one reload. The callback belongs to the attempt that received it, so
   * one held past this attempt's teardown does nothing. A fourth reload within
   * 30 seconds of three accepted ones stops the view instead, and the panel
   * stays stopped until the user reloads it.
   *
   * Absent where the host offers no reload (a project surface, for one), so
   * call it optionally.
   */
  readonly requestReload?: () => void;
  /**
   * Tell the host whether this view holds work that a reload or a close would
   * lose (#12611, #13815).
   *
   * The user can reload a plugin panel from its menus, and an agent can do the
   * same through the host's tools. Neither asks first by default, because what
   * you accepted through {@link persistState} comes back. While this is set to
   * `true`, both ask the user to confirm before discarding the view, and so
   * does closing the panel with its close button or menu. Set it back to
   * `false` once the work is saved or dropped.
   *
   * Your own {@link requestReload} is never held up by it. The setter belongs to
   * the attempt that received it: one held past this attempt's teardown does
   * nothing, and a new attempt starts with no unsaved work until it says so.
   *
   * While it is `true`, the host also keeps the project's renderer: automatic
   * Sleep waits, and cache eviction skips it until memory runs short. Work you
   * keep in {@link persistState} comes back after either, so prefer persisting
   * a draft over holding the flag, and keep the flag for work that cannot be
   * persisted. Offered outside the grid too (a Home surface, a sidebar view, a
   * settings section, a toolbar popover), where there is no close to confirm.
   *
   * Absent where the host offers neither (a file editor, whose document owns
   * its draft), so call it optionally.
   */
  readonly setHasUnsavedChanges?: (hasUnsavedChanges: boolean) => void;
  /**
   * Sets the live state of one of this panel's manifest `toolbar` buttons by
   * its `actionId` (as written in the manifest). Each call replaces that
   * button's state; `null` resets it. State belongs to the panel, so it
   * survives the view re-rendering, unmounting and remounting, and is cleared
   * when the panel closes or the view reloads. An `actionId` the manifest
   * does not list is ignored.
   *
   * Like {@link setHasUnsavedChanges}, the setter belongs to the attempt that
   * received it: a call held past this attempt's teardown (a refresh that
   * settles after a reload) does nothing.
   *
   * Absent where the panel has no header (a surface), so call it optionally.
   */
  readonly setToolbarItemState?: (
    actionId: string,
    state: PluginPanelToolbarItemState | null
  ) => void;
  /**
   * Publishes the contextual actions this panel's ⋯ and right-click menus
   * offer right now, in order, in the plugin's own group after the manifest's
   * `menu` entries. Each call replaces the whole list; `null` (or `[]`) clears
   * it. Every `actionId` must be one of your own actions, written
   * `"{manifestId}.{id}"` like the manifest's `menu`; an entry shows while its
   * action is registered and is dispatched with `{ panelId }`, through the
   * action's own danger tier. At most five entries; labels default to the
   * action's title and are cut at 80 characters. An invalid list (a foreign or
   * built-in action, a duplicate, too many entries) is ignored whole.
   *
   * The list belongs to the panel, so it survives the view re-rendering,
   * unmounting and remounting, and is cleared when the panel closes or the view
   * reloads. A menu that is open when you republish shows the new list.
   *
   * The setter belongs to the attempt that received it: a call held past this
   * attempt's teardown does nothing. `usePanelMenuItems` wraps it.
   *
   * Absent where the panel has no host menu (a surface), so call it optionally.
   */
  readonly setMenuItems?: (items: readonly PanelMenuItemContribution[] | null) => void;
  /**
   * Names this panel: the title shown on its tab, its header, its dock chip and
   * its dialog. Use it when one kind shows different things, so three record
   * panels read "Record #42", "Record #43" and "Record #44" rather than three
   * copies of the kind's `name`. `null` (or a blank string) goes back to the
   * kind's name.
   *
   * The title belongs to the panel, not the view: it survives the view
   * unmounting and reloading, and a grid or dock panel keeps it across a
   * restart. A dialog keeps it until the dialog closes, since closing one
   * removes its panel. A name the user typed wins: once they rename the panel,
   * this does nothing until they clear their rename. The title is held to one
   * line: control and invisible formatting characters become spaces, and it is
   * cut at 80 characters.
   *
   * Only ever titles this panel. The setter belongs to the attempt that
   * received it: a call held past this attempt's teardown does nothing.
   *
   * Absent where the host has no panel to name (a project surface, a settings
   * view), so call it optionally.
   */
  readonly setTitle?: (title: string | null) => void;
  /**
   * Your actions whose handlers are running right now, by `actionId` as the
   * manifest writes it — however they were dispatched: the palette, a menu,
   * the panel toolbar, a keybinding or an agent. A new array when the set
   * changes, so a view re-renders as a run starts and ends, and a view that
   * mounts mid-run sees it at once. `useActionRunning` reads one action.
   *
   * Absent on a host that does not track runs, so read it optionally.
   */
  readonly runningActions?: readonly string[];
  /**
   * The worktree the panel instance belongs to, as recorded on the panel at
   * spawn time. Lets a view reconstruct its own context without dispatching
   * `worktree.getCurrent` — which resolves the *visible* worktree, not the
   * one that owns the panel, and so returns the wrong answer for a background
   * or restored panel. `undefined` for a panel spawned without a worktree.
   */
  readonly worktreeId?: string;
  /**
   * Spread onto any container you render through `createPortal`, so the
   * portalled subtree stays inside Daintree's styling contract.
   *
   * Tailwind classes in a plugin view are compiled at runtime and scoped to the
   * element the host marks as the view's style root. A portal renders outside
   * that element — into `document.body`, or a container of your own — so
   * without this its classes generate CSS that never matches, and the subtree
   * paints unstyled. Everything rendered normally is already inside the root
   * and needs nothing.
   *
   * ```tsx
   * createPortal(<div {...styleRootAttributes}>…</div>, document.body)
   * ```
   */
  readonly styleRootAttributes: Readonly<Record<string, string>>;
  /**
   * Present only for a `location: "settings"` view: which settings home it is
   * mounted in, so it renders the rows for that scope. Absent for a panel view.
   */
  readonly settingsContext?: PluginSettingsViewContext;
  /**
   * Present only for a `location: "fileEditor"` view (#13809): the file it was
   * opened for, owned by the host. Read it with a revision, save against the
   * revision you read, and report your unsaved text with `setDraft` so the
   * host's dirty indicator, Rendered preview and Save / Discard / Cancel prompt
   * on close all apply. The draft is the host's, not the view's: it survives
   * the user switching to Source and back, and the close prompt can save it
   * after your view has unmounted.
   */
  readonly fileDocument?: PluginFileDocument;
  /**
   * Where the host mounted this view — a panel, a project surface, the plugin's
   * settings section, the sidebar — so one view can lay itself out for each
   * place it appears. Always set by Daintree; absent only from a host that predates it,
   * which you can treat as `"panel"`.
   *
   * This is the whole of what a view learns about its surroundings. Your view
   * owns its own box and nothing outside it: reading or styling the host's DOM,
   * relying on an ancestor's layout or class names, or reaching past your box
   * with global CSS is unsupported and can break on any update. The host
   * contains your layout (`position: fixed` stays inside your box, and your
   * z-indexes stay in your own stacking context), but a modal `<dialog>`, a
   * `popover` element or a `createPortal` into `document.body` leaves that
   * containment. For overlays use `@daintreehq/plugin-ui`'s `Dialog`, `Popover`
   * and menus, which the host draws and positions.
   *
   * New host kinds are added over time, so give an unrecognised `kind` a
   * sensible default rather than switching on it exhaustively.
   */
  readonly hostContext?: PluginViewHostContext;
  /**
   * The project application's navigation (#14108): the location its declared
   * sections share across the application's sidebar view, Home and panels,
   * with back and forward.
   *
   * Handed only to views of the plugin whose `application` is in force in
   * this project and declares `navigation`; absent otherwise, and absent in a
   * user-scope settings section, which belongs to no project. Live: the view
   * re-renders with a new `location` when any view of the application moves
   * it, without remounting, so it keeps its own state, its `initialArgs` and
   * its {@link disposeSignal}.
   *
   * The location is restored per project after a remount, an evicted renderer
   * or a restart, but only parameters declared `persist` are written to disk;
   * the others last as long as the project's renderer, so they survive a
   * remount but not an evicted or reloaded renderer. A location that no longer
   * resolves — its section removed, a parameter that no longer validates, a
   * raised `navigation.version` — restores as the default section.
   *
   * Navigation is refused with `unsaved` while any view of the application
   * reports {@link setHasUnsavedChanges}, so a pending form is never replaced:
   * persist the draft or drop it, clear the flag, and navigate again. A
   * callback held past this view attempt refuses with `stale`.
   */
  readonly navigation?: PluginApplicationNavigationApi;
}

/**
 * What just happened to one plugin panel instance (#11301). The renderer owns
 * the transitions; the worker observes them through
 * `host.onDidChangePanelLifecycle`.
 *
 * `mounted` / `hidden` are the two *view* states — a panel whose React subtree
 * is currently rendered vs. one whose subtree has been torn down while the panel
 * record lives on (sibling maximize, an inactive dock tab, a cached project
 * view). `hidden` explicitly does NOT mean the user closed anything.
 *
 * `backgrounded` / `trashed` / `restored` / `removed` are *panel record* states
 * read off `PanelLocation`: `backgrounded` is `location: "background"`,
 * `trashed` is the recoverable soft close, `restored` is the one-shot edge out
 * of trash (a transition, never a resting state), and `removed` is the terminal
 * event — the panel is gone and will never come back under this id.
 *
 * `render-failed` means the panel has no working view: the current attempt
 * reached the host's error boundary, or the host stopped a view that kept
 * asking to reload (#12609). It clears when a retry starts or the user reloads
 * the panel, so the next phase is the new attempt's own. The failure detail
 * stays in the renderer; only the fact of failure crosses to the worker.
 */
export type PluginPanelLifecyclePhase =
  "mounted" | "hidden" | "backgrounded" | "trashed" | "restored" | "removed" | "render-failed";

/**
 * One panel lifecycle transition delivered to a plugin worker (#11301).
 * Deliberately minimal and frozen before delivery: it carries identity and
 * phase, never renderer internals, error text, or user paths.
 */
export interface PluginPanelLifecycleEvent {
  /** Runtime panel instance id — matches `PanelViewProps.panelId`. */
  readonly panelId: string;
  /** Namespaced panel kind, i.e. `${pluginId}.${panel.id}`. */
  readonly panelKindId: string;
  /**
   * Owning plugin's runtime id — the manifest `name` for an installed or
   * builtin plugin, the project-qualified instance key for a project plugin.
   * Always this plugin's own id.
   */
  readonly pluginId: string;
  readonly phase: PluginPanelLifecyclePhase;
}

/**
 * What the host did with a `host.reloadPanel()` request (#12610). An
 * acknowledgment of scheduling only — never proof that the fresh view
 * rendered, and never a statement about memory.
 *
 * - `"scheduled"` — the panel's view was mounted and a fresh attempt is queued.
 * - `"not-mounted"` — the panel exists but has no mounted view (hidden,
 *   backgrounded, trashed), or the host knows no such panel. Nothing is opened
 *   or focused; the panel's next ordinary mount is already fresh.
 * - `"rate-limited"` — the panel's reload budget is spent or its view is
 *   already stopped for reloading too often. Shared with the view's own
 *   `requestReload`.
 * - `"unavailable"` — the host could not act right now: the panel's window is
 *   cached, closed, or unresponsive, its view is showing an error, or its
 *   backend is restarting.
 */
export type PanelReloadResult = "scheduled" | "not-mounted" | "rate-limited" | "unavailable";

/**
 * What the host did with a `host.restartWorker()` request (#13410). An
 * acknowledgment of scheduling only — the restart runs after the answer is
 * delivered, so the caller never sees the replacement come up.
 *
 * - `"scheduled"` — the plugin's worker will be torn down and started again.
 * - `"rate-limited"` — a self-restart was already accepted within the last
 *   30 seconds. Nothing is queued.
 * - `"unavailable"` — there is no worker to restart: the plugin runs in
 *   process (a builtin), is disabled or unloaded, or has no backend code.
 */
export type WorkerRestartResult = "scheduled" | "rate-limited" | "unavailable";

/** Minimum gap between two accepted `host.restartWorker()` requests from one plugin. */
export const PLUGIN_WORKER_SELF_RESTART_COOLDOWN_MS = 30_000;

/**
 * Worker-side deadlines for a host call (#13410), enforced in the worker so
 * they fire even when main is the side that stopped answering. An expired
 * call rejects with an error whose `code` is `"TIMEOUT"`; a timeout never
 * proves the host did nothing.
 */
export const PLUGIN_HOST_CALL_TIMEOUT_MS = 60_000;
/** Deadline for a host call that walks a tree or runs git. */
export const PLUGIN_HOST_CALL_SLOW_TIMEOUT_MS = 120_000;
/**
 * Deadline for a host call that may first wait on a person: a first-use
 * capability consent dialog (five minutes to answer) or an OS keychain prompt.
 */
export const PLUGIN_HOST_CALL_INTERACTIVE_TIMEOUT_MS = 360_000;

/**
 * One machine wake observation delivered to a plugin (#12175). Frozen before
 * delivery, and carries only timing — never what the machine was doing while
 * suspended.
 *
 * Emitted at most once per resume, after the host's own settle delay and after
 * it has attempted to resync its pty and workspace hosts. Suspend has no
 * counterpart event: a plugin cannot reliably run work between the OS
 * signalling suspend and the process freezing, so only the wake edge is
 * exposed.
 */
export interface PluginSystemWakeEvent {
  /**
   * Milliseconds the machine spent suspended.
   *
   * Measured from the observed suspend to the start of the host's post-wake
   * recovery, so it includes the settle delay but not however long recovery
   * itself took — a coarse "how stale is my state" figure, not a precise
   * hardware sleep time.
   *
   * `0` is a sentinel, not a measurement: it means the matching suspend edge
   * was never observed (the host started mid-sleep, or the OS delivered resume
   * without a preceding suspend). Treat `0` as "unknown duration" — do not
   * compare it against a staleness threshold and conclude the sleep was short.
   */
  readonly sleepDuration: number;
  /** `Date.now()` at the moment the wake was published. */
  readonly timestamp: number;
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
 * One `contributes.agentMcp` entry: an MCP tools endpoint the plugin serves to
 * agents running in Daintree's terminals — the inbound direction, unlike
 * {@link McpServerContribution}, where Daintree is the client.
 *
 * The host owns everything but the tools: the transport (a plugin-only path on
 * the existing loopback listener), the per-terminal credential, the project
 * binding and revocation. The plugin supplies the tool roster at activation via
 * {@link PluginMcpApi.registerTools}. Requires the `mcp:expose` capability, and
 * reaches no agent until the user gives the plugin read-and-write access — or,
 * when it declares `groups`, until the user allows a group. Its tools share
 * one MCP server with the host's tools for the plugin's databases, so
 * `database_schema` and `database_query` are reserved.
 */
export interface PluginAgentMcpContribution {
  id: string;
  /** Shown in the per-project access UI. Agents never see it; their server name comes from the manifest's `mcpName`. */
  name: string;
  description?: string;
  /** Host-managed tools. The only mode today; kept explicit so a later mode is additive. */
  mode: "tools";
  /**
   * Sets of tools the user allows one at a time, such as a `search` group apart
   * from a `commit` group. With groups declared, every registered tool names
   * one, and access levels no longer reach the plugin's own tools: only a
   * group the user allowed does. See {@link PluginAgentMcpToolGroup}.
   */
  groups?: PluginAgentMcpToolGroup[];
  /**
   * Serve chosen tools of one of the plugin's own `contributes.mcpServers`
   * entries here instead of a roster from {@link PluginMcpApi.registerTools},
   * which the host then refuses for this endpoint. The server stays where it
   * is: the host supervises it, resolves its settings and environment, and
   * starts it the first time an agent with access lists or calls a tool. Only
   * the tools named in `tools` are served, under their agent-facing names.
   */
  source?: PluginAgentMcpServerSource;
}

/** An `agentMcp` endpoint's tools taken from a contributed MCP server. */
export interface PluginAgentMcpServerSource {
  /** The id of a `contributes.mcpServers` entry in the same manifest. */
  mcpServer: string;
  /** The tools served, each named explicitly; nothing else the server lists ever reaches an agent. */
  tools: PluginAgentMcpServerSourceTool[];
}

/** One tool an `agentMcp` endpoint takes from its source server. */
export interface PluginAgentMcpServerSourceTool {
  /** What agents call it, in the {@link AGENT_MCP_TOOL_NAME_PATTERN} grammar. */
  name: string;
  /** Its exact name on the server. */
  serverTool: string;
  /** A group the endpoint declares; required when it declares any, refused when it declares none. */
  group?: string;
  /** Replaces the server's own description, which is otherwise cut to {@link AGENT_MCP_MAX_DESCRIPTION_BYTES}. */
  description?: string;
}

/**
 * Whether a group's tools read and search, or change things. The plugin's own
 * description of its tools, shown to the user as such: the host can't check
 * it, never turns it into a `readOnlyHint`, and never allows a group because
 * of it.
 */
export type PluginAgentMcpToolGroupAccess = "read" | "write";

/** One `contributes.agentMcp[].groups` entry. */
export interface PluginAgentMcpToolGroup {
  /** What tools name in {@link PluginMcpToolDefinition.group}, and what the user's choice is kept under. */
  id: string;
  /** Shown in the per-project access UI. */
  name: string;
  description?: string;
  access: PluginAgentMcpToolGroupAccess;
}

/**
 * `contributes.databases` entry — a SQLite file the plugin opens through
 * {@link PluginDatabaseApi}. A `"project"` database lives in the repository
 * (default `.daintree/data/{manifestId}/{id}.db`, or `path` relative to the
 * project root) and requires `scope: "project"` plus `fs:project-write`; a
 * `"local"` one lives in the plugin's per-machine data directory.
 */
export interface PluginDatabaseContribution {
  id: string;
  description?: string;
  location: PluginDatabaseLocationKind;
  path?: string;
  journalMode: "delete" | "wal";
  /**
   * How many migrations this version of the plugin applies: the schema it
   * leaves the file at. Lets the host refuse an application whose file was
   * written by a newer copy before any of its code runs, and makes a writable
   * `db.open` with a different number of migrations fail rather than drift.
   */
  schemaVersion?: number;
  /** Named statements the host serves to agents as tools of their own. */
  queries?: PluginDatabaseQueryContribution[];
}

/** The JSON type an agent passes for one declared query parameter. */
export type PluginDatabaseQueryParamType = "string" | "number" | "integer" | "boolean";

/** The `format`s a declared `"string"` param may require, as JSON Schema defines them. */
export type PluginDatabaseQueryParamFormat =
  "date" | "time" | "date-time" | "email" | "uri" | "uuid";

/**
 * One parameter of a declared query, bound to the placeholder of the same name.
 *
 * The constraints are JSON Schema keywords copied into the tool's input
 * schema, which the host checks before the statement runs. Unlike a trigger
 * or `CHECK` constraint, they do not depend on what schema the file has when
 * the query is called, so a rule about one value belongs here. A string may
 * take `minLength`, `maxLength` (both counted in characters), `pattern` (a
 * Unicode regular expression) and `format`; a number or integer `minimum` and
 * `maximum` (inclusive). `not: { const }` refuses one value of the param's
 * type, such as 0.
 */
export interface PluginDatabaseQueryParam {
  type: PluginDatabaseQueryParamType;
  description?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: PluginDatabaseQueryParamFormat;
  minimum?: number;
  maximum?: number;
  not?: { const: string | number | boolean };
}

/**
 * One `contributes.databases[].queries` entry: a single parameterised SQL
 * statement the host serves to agents as its own tool, named `name`, on the
 * plugin's MCP server — no plugin code runs. The tool's input schema is built
 * from `params`, every one required; agents pass bound values only. Each
 * placeholder (`:name`, `@name` or `$name`) must have a matching param and each
 * param a placeholder; a boolean binds as 1 or 0.
 *
 * A `"read"` query is served beside `database_query`, under the same access
 * level and on the same read-only connection, and must be one `SELECT`, `WITH`
 * or `VALUES` statement. The host, not the plugin, marks it read-only to
 * clients.
 *
 * A `"write"` query must be one `INSERT`, `REPLACE`, `UPDATE` or `DELETE`
 * statement, optionally after `WITH` and with `RETURNING`. It is served only
 * with read and write access, as the plugin's own tools are, and runs in a
 * transaction of its own under the policy of a writable `host.db` open — so
 * the statement and the schema's constraints and triggers are the rules a write
 * must pass. It never creates a database that does not exist yet, and a
 * `host.db` handle sees its commit as `origin: "external"`. Its result is
 * `changes` and `lastInsertRowid`, plus `columns` and `rows` with `RETURNING`.
 *
 * Declared queries count toward the plugin's
 * {@link AGENT_MCP_MAX_TOOLS_PER_ENDPOINT} together with any tools it
 * registers.
 */
export interface PluginDatabaseQueryContribution {
  name: string;
  mode: "read" | "write";
  description: string;
  params: Record<string, PluginDatabaseQueryParam>;
  sql: string;
}

/**
 * Most tools one plugin may serve agents beyond the host's two database tools:
 * its registered `agentMcp` roster and its declared database queries together.
 * Client tool caps are app-wide, not per server.
 */
export const AGENT_MCP_MAX_TOOLS_PER_ENDPOINT = 16;
/** Most `agentMcp` endpoints one manifest may declare. */
export const AGENT_MCP_MAX_ENDPOINTS_PER_PLUGIN = 1;
/** Most tool groups one `agentMcp` endpoint may declare. */
export const AGENT_MCP_MAX_GROUPS_PER_ENDPOINT = 8;
/**
 * Tool name grammar — the subset every MCP client accepts unmangled. Capped at
 * 32 characters because Claude exposes a server's tools as
 * `mcp__<server>__<tool>` under a 64-character tool-name limit, and the host's
 * server key for a plugin takes up to 25 of what is left.
 */
export const AGENT_MCP_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** UTF-8 byte cap on a tool description, matching the host's own MCP authoring budget. */
export const AGENT_MCP_MAX_DESCRIPTION_BYTES = 400;
/** UTF-8 byte cap on one tool's serialized input or output schema. */
export const AGENT_MCP_MAX_SCHEMA_BYTES = 8 * 1024;
/** UTF-8 byte cap on one serialized tool result. */
export const AGENT_MCP_MAX_RESULT_BYTES = 256 * 1024;
/** Wall-clock budget for one tool call before the host aborts it. */
export const AGENT_MCP_CALL_TIMEOUT_MS = 60_000;
/** Server tool name grammar an `agentMcp` source may select: the MCP spec's recommended tool name characters. */
export const AGENT_MCP_SERVER_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Who a tool call came from, as far as the host can say. Provenance, not
 * identity: the grant was issued for a launch in this terminal and project, but
 * any process that read the credential can present it. `launchAgentIdHint` is
 * what the terminal was launched as — never proof of what is calling.
 */
export interface PluginMcpCaller {
  /** Stable correlation id for the credential. Never the credential itself. */
  readonly credentialId: string;
  readonly projectId: string;
  readonly terminalId: string;
  readonly launchAgentIdHint?: string;
}

/** A JSON Schema object describing a tool's arguments or result. Must be `type: "object"`. */
export type PluginMcpJsonSchema = { type: "object" } & Record<string, unknown>;

/**
 * The MCP tool annotations a plugin may declare. They are hints for the agent
 * client, advertised as written and never checked against what `execute` does;
 * an omitted hint means the MCP default (destructive, non-idempotent,
 * open-world). A plugin may only add caution: `destructiveHint` and
 * `openWorldHint` accept `true` alone, and `readOnlyHint` is absent, because a
 * claim that a tool is safe is one clients can act on by asking less, so only
 * the host may make it. A roster declaring any such claim is rejected.
 */
export interface PluginMcpToolAnnotations {
  /** `true` to state the tool may delete or overwrite; `false` is rejected. */
  destructiveHint?: boolean;
  /** `true` when repeating a call with the same arguments has no further effect. */
  idempotentHint?: boolean;
  /** `true` to state the tool reaches beyond this project, such as the network; `false` is rejected. */
  openWorldHint?: boolean;
}

/**
 * One tool on an `agentMcp` endpoint. Both schemas are compiled at
 * registration. `execute` receives the arguments the agent sent, already
 * checked against `inputSchema` and never coerced, defaulted or stripped; a
 * call that does not match never reaches it. It also receives the caller's
 * provenance, and a signal aborted when the call is cancelled, times out, or
 * the plugin unloads. The return value must be JSON-serializable, and match
 * `outputSchema` when one is declared; it reaches the agent as the tool
 * result. A thrown error becomes a tool error carrying its message.
 */
export interface PluginMcpToolDefinition {
  description: string;
  inputSchema: PluginMcpJsonSchema;
  outputSchema?: PluginMcpJsonSchema;
  /** MCP tool annotations advertised on `tools/list`. See {@link PluginMcpToolAnnotations}. */
  annotations?: PluginMcpToolAnnotations;
  /**
   * The declared group the tool belongs to: required when the endpoint
   * declares `groups`, rejected when it declares none. The tool is listed and
   * callable only on credentials for a project whose user allowed that group.
   */
  group?: string;
  execute(
    args: Record<string, unknown>,
    caller: PluginMcpCaller,
    signal: AbortSignal
  ): unknown | Promise<unknown>;
}

/** Host API for serving `contributes.agentMcp` endpoints. Requires `mcp:expose`. */
export interface PluginMcpApi {
  /**
   * Bind the tool roster for an endpoint declared in `contributes.agentMcp`,
   * keyed by tool name. An undeclared endpoint id, a roster that with the
   * manifest's declared database queries comes to more than
   * {@link AGENT_MCP_MAX_TOOLS_PER_ENDPOINT}, a tool named like one of those
   * queries, or a tool breaking the name, description or schema limits is
   * rejected whole, and so is a tool naming no declared group on an endpoint
   * that declares groups. Calling it again for the same endpoint replaces the
   * roster; a replacement that changes which tools a group holds revokes
   * the credentials agents hold for the plugin's groups. Returns a disposer; every roster is dropped when the plugin
   * unloads. Must be called during `activate()`.
   */
  registerTools(
    endpointId: string,
    tools: Record<string, PluginMcpToolDefinition>
  ): Promise<() => void>;
}

/**
 * One `contributes.skills` entry (#10892). A skill is a markdown file the plugin
 * ships — instructions/knowledge (not executable code) that Daintree's built-in
 * MCP server surfaces to agents through the `skills.search` / `skills.load`
 * tools. `id` is namespaced at runtime as `{pluginId}.{id}`. `path` is a
 * plugin-relative markdown file, validated with the same traversal guard as a
 * view's `componentPath` and realpath-contained to the plugin dir when read.
 * Skills carry no capability requirement — they are inert declarative content.
 */
export interface SkillContribution {
  id: string;
  name: string;
  /** Plugin-relative path to the skill's markdown file (e.g. `./skills/tdd.md`). */
  path: string;
  /** Optional phrase fragments that help agents discover the skill via `skills.search`. */
  triggers?: string[];
}

/** One skill or reference file in `contributes.assistantKnowledge`. */
export interface AssistantKnowledgeEntry {
  /** Lowercase letters, digits and single hyphens; unique within its list. */
  id: string;
  /** Plugin-relative path: a skill directory holding `SKILL.md`, or a `.md` reference file. */
  path: string;
}

/**
 * `contributes.assistantKnowledge` (#13828): Markdown the Daintree Assistant is
 * given about this plugin's tools. Delivered only while the user has given the
 * Assistant everything the plugin declares (its databases, their writes and its
 * own `agentMcp` endpoint) in the project, and framed to the model as the plugin
 * author's notes on those tools, never as the user speaking.
 */
export interface AssistantKnowledgeContribution {
  /** Plugin-relative `.md` file of short notes, inlined up to 4 KiB and otherwise handed over as a file. */
  instructions?: string;
  /** Skill directories (Agent Skills layout); only their `.md` files are mirrored, never `scripts/`. */
  skills?: AssistantKnowledgeEntry[];
  /** `.md` files the Assistant can read when a question needs them. */
  references?: AssistantKnowledgeEntry[];
}

/**
 * One `contributes.themes` entry (#13832). `path` is a plugin-relative JSON file
 * holding `{ palette, tokens?, extensions? }`, the palette in the same shape
 * Daintree's built-in themes use, with overrides limited to the registered token
 * and extension sets. Offered in Appearance as `plugin:{pluginId}:{id}`, grouped
 * under the plugin, once the theme clears the contrast gate; a theme that fails
 * is not offered and the failure is written to the plugin's log. `type` is the
 * polarity the palette must declare.
 */
export interface ThemeContribution {
  id: string;
  name: string;
  type: "dark" | "light";
  /** Plugin-relative path to the theme JSON file (e.g. `./themes/midnight.json`). */
  path: string;
}

/**
 * One terminal in a `contributes.recipes` entry (#11860). The authorable subset
 * of {@link RecipeTerminal}: the transient per-launch fields (`agentModelId`,
 * `agentLaunchFlags`, `location`) are session state the recipe editor already
 * strips on persist, so a manifest may not declare them. `type` accepts the
 * built-in terminal kinds plus an agent id the SAME plugin contributes — a
 * foreign plugin's agent id is dropped by the sanitizer at registration.
 *
 * `type: "plugin-panel"` opens one of this plugin's own `contributes.panels`
 * (#13797), named by `panelId`, with `panelArgs` handed to the view.
 */
export interface RecipeContributionTerminal {
  type: string;
  title?: string;
  command?: string;
  env?: Record<string, string>;
  /** First turn for an agent step. `{{plugin.<name>}}` takes one of the recipe's `variables`. */
  initialPrompt?: string;
  /**
   * Standing instruction appended to an agent step's system prompt, on agents
   * whose CLI supports one. Takes `{{plugin.<name>}}` like `initialPrompt`.
   */
  systemPrompt?: string;
  args?: string;
  devCommand?: string;
  exitBehavior?: "keep" | "trash" | "remove";
  /** A `contributes.panels[].id` of this plugin, for a `plugin-panel` step. */
  panelId?: string;
  /** Handed to a `plugin-panel` step's view as `initialArgs`, or as `openRequest` to a panel it reuses. */
  panelArgs?: Record<string, unknown>;
}

/**
 * One argument of a {@link PromptTemplateContribution}: a single-line text
 * field in the form the template opens, filled into `{{name}}` in the body.
 */
export interface PromptTemplateArgument {
  name: string;
  label: string;
  required?: boolean;
}

/**
 * One `contributes.promptTemplates` entry (#13799). A prompt template is
 * offered in the composer's `/` menu, under its own heading after the agent
 * CLI's commands, with the plugin's name; choosing it asks for its arguments
 * and puts the expanded body in the composer's draft. It never submits, and it
 * never appears in the `$` menu. Inert declarative content: no capability
 * required.
 */
export interface PromptTemplateContribution {
  id: string;
  title: string;
  description: string;
  /** Prompt text; `{{name}}` is replaced by the argument of that name. */
  body: string;
  args: PromptTemplateArgument[];
}

/** The URLs a {@link TerminalLinkContribution} claims: one scheme, one exact host. */
export interface TerminalLinkUrlContribution {
  scheme: "https" | "http";
  /** A lowercase public domain name; never loopback, private, local-only or an IP. */
  host: string;
  /** Matched against the URL's path as a plain prefix. */
  pathPrefix?: string;
}

/**
 * One `contributes.terminalLinks` entry (#13798): terminal text the plugin
 * makes clickable. Exactly one of `pattern` or `url` is set. A pattern match
 * dispatches `actionId` with {@link TerminalLinkPatternArgs}; a claimed URL
 * dispatches it with {@link TerminalLinkUrlArgs} instead of opening the
 * browser. Matching runs in the host on hover only, and only the matched text
 * reaches the plugin, on click. Built-in links win any overlap.
 */
export interface TerminalLinkContribution {
  id: string;
  /** One of the plugin's own commands, written `"{manifest name}.{id}"`. */
  actionId: string;
  /** A bounded regular expression, matched within one terminal row. */
  pattern?: string;
  /** Match `pattern` without regard to case. */
  ignoreCase?: boolean;
  url?: TerminalLinkUrlContribution;
}

/** The terminal a clicked plugin link was in. */
export interface TerminalLinkSubject {
  panelId: string;
  panelKind: string;
  /** Absent for a terminal outside any worktree. */
  worktreeId?: string;
}

/** What a pattern {@link TerminalLinkContribution}'s command receives on click. */
export interface TerminalLinkPatternArgs extends TerminalLinkSubject {
  text: string;
  /** Capture groups by position; `null` where an optional group matched nothing. */
  groups: (string | null)[];
}

/** What a URL {@link TerminalLinkContribution}'s command receives on click. */
export interface TerminalLinkUrlArgs extends TerminalLinkSubject {
  url: string;
}

/**
 * One `contributes.recipes` entry (#11860). A recipe is a named multi-terminal
 * launch layout the plugin ships; the host registers it under the qualified id
 * `{pluginId}.{id}` and merges it into the recipe list as a plugin-owned tier:
 * in every project for an installed plugin, in its own project only for a
 * `scope: "project"` one.
 *
 * Terminals are declared inline rather than pointing at a shipped JSON file so
 * the install-time confirmation can show what a recipe actually runs:
 * `readArchiveManifest` reads only the manifest, never extracting the archive.
 *
 * Contributed content is immutable — the user customises by duplicating into a
 * user-owned tier. `showInEmptyState` and `autoAssign` are DEFAULTS: a user
 * override for either lives in the sidecar
 * ({@link PluginRecipeMetadata}) and wins. Recipes carry no capability
 * requirement, matching {@link SkillContribution} — the terminals they declare
 * still pass the same content sanitizer every other recipe tier does, and a
 * capability in an unsandboxed runtime would be a label rather than a gate.
 */
export interface RecipeContribution {
  id: string;
  name: string;
  terminals: RecipeContributionTerminal[];
  /** Default for the empty-state pin; a user pin/unpin overrides it. */
  showInEmptyState?: boolean;
  /**
   * Default issue auto-assign behaviour; a user choice overrides it.
   *
   * Spelled out rather than importing `RecipeAutoAssign` from `./project.js`.
   * This module is an entry point of the plugin SDK's bundled declarations, and
   * a type-only import still widens that rollup's graph: pulling in `project.ts`
   * drags `panel.ts` → `panelKindRegistry.ts` → `theme/terminal.ts` behind it,
   * and the DTS build then fails on an `@xterm/xterm` type that module imports.
   * The two stay in step because the registry assigns this straight onto
   * `TerminalRecipe.autoAssign`, so any drift is a compile error there.
   */
  autoAssign?: "always" | "never" | "prompt";
  /**
   * Names the prompts may use as `{{plugin.<name>}}` (#13797), filled by
   * {@link PluginHostApi.runRecipe}. A run that supplies no value for one
   * leaves it empty, as a host variable with no value is.
   */
  variables?: string[];
  /**
   * The recipe's agents need this plugin's agent tools. While those are off in
   * the project the launch is refused and says so, rather than starting agents
   * without them. It never turns them on.
   */
  requiresAgentTools?: boolean;
}

/** One caption line in a {@link PluginTourChapter}, in seconds from the chapter start. */
export interface PluginTourCaption {
  start: number;
  end: number;
  text: string;
}

/**
 * Timing for one chapter of a {@link PluginTourContribution}, the same data the
 * built-in Daintree tour generates per chapter. Every cue and caption falls
 * inside `duration` (seconds).
 */
export interface PluginTourChapter {
  id: string;
  duration: number;
  /** Named scene cues, in seconds. Scenes animate off these, never wall-clock literals. */
  cues?: Record<string, number>;
  captions?: PluginTourCaption[];
  /**
   * Narration audio: a plugin-relative asset path, an https URL on a host the
   * tour lists in `audioHosts`, or `null` for a silent chapter.
   */
  audioUrl: string | null;
  /** 8-character lowercase hex fingerprint of the narration the timing was generated from. */
  narrationHash: string;
}

/**
 * One `contributes.tours` entry (#12768): a welcome tour that plays in the same
 * dialog as the Daintree tour. Without `panelKind` it is a plugin tour offered
 * from Help and the command palette; with one it is a panel tour opened from
 * that panel's menu, and `panelKind` must name one of this plugin's own
 * `contributes.panels`. Remote narration may only be fetched from the hosts
 * listed in `audioHosts`, so the user can see where audio comes from.
 * Registered while the plugin is loaded; the scene module is imported only
 * when the tour opens.
 */
export interface PluginTourContribution {
  id: string;
  title: string;
  /** Plugin-relative module exporting the chapter scenes. */
  componentPath: string;
  panelKind?: string;
  /** Bare hostnames remote chapter audio is fetched from, e.g. `cdn.example.com`. */
  audioHosts?: string[];
  chapters: PluginTourChapter[];
  /**
   * Content version. Saved progress resumes by chapter id only while it
   * matches; bump it when a half-watched run should start over.
   */
  version?: string;
  /** What Finish does beyond closing. */
  finish?: PluginTourFinishContribution;
}

/**
 * A tour's Finish handoff (#14098): open this plugin's settings, optionally at
 * one setting, or run one of its own commands, written `{manifest.name}.<id>`.
 */
export interface PluginTourFinishContribution {
  /** The line on the last end card that says what Finish will do. */
  hint: string;
  action: { kind: "settings"; key?: string } | { kind: "command"; actionId: string };
}

/** {@link PluginTourFinishContribution} as renderers see it: the command qualified to this instance. */
export interface PluginTourDescriptorFinish {
  hint: string;
  action: PluginSetupStepUiAction;
}

/** One chapter of a {@link PluginTourDescriptor}: manifest timing with its audio resolved. */
export interface PluginTourDescriptorChapter {
  id: string;
  duration: number;
  cues: Record<string, number>;
  captions: PluginTourCaption[];
  /**
   * Where the player fetches narration: a `plugin://` URL for bundled audio or
   * for the host's audio route to a declared remote host, `null` when silent.
   */
  audioUrl: string | null;
}

/**
 * A loaded plugin's tour as renderers see it. Serializable: the scene module
 * is named by URL and imported only when the tour opens.
 */
export interface PluginTourDescriptor {
  /** Qualified id, `{pluginId}.{tourId}` — what progress and `help.tour.show` key on. */
  id: string;
  pluginId: string;
  /** The plugin's display name, which Help and the palette list the tour under. */
  pluginName: string;
  title: string;
  panelKind?: string;
  /** `plugin://` URL of the scene module, carrying the load's view generation. */
  moduleUrl: string;
  chapters: PluginTourDescriptorChapter[];
  version?: string;
  finish?: PluginTourDescriptorFinish;
}

/**
 * One `contributes.projectTemplates` entry (#13825): a starting set of files
 * offered in the Create project dialog. The files are the plugin's
 * `project-templates/<id>/` folder, copied as they are into the new folder the
 * user names. Nothing in the plugin runs to produce them.
 */
export interface ProjectTemplateContribution {
  id: string;
  title: string;
  description: string;
  /** A plugin icon id (`shared/config/pluginIconIds.ts`); advisory, with a fallback glyph. */
  iconId?: string;
}

/** A loaded plugin's project template as the Create project dialog lists it. */
export interface ProjectTemplateDescriptor {
  pluginId: string;
  /** The plugin's display name, which the dialog attributes the template to. */
  pluginName: string;
  templateId: string;
  title: string;
  description: string;
  iconId?: string;
}

/**
 * What a template file is to the user reading the list: an instruction file
 * agents read, part of a project plugin that asks for trust on first open, or
 * anything else.
 */
export type ProjectTemplateFileKind = "file" | "instructions" | "project-plugin";

export interface ProjectTemplateFile {
  /** Relative to the new project folder, `/`-separated. */
  path: string;
  size: number;
  kind: ProjectTemplateFileKind;
}

/**
 * Every file a template would write, or why it can't be used. `digest` names
 * this exact set of paths and bytes; creating from the template hands it back
 * and is refused if the files have changed since.
 */
export type ProjectTemplatePreview =
  | { status: "ready"; digest: string; files: ProjectTemplateFile[]; totalBytes: number }
  | {
      status: "unusable";
      reason: string;
      /** The files couldn't be read, rather than the template refused: reading again may work. */
      retryable?: true;
    };

/** The template a new project folder starts from, as the dialog previewed it. */
export interface ProjectTemplateSelection {
  pluginId: string;
  templateId: string;
  digest: string;
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

/**
 * Optional path intent for the `socket:connect` capability (#11299). Purely
 * declarative: unlike {@link PluginFsScope}, nothing enforces it, because a
 * plugin's `main` reaches `node:net` directly and the host has no interception
 * point. Its job is disclosure — the Permissions tab renders these entries so
 * "connects to local sockets" reads as "connects to `/var/run/docker.sock`".
 *
 * Entries are validated for shape only (a Unix-domain path or a Windows
 * `\\.\pipe\…` name, no globs), and validated identically on every platform so
 * a cross-platform manifest parses on all of them.
 */
export interface PluginLocalSocketScope {
  /**
   * Declared local endpoints the plugin intends to connect to — Unix-domain
   * socket paths and/or Windows named pipes. Advisory, not enforced.
   */
  allowedPaths: string[];
}

export interface PluginManifestScopes {
  network?: PluginNetworkScope;
  fs?: PluginFsScope;
  socket?: PluginLocalSocketScope;
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
 * `supportsContextInjection`, an optional `resume` block (#13687), and an
 * optional `detection` block. The
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
  /**
   * Optional session resume (#13687): `session-id` with a `{sessionId}` args
   * template, or `project-scoped` static args. Plain data, expanded where a
   * resume command is built. Plugin agents never claim a `continuity` tier.
   */
  resume?: AgentResumeTemplate;
  /**
   * Optional additive launch mechanism (#13803): the CLI's own way of merging
   * extra MCP servers over the user's, which Daintree uses to hand the agent its
   * orchestration server and the plugin endpoints the project turned on. Declaring
   * a format grants nothing — access still comes from the project's tool
   * settings. Only the format is declared; Daintree owns any env var name.
   */
  launchMcp?: { format: LaunchMcpFormat };
}

/**
 * A plugin-contributed terminal process detection (#11613). Maps one command
 * name to the icon a terminal tab shows while that command runs, so a plugin
 * that ships or wraps a CLI can make it identifiable in a pane instead of
 * falling back to the generic terminal glyph.
 *
 * `command` is the bare executable name the detector matches — the same key
 * space as the built-in `PROCESS_TOOL_REGISTRY` commands (`vite`, `pytest`,
 * `redis-cli`). Lowercase only: `ProcessDetector` lower-cases every candidate
 * before lookup, so a mixed-case key could never match. A tool with aliases
 * declares one entry per alias.
 *
 * `iconId` uses the generic plugin icon namespace ({@link PLUGIN_ICON_IDS} in
 * `shared/config/pluginIconIds.ts`), the same one `contributes.panels[].iconId`
 * and `contributes.toolbarButtons[].iconId` use, or — like those siblings — a
 * `./…svg` path to the plugin's own icon file (#13143). Advisory: an
 * unrecognized id or unloadable file renders a fallback glyph rather than
 * failing the load.
 *
 * Inert declarative data, so no capability is required. A command that collides
 * with a built-in tool or agent is rejected at parse time; a cross-plugin
 * collision resolves first-registered-wins with a warning.
 *
 * Deliberately no `label`: the renderer resolves a detected process's display
 * label from its icon id (`deriveTerminalChrome`), and generic plugin icon ids
 * are shared across plugins, so a plugin-supplied label could not be resolved
 * unambiguously. A plugin-detected process labels itself with its icon id until
 * the identity model carries a distinct process label through panel state.
 *
 * Registered into `shared/config/pluginProcessToolRegistry.ts` at load time and
 * mirrored into the pty-host, where detection runs.
 */
export interface PluginProcessToolContribution {
  command: string;
  iconId: string;
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

/**
 * Which root a plugin was discovered under. Replaces the `isBuiltin` boolean at
 * the manifest gate, which could only say "first-party or not" and had no way
 * to express a third root:
 *
 * - `"builtin"` — shipped inside the app bundle (`plugins/builtin/`), plus the
 *   E2E sideload root, which is loaded on the same trust footing.
 * - `"user"` — installed by the user into the per-user plugins directory.
 * - `"project"` — lives in a project's own `.daintree/plugins/`, is only ever
 *   loaded while that project is open, and must declare `scope: "project"`.
 *
 * Host-internal: a plugin never learns its own origin, so this is deliberately
 * not re-exported from the SDK barrel.
 */
export type PluginOrigin = "builtin" | "user" | "project";

export interface PluginManifest {
  /** JSON Schema URL for editor completion; accepted by the validator, never read by the host. */
  $schema?: string;
  name: string;
  version: string;
  displayName?: string;
  /**
   * The short name agents see this plugin's MCP server under, as
   * `daintree-<mcpName>`: lowercase letters, digits and hyphens, at most 16
   * characters. `docs` and `runbooks` are taken by the Daintree Assistant's own
   * servers, and `decisions` by the server agents ask the person through.
   * Without one the host derives a name from the last segment of
   * `name`. The same name in every project; see `docs/plugins/manifest.md` for
   * how a clash between two plugins is settled.
   */
  mcpName?: string;
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
   * Manifest ids (`publisher.name`) of other plugins this one works with, shown
   * in the plugin manager with whether each is installed. Disclosure and an
   * install hint only: nothing is installed, loaded or ordered from it, and a
   * listed plugin that is missing changes nothing about how this one runs.
   */
  worksWith?: string[];
  /**
   * Declared catalog category. Optional — when absent the manager derives one
   * from `contributes` (see `resolvePluginCategory`).
   */
  category?: PluginCategoryId;
  main?: string;
  engines?: {
    daintree?: string;
  };
  /**
   * Declares the plugin is only ever loaded project-locally. REQUIRED when the
   * manifest is discovered under a project's own plugins directory, REJECTED
   * under the user or builtin roots. The manifest gate enforces both directions,
   * so a project plugin cannot be dropped into the user directory (or a user
   * plugin into a project) and quietly keep working under assumptions its author
   * never made.
   *
   * A guardrail against accidental promotion, not a security control: the trust
   * decision is the project folder, not this field.
   */
  scope?: "project";
  /**
   * Opts an installed package into running as one independently bound instance
   * per selected project, instead of a single app-wide singleton. Absent means
   * singleton. Installed packages only, and mutually exclusive with `scope`.
   * An instance runs under the project-plugin binding contract: its settings,
   * storage, databases and connections are pinned to the project it was enabled
   * in, never to whichever project is focused.
   */
  instanceMode?: "project";
  /**
   * Names this project plugin as the project's application and points at the
   * parts of it the plugin already contributes. `scope: "project"` only. See
   * {@link PluginApplicationDescriptor}.
   */
  application?: PluginApplicationDescriptor;
  /**
   * `"unsupported"` for a plugin that only works on the machine the person is
   * sitting at — a view that assumes the renderer's `localhost` is the
   * project's machine, or code that relies on local OS behaviour. It is then
   * not activated for a window attached from another machine, which shows a
   * placeholder instead. Absent means `"supported"`.
   */
  remote?: "supported" | "unsupported";
  /**
   * The operating systems (Node `process.platform` names) the package has a
   * build for. Absent means any; only a plugin shipping native modules for one
   * OS needs it, and installing it on another machine is refused up front.
   */
  platforms?: Array<"darwin" | "linux" | "win32">;
  capabilities?: PluginCapability[];
  /**
   * Per-capability scope bindings that attenuate the compound-capability
   * lattice. See {@link PluginManifestScopes}. Absent on most plugins —
   * the lattice still elevates compound pairs without scopes, so this field
   * is opt-in only for plugins that need to skip elevation.
   */
  scopes?: PluginManifestScopes;
  activationEvents?: "onStartupFinished"[];
  /**
   * Events that wake the plugin and run one of its own commands (#13816).
   * Optional in the type but always materialized by the manifest schema's
   * `.default([])`. See {@link PluginEventRoute}.
   */
  eventRoutes?: PluginEventRoute[];
  contributes: {
    panels: PanelContribution[];
    toolbarButtons: ToolbarButtonContribution[];
    menuItems: MenuItemContribution[];
    keybindings: KeybindingContribution[];
    contextMenus: ContextMenuContribution[];
    /**
     * Rows the plugin adds to the launcher (#13788). Optional in the type but
     * always materialized by the manifest schema's `.default([])`, like
     * `agentMcp`.
     */
    launchEntries?: PluginLaunchEntryContribution[];
    /**
     * Named panel layouts (#13780). Optional in the type but always
     * materialized by the manifest schema's `.default([])`, like
     * `launchEntries`.
     */
    layouts?: LayoutContribution[];
    /**
     * Search providers for the quick switcher (#13792). Optional in the type
     * but always materialized by the manifest schema's `.default([])`.
     */
    searchProviders?: PluginSearchProviderContribution[];
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
    /**
     * MCP tools endpoints this plugin serves to terminal agents. Requires the
     * `mcp:expose` capability. Optional in the type but always materialized by
     * the manifest schema's `.default([])`, for the same reason as `surfaces`.
     */
    agentMcp?: PluginAgentMcpContribution[];
    /**
     * Plugin-contributed skills (#10892) — markdown knowledge/instruction files
     * surfaced to agents via the built-in MCP server's `skills.search` /
     * `skills.load` tools. Inert declarative content; no capability required.
     * Empty unless the plugin ships skills.
     */
    skills: SkillContribution[];
    /**
     * Markdown for the Daintree Assistant about this plugin's tools (#13828).
     * Not materialized by the schema: absent unless the plugin declares it.
     */
    assistantKnowledge?: AssistantKnowledgeContribution;
    /**
     * Plugin-contributed themes (#13832). Optional in the type but always
     * materialized by the manifest schema's `.default([])`, for the same reason
     * as `surfaces`. Installed and built-in plugins only.
     */
    themes?: ThemeContribution[];
    /**
     * Plugin-contributed prompt templates (#13799). Optional in the type but
     * always materialized by the manifest schema's `.default([])`. Shown in
     * every project for an installed plugin, in its own project only for a
     * `scope: "project"` one.
     */
    promptTemplates?: PromptTemplateContribution[];
    /**
     * Plugin-contributed terminal link matchers (#13798). Optional in the type
     * but always materialized by the manifest schema's `.default([])`. Applied
     * in every project's terminals for an installed plugin, in its own
     * project's only for a `scope: "project"` one.
     */
    terminalLinks?: TerminalLinkContribution[];
    /**
     * `@` context providers for the agent composer (#13795). Optional in the
     * type but always materialized by the manifest schema's `.default([])`. A
     * project plugin's providers show in its own project only.
     */
    contextProviders?: ContextProviderContribution[];
    forgeProviders: ForgeProviderContribution[];
    /**
     * Element Picker framework providers (#14073). Optional in the type but
     * always materialized by the manifest schema's `.default([])`.
     */
    elementPickerProviders?: ElementPickerProviderContribution[];
    fileDecorationProviders: FileDecorationContribution[];
    /**
     * The plugin's check for worktree delete confirmations (#13805), at most
     * one. Optional in the type but always materialized by the manifest
     * schema's `.default([])`, like `launchEntries`.
     */
    worktreeDeleteNotes?: WorktreeDeleteNotesContribution[];
    /**
     * Plugin-contributed file editors (#12323): an extra, writable mode on the
     * host's file panel for the declared extensions. Built-in plugins only in
     * v1 — the slot resolves through the host-bundled builtin view registry,
     * which an installed plugin's renderer cannot reach. Empty unless the
     * plugin ships an editor.
     */
    fileEditors: FileEditorContribution[];
    /**
     * Plugin-contributed launchable agents (#9560). Each entry registers an
     * {@link PluginAgentContribution} into the effective agent registry at load
     * time so the CLI is selectable as a named agent. Requires the
     * `agent:register` capability. Empty unless the plugin opts in.
     */
    agents: PluginAgentContribution[];
    /**
     * Plugin-contributed terminal process detections (#11613). Each entry maps
     * a command name to the icon a terminal tab shows while that command runs.
     * Inert declarative data; no capability required. Empty unless the plugin
     * ships or wraps a CLI it wants recognized.
     */
    processTools: PluginProcessToolContribution[];
    /**
     * Declared plugin settings. When absent or empty, `host.settings.set()`
     * accepts any key (permissive for plugins that declare none). When non-empty,
     * `set()` (and the settings-UI write/reset paths) reject keys not declared
     * here and enforce each setting's declared scope — see `assertSettingDeclared`
     * in `electron/services/plugin/PluginSettingsManager.ts`.
     */
    settings?: SettingDefinition[];
    /**
     * Plugin-contributed recipes (#11860) — named multi-terminal launch layouts
     * merged into the recipe list as a plugin-owned tier, shown in every
     * project or, for a `scope: "project"` plugin, in its own project only.
     * Inert declarative content; no capability required. Content is immutable;
     * user-owned frecency and preferences live in a sidecar keyed by the
     * qualified id. Empty unless the plugin ships recipes.
     */
    recipes: RecipeContribution[];
    /**
     * Plugin welcome tours (#12768). Optional in the type but always
     * materialized by the manifest schema's `.default([])`, for the same reason
     * as `agentMcp`.
     */
    tours?: PluginTourContribution[];
    /**
     * Project templates offered in the Create project dialog (#13825). Optional
     * in the type but always materialized by the manifest schema's
     * `.default([])`, like `agentMcp`. Installed and builtin plugins only.
     */
    projectTemplates?: ProjectTemplateContribution[];
    /**
     * Project surfaces this plugin claims (§7.8). Optional in the type but
     * always materialized by the manifest schema's `.default({})`, so a
     * consumer reading it off a parsed manifest never sees `undefined` — the
     * optionality is for the hand-built manifest literals in tests and tooling
     * that predate the field.
     *
     * Only meaningful for a `scope: "project"` plugin; the manifest schema
     * rejects the key outright for any other origin.
     */
    surfaces?: SurfaceContributions;
    /**
     * SQLite databases opened through `host.db`. Optional in the type but
     * always materialized by the manifest schema's `.default([])`, like
     * `agentMcp`.
     */
    databases?: PluginDatabaseContribution[];
    /**
     * Steps run for each new worktree after the project's setup script
     * (#13807). Optional in the type but always materialized by the manifest
     * schema's `.default([])`, like `agentMcp`.
     */
    worktreeSetupSteps?: WorktreeSetupStepContribution[];
    /**
     * The one online account the host signs in to for this plugin (#13823).
     * The host draws the Connect / Disconnect row, runs the flow, stores the
     * tokens in the OS keychain and hands the plugin a current access token
     * through `host.account`. A project plugin's account is per project.
     * Shorthand for a single connection named `"default"`; a manifest declares
     * this or `connections`, never both.
     */
    account?: PluginAccountContribution;
    /**
     * Named host-managed connections (#14102): one entry per service or per
     * account of the same service ("work", "personal"). Each is signed in,
     * refreshed and disconnected on its own; `host.account` picks one by id,
     * or the one the project is bound to. Same rules as `account` otherwise.
     */
    connections?: PluginConnectionContribution[];
    /**
     * Services this plugin exports to other plugins and imports from them
     * (#14105). Optional in the type but always materialized by the manifest
     * schema's default, like `surfaces`. See {@link PluginServicesContribution}.
     */
    services?: PluginServicesContribution;
    /**
     * A short setup checklist (#13824), shown on the plugin's setup strip and
     * at the top of its settings. The host works out which steps are done from
     * what it can see; only the user's "Skip" is remembered, per project.
     * Optional in the type but always materialized by the manifest schema's
     * `.default([])`, like `agentMcp`.
     */
    setup?: PluginSetupStepContribution[];
  };
}

/**
 * How the host tells a setup step is done. Never stored: a cleared setting, a
 * disconnected account or a context key that turns false makes the step
 * outstanding again.
 *
 * - `setting`: the declared setting `key` has a stored value. A declared
 *   `default` doesn't count, the same rule `required` settings follow.
 * - `account`: the plugin's account is connected — the named `connection`, or
 *   without one the connection the project uses.
 * - `context`: the `when` clause holds over the context keys plugins publish
 *   with `host.setContext`, written `publisher.name.key`.
 */
export type PluginSetupStepDone =
  | { kind: "setting"; key: string }
  | { kind: "account"; connection?: string }
  | { kind: "context"; when: string };

/**
 * What clicking a setup step does.
 *
 * - `settings`: open the plugin's settings, at the declared setting `key` when
 *   one is given.
 * - `command`: run one of the plugin's own commands, written
 *   `"<manifest name>.<id>"` like every other action reference in the manifest.
 *   It runs with no arguments.
 */
export type PluginSetupStepAction =
  { kind: "settings"; key?: string } | { kind: "command"; actionId: string };

/** One `contributes.setup` entry (#13824). */
export interface PluginSetupStepContribution {
  /** Unique within the plugin; what a skip is remembered by. */
  id: string;
  title: string;
  description?: string;
  done: PluginSetupStepDone;
  /**
   * Defaults to opening the step's setting for a `setting` step and the
   * plugin's settings for an `account` step. A `context` step has none unless
   * it declares one.
   */
  action?: PluginSetupStepAction;
}

/** A setup step's action as the renderer runs it: a command already in the instance's namespace. */
export type PluginSetupStepUiAction =
  { kind: "settings"; key: string | null } | { kind: "command"; actionId: string };

/**
 * What the host saw for one setup step. A `context` step carries its clause
 * instead of an answer: the renderer evaluates it against the context keys its
 * own view mirrors.
 */
export type PluginSetupStepCheck =
  { kind: "observed"; done: boolean } | { kind: "context"; when: string };

export interface PluginSetupStepUiStatus {
  id: string;
  title: string;
  description: string | null;
  check: PluginSetupStepCheck;
  action: PluginSetupStepUiAction | null;
  /** The user skipped this step in the requested project. Always false with no project. */
  skipped: boolean;
}

/** A plugin's setup checklist, in manifest order; empty when it declares none. */
export interface PluginSetupUiStatus {
  steps: PluginSetupStepUiStatus[];
}

/** Where "Connected as …" comes from: a bearer GET whose JSON holds the name at `field`. */
export interface PluginAccountIdentity {
  url: string;
  /** Dotted path into the response, such as `"viewer.login"`. */
  field: string;
}

/**
 * A connection test: a bearer GET that answers 2xx while the service still
 * accepts the token, and 401/403 once it doesn't.
 */
export interface PluginAccountTest {
  url: string;
}

interface PluginAccountContributionBase {
  /** The service's name, shown on the Connect row ("GitLab", "Linear"). */
  label: string;
  description?: string;
  identity?: PluginAccountIdentity;
  /** What the settings row's Test runs. Without one, Test asks the `identity` endpoint. */
  test?: PluginAccountTest;
}

/**
 * `contributes.account`. `oauth2` runs an authorization-code flow with PKCE
 * (S256) as a public client against fixed `https:` endpoints; `token` stores
 * an API token the user pastes.
 */
export type PluginAccountContribution =
  | (PluginAccountContributionBase & {
      kind: "oauth2";
      authorizeUrl: string;
      tokenUrl: string;
      clientId: string;
      scopes: string[];
    })
  | (PluginAccountContributionBase & { kind: "token" });

export type PluginAccountKind = PluginAccountContribution["kind"];

/** One `contributes.connections` entry: an account declaration with the id it is addressed by. */
export type PluginConnectionContribution = PluginAccountContribution & { id: string };

/** The connection `contributes.account` declares. */
export const DEFAULT_PLUGIN_CONNECTION_ID = "default";

/**
 * Which connection a `host.account` call means. `connection` names a declared
 * one; without it the project's bound connection, else the first declared.
 * `projectId` says which project's binding applies: an installed plugin serves
 * every project and passes it, a project plugin's host already knows its own.
 */
export interface PluginAccountRef {
  connection?: string;
  projectId?: string;
}

/**
 * A project's choice of connection for one plugin, kept in Daintree's own
 * settings, never the repository. `machine` points a project plugin at the
 * installed plugin's connection of the same id on this machine instead of its
 * own private one.
 */
export interface PluginAccountBinding {
  connectionId: string;
  source: "own" | "machine";
}

/**
 * What the host last saw when it used the stored tokens. Never stored: it
 * starts `unchecked` and resets on every sign-in, so "connected" only ever
 * means tokens are kept, and this says whether the service took them.
 *
 * - `ok`: a test or a refresh succeeded.
 * - `rejected`: the service answered 401/403 to a test.
 * - `unreachable`: the test couldn't reach the service or got another error.
 * - `revoked`: a refresh was refused for good, so the tokens were dropped.
 */
export interface PluginAccountVerification {
  status: "unchecked" | "ok" | "rejected" | "unreachable" | "revoked";
  /** Epoch ms of the check, `null` while unchecked. */
  checkedAt: number | null;
  message: string | null;
}

/** What a plugin hears about its account. Never carries a token. */
export interface PluginAccountState {
  connected: boolean;
  /** The name the service reported, when the manifest declares `identity` and it answered. */
  identity: string | null;
}

/** A current access token for the plugin's account. The refresh token never leaves the host. */
export interface PluginAccountAccessToken {
  accessToken: string;
  /** Epoch ms the token expires at, or `null` when the service didn't say. */
  expiresAt: number | null;
}

/**
 * `host.account` — the plugin's side of its host-managed account. Signing in
 * and out happens only from the host's own settings row.
 */
export interface PluginAccountApi {
  /** Whether the account is connected, and as whom. */
  getState(ref?: PluginAccountRef): Promise<PluginAccountState>;
  /**
   * A current access token, refreshed first when it is about to expire, or
   * `null` when the account isn't connected (including after the service
   * refused a refresh, which disconnects it). Ask each time you need one;
   * don't keep it. Rejects when the plugin declares no `contributes.account`,
   * or when a refresh fails for a reason that may pass (offline, server error).
   */
  getAccessToken(ref?: PluginAccountRef): Promise<PluginAccountAccessToken | null>;
  /**
   * Called when the account connects, disconnects or reports a new identity,
   * and when the project's binding moves `ref` to another connection.
   * Returns a disposer; every subscription is disposed when the plugin unloads.
   * Without a declared account nothing ever changes, so the callback never runs.
   */
  onDidChange(
    callback: (state: PluginAccountState) => void | Promise<void>,
    ref?: PluginAccountRef
  ): () => void;
}

/** The settings row's view of a plugin account. */
export interface PluginAccountUiStatus {
  /** The connection's id; `"default"` for `contributes.account`. */
  connectionId: string;
  kind: PluginAccountKind;
  label: string;
  description: string | null;
  connected: boolean;
  identity: string | null;
  /** A browser sign-in is waiting on the user. */
  pending: boolean;
  /** Whether the OS keychain can store the tokens right now. */
  secretTier: PluginSecretStorageTier;
  /** Whether the manifest declares something Test can ask (`test`, else `identity`). */
  testable: boolean;
  verification: PluginAccountVerification;
}

/** A connection a project can use for a plugin, as its binding picker lists it. */
export interface PluginAccountBindingChoice extends PluginAccountBinding {
  label: string;
  connected: boolean;
  identity: string | null;
}

/** Which connection a project uses for one plugin, and what it could use instead. */
export interface PluginAccountBindingUiStatus {
  /** The stored choice, or `null` when the project uses the default. */
  binding: PluginAccountBinding | null;
  /** What `host.account` resolves to in this project without a named connection. */
  selected: PluginAccountBinding;
  choices: PluginAccountBindingChoice[];
}

/** How a Connect click ended. `cancelled` covers a superseded or cancelled flow. */
export type PluginAccountConnectResult =
  | { status: "connected"; account: PluginAccountUiStatus }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

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
  "string" | "number" | "boolean" | "enum" | "json" | "secret" | "path" | "directory" | "file";

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
   * Legacy secret hint (F19). The manifest schema normalizes `secret: true` to
   * `type: "secret"`; new manifests should use the type. Once normalized, the
   * value is stored like any `type: "secret"` setting — encrypted through the
   * OS keychain via Electron `safeStorage`, and refused rather than written in
   * plaintext when no keychain is available (see {@link PluginSecretStorageTier}).
   */
  secret?: boolean;
  /**
   * The plugin can't do its job until this is set. While any required setting
   * is unset — a secret counts as set only once a value is stored, and a
   * declared `default` never satisfies it — each of the plugin's open panels
   * shows a "needs setup" strip above its view that opens the setting, and
   * {@link SettingsApi.missingRequired} lists it.
   */
  required?: boolean;
  /**
   * Who edits the value in Settings. `"view"` hands it to the plugin's own
   * `location: "settings"` view — for a value a plain field can't edit well,
   * such as a per-channel table stored as `json` — and the generated form
   * leaves it out rather than showing it twice. Without such a view the form
   * shows the field anyway, so the value is never left uneditable. Default
   * `"form"`.
   */
  editor?: "form" | "view";
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

/**
 * Where a `contributes.settings` value is stored.
 *
 * `"user"` is one file shared by every project. `"project"` is written into the
 * repository (`<projectRoot>/.daintree/plugin-settings/`) and travels to every
 * clone. `"local"` is the third case neither covers: per project AND per
 * machine, held in Daintree's own state directory beside the rest of this
 * machine's per-project plugin state, never in the repo. An interpreter path is
 * the canonical example — committing it publishes one machine's layout, and
 * putting it in user scope applies it to unrelated projects.
 *
 * Secret settings are the exception to where `"project"` writes: a secret is
 * never stored under the project root, whatever its scope. A `"project"`-scoped
 * secret is still read, written, and subscribed to under `"project"` and shown
 * in the settings form's project section, but its value is stored in the
 * `"local"` file on this machine — so it is per project, and never committed.
 */
export type PluginSettingsScope = "user" | "project" | "local";

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
   * the OS keychain (Electron `safeStorage`) is available, `"unavailable"` when
   * it is not (e.g. a headless Linux box) and secret writes are refused,
   * `"locked"` when it gave no key this session. The settings UI discloses this
   * honestly per secret field.
   */
  secretTier: PluginSecretStorageTier;
  /**
   * Ids of secret settings whose *currently stored* value is still plaintext —
   * written by an older Daintree before secrets were refused without a keychain.
   * The UI should nudge the user to re-save it; migration into the keychain
   * happens automatically on the next write.
   */
  secretsPlaintext: string[];
}

/**
 * At-rest storage tier for new secret setting values. Secrets are never written
 * in plaintext: with no OS keychain the tier is `"unavailable"` and a write is
 * refused (#12613). `"locked"` is a keychain that is there but gave no key this
 * session (its unlock prompt was dismissed or failed): Electron asks once per
 * run, so writes are refused until Daintree restarts and asks again.
 */
export type PluginSecretStorageTier = "keychain" | "locked" | "unavailable";

/**
 * A plugin's declared `required` settings, split by what their stored state
 * says. `missing` has nothing stored (a declared default never counts);
 * `unreadable` is stored in a file that couldn't be read, reported apart so one
 * bad file doesn't hide — or fake — every other answer. Ids only, never values.
 */
export interface PluginRequiredSettingsStatus {
  missing: string[];
  unreadable: string[];
  /** Display label (declared `label`, else the id) for every id in either list. */
  labels: Record<string, string>;
}

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
 * Call options for {@link PluginHostApi.showQuickPick},
 * {@link PluginHostApi.showInputBox} and {@link PluginHostApi.showConfirm}.
 *
 * `whenNoFrontend` decides what happens when the project lives on a host that
 * nobody is attached to (agents often run overnight with no window open).
 * `"fail"`, the default, rejects with a `NO_FRONTEND_ATTACHED:` error — never
 * the dismiss value, so "nobody was there" can't be mistaken for "the person
 * said no". `"queue"` waits until a frontend attaches and shows the prompt
 * there, marked with the host and the time it was asked; aborting `signal`
 * still settles it with the dismiss value.
 */
export interface PluginPromptCallOptions extends PluginHostCallOptions {
  whenNoFrontend?: "fail" | "queue";
}

/**
 * Options accepted by the bursty host subscriptions —
 * {@link PluginActivationApi.onDidChangeWorktrees},
 * {@link PluginActivationApi.onDidChangeActiveWorktree},
 * {@link PluginActivationApi.onDidChangeAgentState},
 * {@link PluginActivationApi.onDidChangeAllAgents},
 * {@link PluginActivationApi.onDidChangeFocusedPanel} and
 * {@link PluginActivationApi.onDidChangeProjectPresence}. These coalesce by default:
 * a burst of events becomes one trailing callback fired `debounceMs` after the
 * last event (the host re-emits the worktree set on every git-status poll, and
 * agents change state many times a second). A burst that never goes quiet
 * still fires at least every `4 × debounceMs`, so a busy project never
 * withholds its latest state indefinitely.
 *
 * - omitted (or not a number) — the default window, 100ms (250ms for
 *   `onDidChangeFocusedPanel`)
 * - `0` (or a negative number) — no coalescing: every event is delivered
 * - any other value — used as the window, clamped to 50–60000ms
 *
 * What a coalesced callback receives is documented on each subscription; the
 * common rule is that the most recent value is always delivered.
 */
export interface PluginHostSubscriptionOptions {
  debounceMs?: number;
}

/**
 * What changed in the worktree set since the previous
 * {@link PluginActivationApi.onDidChangeWorktrees} delivery to the same
 * subscription, as snapshot `id`s. Computed by the host from the list it last
 * delivered, so a coalesced burst reports the net change across the whole
 * burst (a worktree added and removed within one window appears in neither
 * list). The first delivery compares against an empty set: every worktree is
 * `added`.
 *
 * A worktree is `changed` when any field of its {@link PluginWorktreeSnapshot}
 * differs — branch, current/main flags, ahead/behind counts, mood, activity
 * and creation times, the linked issue/PR projection, or its status (the
 * per-state counts and the path + state of every changed file). A delivery
 * whose three lists are all empty re-sends an unchanged set; a plugin that
 * only cares about changes can return early on it.
 */
export interface PluginWorktreesChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/**
 * Persistent, plugin-scoped key/value settings exposed on
 * {@link PluginHostApi.settings}. Values are stored as JSON at
 * `~/.daintree/plugin-settings/{pluginId}.json` (user scope; a project
 * plugin's `pluginId` is its per-project instance key),
 * `<projectRoot>/.daintree/plugin-settings/{manifestId}.json` (project scope,
 * committed with the repository) or this machine's per-project local file
 * (local scope), with `chmod 0o600` applied on POSIX. Settings declared
 * `type: "secret"` are encrypted at rest through the OS keychain (Electron
 * `safeStorage`) and never stored under the project root. With no keychain
 * available a secret write is refused rather than stored in plaintext.
 * Non-secret values are always plaintext JSON — do not store credentials in
 * non-secret keys.
 *
 * Omitting `scope` targets the key's declared scope (`"user"` for an
 * undeclared key). While nothing is stored — or, for a project-bound scope,
 * no project is available — `get` resolves to the declared `default`.
 */
export interface SettingsApi {
  /**
   * Read a setting. While nothing is stored — or, for `"project"` scope, no
   * project is active — it resolves to the key's declared `default`, and to
   * `undefined` when it declares none.
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
   * declares `contributes.settings`, an undeclared key is rejected. A declared
   * secret is rejected when no OS keychain is available to encrypt it. Omitting
   * `scope` targets the key's declared scope (`"user"` for an undeclared key);
   * an explicit scope that conflicts with the declaration throws.
   */
  set<T = unknown>(key: string, value: T, scope?: PluginSettingsScope): Promise<void>;
  /**
   * Clear a stored setting, so it reads as its declared `default` (or
   * `undefined`) again. This is not the same as writing an empty value: a
   * cleared `required` setting is listed by {@link missingRequired} again, and a
   * cleared secret is removed from the keychain-backed store it was written to.
   * Only a key the manifest declares in `contributes.settings` can be cleared,
   * in the scope it declares; omitting `scope` targets that scope, and a
   * conflicting one throws. Subscribers fire with the declared default when
   * something was removed, and clearing a key that holds nothing is silent.
   * For `"project"` scope with no active project there is nothing to clear and
   * it resolves.
   */
  unset(key: string, scope?: PluginSettingsScope): Promise<void>;
  /**
   * Subscribe to in-process writes of `key` in `scope` (default: the key's
   * declared scope, else `"user"`). The callback fires with the new value after
   * each `set` that changes it, and with the declared `default` (or
   * `undefined`) when the stored value is cleared. Edits
   * made to the JSON file by other processes never fire (a later `get` reads
   * them). Must be called during `activate()` — subscribing is revoke-guarded.
   * Resolves to a disposer; calling it more than once is a no-op. All
   * subscriptions are automatically disposed when the plugin is unloaded.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked, and the call throws synchronously.
   */
  onDidChange<T = unknown>(
    key: string,
    callback: (value: T | undefined) => void,
    scope?: PluginSettingsScope
  ): Promise<() => void>;
  /**
   * Take the user to this plugin's settings, in whichever home they live in —
   * the plugin manager for an installed plugin's own settings, Project
   * settings → Plugins for a project plugin or a project-scoped key — and, when
   * `key` names a declared setting, scroll to it and highlight it briefly.
   *
   * A bound (project) plugin opens in its own project's window. Resolves once
   * the request is handed to the renderer; rejects when no window can show it,
   * or when the destination is Project settings and no project is open there.
   */
  open(key?: string): Promise<void>;
  /**
   * The ids of declared `required: true` settings that are still unset, in
   * manifest order. A secret counts as set only once a value is stored, and a
   * declared `default` never counts. Project-scoped keys are read against the
   * plugin's project (or the active project for an installed plugin) and are
   * reported missing when there is none. A key whose stored file can't be read
   * is listed too — the plugin couldn't read it either — without hiding the
   * others. Secrets are checked for presence without being decrypted. Empty
   * when nothing is required.
   */
  missingRequired(): Promise<string[]>;
}

/**
 * Private, plugin-scoped key/value storage exposed on
 * {@link PluginHostApi.storage}. This is the machine-owned counterpart to
 * {@link SettingsApi}: values never surface in the plugin settings UI and are
 * NOT gated by `contributes.settings` declarations, so a plugin can persist its
 * own working state freely without declaring every key. Values are stored as
 * plaintext JSON (no secret encryption — never store credentials here) at
 * `~/.daintree/plugin-storage/{pluginId}.json` (user scope; a project
 * plugin's `pluginId` is its per-project instance key),
 * `<projectRoot>/.daintree/plugin-storage/{manifestId}.json` (project scope), or
 * `<worktreePath>/.daintree/plugin-storage/{manifestId}.json` (worktree scope),
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
   * Edits made to the JSON file by other processes never fire (a later `get` reads
   * them). Must be called during `activate()` — subscribing is revoke-guarded.
   * Resolves to a disposer; calling it more than once is a no-op. All
   * subscriptions are automatically disposed when the plugin is unloaded.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked, and the call throws synchronously.
   */
  onDidChange<T = unknown>(
    key: string,
    callback: (value: T | undefined) => void,
    scope?: PluginStorageScope
  ): Promise<() => void>;
}

/**
 * Where a declared database lives. `"project"` puts the file in
 * the repository, so agents in the project's terminals can read and write it
 * with the `sqlite3` CLI and it travels with a clone; `"local"` keeps it in
 * this machine's per-plugin data directory, out of the repository.
 */
export type PluginDatabaseLocationKind = "project" | "local";

/** The resolved location of one declared database. */
export interface PluginDatabaseLocation {
  /** The `contributes.databases[].id` this resolves. */
  readonly id: string;
  readonly location: PluginDatabaseLocationKind;
  /** Absolute path of the SQLite file. May not exist until first opened. */
  readonly path: string;
  /** For a `"project"` database, the path relative to the project root. */
  readonly projectRelativePath: string | null;
  readonly journalMode: "delete" | "wal";
  /** The declaration's `schemaVersion`, when it has one. */
  readonly schemaVersion?: number;
}

/** Positional (`?`) or named (`:name`, `$name`, `@name`) statement parameters. */
export type PluginDatabaseParams =
  | ReadonlyArray<string | number | bigint | null | Uint8Array>
  | Readonly<Record<string, string | number | bigint | null | Uint8Array>>;

export interface PluginDatabaseRunResult {
  /** Rows changed by the statement. */
  changes: number;
  /** Rowid of the last inserted row, as a number when it fits in 2^53. */
  lastInsertRowid: number | bigint;
}

/**
 * Why a database's contents may have changed. `"self"` is a commit this
 * handle made; `"external"` is anything else — an agent's `sqlite3` session,
 * another process, or the file being replaced (`git checkout`, a restore).
 */
export interface PluginDatabaseChangeEvent {
  readonly origin: "self" | "external";
}

/** The statement surface shared by a database handle and a transaction. */
export interface PluginDatabaseStatements {
  /** Every row the statement returns, as plain objects keyed by column name. */
  query<T = Record<string, unknown>>(sql: string, params?: PluginDatabaseParams): Promise<T[]>;
  /** The first row, or `undefined`. */
  get<T = Record<string, unknown>>(
    sql: string,
    params?: PluginDatabaseParams
  ): Promise<T | undefined>;
  /**
   * Execute one statement that returns no rows. `query`, `get`, `run` and
   * `columns` each take exactly one statement; SQL after it rejects with
   * `DB_MULTIPLE_STATEMENTS` rather than being silently ignored — use `exec`
   * for a batch.
   */
  run(sql: string, params?: PluginDatabaseParams): Promise<PluginDatabaseRunResult>;
  /** Execute one or more statements with no parameters (schema, pragmas). */
  exec(sql: string): Promise<void>;
  /**
   * The result columns a statement would return, without running it — the
   * headers for a result that may have no rows.
   */
  columns(sql: string): Promise<PluginDatabaseColumn[]>;
}

/** One result column of a statement, from `PluginDatabase.columns`. */
export interface PluginDatabaseColumn {
  /** The name a row object uses for this column (after any `AS` alias). */
  name: string;
  /** Source table, or null for an expression. */
  table: string | null;
  /** Source column, or null for an expression. */
  column: string | null;
  /** Declared type of the source column, or null. */
  type: string | null;
}

export interface PluginDatabaseOpenOptions {
  /**
   * Open for reading only. The host neither creates the file nor its
   * directory (SQLite itself may add `-wal`/`-shm` sidecars when reading a
   * file in WAL mode), raises no write-consent prompt, and refuses `run`, `exec` and
   * `transaction` with `DB_READONLY`; SQLite itself refuses any write a query
   * attempts. `migrations` and `definitions` cannot be combined with it. A
   * missing file rejects with `DB_NOT_FOUND`. The right mode for a dashboard
   * over data that agents write.
   */
  readonly?: boolean;
  /**
   * Ordered schema migrations. Migration `n` (0-based) runs when the file's
   * `PRAGMA user_version` is `n`, inside its own `BEGIN IMMEDIATE`
   * transaction, and bumps `user_version` to `n + 1`. Append new entries;
   * never edit or reorder shipped ones. A file whose `user_version` is higher
   * than `migrations.length` was written by a newer copy of the plugin, and
   * `open` rejects with `DB_SCHEMA_TOO_NEW` rather than guess.
   */
  migrations?: readonly string[];
  /**
   * SQL applied after `migrations`, in one transaction, whenever its text
   * differs from the last applied — views and triggers, which should change
   * without a numbered migration. Must be idempotent
   * (`DROP VIEW IF EXISTS v; CREATE VIEW v AS …`). The applied hash is kept in
   * a host-owned `_daintree_meta` table. A failure rolls back and rejects with
   * `DB_DEFINITIONS_FAILED`.
   */
  definitions?: string;
}

/**
 * An open plugin database. The host sets the connection policy on open —
 * foreign keys enforced, a 5 s busy timeout, and the declared journal mode —
 * and reopens transparently when the file is replaced underneath it, so a
 * long-lived handle never keeps reading an unlinked inode.
 *
 * Calls are serialised per handle: a statement issued while a
 * {@link transaction} is running waits for it.
 */
export interface PluginDatabase extends PluginDatabaseStatements {
  readonly id: string;
  /** Where the file is. Hand `path` to agents; they can use `sqlite3` on it. */
  readonly location: PluginDatabaseLocation;
  /** Whether the handle was opened with `readonly: true`. */
  readonly readonly: boolean;
  /**
   * Run `fn` inside `BEGIN IMMEDIATE` … `COMMIT`, rolling back if it throws.
   * Use the `tx` it is handed — calling the outer handle from inside `fn`
   * waits for the transaction to finish, and so deadlocks.
   */
  transaction<T>(fn: (tx: PluginDatabaseStatements) => Promise<T> | T): Promise<T>;
  /**
   * Fire after the database changes, including commits by other processes —
   * the usual case being an agent writing with the `sqlite3` CLI. Returns a
   * disposer.
   *
   * Coalesced: every change within a 50ms window — this handle's own commits
   * and external ones alike — is delivered as one event at the end of the
   * window, so 200 inserts awaited one after another cost a handful of
   * refetches rather than 200. The last change is always delivered, including
   * one whose window is still open when the handle closes. A window
   * that saw any external change reports `origin: "external"`; one that saw
   * only this handle's commits reports `"self"`.
   */
  onDidChange(callback: (event: PluginDatabaseChangeEvent) => void): () => void;
  /**
   * Write a consistent snapshot of the database to `destPath` using SQLite's
   * online backup, then move it into place atomically. The destination is
   * checked exactly like `host.fs.writeFile`: it must be inside your declared
   * `scopes.fs.allowedPaths` (or your data directory), needs the matching
   * `fs:*-write` capability and first-use consent, and a symlink there is
   * refused. Use it for a "Back up" button, or to hand a sync folder a copy
   * rather than the live file.
   */
  backup(destPath: string): Promise<PluginDatabaseBackupResult>;
  /** Close the connection and stop change detection. Idempotent. */
  close(): Promise<void>;
}

export interface PluginDatabaseBackupResult {
  /** Absolute path the snapshot now stands at. */
  path: string;
  /** Size of the snapshot in bytes. */
  bytes: number;
}

/**
 * Host-managed SQLite for plugins (`host.db`). A database is declared in
 * `contributes.databases` — which is what names the file, discloses it, and
 * decides where it lives — then opened by id. Queries run in the plugin's own
 * process over the runtime's built-in `node:sqlite`; only the location is
 * resolved by the host.
 */
export interface PluginDatabaseApi {
  /**
   * Resolve a declared database's location without opening it. By default
   * this prepares the location for writing (creating the directory, and for a
   * project database asking for write consent the first time); with
   * `readonly: true` it only locates an existing file.
   */
  resolve(id: string, options?: { readonly?: boolean }): Promise<PluginDatabaseLocation>;
  /**
   * Open (creating if needed) a declared database, apply `migrations`, and
   * return a handle. Handles are closed automatically when the plugin unloads.
   */
  open(id: string, options?: PluginDatabaseOpenOptions): Promise<PluginDatabase>;
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
  { action: "install"; url: string } | { action: "open"; pluginId: string };

/**
 * Manifest identity shown in the sideload confirmation dialog (#11280). A
 * narrow projection of {@link PluginManifest} read by `readArchiveManifest`
 * without extracting the archive — `contributes` and the rest of the manifest
 * tree never cross IPC. Arrays are normalized to `[]` so the dialog renders
 * explicit empty states rather than omitting rows.
 */
export interface PluginArchiveManifestPreview {
  name: string;
  displayName?: string;
  version: string;
  /**
   * Resolved on main from the full validated manifest (`resolvePluginCategory`
   * needs `contributes`, which never crosses IPC) so the dialog can render the
   * same category icon tile the catalog uses.
   */
  category: PluginCategoryId;
  authors: PluginAuthor[];
  capabilities: PluginCapability[];
  /**
   * Contributed recipes, disclosed by name because a recipe is executable
   * content that ships with no capability to advertise it (#11860). `names` is
   * the complete (clamped, sanitized) list — bounded by the manifest schema at
   * 50 recipes and 200 characters each, so it can't flood the surface, and the
   * dialog bounds its own viewport rather than the data (#12001). `count` is
   * the same total, kept as the cross-process invariant the dialog's prose
   * reads.
   */
  recipes: { count: number; names: string[] };
  /**
   * Project templates (#13825), by title, each with the project plugins its
   * files include — named by their `.daintree/plugins/<dir>` folder, read from
   * the archive's entry names without parsing or loading anything. A template
   * writes files only after the Create project dialog lists every one, but a
   * project plugin inside it asks for trust when that project first opens, so
   * install is where the user first hears about it.
   */
  projectTemplates: Array<{ title: string; projectPlugins: string[] }>;
}

/**
 * One `.dntr` archive awaiting the user's install decision (#11280). Raised
 * when the OS hands the app a double-clicked archive — macOS `open-file`, or a
 * Windows/Linux argv entry — and delivered to the primary window once it has
 * painted. Carrying the parsed manifest (not just the path) is what makes the
 * confirmation a D2 preview of actual content rather than a filename prompt.
 *
 * `archivePath` is the approval token: the renderer hands it back to
 * `plugin.installFromPath`, which re-runs every trust gate in main.
 */
export interface PluginArchiveInstallIntent {
  intentId: string;
  archivePath: string;
  archiveFileName: string;
  manifest: PluginArchiveManifestPreview;
}

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
      /**
       * SHA-256 of the archive this preview was read from. A confirmed update
       * passes it back as {@link PluginInstallExpectation.archiveHash} so the
       * install refuses any bytes other than the ones the user reviewed (#12612).
       */
      archiveHash: string;
    }
  | { status: "invalid-id" }
  | { status: "fetch-failed"; message: string };

/**
 * One URL-installed plugin found to have an update available by the opt-in
 * background check (#10893). A trimmed projection of the `available` variant of
 * {@link PluginCheckUpdateResult} — enough for the inbox notification copy and
 * the manager's "Update all" queue without re-querying.
 */
export interface PluginBackgroundUpdateEntry {
  pluginId: string;
  displayName: string;
  version: string;
  capabilities: PluginCapability[];
}

/**
 * Result of a background update-check pass across all URL-installed plugins
 * (#10893). Broadcast to renderers (and cached in main for late-subscriber
 * hydration) only when `updates` is non-empty. `signature` is a deterministic
 * digest of the update set so the renderer can dedupe repeated passes that
 * surface the same set into a single inbox row.
 */
export interface PluginBackgroundUpdateCheckResult {
  checkedAt: number;
  updates: PluginBackgroundUpdateEntry[];
  signature: string;
}

/** Opt-in state for the background update check (#10893). OFF by default. */
export interface PluginBackgroundUpdateCheckSettings {
  enabled: boolean;
}

export interface PluginLoadError {
  message: string;
  stack?: string;
  at: number;
}

/**
 * Outcome of an implicit panel-view activation (`plugin:activate-for-view`).
 * Returned as a plain discriminated object — never a thrown `Error` — so the
 * discriminant and message survive the contextBridge crossing intact (#6116:
 * custom `Error` properties are stripped a second time on deserialize). The
 * renderer throws renderer-side from `{ ok: false }` so the real activation
 * cause reaches the view's ErrorBoundary instead of a generic import timeout.
 */
export type PluginActivationResult =
  | {
      ok: true;
      /**
       * A main-minted `plugin://` URL on a fresh view generation, returned only
       * when the caller asked to recover from an import-stage failure (#11728).
       * The renderer imports this instead of the poisoned specifier — a rejected
       * dynamic import is permanent for its URL, so only a specifier V8 has
       * never seen re-evaluates. Absent for PTY/view-less kinds and whenever no
       * recovery was requested.
       */
      recoveryComponentPath?: string;
    }
  | {
      ok: false;
      error: string;
      stack?: string;
      /**
       * The plugin declares `"remote": "unsupported"` and the caller is a
       * window attached from another machine: it was deliberately not started.
       */
      remoteUnsupported?: { pluginId: string };
    };

/**
 * Wire envelope for every push over the `plugin:{pluginId}:{channel}` transport
 * (`host.broadcastToRenderer`, `host.postToPanel`, and the managed-process
 * stream). `panelId` carries the per-instance target: `null` is a broadcast to
 * every subscriber of `(pluginId, channel)`, a non-empty string targets only
 * the panel instance with that id. The preload `plugin.on` / `plugin.onPanel`
 * dispatcher unwraps `payload` before handing it to the subscriber.
 */
export interface PluginPanelEventEnvelope {
  panelId: string | null;
  payload: unknown;
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
 * - `namespace_unauthorized` — reserved `daintree.*` name or publisher/name disagreement
 * - `name_collision` — the id matches a built-in or a launch-reserved plugin name; rejected before the swap so no broken dir is left
 * - `hash_failed` — couldn't compute the archive SHA-256
 * - `archive_mismatch` — the install carried an {@link PluginInstallExpectation} (a
 *   reviewed update) and the archive's digest or `manifest.name` differs from it;
 *   refused before extraction (digest) or before the swap (name), so nothing runs
 *   or is replaced
 * - `instance_mode_changed` — the update switches `instanceMode` between a singleton
 *   and per-project instances; refused before the swap because nothing carries
 *   settings, grants or enablements across, so the user uninstalls first
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
 * - `extraction_timeout` — extraction ran past `PLUGIN_ARCHIVE_TOTAL_DEADLINE_MS` (#11302), distinct
 *   from `archive_invalid`: the archive may be fine and the source merely too slow, so the
 *   actionable advice is "try again", not "check the file"
 */
export type PluginInstallErrorCode =
  | "lock_failed"
  | "archive_invalid"
  | "extraction_timeout"
  | "manifest_invalid"
  | "namespace_unauthorized"
  | "name_collision"
  | "hash_failed"
  | "archive_mismatch"
  | "instance_mode_changed"
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
  /**
   * Correlation id for progress reporting and cancellation (#11302). Minted by
   * the caller that wants feedback; omitting it installs exactly as before, just
   * without progress events or a cancel target. Not persisted.
   */
  jobId?: string;
  /**
   * The archive a user approved from an update preview. When set, the install
   * is refused unless the archive's SHA-256 and `manifest.name` both match it.
   * Transient: checked, never persisted.
   */
  expected?: PluginInstallExpectation;
}

/**
 * Binds a confirmed update to the archive its preview was read from (#12612).
 * The confirm re-downloads the URL, so without this the server could answer the
 * check with one archive and the install with another. Both fields come from the
 * `available` {@link PluginCheckUpdateResult}: `pluginId` is the installed
 * plugin's `manifest.name`, `archiveHash` the reviewed archive's digest.
 */
export interface PluginInstallExpectation {
  pluginId: string;
  archiveHash: string;
}

/**
 * Coarse stage of an in-flight install (#11302). Deliberately a small fixed
 * sequence rather than the agent installer's raw stdout chunks — a plugin
 * install is a known series of steps, not a subprocess emitting text.
 *
 * `downloading` only occurs for install-from-URL. Everything through
 * `validating` is staged in a scratch directory and freely cancellable;
 * `activating` marks the commit point, past which cancellation is refused
 * because the swap and load are already underway.
 */
export type PluginInstallPhase = "downloading" | "extracting" | "validating" | "activating";

/** Progress push for an install started with a {@link PluginInstallOptions.jobId}. */
export interface PluginInstallProgressEvent {
  /** The `jobId` the caller supplied; events for other jobs must be ignored. */
  jobId: string;
  phase: PluginInstallPhase;
  /**
   * The archive entry currently being written, during `extracting` only.
   * Throttled — this is a liveness detail, not a complete log of every entry.
   */
  entry?: string;
  /** False once the install has passed the commit point and can no longer be cancelled. */
  cancellable: boolean;
  /**
   * What is being installed: the archive's file name, or the URL without its
   * query string. Set by main on every event of a job.
   */
  source?: string;
}

export interface LoadedPluginInfo {
  manifest: PluginManifest;
  /**
   * The key this plugin is registered under, which is what every id-taking API
   * (settings, invoke, actions) expects.
   *
   * Equal to `manifest.name` for installed and builtin plugins. For a PROJECT
   * plugin it is the instance key (`project__{projectId}__{name}`), and for an
   * installed package's per-project instance it is
   * `project__{projectId}__installed__{name}`; either way the manifest is left
   * alone — so `manifest.name` alone cannot tell the two
   * apart, and a consumer that filtered on it would treat a project plugin as
   * an installed one.
   *
   * This is also the field renderer-side maps key on. Keying them on
   * `manifest.name` instead is what made every project-plugin lookup miss and
   * fall back to rendering the raw instance key (#12211): a contribution never
   * carries the bare manifest id, so the two never met.
   */
  instanceId: string;
  /** `"project"` for a `.daintree/plugins` contribution, `"global"` otherwise. */
  origin: "global" | "project";
  /** Owning project for a project-owned plugin; `null` when `origin` is `"global"`. */
  projectId: string | null;
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
  /**
   * True when the plugin was refused at load time by the remote blocklist /
   * kill-switch (#10891) — its `manifest.name` matched a blocklist entry whose
   * version range covers `manifest.version`. Distinct from `disabled` (a
   * user-togglable Preferences state) and `loadError` (a technical activation
   * failure): this is a host-decided policy refusal the user cannot toggle off.
   * A blocklisted plugin is never registered in the running set — no `activate`
   * runs and it contributes no panels/actions — but it is still surfaced in the
   * Plugin Manager so the block is visible.
   */
  blocklisted: boolean;
  /**
   * Human-readable explanation for the block (from the matched entry's
   * `message`, falling back to its machine `reason`). `undefined` unless
   * `blocklisted` is true.
   */
  blocklistReason?: string;
  /**
   * Set on the package row of an installed `instanceMode: "project"` package.
   * That row is the catalog entry: it never runs itself (`loadedAt` is 0), and
   * each project that enabled it runs its own instance, listed as a separate
   * `origin: "project"` row under its instance key.
   */
  instanceMode?: "project";
  /** Project ids the package is enabled in. Present exactly when `instanceMode` is. */
  enabledInProjects?: string[];
}

export interface PluginIpcContext {
  projectId: string | null;
  worktreeId: string | null;
  /**
   * Opaque per-caller handle. A view on this machine has its renderer's id
   * (positive); a view on another machine attached to this host has a negative
   * handle that names no local renderer.
   */
  webContentsId: number;
  pluginId: string;
  /**
   * Set when the call reached this host over a link: which attached frontend
   * made it (`"remote"` for a window on another machine). Absent for a window
   * on this machine.
   */
  origin?: PluginInvokeOrigin;
}

/** The frontend behind one {@link PluginIpcContext}. */
export interface PluginInvokeOrigin {
  kind: "local" | "remote";
  /** Stable id of the attached machine; `"local"` for this one. */
  clientId: string;
  /** Stable id of the calling view for as long as it stays attached. */
  endpointId: string;
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
 * Per-channel options for {@link PluginHostApi.registerHandler}.
 */
export interface PluginHandlerOptions {
  /**
   * Deadline, in milliseconds, for one invoke of this channel. When it passes,
   * the renderer's `invoke` rejects with a `PLUGIN_INVOKE_TIMEOUT:` error and a
   * worker-hosted handler's invoke is cancelled. Defaults to five minutes;
   * `0` disables the deadline for handlers that legitimately run longer.
   */
  timeoutMs?: number;
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
  /**
   * A merge the forge was asked to carry out later (auto-merge or merge queue),
   * whoever asked. `null`: the forge reported nothing pending.
   */
  readonly mergeIntent?: import("./forge.js").PRMergeIntent | null;
  /**
   * The PR's head moved while this host watched auto-merge stay armed — a
   * later push the forge may merge unreviewed. Observed this session only.
   */
  readonly headMovedWhileArmed?: boolean;
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
 * A git operation the host saw in progress in a worktree, read from the
 * operation's marker files under the git directory. Only operations that block
 * normal work appear here; a worktree with none reads as `null`.
 */
export type PluginWorktreeGitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

/**
 * How far a worktree's post-create setup has got.
 *
 * - `pending`: the worktree exists and setup has not started
 * - `running`: config copy, submodule init, the setup commands or a plugin
 *   setup step are in flight
 * - `ready`: the recorded run finished without a failure, including a project
 *   with no setup commands. A retry resumes the setup commands, or the plugin
 *   setup steps that did not succeed, so after a retry `ready` speaks for those
 *   alone
 * - `failed` / `timed-out`: a stage failed; {@link PluginWorktreeSetup.stage} says which.
 *   A plugin setup step whose plugin could not run it counts as failed
 * - `needs-approval`: setup or provisioning commands from the repository, or a
 *   plugin setup step, are waiting for the user's approval, so they were
 *   skipped. The checkout exists, but its initialization may be incomplete
 */
export type PluginWorktreeSetupState =
  "pending" | "running" | "ready" | "failed" | "timed-out" | "needs-approval";

/**
 * The stages of worktree setup, in the order they run. `setup-script` covers
 * the project's setup commands and any resource provisioning that follows them.
 * `plugin-steps` covers every plugin's {@link WorktreeSetupStepContribution}.
 */
export type PluginWorktreeSetupStage =
  "copy-config" | "submodules" | "setup-script" | "plugin-steps";

/** The workspace host's record of a worktree's setup run, including a retry. */
export interface PluginWorktreeSetup {
  readonly state: PluginWorktreeSetupState;
  /** The stage running, or the one that failed. `null` once `ready`. */
  readonly stage: PluginWorktreeSetupStage | null;
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
  /**
   * The title the user gave this worktree, shown in place of its issue, PR or
   * branch headline, or `null` when they gave none. Whitespace is collapsed and
   * it is at most 80 characters. A rename or clear is a change to the worktree,
   * so it reaches {@link PluginHostApi.onDidChangeWorktrees} like any other.
   */
  readonly customTitle: string | null;
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
  /** Most recent valid dirty-file modification time or HEAD committer time (milliseconds since epoch) */
  readonly lastActivityTimestamp?: number | null;
  readonly createdAt?: number;
  /**
   * Projection of the worktree's polled git status — which files changed and a
   * per-state tally. Sourced from the host's existing status poll, so a plugin
   * can scan only the changed set without shelling out to `git status`.
   * `null` when the host hasn't computed a status for this worktree yet.
   */
  readonly status: PluginWorktreeStatus | null;
  /**
   * Object id of the commit HEAD points at, from the same status poll as
   * `status`. A new value means HEAD moved since the last poll: a commit from
   * any source, a checkout, a reset or a pull. It is a sample, not a commit
   * log, so a move that returns to the same oid between polls is not seen.
   * Treat it as an opaque string. `null` before the first status poll and on a
   * repository with no commits yet. While a git operation is in progress the
   * host pauses status polling, so this holds its last value.
   */
  readonly headOid: string | null;
  /**
   * The blocking git operation in progress, or `null` when the host saw none.
   * Detection fails open, so `null` is the host's observation, not a promise
   * that git is idle.
   */
  readonly gitOperation: PluginWorktreeGitOperation | null;
  /**
   * Setup progress, or `null` when the workspace host has no record of a setup
   * run for this worktree. The record is held in memory and written when the
   * host creates the worktree or retries its setup, so a worktree made outside
   * Daintree, or one from before the workspace host last started, reads `null`
   * until its setup is retried. `null` means unknown, never ready.
   */
  readonly setup: PluginWorktreeSetup | null;
}

/**
 * Why {@link PluginWorktreesResult} could not name a worktree set (#12174).
 *
 * The argument-less {@link PluginHostApi.getWorktrees} collapses every one of
 * these to `[]`, which a plugin cannot tell apart from a project that genuinely
 * has no worktrees. The reasons are deliberately semantic rather than one
 * literal per internal branch: a plugin can act on "retry later" versus "this
 * project is gone", but nothing it can do differs between a workspace client
 * that is not wired yet and a workspace host that missed its readiness gate.
 * The finer diagnosis stays in Daintree's logs.
 *
 * - `plugin-unloaded` — the plugin unloaded (or was replaced by a same-id
 *   reload) before or during the read; a stale timer sees this
 * - `workspace-unavailable` — the workspace subsystem cannot answer yet: no
 *   client wired, no host serving the resolved window (a project still opening),
 *   or a host that never finished populating
 * - `scope-unresolved` — an unbound host found no focused project view to read
 *   on behalf of (common mid-project-switch)
 * - `project-unavailable` — a bound host's project cannot be resolved: the
 *   binding carries no root, or the project has closed and its workspace-host
 *   entry is gone
 * - `fetch-failed` — a read was attempted against a live host and threw
 */
export type PluginWorktreesUnavailableReason =
  | "plugin-unloaded"
  | "workspace-unavailable"
  | "scope-unresolved"
  | "project-unavailable"
  | "fetch-failed";

/**
 * Availability- and scope-aware outcome of a worktree read (#12174). Returned
 * as plain data (never thrown), like {@link PluginCheckUpdateResult} and
 * {@link PluginActivationResult}, so the structured result survives Electron's
 * structured-clone IPC boundary.
 *
 * This exists because `[]` is overloaded. {@link PluginHostApi.getWorktrees}
 * answers `[]` for an unloaded plugin, an unwired workspace client, an
 * unresolved window scope, a rootless or closed project, a failed read, *and*
 * for a project that really has no worktrees — seven states behind one value.
 * A plugin that treats "no match in the list" as proof its stored worktree is
 * gone will therefore false-positive during a project switch or after a wake.
 *
 * `status: "ok"` is the only authoritative answer, and it names `projectId` so
 * a plugin can also tell *which* project the list describes. That matters on
 * the unbound path: mid-switch the focused view can still be the outgoing
 * project, so a populated list that omits the worktree you are looking for may
 * simply belong to another project rather than confirm a mismatch. Compare
 * `projectId` before concluding anything from the contents.
 *
 * The `unavailable` variant deliberately carries no `projectId`: there is no
 * authoritative answer in that branch, so there is no project the absent
 * worktrees can be said to be absent *from*.
 */
export type PluginWorktreesResult =
  | {
      readonly status: "ok";
      /**
       * The project whose workspace host produced `worktrees`, as the host
       * itself knows it — captured from the entry that served this read, not
       * re-resolved from focus afterwards, so a switch that lands while the
       * read is in flight cannot relabel it.
       */
      readonly projectId: string;
      /** Authoritative for `projectId`. Empty means the project has no worktrees. */
      readonly worktrees: PluginWorktreeSnapshot[];
    }
  | {
      readonly status: "unavailable";
      readonly reason: PluginWorktreesUnavailableReason;
    };

/**
 * Read-only, frozen projection of an agent session's coarse state, exposed to
 * plugins behind the `agent:read` capability. This is an explicit allowlist of
 * fields from the internal `agent:state-changed` event payload; do NOT add
 * fields by spreading — every field must be intentionally exposed so internal
 * shape changes (and internal routing identifiers) don't leak to third-party
 * plugins. Observation only: nothing on this surface can drive, pause, resume,
 * or inject into an agent session.
 *
 * Carries the terminal and workspace a transition came from, so a plugin can
 * say where an agent needs attention and join the event to
 * {@link PluginAgentsApi.list}. Deliberately omits `worktreeId`, `cwd` and the
 * activity-detector internals (`trigger`, `confidence`, `temperature`, …), so
 * the snapshot stays safe to send off the machine.
 */
export interface PluginAgentSnapshot {
  /**
   * Stable id of the agent session, when the host could attribute the
   * transition to one. Absent for runtime-detected-only flows that route by
   * terminal rather than a resolved agent id.
   */
  readonly agentId?: string;
  /**
   * The terminal the transition came from — the same id
   * {@link PluginAgentPane.terminalId} reports and
   * {@link PluginHostApi.sendToAgent} takes. Those two only reach the plugin's
   * own (or the focused) project, so a transition from another workspace has no
   * pane to join. Absent when the host could not attribute the transition to a
   * terminal.
   */
  readonly terminalId?: string;
  /**
   * The workspace (project or scratch) that owns the terminal. Opaque: compare
   * it, don't parse it. A project plugin only ever sees its own project's id.
   * Resolved when the transition arrives; absent when the host could not tell
   * which workspace owned the terminal then, e.g. one already torn down.
   */
  readonly workspaceId?: string;
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
 * How a terminal was started, as {@link PluginTerminalLifecycleEvent.kind}
 * reports it:
 *
 * - `agent` — launched to run an agent CLI.
 * - `plugin` — opened as a plugin-contributed terminal panel.
 * - `shell` — anything else: a plain shell, a dev server, a command launch.
 *
 * Fixed at launch. A shell the user later starts an agent in stays `shell`, and
 * an agent pane whose agent has exited back to its prompt stays `agent`.
 */
export type PluginTerminalKind = "agent" | "shell" | "plugin";

/**
 * Which change a {@link PluginTerminalLifecycleEvent} reports:
 *
 * - `spawned` — the terminal's process started. Repeats for the same
 *   `terminalId` when the terminal is restarted or recovered after a
 *   terminal-host crash, sometimes with no `exited` in between.
 * - `exited` — the terminal's process ended.
 * - `trashed` — the user moved the terminal to the trash, where it can still be
 *   restored.
 * - `restored` — the terminal came back out of the trash. Reopening a project
 *   after a restart starts its terminals afresh and reports `spawned`.
 * - `rate-limit-observed` — the terminal's output showed an agent rate-limit
 *   banner.
 */
export type PluginTerminalLifecycleEventType = PluginTerminalLifecycleEvent["type"];

/** The fields every {@link PluginTerminalLifecycleEvent} carries. */
export interface PluginTerminalLifecycleEventBase {
  /**
   * The terminal's id — the same id {@link PluginAgentPane.terminalId} and
   * {@link PluginAgentSnapshot.terminalId} report. Not a lasting identity: a
   * restarted terminal comes back under the same id.
   */
  readonly terminalId: string;
  /**
   * The workspace (project or scratch) that owns the terminal. Opaque: compare
   * it, don't parse it. A project plugin only ever sees its own project's id.
   * Absent for a terminal that belongs to no workspace.
   */
  readonly workspaceId?: string;
  /** The worktree the terminal is filed under, when it has one. An id only. */
  readonly worktreeId?: string;
  /** How the terminal was started. */
  readonly kind: PluginTerminalKind;
  /**
   * The agent the terminal was launched to run (`claude`, `codex`, …), when it
   * was launched for one. A fact about the launch, not about what is running
   * now: the user can exit the agent and run anything in the same shell. Read
   * {@link PluginActivationApi.onDidChangeAgentState} for what is running.
   */
  readonly agentId?: string;
  /** Unix timestamp in milliseconds when the host observed the change. */
  readonly timestamp: number;
}

/**
 * One change in a terminal's life, as
 * {@link PluginActivationApi.onDidChangeTerminalLifecycle} reports it. Frozen.
 *
 * Metadata only, and an explicit allowlist: no command line, working
 * directory, title, environment or output ever rides on it, so it stays safe to
 * log or send off the machine. Narrow on `type`.
 */
export type PluginTerminalLifecycleEvent =
  | (PluginTerminalLifecycleEventBase & { readonly type: "spawned" })
  | (PluginTerminalLifecycleEventBase & {
      readonly type: "exited";
      /**
       * The terminal process's exit code. For an agent pane this is the shell
       * the agent ran in, not the agent itself, which hands back to that shell.
       */
      readonly exitCode: number;
      /** The signal that ended the process, when one did. Never present on Windows. */
      readonly signal?: number;
    })
  | (PluginTerminalLifecycleEventBase & { readonly type: "trashed" })
  | (PluginTerminalLifecycleEventBase & { readonly type: "restored" })
  | (PluginTerminalLifecycleEventBase & {
      readonly type: "rate-limit-observed";
      /**
       * When the banner was seen. An observation that an agent hit a limit, not
       * a reading of how close the account is to one.
       */
      readonly observedAt: number;
    });

/**
 * Why an agent pane will not take a drafted handoff right now. Codes, not copy:
 * the wording belongs to whatever surface shows it.
 *
 * - `unknown-terminal` — no pane with that id in this project.
 * - `not-agent` — the pane is not an agent with an input bar (a plain shell, a
 *   demoted agent, an agent Daintree has no input bar for).
 * - `exited` — the agent's process has ended.
 * - `input-bar-off` — the user has the input bar switched off, so there is no
 *   visible draft to put anything in.
 * - `backend-unavailable` — the terminal service is disconnected or recovering.
 * - `input-locked` — the pane's input is locked.
 * - `restarting` — the pane is restarting.
 * - `input-busy` — the draft is about to be submitted by dictation, which would
 *   send the handoff with it.
 * - `not-in-grid` — the pane is docked or in the background, where its input bar
 *   is not on screen.
 * - `fleet-armed` — a fleet broadcast is armed, so Enter in that draft would go
 *   to every armed agent.
 * - `project-unavailable` — the plugin's project has no open view, or it did not
 *   answer in time.
 * - `launch-failed` — the user chose to start a new agent and it did not start,
 *   or the new worktree's setup failed, needs approval or is still running.
 * - `prompt-open` — another picker from this plugin is already open.
 * - `busy` — too many targeted sends from this plugin are already in flight.
 */
export type PluginSendToAgentRefusalReason =
  | "unknown-terminal"
  | "not-agent"
  | "exited"
  | "input-bar-off"
  | "backend-unavailable"
  | "input-locked"
  | "restarting"
  | "input-busy"
  | "not-in-grid"
  | "fleet-armed"
  | "project-unavailable"
  | "launch-failed"
  | "prompt-open"
  | "busy";

/**
 * One agent pane in the plugin's project, as {@link PluginAgentsApi.list}
 * reports it.
 *
 * `observedState` is what the host last read off the agent's own terminal
 * output — a heuristic that is often wrong, never a guarantee the agent is
 * doing (or done doing) anything. Show it as "last seen working", not as fact.
 */
export interface PluginAgentPane {
  /** The pane's id — what {@link PluginHostApi.sendToAgent} takes as `terminalId`. */
  readonly terminalId: string;
  /** The pane's title as the user sees it, e.g. `Claude: fix auth tests`. */
  readonly title: string;
  /** The agent running in it (`claude`, `codex`, …). */
  readonly agentId: string;
  /** The worktree the pane belongs to, or `null` when it has none. */
  readonly worktree: {
    readonly id: string;
    readonly name: string;
    readonly branch?: string;
  } | null;
  /** Last observed agent state, when there is one. An observation, not a fact. */
  readonly observedState?: AgentState;
  /** Whether this is the pane the user has selected. */
  readonly isFocused: boolean;
  /** Whether {@link PluginHostApi.sendToAgent} would draft into it right now. */
  readonly canDraft: boolean;
  /** Why it would not, when `canDraft` is `false`. */
  readonly draftRefusal?: PluginSendToAgentRefusalReason;
}

/**
 * One agent run anywhere in the app, as {@link PluginAgentsApi.listAll}
 * reports it — any open project or scratch, including ones whose view is not
 * loaded.
 *
 * `observedState` is what the host last read off the agent's own terminal
 * output — a heuristic that is often wrong, never a guarantee the agent is
 * doing (or done doing) anything. Show it as "last seen working", not as fact.
 */
export interface PluginAgentRun {
  /** The project or scratch the run belongs to. */
  readonly workspaceId: string;
  /** Whether {@link workspaceId} names a project or a scratch workspace. */
  readonly workspaceKind: "project" | "scratch";
  /**
   * The run's terminal id. Not a lasting identity: a restarted pane can come
   * back under the same id.
   */
  readonly terminalId: string;
  /** The worktree the run belongs to, when it has one. An id only — no name or branch. */
  readonly worktreeId?: string;
  /** The pane's own title, when it has one. Not the composed title the pane header shows. */
  readonly title?: string;
  /** The agent detected in the run (`claude`, `codex`, …), once detection has committed. */
  readonly agentId?: string;
  /** Last observed agent state, when there is one. An observation, not a fact. */
  readonly observedState?: AgentState;
}

/**
 * Every agent run across every open project and scratch, as
 * {@link PluginAgentsApi.listAll} and
 * {@link PluginActivationApi.onDidChangeAllAgents} report it.
 *
 * An empty `agents` list only means "no agents" when `degraded` is `false`.
 */
export interface PluginAllAgentsSnapshot {
  readonly agents: readonly PluginAgentRun[];
  /**
   * The host could not read every terminal behind this answer, so `agents` is
   * the last complete view rather than the current one — show it as stale,
   * never as clear. Also `true`, with `agents` empty and `lastSuccessfulAt`
   * `null`, before the host has read the fleet even once.
   */
  readonly degraded: boolean;
  /**
   * When a complete read last succeeded (epoch ms), or `null` if none has. Only
   * updated when the answer changes, so it is not a heartbeat.
   */
  readonly lastSuccessfulAt: number | null;
}

/**
 * The kind of surface that has focus, as
 * {@link PluginActivationApi.onDidChangeFocusedPanel} reports it. A built-in
 * panel kind passes through as-is; every plugin-contributed panel, this
 * plugin's own included, is `"plugin"`; `"portal"` is the Portal (web chat)
 * dock.
 */
export type PluginFocusedPanelKind =
  // `BuiltInPanelKind`, spelled out so the SDK bundle never pulls the panel
  // registry and its theme imports; pinned to it by a type test.
  | "terminal"
  | "browser"
  | "dev-preview"
  | "review"
  | "file"
  | "file-browser"
  | "diff"
  | "plugin"
  | "portal";

/**
 * Which kind of panel the user is working in. Carries the kind and the
 * worktree only — never a panel's id, title, URL, cwd or content.
 */
export interface PluginFocusedPanel {
  /**
   * The focused kind, or `null` when Daintree has no focused panel: its window
   * is not the OS foreground window, or focus is on something that is not a
   * panel (the sidebar, an app dialog, the assistant).
   */
  readonly kind: PluginFocusedPanelKind | null;
  /** The focused panel is a terminal currently running an agent. */
  readonly agent: boolean;
  /** The focused panel's worktree, when it belongs to one. Always `null` for `"portal"`. */
  readonly worktreeId: string | null;
}

/**
 * Where a project is, as {@link PluginActivationApi.onDidChangeProjectPresence}
 * reports it: `"foreground"` while it is the project some window shows (or a
 * remote Shell shows from this machine), `"background"` while it is open but
 * no window shows it, and `"closed"` once it is closed, removed or put to
 * sleep. A project whose renderer was reclaimed under memory pressure is still
 * open, and reads as `"background"`.
 */
export type PluginProjectPresenceState = "foreground" | "background" | "closed";

/** One project's presence. Carries the project id and the state only. */
export interface PluginProjectPresence {
  readonly projectId: string;
  readonly state: PluginProjectPresenceState;
}

/** Every {@link PluginEventRouteEvent}, in the order the docs list them. */
export const PLUGIN_EVENT_ROUTE_EVENTS = [
  "agentWaiting",
  "worktreeAdded",
  "worktreeRemoved",
  "projectForeground",
] as const;

/**
 * The events a manifest {@link PluginEventRoute} can wake a plugin on (#13816).
 * Closed: each is the edge of an existing subscription, and the wake carries
 * that subscription's payload.
 *
 * - `agentWaiting` — an agent session moved into `waiting`, as
 *   {@link PluginActivationApi.onDidChangeAgentState} reports it. Needs
 *   `agent:read`.
 * - `worktreeAdded` / `worktreeRemoved` — the worktree set
 *   {@link PluginActivationApi.onDidChangeWorktrees} reports gained or lost a
 *   worktree.
 * - `projectForeground` — a project became `"foreground"`, as
 *   {@link PluginActivationApi.onDidChangeProjectPresence} reports it.
 */
export type PluginEventRouteEvent = (typeof PLUGIN_EVENT_ROUTE_EVENTS)[number];

/**
 * One manifest `eventRoutes` entry: when `event` happens, the host activates
 * the plugin if it is not running and runs `command` with a
 * {@link PluginEventRouteWake}. Unlike a live subscription, a route holds no
 * worker open, so a plugin that only reacts through routes can still be
 * disposed while idle.
 */
export interface PluginEventRoute {
  readonly event: PluginEventRouteEvent;
  /** Bare id of one of this plugin's own `contributes.commands` entries. */
  readonly command: string;
}

/**
 * The single argument a routed command receives. Each variant carries exactly
 * what the matching subscription delivers, so a handler can share code with a
 * live listener.
 *
 * Wakes are best effort: a burst coalesces to the latest value per terminal,
 * project or worktree set, a plugin is woken at most about once a second, and
 * nothing is delivered while its worker has failed. A transition that reverses
 * before the wake runs (an agent that stopped waiting, a project sent back)
 * cancels it. Nothing is replayed when the plugin loads.
 */
export type PluginEventRouteWake =
  | { readonly event: "agentWaiting"; readonly agent: PluginAgentSnapshot }
  | {
      readonly event: "worktreeAdded" | "worktreeRemoved";
      /** The worktree set after the change, as `onDidChangeWorktrees` lists it. */
      readonly worktrees: readonly PluginWorktreeSnapshot[];
      /**
       * What changed: one read's difference from the read before it, or, when
       * the wake waited its turn, the net of every read since it was due.
       */
      readonly change: PluginWorktreesChange;
    }
  | { readonly event: "projectForeground"; readonly presence: PluginProjectPresence };

/**
 * What {@link PluginAgentsApi.sendKeys} presses: up to 16 named keys (`Up`,
 * `Down`, `Left`, `Right`, `Enter`, `Escape`, `Tab`, `Space`, `Backspace`, or
 * one lowercase letter or digit), or the option whose label the agent's screen
 * shows — the host moves to it and presses Enter. Prefer `choose` for a
 * dialog's options.
 */
export type PluginAgentKeysInput =
  | { readonly keys: readonly string[]; readonly choose?: never }
  | { readonly choose: string; readonly keys?: never };

/**
 * What an input call on an agent this plugin launched did.
 *
 * - `sent`: the input was written. Delivery is not acknowledged and the effect
 *   is not observed; read the screen or watch the agent's state for that.
 * - `refused`: nothing was written, and `reason` says why — an interrupt to an
 *   idle agent, a label the screen doesn't show, a trashed pane. Not worth
 *   retrying unchanged.
 * - `not-found`: no running agent this plugin launched has that id. One answer
 *   for an unknown id, an agent the user, an MCP client or another plugin
 *   started, and one outside a project plugin's own project.
 * - `unavailable`: the terminal host did not answer, or the plugin is
 *   unloaded. Worth retrying later.
 */
export type PluginAgentInputResult =
  | { readonly status: "sent" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/**
 * What {@link PluginAgentsApi.interrupt} did. `cancelKey` is `advertised` when
 * the agent's CLI shows the cancel key it was sent, and `unverified` when it is
 * that agent's known convention but not one its screen confirms.
 */
export type PluginAgentInterruptResult =
  | { readonly status: "sent"; readonly cancelKey: "advertised" | "unverified" }
  | Exclude<PluginAgentInputResult, { readonly status: "sent" }>;

/** What {@link PluginAgentsApi.sendKeys} did; `keys` are the keys pressed, in order. */
export type PluginAgentKeysResult =
  | { readonly status: "sent"; readonly keys: readonly string[] }
  | Exclude<PluginAgentInputResult, { readonly status: "sent" }>;

/** `host.agents` — the agent panes in the plugin's project. */
export interface PluginAgentsApi {
  /**
   * The live agent panes in this plugin's project, grouped by nothing and in
   * the order the grid holds them. A project plugin sees only its own
   * project's agents; an installed plugin sees the project the user is looking
   * at. Exited and demoted agents are left out. Gated on `agent:read`.
   *
   * Resolves `[]` when the project has no open view or once the plugin is
   * unloaded.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare `agent:read`.
   */
  list(): Promise<PluginAgentPane[]>;
  /**
   * Every agent run across every open project and scratch, answered by the
   * host's main process — so projects whose view is not loaded are included.
   * Exited and demoted agents are left out. Gated on `agent:read`, and only
   * for installed and built-in plugins: a project plugin is scoped to its own
   * project and is refused.
   *
   * Resolves an empty, `degraded` snapshot before the host has read the fleet
   * once and after the plugin is unloaded. Subscribe with
   * {@link PluginActivationApi.onDidChangeAllAgents} before the first call so
   * no change between the two is missed.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare
   *   `agent:read`, or is a project plugin.
   */
  listAll(): Promise<PluginAllAgentsSnapshot>;
  /**
   * Stop the turn an agent this plugin launched is running, keeping its pane
   * and conversation. Sends the agent's cancel keystrokes, not text. An idle
   * agent, or one whose CLI binds a different cancel key, is refused rather
   * than reported stopped.
   *
   * Only agents this plugin started with its own `host.dispatch("agent.launch")`
   * are reachable, for as long as the plugin stays loaded — an agent the user,
   * an MCP client or another plugin started answers `not-found`, and so does
   * one outside a project plugin's own project. A launch that passes its own
   * `requestedId` is not counted: the launcher must choose the id. The three
   * input methods are gated on `agent:input` with the same first-use consent
   * prompt as {@link PluginHostApi.sendToActiveAgent}; a call that would answer
   * `not-found` never raises it. Answered by the host's main process, so an
   * agent in a project whose view is not loaded is reached too. In a plugin
   * worker, a call still in flight when the worker stops rejects, since the
   * input may already have been written.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare
   *   `agent:input`, or the user denies the consent prompt.
   * @throws {Error} `DRIVEN_ELSEWHERE:` when the call came from a view that
   *   doesn't drive the agent's project.
   * @throws {Error} If `terminalId` is not a non-empty string of at most 512
   *   characters.
   */
  interrupt(terminalId: string): Promise<PluginAgentInterruptResult>;
  /**
   * Press keys in an agent this plugin launched — most often to answer its
   * CLI's own dialog (a trust or permission prompt, a list). Keys go one at a
   * time, spaced out so a TUI reads each on its own. Reach, capability and
   * consent are as for {@link interrupt}.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` / `DRIVEN_ELSEWHERE:` as for
   *   {@link interrupt}.
   * @throws {Error} If `input` does not hold exactly one of `keys` (1 to 16
   *   names) or `choose` (1 to 200 characters).
   */
  sendKeys(terminalId: string, input: PluginAgentKeysInput): Promise<PluginAgentKeysResult>;
  /**
   * Submit `text` to an agent this plugin launched, as one submission with one
   * Enter: the agent takes it as its next prompt, or a slash command such as
   * `/compact`. Resolves once it is queued, not once the agent reads it. Reach,
   * capability and consent are as for {@link interrupt}.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` / `DRIVEN_ELSEWHERE:` as for
   *   {@link interrupt}.
   * @throws {Error} If `text` is blank.
   */
  submit(terminalId: string, text: string): Promise<PluginAgentInputResult>;
}

/** Options for {@link PluginTerminalsApi.readScreen}. */
export interface PluginTerminalReadScreenOptions {
  /**
   * How many of the screen's last lines to return: an integer from 1 to 100.
   * Defaults to 20. Fewer come back when the screen holds fewer. A line the
   * terminal soft-wrapped across rows counts once.
   */
  lines?: number;
}

/**
 * What {@link PluginTerminalsApi.readScreen} found.
 *
 * - `ok`: the terminal's current screen, as plain text with no ANSI. `text` is
 *   `""` (and `lineCount` `0`) when the screen is blank — an empty screen, not a
 *   missing terminal. `truncated` is `true` when lines above the returned ones,
 *   or bytes past the 16 KiB cap, were left out; the newest content is kept.
 * - `exited`: the terminal is still listed but its process has exited.
 * - `not-found`: no terminal this plugin may read has that id. One answer for
 *   an unknown id, one in another project, and one that is not a user terminal.
 * - `unavailable`: the terminal exists but its screen could not be read right
 *   now (the terminal host is down or did not answer). Worth retrying later.
 */
export type PluginTerminalScreenResult =
  | {
      readonly status: "ok";
      readonly text: string;
      readonly lineCount: number;
      readonly truncated: boolean;
    }
  | { readonly status: "exited" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/** `host.terminals` — read-only access to what terminals show. */
export interface PluginTerminalsApi {
  /**
   * Read the current screen of one terminal as plain text: its last
   * `options.lines` non-padding lines, never its scrollback. Answered by the
   * terminal host, so it works for terminals in projects whose view is not
   * open. Take ids from {@link PluginAgentsApi.list}, or, for an installed
   * plugin, {@link PluginAgentsApi.listAll}. A project plugin reads only its own
   * project's terminals; an installed plugin may read any user terminal by id.
   *
   * Gated on `terminal:read`, with a first-use consent prompt that tells the
   * user the plugin can read what their terminals show. Rate limited to 60
   * calls per second per plugin — enough for a grid polling a few dozen cards
   * once a second. Never touches the terminal's input or size. The host neither
   * logs nor stores the text; once returned, it is the plugin's to protect.
   *
   * Resolves `{ status: "unavailable" }` once the plugin is unloaded.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare
   *   `terminal:read`, or the user denies the consent prompt.
   * @throws {Error} `RATE_LIMITED:` when the plugin exceeds 60 calls a second.
   *   Nothing is queued; call again later.
   * @throws {Error} If `terminalId` is not a non-empty string or `options.lines`
   *   is not an integer from 1 to 100.
   */
  readScreen(
    terminalId: string,
    options?: PluginTerminalReadScreenOptions
  ): Promise<PluginTerminalScreenResult>;
}

/** Options for {@link PluginHostApi.sendToAgent}. */
export interface PluginSendToAgentOptions {
  /**
   * Draft straight into this pane (an id from {@link PluginAgentsApi.list}),
   * with no picker. Omit to let the user choose.
   */
  terminalId?: string;
  /**
   * The worktree the call is about — typically `PanelViewProps.worktreeId`.
   * Only steers the picker: an agent there is preselected, and "New agent here"
   * starts one there.
   */
  worktreeId?: string;
  /** Heading shown above the text in the draft, e.g. a card title. At most 120 characters. */
  title?: string;
}

/**
 * How a {@link PluginHostApi.sendToAgent} call ended. `drafted` means the text
 * is in that agent's draft and nothing was submitted. A `launch-failed` refusal
 * that got as far as creating a worktree names it in `worktreeId`, so the
 * plugin can tell the user where it is.
 */
export type PluginSendToAgentResult =
  | { status: "drafted"; terminalId: string }
  | { status: "cancelled" }
  | { status: "refused"; reason: PluginSendToAgentRefusalReason; worktreeId?: string };

/** Options for {@link PluginHostApi.runRecipe}. */
export interface PluginRunRecipeOptions {
  /**
   * Values for the recipe's declared `variables`, filling `{{plugin.<name>}}`
   * in its prompts. A name the recipe doesn't declare is an error; a declared
   * one left out is empty.
   */
  variables?: Record<string, string>;
  /** The worktree to run it in. Omit for the active one. */
  worktreeId?: string;
}

/**
 * Why a {@link PluginHostApi.runRecipe} call ran nothing:
 *
 * - `unknown-worktree` — `options.worktreeId` is not a worktree of the plugin's project.
 * - `recipe-unavailable` — the recipe isn't offered in the project's window,
 *   for example because the plugin is hidden there.
 * - `agent-tools-off` — the recipe declares `requiresAgentTools` and this
 *   plugin's agent tools are off in the project. The dialog said so.
 * - `project-unavailable` — the plugin's project has no open view, or it did not answer.
 * - `prompt-open` — another dialog from this plugin is already open.
 * - `launch-failed` — the user ran it and nothing started.
 */
export type PluginRunRecipeRefusalReason =
  | "unknown-worktree"
  | "recipe-unavailable"
  | "agent-tools-off"
  | "project-unavailable"
  | "prompt-open"
  | "launch-failed";

/**
 * How a {@link PluginHostApi.runRecipe} call ended. `ran` means the user
 * confirmed and at least one step started; `failedCount` is the steps that
 * didn't.
 */
export type PluginRunRecipeResult =
  | { status: "ran"; spawnedCount: number; failedCount: number }
  | { status: "cancelled" }
  | { status: "refused"; reason: PluginRunRecipeRefusalReason };

/**
 * Options for {@link PluginHostApi.showToast}. Intentionally narrower than the
 * app's internal `notify()` surface: plugins cannot set `priority` (a
 * `priority:"low"` + `type:"error"` toast silently drops — see the lint rule at
 * `eslint.config.js`), pass a `ReactNode` message, or attach an action button
 * (plugins have no IPC channel to wire one to). `message` is prefixed with the
 * plugin's manifest `displayName` (or `name` when it has none) by the host for
 * provenance: `{displayName}: {message}`.
 */
export interface PluginToastOptions {
  /** Toast body. String only across the IPC boundary — no `ReactNode`. */
  message: string;
  /** Maps directly to the app's `NotificationType`. Defaults to `"info"`. */
  type?: NotificationType;
  /** Auto-dismiss delay in milliseconds. Defaults to the app's per-type default. */
  durationMs?: number;
}

/** Most buttons one {@link PluginHostApi.notify} call may carry. */
export const PLUGIN_NOTIFY_MAX_ACTIONS = 2;

/** A button on a {@link PluginHostApi.notify} notification. */
export interface PluginNotifyAction {
  /** Unique within the notification. */
  id: string;
  /** Button text on the toast and inbox row. */
  label: string;
  /**
   * One of the caller's own actions, written `"{manifest name}.{id}"` as in
   * `contributes.menu`. The host runs it in the plugin's instance namespace.
   */
  actionId: ActionId;
  /** Passed to the action, validated against its `argsSchema` at dispatch. */
  args?: Record<string, unknown>;
}

/**
 * Where a {@link PluginHostApi.notify} notification leads: one of the plugin's
 * own panels (an id from {@link PluginHostApi.onDidChangePanelLifecycle}) or a
 * worktree the plugin can see. The inbox row's Go to source opens it.
 */
export type PluginNotifyTarget = { panelId: string } | { worktreeId: string };

/** Options for {@link PluginHostApi.notify}. */
export interface PluginNotifyOptions {
  title: string;
  body: string;
  /**
   * How serious it is. Defaults to `"info"`. An `"error"` needs exactly one
   * action, the way out of it, and can't be passive.
   */
  severity?: "info" | "warning" | "error";
  /**
   * `"active"` (the default) shows a toast when the window has focus and keeps
   * an inbox row either way. `"passive"` goes to the inbox only: no toast and
   * no OS banner, so it can't be combined with `os`.
   */
  delivery?: "active" | "passive";
  /**
   * What the notification is about. A panel must be one of this plugin's own
   * and a worktree one it can see; anything else rejects. A target the host
   * can't check yet (a panel no window has reported) is dropped and the
   * notification still goes out.
   */
  target?: PluginNotifyTarget;
  /** At most {@link PLUGIN_NOTIFY_MAX_ACTIONS}. */
  actions?: PluginNotifyAction[];
  /**
   * Also page the operating system. A request, never a bypass: the host drops
   * the banner when the user hasn't turned it on, during quiet hours or a
   * session mute, while the user is looking at the plugin's project, and when
   * the plugin pages faster than the host allows. Needs the `notification:os`
   * capability, and an active notification.
   */
  os?: boolean;
  /**
   * A later notification with the same key replaces this one — its toast, its
   * inbox row and its OS banner — instead of stacking beside it.
   */
  dedupeKey?: string;
}

/** What {@link PluginHostApi.notify} resolves with. */
export interface PluginNotifyResult {
  /** A fresh id per call; it doesn't say which surfaces showed it. */
  id: string;
}

/** Most unfinished tasks one plugin may hold at once through {@link PluginHostApi.tasks}. */
export const PLUGIN_TASK_MAX_LIVE = 16;

/** Most interrupted tasks the host keeps per plugin until the user dismisses them. */
export const PLUGIN_TASK_MAX_INTERRUPTED = 16;

/** Max length of a task's `title`, enforced host-side. */
export const PLUGIN_TASK_TITLE_MAX = 120;

/** Max length of a task's `detail`, enforced host-side. */
export const PLUGIN_TASK_DETAIL_MAX = 200;

/** Max length of a finished task's `message`, enforced host-side. */
export const PLUGIN_TASK_MESSAGE_MAX = 2000;

/** Serialized size cap for a task's `retry.args`, the same as a notification action's. */
export const PLUGIN_TASK_RETRY_ARGS_MAX_BYTES = 4096;

/**
 * Window a task's progress reports are coalesced over before they cross a
 * process boundary: the worker's port to main, and main's push to the views.
 * The latest report in the window wins.
 */
export const PLUGIN_TASK_PROGRESS_COALESCE_MS = 150;

/** Options for {@link PluginTaskApi.start}. */
export interface PluginTaskStartOptions {
  /** What the task is doing, in a few words ("Importing records"). */
  title: string;
  /** A second line under the title ("312 of 1,000"). */
  detail?: string;
  /** Whether the user may cancel it. Defaults to `false`. */
  cancellable?: boolean;
  /**
   * Progress from 0 to 1, or `null` (the default) while it can't be measured.
   */
  fraction?: number | null;
  /**
   * One of the plugin's own actions that runs the work again, written
   * `"{manifest name}.{id}"` as in `contributes.menu`. A failed task's
   * notification offers it as Retry.
   */
  retry: { actionId: ActionId; args?: Record<string, unknown> };
}

/** A progress update for {@link PluginTaskHandle.report}. Omitted fields keep their last value. */
export interface PluginTaskProgress {
  /** Progress from 0 to 1, or `null` while it can't be measured. */
  fraction?: number | null;
  /** Replaces the detail line; `""` clears it. */
  detail?: string;
}

/**
 * How a task ended, for {@link PluginTaskHandle.finish}. A failure's `message`
 * says what went wrong and becomes the notification body. A success's
 * optional `message` files a passive inbox entry; without one, nothing is
 * shown.
 */
export type PluginTaskResult =
  | { outcome: "succeeded"; message?: string }
  | { outcome: "failed"; message: string }
  | { outcome: "cancelled" };

/**
 * Why a task's signal aborted, carried as `signal.reason.cause`: the user's
 * Cancel, or the host interrupting the task because the plugin is unloading,
 * restarting or crashed.
 */
export type PluginTaskAbortCause = "cancelled" | "interrupted";

/** A running task started with {@link PluginTaskApi.start}. */
export interface PluginTaskHandle {
  /** Host-assigned, unique for the session. */
  readonly id: string;
  /**
   * Aborts when the user cancels the task or the host interrupts it (the
   * plugin unloading). The plugin still calls {@link finish} with
   * `"cancelled"` once it has stopped.
   *
   * `signal.reason` is an `AbortError` whose `cause` says which:
   * {@link PluginTaskAbortCause}. Work that outlives the plugin — a durable
   * operation — records a user's cancel, but treats an interruption as the
   * plugin stopping, to be resumed when it runs again.
   */
  readonly signal: AbortSignal;
  /**
   * Update the task's progress. Reports are coalesced before they cross IPC,
   * so calling this on every item is fine. Invalid progress throws; a report
   * after the task finished is ignored.
   */
  report(progress: PluginTaskProgress): void;
  /**
   * End the task. Only the first call counts. Invalid results reject.
   */
  finish(result: PluginTaskResult): Promise<void>;
}

/**
 * Long-running work the host shows in its own place for background work
 * (#13819), with Cancel where the task allows it. A failed task raises an
 * error notification naming the plugin, with Retry. A successful one shows at
 * most a passive inbox entry, and a cancelled one nothing. Tasks still
 * running when the plugin unloads are marked interrupted.
 */
export interface PluginTaskApi {
  /**
   * Start a task. Rejects on invalid options, a `retry` outside the plugin's
   * own namespace, or more than {@link PLUGIN_TASK_MAX_LIVE} unfinished tasks.
   * Once the plugin is unloaded it resolves with a handle whose signal is
   * already aborted and whose methods do nothing.
   */
  start(options: PluginTaskStartOptions): Promise<PluginTaskHandle>;
}

/** Where a plugin task stands, as the host shows it. */
export type PluginTaskState = "working" | "cancelling" | "interrupted";

/**
 * A plugin task as main holds and sends it to the views. Never authored by a
 * plugin. The plugin's name is captured at start, so an interrupted task
 * still names its plugin after the plugin has gone.
 */
export interface PluginTaskSnapshot {
  id: string;
  pluginId: string;
  pluginName: string;
  title: string;
  detail?: string;
  /** 0 to 1, or `null` when the plugin can't measure it. */
  fraction: number | null;
  cancellable: boolean;
  state: PluginTaskState;
  startedAt: number;
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
 * Execution backend for a managed process (#11300, #11871).
 *
 * - `pipe` (the default): a plain child process with stdin closed and
 *   stdout/stderr piped. Output arrives split by stream.
 * - `duplex`: as `pipe`, but stdin is piped too, so the child can be driven via
 *   {@link PluginDuplexProcessHandle.write}. stdout and stderr stay separate.
 *   This is the mode for a child speaking a protocol over stdio — MCP, LSP and
 *   ACP servers all carry JSON-RPC on stdout while using stderr for
 *   diagnostics, so they need a writable input AND an output stream the
 *   diagnostics are not mixed into. The host stays framing-agnostic: MCP and
 *   ACP delimit messages with newlines, LSP with `Content-Length` headers, and
 *   the plugin implements whichever its child speaks.
 * - `pty`: the command runs under a real pseudo-terminal, so it sees a TTY,
 *   accepts input via {@link PluginPtyProcessHandle.write}, and can be resized.
 *   A PTY merges stdout and stderr into one stream by construction.
 */
export type PluginProcessMode = "pipe" | "duplex" | "pty";

/**
 * One chunk of output from a managed process, delivered to
 * {@link PluginProcessHandle.onData}.
 */
export interface PluginProcessDataChunk {
  /**
   * `stdout` / `stderr` in pipe and duplex mode — both keep the child's two
   * output streams apart. `data` in PTY mode only: a pseudo-terminal has a
   * single combined stream, so there is no split to report.
   */
  readonly stream: "stdout" | "stderr" | "data";
  /** The decoded UTF-8 chunk. */
  readonly chunk: string;
}

/**
 * Options for {@link PluginProcessApi.spawn} in the default pipe mode. All
 * fields are optional; `command` is the positional first argument. The host
 * anchors a relative spawn against `cwd` (defaulting to the active worktree
 * path, then the process cwd).
 *
 * The child does NOT inherit the host environment. It is built from a fixed
 * allowlist of essentials (PATH, HOME, locale, temp dir, and the Windows keys a
 * child cannot run without) plus whatever this call passes in {@link env} — so
 * a plugin never receives the main process's tokens, and anything else the
 * command needs must be handed to it explicitly.
 */
export interface PluginProcessSpawnOptions {
  /** Argument vector. Each entry is passed verbatim — no shell interpolation. */
  args?: string[];
  /** Working directory for the child. Defaults to the active worktree, then the host cwd. */
  cwd?: string;
  /**
   * Environment entries applied over the host's safe-key allowlist. These are
   * additions to a minimal base, NOT overrides on the full host environment —
   * a key the plugin does not pass and the allowlist does not cover is absent.
   */
  env?: Record<string, string>;
  /**
   * Execution backend. Omit (or pass `"pipe"`) for the default piped child.
   * Pass `"duplex"` ({@link PluginDuplexProcessSpawnOptions}) to also get a
   * writable stdin, or `"pty"` ({@link PluginPtyProcessSpawnOptions}) for a
   * pseudo-terminal.
   */
  mode?: "pipe";
  /**
   * Route this process's stream events to a single panel instead of every panel
   * the plugin owns. `undefined` / `null` broadcast, matching `postToPanel`.
   */
  panelId?: string | null;
}

/**
 * Options for a stdio-driven {@link PluginProcessApi.spawn}. Same anchoring and
 * environment rules as {@link PluginProcessSpawnOptions} — the only difference
 * is that stdin is piped rather than closed. Selecting `mode: "duplex"` narrows
 * the returned handle to {@link PluginDuplexProcessHandle}.
 */
export interface PluginDuplexProcessSpawnOptions extends Omit<PluginProcessSpawnOptions, "mode"> {
  mode: "duplex";
}

/**
 * Options for an interactive {@link PluginProcessApi.spawn}. Same anchoring and
 * environment rules as {@link PluginProcessSpawnOptions}, plus the initial
 * terminal size. Selecting `mode: "pty"` narrows the returned handle to
 * {@link PluginPtyProcessHandle}.
 */
export interface PluginPtyProcessSpawnOptions extends Omit<PluginProcessSpawnOptions, "mode"> {
  mode: "pty";
  /** Initial column count. Defaults to 80. Must be a positive integer. */
  cols?: number;
  /** Initial row count. Defaults to 24. Must be a positive integer. */
  rows?: number;
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
  /**
   * Receive the process's output in the plugin's own code (#11300) — the
   * counterpart to the panel stream, for a plugin that needs to parse what it
   * spawned (a `--machine`-mode daemon's line-delimited JSON, say) rather than
   * just display it. Returns a disposer.
   *
   * Output produced before the first subscriber attaches is buffered (bounded)
   * and replayed on subscription, so a daemon that greets immediately is not
   * missed by a callback registered on the next tick. Once any subscriber has
   * attached, delivery is live-only. Panel streaming is unaffected either way.
   */
  onData(callback: (chunk: PluginProcessDataChunk) => void): () => void;
}

/**
 * A {@link PluginProcessHandle} for a process whose input the plugin can drive
 * — spawned with `mode: "duplex"` (stdin piped, stdout/stderr still separate)
 * or `mode: "pty"` (a pseudo-terminal, which also brings `resize`).
 *
 * `write()` is fire-and-forget and never throws: it is a no-op once the process
 * has exited or its input has closed, mirroring `kill()`. It is safe to call
 * immediately after `spawn()` resolves.
 */
export interface PluginDuplexProcessHandle extends PluginProcessHandle {
  /**
   * Write to the child's input. Passed through verbatim — the host adds no
   * framing, so the caller emits whatever its protocol expects: a newline
   * terminator for NDJSON (`JSON.stringify(msg) + "\n"`), or a
   * `Content-Length` header block for LSP.
   *
   * Framing is the caller's job in both directions: {@link PluginProcessHandle.onData}
   * delivers raw chunks that may split or coalesce protocol frames, so the
   * plugin does its own buffering and message splitting.
   *
   * Fire-and-forget: the write is queued on the child's stdin and the
   * backpressure signal is not surfaced. That suits the low-volume
   * control-plane traffic this is built for; a plugin that streams bulk data
   * faster than the child reads it will grow that buffer unboundedly.
   */
  write(data: string): void;
}

/**
 * A {@link PluginDuplexProcessHandle} for a process spawned with `mode: "pty"`.
 * Adds the one operation only a pseudo-terminal makes possible on top of
 * `write()`: telling the child the window changed size.
 *
 * Like `write()`, `resize()` is a no-op once the process has exited and is safe
 * to call immediately after `spawn()` resolves. A `resize()` issued while a
 * `restart()` is still allocating the replacement PTY is retained (last write
 * wins) and folded into that PTY's initial size rather than replayed as a late
 * SIGWINCH.
 */
export interface PluginPtyProcessHandle extends PluginDuplexProcessHandle {
  /** Report a new terminal size to the child. Both values must be positive integers. */
  resize(cols: number, rows: number): void;
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
   * Spawn the command under a real pseudo-terminal. The returned handle adds
   * `write()` and `resize()`; output arrives as a single combined stream on
   * `onData()` and as `{ kind: "data" }` panel events. The PTY is allocated in
   * the crash-isolated pty-host utility process, so a native failure cannot
   * take the app down with it.
   */
  spawn(command: string, options: PluginPtyProcessSpawnOptions): Promise<PluginPtyProcessHandle>;
  /**
   * Spawn a child with its stdin piped as well as its stdout/stderr, and return
   * a handle that adds `write()`. Use this to drive a command that speaks a
   * protocol over stdio — an MCP, LSP or ACP server, or anything else carrying
   * JSON-RPC — where the reply stream must stay free of the diagnostics the
   * child writes to stderr. Output arrives split by stream on
   * {@link PluginProcessHandle.onData}, exactly as in pipe mode; the host does
   * no framing, so the plugin owns buffering and message splitting.
   *
   * Rejects on the same conditions as the pipe-mode overload.
   */
  spawn(
    command: string,
    options: PluginDuplexProcessSpawnOptions
  ): Promise<PluginDuplexProcessHandle>;
  /**
   * Spawn a child process on the plugin's behalf and return a live handle. The
   * child's stdout/stderr stream to the plugin's panels over
   * `postToPanel("process", …)` keyed by the handle id (targeted at
   * `options.panelId` when given, broadcast otherwise), and to the plugin's own
   * code via {@link PluginProcessHandle.onData}. Rejects when the plugin lacks
   * `shell:exec`, when the per-plugin concurrency cap is reached, or when the
   * plugin has been unloaded.
   */
  spawn(command: string, options?: PluginProcessSpawnOptions): Promise<PluginProcessHandle>;
}

/**
 * What a symbolic link points at, as classified by the host's listing.
 * Present on a {@link PluginFsDirEntry} only for a detailed read of a link.
 *
 * Deliberately mirrors the classification Daintree's own file browser renders,
 * so a plugin presenting a file tree does not have to re-derive it — resolving
 * a link correctly means resolving it against the *canonical* directory it was
 * listed from, which differs from the lexical parent whenever the listed
 * directory is itself reached through a link.
 */
export interface PluginFsSymlink {
  /** Absolute path the link resolves to, the way the kernel would resolve it. */
  target: string;
  /**
   * `"file"` and `"directory"` are the resolved, in-scope cases — the only two
   * where `isDirectory` describes the target and descending is allowed.
   * `"broken"` is a target that does not exist. `"external"` is a target that
   * resolves outside the allowed root that contains the listed directory, so
   * the host will refuse to read it through that listing. Conservative: a link
   * into a different allowed root also reads as `"external"`. `"unknown"` is a
   * target that could not be classified at all (a link loop, permission
   * denied) — kept distinct from `"external"` so a UI never reports a link as
   * leaving scope when the truth is that it could not be read.
   */
  targetKind: "file" | "directory" | "broken" | "external" | "unknown";
}

/** One directory entry returned by {@link PluginFsApi.readdir}. */
export interface PluginFsDirEntry {
  /** Entry name (basename only — never a path). */
  name: string;
  /** True when the entry is a directory. */
  isDirectory: boolean;
  /**
   * True when the entry is a regular file.
   *
   * On a detailed read a symbolic link is described by what it resolves to, so
   * a link is `isFile` only when its `symlink.targetKind` is `"file"` — a
   * broken or out-of-scope link is neither a file nor a directory, because
   * there is nothing there to open. On a plain read this is the raw directory
   * entry's own kind, so a link reads as neither file nor directory there.
   *
   * Caveat on a detailed read: a non-link entry that is neither a directory nor
   * a regular file — a socket, fifo or device node — is reported as a file,
   * because the underlying listing records only "directory or not". These do
   * not occur in ordinary project trees; treat `isFile` as "not a directory"
   * if your plugin might browse somewhere they do.
   */
  isFile: boolean;
  /** True when the entry is a symbolic link (resolved containment still applies on read). */
  isSymbolicLink: boolean;
  /**
   * Size in bytes. Only present on a detailed read
   * ({@link PluginFsReaddirOptions.detail}), and omitted there for directories
   * and for an unresolved symlink — a link's own size is the byte length of the
   * stored target string, which renders as a real but meaningless file size.
   */
  size?: number;
  /**
   * Last-modified time in epoch milliseconds. Only present on a detailed read.
   * A resolved symlink reports its target's time, because that is what opening
   * the entry would give you.
   */
  mtimeMs?: number;
  /**
   * Present only on a symbolic link, and only on a detailed read. Absence means
   * the entry is a plain file or directory, which is why a consumer can keep
   * reading `isDirectory` and ignore this field entirely.
   */
  symlink?: PluginFsSymlink;
}

/** Options for {@link PluginFsApi.readdir}. */
export interface PluginFsReaddirOptions extends PluginHostCallOptions {
  /**
   * Return the same metadata Daintree's own file listing produces — `size`,
   * `mtimeMs`, symlink target and kind — with entries ordered directories-first
   * and then by a numeric-aware name collation.
   *
   * Off by default: a plain read is one `readdir` syscall, while a detailed one
   * additionally `lstat`s every entry and resolves every link, so the cost is
   * opt-in rather than silently imposed on existing callers. Turn it on when
   * you are presenting a file tree — deriving these per entry with your own
   * {@link PluginFsApi.stat} calls costs one host round trip *per entry* and
   * still would not reproduce the link classification or the ordering.
   */
  detail?: boolean;
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
 * Options for {@link PluginFsApi.writeFile} (#12323). Omitting them is the
 * same write as passing `{}`.
 */
export interface PluginFsWriteOptions {
  /**
   * The revision the caller last read — the sha256 hex of the file's bytes,
   * as returned by an earlier write or by
   * {@link PluginFsApi.readFileWithRevision}. The write is refused with
   * `REVISION_MISMATCH` when the file's current bytes hash differently; the
   * error carries the current revision so the caller can enter a conflict
   * state without a second read. `null` means the file must not exist yet
   * (a create-new write, refused with `TARGET_EXISTS` otherwise). Omit it to
   * write atomically without a freshness check.
   */
  expectedRevision?: string | null;
}

export interface PluginFsWriteResult {
  /** sha256 hex of the bytes written — the caller's next `expectedRevision`. */
  revision: string;
}

/** Result of {@link PluginFsApi.readFileWithRevision}. */
export interface PluginFsReadWithRevisionResult {
  /** The file's bytes decoded as UTF-8, exactly as {@link PluginFsApi.readFile} returns them. */
  contents: string;
  /**
   * sha256 hex of the exact bytes read — pass it straight to
   * {@link PluginFsWriteOptions.expectedRevision}.
   */
  revision: string;
}

/**
 * Options for {@link PluginFsApi.readFiles}. `encoding` picks the content type:
 * `"utf-8"` (the default) decodes each file as {@link PluginFsApi.readFile}
 * does, `"bytes"` returns raw bytes as {@link PluginFsApi.readFileBytes} does.
 */
export interface PluginFsReadFilesOptions<
  E extends PluginFsReadFilesEncoding = PluginFsReadFilesEncoding,
> extends PluginHostCallOptions {
  encoding?: E;
  /**
   * Per-file ceiling in bytes. A larger file is not read past the ceiling and
   * comes back as `{ ok: false, error: { code: "TOO_LARGE" } }`. Must be a
   * non-negative integer; omitted means only the call's total budget applies.
   */
  maxBytesPerFile?: number;
}

/** Content type of a {@link PluginFsApi.readFiles} call. */
export type PluginFsReadFilesEncoding = "utf-8" | "bytes";

/**
 * Why one path in a {@link PluginFsApi.readFiles} call was not read.
 *
 * - `PATH_NOT_ALLOWED` / `PERMISSION_REQUIRED` — the same refusals
 *   {@link PluginFsApi.readFile} rejects with (outside every allowed root, or
 *   the root's read capability is not declared)
 * - `NOT_FOUND` — nothing at the path
 * - `NOT_A_FILE` — a directory, FIFO, device or other non-regular file
 * - `TARGET_IS_SYMLINK` / `TARGET_UNAVAILABLE` — the verified-open refusals
 *   {@link PluginFsApi.readFile} documents
 * - `TOO_LARGE` — bigger than `maxBytesPerFile`
 * - `RESULT_TOO_LARGE` — the call's total byte budget was spent on earlier
 *   entries; read this path in a later call
 * - `READ_FAILED` — anything else (the `message` says what)
 */
export type PluginFsReadFilesErrorCode =
  | "PATH_NOT_ALLOWED"
  | "PERMISSION_REQUIRED"
  | "NOT_FOUND"
  | "NOT_A_FILE"
  | "TARGET_IS_SYMLINK"
  | "TARGET_UNAVAILABLE"
  | "TOO_LARGE"
  | "RESULT_TOO_LARGE"
  | "READ_FAILED";

/** One entry of a {@link PluginFsApi.readFiles} result, in request order. */
export type PluginFsReadFilesEntry<C = string> =
  | { readonly path: string; readonly ok: true; readonly content: C }
  | {
      readonly path: string;
      readonly ok: false;
      readonly error: { readonly code: PluginFsReadFilesErrorCode; readonly message: string };
    };

/** Options for {@link PluginFsApi.walk}. */
export interface PluginFsWalkOptions extends PluginHostCallOptions {
  /**
   * Globs (the `path.matchesGlob` dialect: `*`, `**`, `?`, `[…]`, `{a,b}`)
   * matched against each entry's root-relative path. When given, only entries
   * matching at least one are returned; directories are still walked, so
   * `["**\/*.ts"]` finds every TypeScript file. At most 64 patterns.
   */
  include?: readonly string[];
  /**
   * Globs, as for `include`. A matching entry is left out, and a matching
   * directory is not descended into — `["node_modules", "**\/dist"]` prunes
   * both. At most 64 patterns.
   */
  exclude?: readonly string[];
  /**
   * How deep to go: `1` lists `root`'s own children (like {@link PluginFsApi.readdir}),
   * `2` their children too, and so on. An integer from 1 to 64; omitted means
   * 64.
   */
  maxDepth?: number;
  /**
   * Most entries to return, counted after `include` filtering. An integer from
   * 1 to 50,000; default 10,000. Past it the result is `truncated`.
   */
  limit?: number;
  /** Leave out what git ignores (see {@link PluginFsApi.walk}). Default `true`. */
  respectGitignore?: boolean;
  /** Report each file's size in bytes. Default `false`; it costs one stat per file. */
  includeSize?: boolean;
}

/** One entry of a {@link PluginFsApi.walk} result. */
export interface PluginFsWalkEntry {
  /** Relative to the walk's root, `/`-separated, never starting with `/` or `./`. */
  readonly path: string;
  readonly type: "file" | "dir";
  /** Size in bytes, for a file, when {@link PluginFsWalkOptions.includeSize} was set. */
  readonly size?: number;
}

/** What a {@link PluginFsApi.walk} call returns. */
export interface PluginFsWalkResult {
  readonly entries: PluginFsWalkEntry[];
  /**
   * True when the walk stopped at `limit`, the result budget or one of the
   * host's cost bounds with entries left unlisted.
   */
  readonly truncated: boolean;
}

/** Options for {@link PluginFsApi.watch}. */
export interface PluginFsWatchOptions extends PluginHostCallOptions {
  /**
   * Watch every directory beneath each path, including subdirectories created
   * after the subscription. The callback then receives the absolute path of
   * whatever changed at any depth. Off by default: a plain watch reports only
   * a directory's immediate children. A non-boolean value rejects the watch.
   *
   * On Linux, Node implements this in JavaScript with one inotify watch per
   * file and directory, it can report names under symlinked subdirectories,
   * and it can stop reporting a file that is replaced by rename — see the
   * host API docs before relying on it there.
   */
  recursive?: boolean;
  /**
   * Coalesce a burst of changes into one trailing callback fired `debounceMs`
   * after the last change, carrying the most recent changed path. `0` /
   * omitted delivers every event; any other value is clamped to 50–60000ms.
   * A value that is not a finite, non-negative number rejects the watch.
   */
  debounceMs?: number;
  /**
   * Accept a path that does not exist yet, and keep watching through a
   * deletion. The host checks once a second: when a missing path appears it
   * re-proves containment (so a symlink created there cannot redirect the
   * watch), attaches, and calls back with the path; when a watched path
   * disappears, or is replaced by a new directory, it detaches, calls back,
   * and waits again. Without it a missing path rejects the watch, and a
   * deleted directory silently stops reporting.
   */
  allowMissing?: boolean;
}

/**
 * Error codes {@link PluginFsApi.writeFile} rejects with, carried on
 * the error's `code` property alongside a `message` that starts with the same
 * token. The reads reject with `TARGET_IS_SYMLINK` and `TARGET_UNAVAILABLE` the
 * same way — see {@link PluginFsApi.readFile}. In-process callers (built-in
 * plugins) and plugin workers both receive `code` (and, for a revision
 * mismatch, `currentRevision`) on the error — the worker port carries those
 * fields across. The renderer bridge to a plugin's view keeps only the
 * message, so hand a conflict to a view as a handler result, not a throw.
 */
export type PluginFsWriteErrorCode =
  "REVISION_MISMATCH" | "TARGET_UNAVAILABLE" | "TARGET_EXISTS" | "TARGET_IS_SYMLINK";

export interface PluginFsRevisionMismatchError extends Error {
  code: "REVISION_MISMATCH";
  /** The revision of the bytes on disk at the moment the write was refused. */
  currentRevision: string;
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
 * capability is rejected with a `PERMISSION_REQUIRED:` prefix; a path outside
 * every allowed root is rejected with a `PATH_NOT_ALLOWED:` prefix. Writes are
 * recorded in the plugin audit trail.
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
   *
   * A symlink the caller names is followed when it resolves inside a root.
   * Once open, the descriptor must be the entry standing at the contained path
   * (#12618): a leaf swapped for a symlink after containment rejects with
   * `TARGET_IS_SYMLINK`, and a descriptor that is not the file now at the path
   * with `TARGET_UNAVAILABLE`. A read that races a legitimate replace can see
   * the latter and is safe to retry.
   */
  readFile(filePath: string, options?: PluginHostCallOptions): Promise<string>;
  /**
   * Read a file as raw bytes, for the content UTF-8 decoding would corrupt —
   * an image, a font, an archive, anything a plugin wants to hash or hand to a
   * view as a data URL. Same capability gate, containment and cancellation as
   * {@link readFile}, and the same absence of a size cap.
   *
   * A separate method rather than an `encoding`-shaped option on `readFile`:
   * the return type stays unambiguous at every call site, the existing
   * text contract is untouched, and no `string | Uint8Array` union is baked
   * permanently into the published SDK surface.
   */
  readFileBytes(filePath: string, options?: PluginHostCallOptions): Promise<Uint8Array>;
  /**
   * Read a file as UTF-8 text together with its revision — the sha256 hex of
   * the exact bytes read, computed the same way {@link writeFile} computes the
   * revision it returns. Hand `revision` straight to
   * {@link PluginFsWriteOptions.expectedRevision} for a read-modify-write that
   * refuses to clobber a change made in between. Same capability gate,
   * containment, verified open and cancellation as {@link readFile}.
   */
  readFileWithRevision(
    filePath: string,
    options?: PluginHostCallOptions
  ): Promise<PluginFsReadWithRevisionResult>;
  /**
   * Read many files in one host round trip — the bulk counterpart to
   * {@link readFile} for a search, an index build, or a tree of small config
   * files, where one call per file costs a round trip each.
   *
   * Every path gets exactly the checks {@link readFile} applies — containment
   * against `scopes.fs.allowedPaths`, the root's read capability, and the
   * verified open — but a refusal fails only that entry: the result has one
   * {@link PluginFsReadFilesEntry} per path, in request order, each either
   * `{ ok: true, content }` or `{ ok: false, error: { code, message } }`.
   *
   * Bounded so the result always fits one host reply: at most 1024 paths per
   * call (more rejects the call), and at most 8 MiB of content in total,
   * measured as returned (decoded UTF-8 text, or bytes) and spent in request
   * order — entries past the budget come back `RESULT_TOO_LARGE` for a
   * follow-up call, and the same request always defers the same entries.
   * The whole call rejects only on a missing read capability for every root,
   * an unloaded plugin, invalid arguments, or `options.signal` aborting.
   *
   * Optional in the type so existing hand-written {@link PluginFsApi} fakes
   * keep compiling; Daintree's host, the worker host and `createMockHost`
   * always provide it.
   */
  readFiles?: {
    (
      paths: readonly string[],
      options?: PluginFsReadFilesOptions<"utf-8">
    ): Promise<PluginFsReadFilesEntry<string>[]>;
    (
      paths: readonly string[],
      options: PluginFsReadFilesOptions<"bytes">
    ): Promise<PluginFsReadFilesEntry<Uint8Array>[]>;
  };
  /**
   * Create a directory and any missing ancestors. Creating a directory that
   * already exists is a no-op; a non-directory at the path rejects. Gated and
   * consented like {@link writeFile}, and both happen before anything is
   * created: containment is proven first, so a symlinked ancestor that
   * resolves outside every allowed root is refused. Each missing component is
   * then created one at a time, refused if something other than a real
   * directory appears there, and audited individually.
   */
  mkdir(dirPath: string): Promise<void>;
  /**
   * Append UTF-8 text to a file, creating it if absent (the parent directory
   * must already exist). Gated, consented, serialised and audited like
   * {@link writeFile}; a symlink leaf is refused with `TARGET_IS_SYMLINK`, and
   * a FIFO, device or directory with `TARGET_UNAVAILABLE`.
   * The bytes land through one `O_APPEND` descriptor in one `write()` per call
   * (a short write is completed by more), so concurrent appenders — an agent
   * adding a line to the same JSONL file — each land at the end instead of
   * racing a read-and-rewrite. Whole-line atomicity against another writer is
   * a practical outcome for small lines, not a guarantee. No revision is returned: an
   * append is meaningful without one, and computing it would mean reading the
   * whole file back.
   */
  appendFile(filePath: string, contents: string): Promise<void>;
  /**
   * Write UTF-8 text to a file, creating it if absent (parent directories must
   * already exist within scope). Rejects on a missing write capability or an
   * out-of-scope path. Recorded in the audit trail. No cancellation signal —
   * partial-write semantics are deliberately out of scope.
   *
   * Every write is checked (#12323, #12618), with or without `options`: the
   * host serialises writes per resolved path, re-proves containment once the
   * consent prompt and the queue wait are over, refuses a symlink target
   * (`TARGET_IS_SYMLINK`), and — when
   * {@link PluginFsWriteOptions.expectedRevision} is a revision — compares the
   * file's current bytes against it before touching it. The file is then
   * replaced atomically (sibling temp file, flush, rename, original mode
   * preserved), so a file watcher sees the old inode go and a new one arrive.
   * A create-new write (`expectedRevision: null`) is an exclusive create at
   * the target instead, with no temp file. The write resolves the revision of
   * the bytes actually written, so the next `expectedRevision` needs no
   * re-read.
   *
   * What the write promises: a replace never leaves a partial file, every
   * host-mediated writer is serialised, and — given an `expectedRevision` — no
   * change the caller has not seen is clobbered. What it does not promise: a lock against an uncooperative external
   * process — a write that lands between the hash check and the rename is
   * overwritten. The window is small, and callers that care keep their own
   * copy of what they asked to write.
   */
  writeFile(
    filePath: string,
    contents: string,
    options?: PluginFsWriteOptions
  ): Promise<PluginFsWriteResult>;
  /**
   * List a directory's immediate children. Rejects on a missing read capability
   * or an out-of-scope path.
   *
   * Pass `{ detail: true }` to get the metadata and ordering Daintree's own file
   * browser uses — see {@link PluginFsReaddirOptions.detail}.
   */
  readdir(dirPath: string, options?: PluginFsReaddirOptions): Promise<PluginFsDirEntry[]>;
  /**
   * List a directory tree in one host round trip — the recursive counterpart
   * to {@link readdir} for a file search or an index build, where one
   * `readdir` per directory costs a round trip each.
   *
   * `root` gets exactly the checks {@link readdir} applies (containment
   * against `scopes.fs.allowedPaths` and the root's read capability), and the
   * walk stays inside it: symbolic links are neither followed nor listed, and
   * a directory's listing is dropped unless it still resolves to where it was
   * reached both before and after it is read. (Like {@link readdir}, reads are
   * by pathname, so a directory swapped for a link and back between those two
   * checks is not excluded.)
   *
   * Entries carry the path relative to `root`, with `/` separators, and come
   * back sorted by path, directories before the entries inside them. The walk
   * is breadth-first, so when `limit` (or the host's result budget) cuts it
   * short, `truncated` is `true` and what was kept is the shallowest part of
   * the tree; the same tree always truncates the same way. Besides `limit`,
   * the host bounds a walk's cost — at most 200,000 directory entries
   * examined and 1,000,000 glob tests — and a walk that reaches either bound
   * returns what it had with `truncated: true`. A directory is read only as
   * far as the examine bound allows, so when one directory alone holds more
   * entries than the bound has left, the entries kept from it are whichever
   * the filesystem enumerated first — still sorted, but not necessarily the
   * first by path, and not guaranteed to repeat.
   *
   * With `includeSize`, a size is omitted for a file whose directory no
   * longer resolves to where the walk listed it when its size is read.
   *
   * With `respectGitignore` (the default), inside a git repository an entry
   * git ignores — and not tracked — is left out and not descended into,
   * `.git` itself is skipped, and a nested repository or submodule is listed
   * but not entered. Outside a repository the option has no effect. On macOS
   * and Windows, a repository that tracks a file matching its own ignore rules
   * is walked without ignore filtering, since git can misreport such a file
   * under a different letter case as ignored.
   *
   * Optional in the type so hand-written {@link PluginFsApi} fakes keep
   * compiling; Daintree's host, the worker host and `createMockHost` always
   * provide it.
   */
  walk?(root: string, options?: PluginFsWalkOptions): Promise<PluginFsWalkResult>;
  /** Stat a path. Rejects on a missing read capability or an out-of-scope path. */
  stat(targetPath: string, options?: PluginHostCallOptions): Promise<PluginFsStat>;
  /**
   * Watch one or more contained paths for changes, invoking `callback` with the
   * changed absolute path. `paths` are each resolved and contained at
   * subscription time; an out-of-scope or missing-capability path rejects.
   * Resolves to a disposer that tears the watcher down; all watchers are
   * automatically torn down on unload. Rejects on a missing read capability so
   * authoring mistakes surface loudly. Pass `options.signal` to abort the
   * subscription attempt before it is wired, `options.recursive` to watch a
   * whole subtree, and `options.debounceMs` to coalesce bursts — see
   * {@link PluginFsWatchOptions}.
   */
  watch(
    paths: string[],
    callback: (changedPath: string) => void,
    options?: PluginFsWatchOptions
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
 * `clipboard:write` capability tokens. The *read* surface is deliberately
 * text-only — omitting image/HTML/file-list reads is what stops a plugin
 * smuggling out richer payloads than it declared. Writes carry no such risk
 * (the plugin already has the bytes), so a bounded {@link writeImage} is
 * offered alongside {@link writeText}; there is still no HTML or file-list
 * write. Every method runs in the main process (Electron's `clipboard` module
 * is unavailable in the plugin utility worker), so they remain callable from a
 * headless plugin with no mounted panel.
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
   * Replace the clipboard's contents with a PNG image. Gated on the same
   * `clipboard:write` token as {@link writeText} — putting an image on the
   * clipboard is no less reversible than putting text there, so it earns no
   * separate capability and does not elevate action danger.
   *
   * `pngData` must be the raw PNG bytes. Rejects with a `PAYLOAD_TOO_LARGE:`
   * prefix above 20 MiB (matching the renderer IPC clipboard guard) and with a
   * `VALIDATION:` prefix when the bytes don't decode to a non-empty image —
   * Electron's `nativeImage.createFromBuffer` reports malformed input by
   * returning an empty image rather than throwing, so the emptiness check is
   * the only signal available. Successful writes append an audit record
   * carrying the byte count only, never the image bytes.
   *
   * Decoding happens in the main process by necessity: the renderer's
   * `navigator.clipboard.write()` path crashes on Linux with binary PNG
   * payloads (#4900), so this is the only safe route for image writes.
   */
  writeImage(pngData: Uint8Array): Promise<void>;
  /**
   * Read the clipboard's text contents. Gated on `clipboard:read`. Resolves to
   * `""` when the clipboard is empty or holds non-text content (image, file
   * list) — it never rejects on content type.
   */
  readText(): Promise<string>;
}

/**
 * Host-mediated OS "reveal / open with the default app" surface (#11299).
 *
 * Exists because the renderer's built-in `system.openPath` action validates
 * against the *user's* roots — open projects, tracked worktrees, Electron's
 * `userData` — and carries no caller identity, so a plugin dispatching it
 * cannot reach the one directory that is unambiguously its own:
 * `~/.daintree/plugin-data/<plugin-id>/`. A plugin that just wrote a
 * screenshot there had no sanctioned way to reveal it, and shelled out to
 * `/usr/bin/open` instead — trading a contained call for arbitrary execution.
 *
 * Both methods resolve paths against the calling plugin's *declared* filesystem
 * scope (`scopes.fs.allowedPaths` plus its implicit plugin-data namespace), and
 * the plugin id is bound at host construction rather than travelling as an
 * argument, so one plugin can never name another's namespace. Containment is
 * realpath-based, so a symlink cannot walk out of scope. Gated on the `fs:*`
 * capability matching the resolved root's class: revealing something under the
 * plugin-data namespace needs `fs:user-data-read` or `fs:user-data-write`,
 * under a project root `fs:project-read` or `fs:project-write` — a plugin that
 * could legitimately create the file can always reveal it.
 *
 * Like {@link PluginFsApi} this is NOT revoke-guarded, and every method rejects
 * once the plugin is unloaded.
 */
export interface PluginSystemApi {
  /**
   * Open `targetPath` with the OS default application. Rejects paths outside
   * the plugin's declared scope (`OUTSIDE_ROOT:`), non-absolute or unresolvable
   * paths (`INVALID_PATH:`), and executable file types (`.app`, `.exe`, `.sh`,
   * … — checked on both the raw path and its realpath target, so a benignly
   * named symlink cannot smuggle a launch primitive past the deny-list).
   */
  openPath(targetPath: string): Promise<void>;
  /**
   * Reveal `targetPath` in the OS file manager, selecting it. Same containment
   * and capability rules as {@link openPath}, but without the executable
   * deny-list: revealing a file in Finder/Explorer shows it, it does not run
   * it. The path must exist.
   */
  showItemInFolder(targetPath: string): Promise<void>;
  /**
   * Open a web page in the user's default browser. Only `https:` URLs of at
   * most 2048 characters and without embedded credentials are accepted
   * (`INVALID_URL:`); `file:`, `http:`, custom schemes and `daintree:` never
   * are. Opens are rate limited per plugin (`RATE_LIMITED:`), and the first
   * link a plugin opens to a given site (its lower-cased hostname, any port or
   * path) asks the user, who can allow that site or deny it
   * (`PERMISSION_REQUIRED:`). An allowed site is remembered for that plugin in
   * its project scope until the plugin is uninstalled or replaced. Built-in
   * plugins are not asked. Nothing opens on a host whose
   * project is driven from another machine (`REMOTE_FRONTEND:`).
   */
  openExternal(url: string): Promise<void>;
}

/** Paper sizes {@link PluginDocumentsApi.renderPdf} accepts. */
export type PluginPdfPageSize = "A4" | "Letter" | "Legal" | "A3" | "A5" | "Tabloid";

/** Page margins for {@link PluginDocumentsApi.renderPdf}, in inches (0–3 each). */
export interface PluginPdfMargins {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/**
 * Options for {@link PluginDocumentsApi.renderPdf}. Exactly one of `html` or
 * `htmlPath` is required; any other key, or a value of the wrong shape, is
 * refused with a `VALIDATION:` error rather than ignored.
 */
export interface PluginRenderPdfOptions {
  /**
   * Inline HTML, at most 5 MiB (UTF-8). The document has no base URL, so a
   * relative reference resolves to nothing: embed images and fonts as `data:`
   * URIs, or write the HTML to disk and pass {@link htmlPath} instead.
   */
  html?: string;
  /**
   * Absolute path to an HTML file (at most 5 MiB, read as UTF-8),
   * read-contained exactly like {@link PluginFsApi.readFile} and gated on the
   * read capability for its root class. It is snapshotted once consent is
   * given and the snapshot is what renders. Relative images and stylesheets
   * resolve against its directory as long as they stay inside the same
   * allowed root.
   */
  htmlPath?: string;
  /**
   * Absolute path of the PDF to write; must end in `.pdf` and its parent
   * directory must exist. Contained, capability-gated, consent-gated and
   * replaced atomically exactly like {@link PluginFsApi.writeFile}.
   */
  outputPath: string;
  /** Paper size. Defaults to `"A4"`. A CSS `@page size` is not honoured. */
  pageSize?: PluginPdfPageSize;
  /** Landscape orientation. Defaults to `false`. */
  landscape?: boolean;
  /** Print CSS backgrounds and colours. Defaults to `true`. */
  printBackground?: boolean;
  /** Page margins in inches. Each side defaults to Chromium's 1 cm (~0.4 in). */
  margins?: PluginPdfMargins;
  /** Pages to keep, e.g. `"1-3, 5"`. Omitted keeps every page. */
  pageRanges?: string;
}

/** Result of {@link PluginDocumentsApi.renderPdf}. */
export interface PluginRenderPdfResult {
  /** The contained absolute path the PDF was written to. */
  path: string;
  /** Size of the written PDF in bytes. */
  bytes: number;
  /**
   * SHA-256 hex of the written bytes — the same revision
   * {@link PluginFsApi.writeFile} returns, so it can be passed straight back as
   * an `expectedRevision`.
   */
  revision: string;
}

/**
 * Host-mediated document export on {@link PluginHostApi.documents}. Rendering
 * runs in the main process — Electron's `printToPDF` is unreachable from the
 * plugin worker — in a hidden, sandboxed window with JavaScript disabled, a
 * throwaway in-memory session, permissions denied, navigation and popups
 * blocked, and the network cut off: only `data:` URIs and `file:` URLs inside
 * a root the plugin can read load, so remote images, fonts and stylesheets are
 * never fetched.
 *
 * NOT revoke-guarded, like {@link PluginFsApi}; every method rejects once the
 * plugin unloads.
 */
export interface PluginDocumentsApi {
  /**
   * Render HTML to a PDF file and resolve its path, size and revision.
   *
   * Gated exactly like {@link PluginFsApi.writeFile} on the output path:
   * `fs:project-write` or `fs:user-data-write` for its root class, then the
   * just-in-time consent prompt; a symlink at the output leaf is refused with
   * `TARGET_IS_SYMLINK`, and a target that moves while the render runs with
   * `TARGET_UNAVAILABLE`. A call waiting on the consent prompt is untimed and
   * holds no render slot, but a plugin may have only two waiting. Renders run
   * two at a time across all plugins; a plugin with two calls holding render
   * slots, or a call arriving when eight are, rejects with `RENDER_BUSY:`. A
   * call not finished within 30 seconds of taking its slot rejects with
   * `RENDER_TIMEOUT:`, a page that fails to load or print with
   * `RENDER_FAILED:`, a PDF over 50 MiB with `PAYLOAD_TOO_LARGE:`, and a
   * call outstanding when the plugin unloads with `RENDER_CANCELLED:`.
   */
  renderPdf(options: PluginRenderPdfOptions): Promise<PluginRenderPdfResult>;
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
   * capabilities throw with a `PERMISSION_REQUIRED:` prefix. The
   * renderer-side `useHostChannel` hook passes the error through unchanged as
   * its `error` value; the view tells the prefixes apart.
   *
   * Must be called during `activate()`.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerHandler<TArgs, TResult>(
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>,
    options?: PluginHandlerOptions
  ): Promise<void>;
  /**
   * Legacy untyped overload: a variadic handler with no host-side validation.
   * Retained for plugins that haven't migrated to per-channel schemas. The
   * typed overload above is preferred for new code. Also revoke-guarded — must
   * be called during `activate()`.
   */
  registerHandler(
    channel: string,
    handler: PluginIpcHandler,
    options?: PluginHandlerOptions
  ): Promise<void>;
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
   * Bind a runtime forge provider implementation to the descriptor declared in
   * `contributes.forgeProviders`. A provider serving both roles (the default)
   * passes a full `ForgeProviderImpl`; one whose manifest declares
   * `roles: ["issues"]` passes a `ForgeIssueProviderImpl`, which must include
   * `resolveIssueRepo`. An implementation missing a member its declared roles
   * require is rejected. The descriptor's `id` is namespaced to the
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
    impl: AnyForgeProviderImpl
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
   * Bind the handler for a step declared in `contributes.worktreeSetupSteps`
   * (#13807). The host runs it for each worktree it creates in a project this
   * plugin is loaded for, after the project's setup script succeeded and once
   * the user has allowed the step for that project. Steps run one at a time,
   * ordered by plugin id and then declaration order, and one failing does not
   * stop the next.
   *
   * The step runs from this plugin as loaded for the project, never from the
   * new worktree's branch. It is not a teardown hook: resources that cost
   * money belong in a resource environment, which has its own teardown.
   *
   * `stepId` must match a declared entry; an undeclared id is rejected.
   * Returns a disposer that unbinds the handler; bindings are removed when the
   * plugin unloads. Must be called during `activate()`. Calling it twice with
   * the same id overwrites the prior binding, and the older disposer becomes
   * inert.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerWorktreeSetupStep(
    stepId: string,
    handler: PluginWorktreeSetupStepHandler
  ): Promise<() => void>;
  /**
   * Answer a `kind: "runtime"` entry of `contributes.searchProviders` (#13792)
   * with `provider`. `id` must name such an entry; an undeclared id, or a
   * declarative one, is rejected. The host asks it while the user types in the
   * quick switcher, with a short deadline: an answer that misses it is dropped
   * and recorded in this plugin's diagnostics, and `context.signal` aborts when
   * the query is superseded. Results are re-checked host-side — a target outside
   * this plugin, or args over the size limit, drop the row.
   *
   * A blended (unscoped) search only asks a provider whose plugin is already
   * running; it never activates the plugin. Returns a disposer; re-registering
   * the same id replaces the binding. Must be called during `activate()`.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerSearchProvider(id: string, provider: PluginSearchProvider): Promise<() => void>;
  /**
   * Bind a runtime {@link ContextProviderImpl} to a provider declared in
   * `contributes.contextProviders` (#13795). The host asks it for matches when
   * the user types `@{prefix}:` in an agent composer, and for an item's content
   * when the user sends a draft holding one of its chips — each call under a
   * deadline, with a signal aborted when the host stops waiting. An undeclared
   * id is rejected. Returns a disposer; every binding is removed when the plugin
   * unloads. Must be called during `activate()`. Registering the same id again
   * replaces the prior binding and leaves the older disposer inert.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerContextProvider(
    descriptor: ContextProviderDescriptor,
    impl: ContextProviderImpl
  ): Promise<() => void>;
  /**
   * Bind the methods of a service declared in `contributes.services.provides`
   * (#14105). `handlers` must have a function for exactly the declared
   * methods. Other plugins reach it through `host.services.call`; the host
   * starts this plugin for the first call, so it need not stay loaded. Each
   * method gets the arguments and a context with the caller's identity and a
   * signal aborted when the caller stops waiting. Returns a disposer; every
   * binding is removed when the plugin unloads, and calls still running then
   * resolve as `unavailable`. Registering the same name again replaces the
   * prior binding and leaves the older disposer inert. Must be called during
   * `activate()`.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerService<TContract extends PluginServiceContract = PluginServiceContract>(
    name: string,
    handlers: PluginServiceHandlers<TContract>
  ): Promise<() => void>;
  /**
   * Bind the check declared in `contributes.worktreeDeleteNotes` (#13805). The
   * host calls `impl.provideNotes` when the delete of a worktree in this
   * plugin's reach is confirmed — the delete dialog, bulk remove, an agent's
   * request over MCP, and the path used when no window is open — and shows
   * the notes attributed to the plugin. A plugin that isn't running is
   * activated for the check, so it need not stay loaded to answer.
   *
   * The answer has 3 seconds, activation included. A late, failed or invalid
   * answer is shown as "<plugin> didn't answer"; notes never change the
   * delete, its confirmation tier or its typed confirmation. The user can turn
   * a plugin's notes off in its permissions, and the plugin is then not asked.
   *
   * The descriptor's `id` must match the manifest entry. Returns a disposer
   * that unbinds the impl; the binding also goes when the plugin unloads.
   * Must be called during `activate()`. Calling it again with the same id
   * replaces the binding, and the older disposer becomes inert.
   *
   * @throws {Error} If called after activation resolves or times out, or with
   *   an id that `contributes.worktreeDeleteNotes` does not declare.
   */
  registerWorktreeDeleteNotesProvider(
    descriptor: WorktreeDeleteNotesProviderDescriptor,
    impl: WorktreeDeleteNotesProviderImpl
  ): Promise<() => void>;
  /**
   * Subscribe to active-worktree changes. The callback fires with the new
   * active snapshot (or `null` when none is active). Returns a disposer;
   * calling it more than once is a no-op. All subscriptions are automatically
   * disposed when the plugin is unloaded.
   *
   * Coalesced by default: a burst of activations becomes one callback with
   * the worktree active at the end of it. Pass `{ debounceMs: 0 }` to receive
   * every activation — see {@link PluginHostSubscriptionOptions}.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  /**
   * Subscribe to the worktree set changing. The callback fires with the full
   * current list on any worktree add/update/remove, and a second argument
   * naming which worktrees were added, removed or changed since the previous
   * delivery — see {@link PluginWorktreesChange}. Resolves to a disposer;
   * calling it more than once is a no-op. All subscriptions are automatically
   * disposed when the plugin is unloaded.
   *
   * Coalesced by default (the host re-emits on every git-status poll): a burst
   * becomes one trailing callback carrying the latest list, and the change
   * describes the whole burst. Pass `{ debounceMs: 0 }` to receive every
   * event — see {@link PluginHostSubscriptionOptions}.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidChangeWorktrees(
    callback: (snapshots: PluginWorktreeSnapshot[], change: PluginWorktreesChange) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  /**
   * Subscribe to agent-session state changes, gated on the `agent:read`
   * capability. The callback fires with a frozen {@link PluginAgentSnapshot}
   * for accepted agent state transitions across all sessions (unscoped,
   * like {@link onDidChangeWorktrees} — a plugin filters by `snapshot.agentId`
   * if it cares about one session). Resolves to a disposer; calling it more
   * than once is a no-op. All subscriptions are automatically disposed when the
   * plugin is unloaded.
   *
   * Coalesced by default, per terminal: within one window only each
   * terminal's latest transition is delivered, one callback per terminal, in
   * the order of those latest transitions. The final state of every terminal
   * is always delivered; the transitions in between may be skipped, so a
   * delivered snapshot's `previousState` is the state immediately before that
   * last transition, not necessarily the state you were last told about. Pass
   * `{ debounceMs: 0 }` to receive every transition — see
   * {@link PluginHostSubscriptionOptions}.
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
  onDidChangeAgentState(
    callback: (snapshot: PluginAgentSnapshot) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  /**
   * Subscribe to terminals starting, exiting, being trashed and restored, and to
   * agent rate-limit banners seen in them, gated on the `agent:read`
   * capability. Covers every terminal — plain shells as well as agents — in
   * every workspace for an installed plugin, and in its own project only for a
   * project plugin. The callback receives one frozen
   * {@link PluginTerminalLifecycleEvent} per change, in the order the host saw
   * them; nothing is coalesced, and nothing is replayed on subscribe. There is
   * no snapshot of the terminals already open — {@link PluginAgentsApi.list}
   * covers only the project's live agent panes. Resolves to a disposer; calling
   * it more than once is a no-op. Disposed automatically when the plugin is
   * unloaded.
   *
   * Observation only — there is no companion method to start, stop or restart a
   * terminal.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare the
   *   `agent:read` capability, or if called after activation resolves or times
   *   out (the host is revoked). In a worker only the revoke check throws: a
   *   missing `agent:read` resolves to a disposer whose callback never fires,
   *   and the refusal is logged in main.
   */
  onDidChangeTerminalLifecycle(
    callback: (event: PluginTerminalLifecycleEvent) => void
  ): Promise<() => void>;
  /**
   * Subscribe to changes in the app-wide agent list that
   * {@link PluginAgentsApi.listAll} returns: a run added or removed, or one's
   * observed state, title or worktree changing, in any open project or scratch.
   * The callback receives the whole new {@link PluginAllAgentsSnapshot},
   * frozen. Gated on `agent:read`, and refused for project plugins like
   * `listAll`. Resolves to a disposer; calling it more than once is a no-op.
   * Disposed automatically when the plugin is unloaded.
   *
   * There is no initial callback — call `listAll()` after subscribing. A
   * callback can repeat the previous snapshot when something the plugin cannot
   * see changed. Coalesced by default to the latest snapshot; see
   * {@link PluginHostSubscriptionOptions}.
   *
   * Subscribing is revoke-guarded — call it during `activate()`.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare
   *   `agent:read`, is a project plugin, or the host is revoked.
   */
  onDidChangeAllAgents(
    callback: (snapshot: PluginAllAgentsSnapshot) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  /**
   * Subscribe to which kind of panel has focus (#13221): a terminal, a browser
   * panel, a diff, the Portal, … The callback receives a frozen
   * {@link PluginFocusedPanel} with `kind: null` while Daintree is not the
   * foreground window or nothing that is a panel has focus. Gated on
   * `panel:focus-read`. A project plugin sees focus only inside its own
   * project, and `kind: null` everywhere else, the Portal included.
   *
   * The current focus is delivered once after subscribing, then every change.
   * Coalesced to the latest value with a 250ms default window, and a value
   * equal to the last one delivered is never repeated; see
   * {@link PluginHostSubscriptionOptions}. Resolves to a disposer; calling it
   * more than once is a no-op. Disposed automatically when the plugin is
   * unloaded.
   *
   * Subscribing is revoke-guarded — call it during `activate()`.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare
   *   `panel:focus-read`, or the host is revoked.
   */
  onDidChangeFocusedPanel(
    callback: (focus: PluginFocusedPanel) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  /**
   * Subscribe to where projects are (#13813): `"foreground"` while a window
   * shows the project, `"background"` while it is open behind another one, and
   * `"closed"` when it closes. The callback receives one frozen
   * {@link PluginProjectPresence} per project that changed. A project plugin
   * hears about its own project only; an installed plugin hears about every
   * open project, and never about a scratch. No capability is required.
   *
   * Presence follows the project each window has switched to, not the user's
   * attention: a project in an unfocused or minimised window is still
   * `"foreground"`, and it changes as a switch commits, before the incoming
   * project has finished painting. Use `onDidChangeFocusedPanel` for focus.
   *
   * The current state is delivered once after subscribing — the bound project
   * for a project plugin, every open project for an installed one — then every
   * change. Coalesced per project to its latest state with the 100ms default
   * window, and a state equal to the last one delivered for that project is
   * never repeated, so a project closed and reopened inside one window may
   * report nothing; see {@link PluginHostSubscriptionOptions}. An installed
   * plugin is never told about a project that opened and closed inside one
   * window. Resolves to a disposer; calling it more than once is a no-op.
   * Disposed automatically when the plugin is unloaded — a project plugin is
   * unloaded as its project closes, so it may not live to see `"closed"`.
   *
   * Subscribing is revoke-guarded — call it during `activate()`.
   *
   * @throws {Error} If the host is revoked.
   */
  onDidChangeProjectPresence(
    callback: (presence: PluginProjectPresence) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  /**
   * Subscribe to panel lifecycle transitions for this plugin's own contributed
   * panels (#11301). No capability is required — a plugin only ever sees events
   * for panel instances of kinds it contributed itself.
   *
   * This is how a worker learns the difference a view's `disposeSignal` cannot
   * express: that signal aborts for a temporary unmount (sibling maximize,
   * inactive dock tab, cached project view) exactly as it does for a permanent
   * close, so a worker that treats it as deletion tears down durable resources
   * the user still wants. Keep those resources in the worker and release them on
   * `"removed"` — the terminal phase — rather than guessing from the view.
   *
   * On subscribe the host replays the current phase of every live panel of this
   * plugin, so a plugin that activated lazily *because* a view opened still sees
   * that panel's state. One-shot transitions (`"restored"`) are not replayed.
   *
   * Callbacks receive a frozen {@link PluginPanelLifecycleEvent}. Resolves to a
   * disposer; calling it more than once is a no-op, and all subscriptions are
   * disposed automatically when the plugin is unloaded.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidChangePanelLifecycle(
    callback: (event: PluginPanelLifecycleEvent) => void
  ): Promise<() => void>;
  /**
   * Subscribe to the machine waking from sleep (#12175). No capability is
   * required — the event describes the machine's own suspend/resume timing and
   * carries nothing about the workspace, the user, or any other plugin.
   *
   * This is the signal background work has no other way to get.
   * {@link onDidChangePanelLifecycle} gives a *view* a re-validation point, but
   * a plugin's timers, forge providers, and reconciliation passes keep running
   * against state frozen at suspend. The host's own resume path resumes
   * git-status polling only while a Daintree window is visible and the screen
   * is unlocked, and holds its explicit post-wake refresh until a window is
   * also focused, so a machine that wakes with the app hidden or locked leaves
   * that state stale until the user comes back — for an unbounded stretch, with
   * nothing else announcing the wake.
   *
   * Delivered at most once per resume, after the host has attempted to resync
   * its pty and workspace hosts, so a plugin re-reading worktree state from the
   * callback is not racing the host's own recovery. That recovery is
   * best-effort: the wake is announced even when part of it failed, because a
   * half-recovered host is when a plugin most needs to revalidate. Rapid
   * resumes coalesce into one delivery, and a re-suspend during the settle
   * window cancels the wake outright rather than emitting a spurious one.
   *
   * Nothing is replayed on subscribe: a wake is a one-shot pulse with no
   * resting state, so a plugin that subscribes after a wake waits for the next
   * one.
   *
   * The event is machine-scoped, not project-scoped: every loaded instance of
   * the plugin receives it, including one bound to a project whose window is
   * not focused.
   *
   * Callbacks receive a frozen {@link PluginSystemWakeEvent}. Resolves to a
   * disposer; calling it more than once is a no-op, and all subscriptions are
   * disposed automatically when the plugin is unloaded.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidWake(callback: (event: PluginSystemWakeEvent) => void): Promise<() => void>;
  /**
   * Serve the tool rosters of the endpoints declared in `contributes.agentMcp`
   * to agents running in Daintree's terminals. Gated on the `mcp:expose`
   * capability. See {@link PluginMcpApi}.
   *
   * `registerTools` is revoke-guarded — call it during `activate()`. The tools'
   * `execute` functions run for the plugin's whole lifetime; only binding the
   * roster is restricted to the activation window.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` from `registerTools` if the plugin
   *   did not declare the `mcp:expose` capability, and a revoked-host error if
   *   it is called after activation resolves or times out.
   */
  readonly mcp: PluginMcpApi;
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
   * {@link PluginActionManifestEntry}. Mirrors `ActionService.list()` minus
   * the actions {@link PluginHostApi.dispatch} refuses: `danger:"restricted"`
   * ones and those closed to plugin dispatch, so listed entries are always
   * `"safe"` or `"confirm"`. Resolves `[]` when no renderer is available or the
   * plugin has been unloaded.
   */
  list(): Promise<PluginActionManifestEntry[]>;
  /**
   * Look up a single action by id, or `null` when it doesn't exist or is one
   * {@link list} leaves out (`danger:"restricted"`, or closed to plugin
   * dispatch). Prefer this over {@link list} for a single lookup — it avoids
   * projecting the whole catalog.
   */
  get(actionId: ActionId): Promise<PluginActionManifestEntry | null>;
  /**
   * Pre-flight a dispatch without triggering it: `"ok"` for a safe action,
   * `"confirm"` for a confirm-gated one (which {@link PluginHostApi.dispatch}
   * would reject with `CONFIRMATION_REQUIRED`), and `"restricted"` for an
   * unknown action or one {@link get} answers `null` for. Lets a plugin warn the user before
   * triggering a confirm prompt. See {@link PluginCanDispatchResult}.
   */
  canDispatch(actionId: ActionId): Promise<PluginCanDispatchResult>;
}

/**
 * Who this plugin is, as the host knows it — the facts a plugin previously had
 * to recover by string-splitting its own {@link PluginHostApi.pluginId}
 * (#12211). Every field is fixed for the life of the host: the binding is
 * captured once when the host is built, never resolved per call.
 */
export interface PluginIdentity {
  /**
   * The key this instance is indexed under host-side, byte-identical to
   * {@link PluginHostApi.pluginId}. Present so a plugin passing identity around
   * as one object never has to reach back for the bare id.
   */
  readonly instanceId: string;
  /**
   * The manifest id (`publisher.name`) — what belongs in anything the
   * *repository* sees, since a project id is machine-local.
   */
  readonly manifestId: string;
  /** `"project"` for a `.daintree/plugins` contribution, `"global"` otherwise. */
  readonly origin: "global" | "project";
  /** Owning project, or `null` for an app-global (installed/builtin) plugin. */
  readonly projectId: string | null;
  /** Absolute project root. Null iff `projectId` is null. */
  readonly projectRoot: string | null;
}

export interface PluginHostApi extends PluginActivationApi {
  readonly pluginId: string;
  /**
   * This plugin's own identity, frozen at activation. Read `manifestId` rather
   * than parsing {@link pluginId}: for a project-owned plugin the id is an
   * instance key, and splitting it by hand is exactly the coupling to the
   * host's internal key format that this exists to remove (#12211).
   *
   * Always readable — it is static closure data, not a live registration, so
   * unlike the registration surface it neither throws after `activate()`
   * resolves nor goes quiet once the plugin unloads.
   */
  readonly pluginInfo: PluginIdentity;
  /**
   * Qualify one of this plugin's own `contributes.panels[].id` values into the
   * runtime panel kind id that {@link PluginHostApi.dispatch}'s
   * `panel.openPluginPanel` expects — `{manifestId}.{bareId}` for a global
   * plugin, `project:{projectId}/{manifestId}/{bareId}` for a project-owned one.
   *
   * Resolution is scoped to this host's own binding, never inferred from the
   * shape of the string, so a plugin can hand over a bare id and get back the
   * qualified form without knowing which of the two it lives under.
   *
   * Throws on an empty `bareId`, and on a project-owned plugin whose binding
   * carries no project (a malformed binding cannot name a project kind) — an
   * authoring or host error either way, surfaced loudly rather than returning
   * an id that resolves to nothing. Synchronous: pure closure data, no
   * round-trip. Always callable, for the same reason as {@link pluginInfo}.
   */
  panelKindId(bareId: string): string;
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
   * channel rejects so authoring mistakes surface loudly.
   *
   * Pass `panelId` to target a single panel instance — only the renderer
   * subscribed via `window.electron.plugin.onPanel(pluginId, channel, panelId,
   * …)` (or the SDK's `usePluginPanelEvent`) receives it, so multiple open
   * instances of the same panel kind no longer all receive every push. Omit it
   * (or pass `null`) to broadcast to every `plugin.on` / `usePluginEvent`
   * subscriber as before. An empty-string `panelId` rejects.
   */
  postToPanel(channel: string, payload: unknown, panelId?: string | null): Promise<void>;
  /**
   * Whether any renderer this host pushes to may currently be subscribed to
   * `channel` — through `window.electron.plugin.on` / `onPanel` or the SDK
   * hooks built on them. Use it to stop producing pushes nobody will receive.
   * It is a hint for the producer only: the host delivers every push to every
   * renderer in scope whatever this answers, because a renderer's report is
   * always a moment behind its subscribers.
   *
   * Errs towards `true`: a renderer that has not reported its subscriptions
   * yet (one just created) counts as listening, and in a worker the first
   * call for a channel answers `true` until the host's first report for it
   * arrives a moment later. `false` once the plugin is unloaded. Synchronous
   * and cheap — read it on every produce.
   *
   * A push you skip because this said `false` is gone for good, and a view
   * can subscribe the moment after you read it. So only skip work a view can
   * recover by pulling state when it mounts (as a synced collection's snapshot
   * does), never a one-off event.
   *
   * Optional in the type so hand-written {@link PluginHostApi} fakes keep
   * compiling; Daintree's host, the worker host and `createMockHost` always
   * provide it. `channel` is validated like {@link postToPanel}'s.
   */
  hasListeners?(channel: string): boolean;
  /**
   * Call `callback` whenever {@link hasListeners} for `channel` changes —
   * with `false` when the last subscriber anywhere in scope goes away, `true`
   * when one appears. Not called with the current value; read that with
   * {@link hasListeners}. Returns a disposer; every registration is also
   * removed when the plugin unloads. Not revoke-guarded — callable any time
   * after activation, like {@link postToPanel}.
   *
   * A live registration is an event subscription like `onDidChangeWorktrees`:
   * while one exists, an idle worker is not disposed, since a disposed worker
   * could not be called back. Reading {@link hasListeners} alone never holds
   * the worker.
   */
  onDidChangeListeners?(channel: string, callback: (hasListeners: boolean) => void): () => void;
  /**
   * Returns the currently-active worktree (`isCurrent === true`) of the project
   * this host reads for, as a frozen snapshot, or `null` if none is active.
   *
   * `null` is overloaded exactly as `[]` is on {@link getWorktrees} — it means
   * "no active worktree" *or* "no answer available". Use
   * {@link getWorktreesResult} and pick out `isCurrent` yourself when the
   * difference matters.
   */
  getActiveWorktree(): Promise<PluginWorktreeSnapshot | null>;
  /**
   * Returns the worktrees of the project this host reads for, as frozen
   * snapshots — the project named by a project-bound host's binding, or the
   * focused window's project for an app-global one.
   *
   * Resolves `[]` both when the project has no worktrees and when no answer is
   * available at all; {@link getWorktreesResult} separates the two.
   */
  getWorktrees(): Promise<PluginWorktreeSnapshot[]>;
  /**
   * The same read as {@link getWorktrees}, but able to say when it has no
   * answer and which project the answer it does have describes (#12174).
   *
   * `getWorktrees()` collapses an unloaded plugin, an unwired workspace client,
   * an unresolved window scope, a rootless or closed project and a failed read
   * all to the same `[]` a genuinely empty project returns. Prefer this method
   * wherever the absence of a worktree drives a decision — a stored binding
   * that looks broken, a panel that looks orphaned — and only treat a
   * `status: "ok"` result whose `projectId` matches your expectation as
   * evidence. See {@link PluginWorktreesResult}.
   *
   * Like {@link getWorktrees} this is not revoke-guarded and never throws: once
   * the plugin unloads it degrades to `{ status: "unavailable", reason:
   * "plugin-unloaded" }`.
   */
  getWorktreesResult(): Promise<PluginWorktreesResult>;
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
   * The Daintree Assistant is never the target, whatever the plugin's consent:
   * a project whose only agent is the assistant is treated as having none.
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
   * The agent panes in this plugin's project, for choosing where to hand work,
   * gated on `agent:read`; and input to the agents this plugin launched, gated
   * on `agent:input`. See {@link PluginAgentsApi}.
   */
  readonly agents: PluginAgentsApi;
  /**
   * Read what a terminal's screen shows, as plain text. Gated on
   * `terminal:read`. See {@link PluginTerminalsApi}.
   */
  readonly terminals: PluginTerminalsApi;
  /**
   * Hand `text` to an agent: it is appended to that agent's visible draft,
   * below anything the user already typed, as a fenced block headed by
   * `options.title` and the plugin's name. Nothing is ever submitted — the user
   * adds their instruction and presses Enter. There is no `submit` option.
   *
   * With `options.terminalId` the draft goes straight to that pane. Without it
   * the user picks from the project's agents, grouped by worktree (an agent in
   * `options.worktreeId` is preselected, else the focused one), or starts a new
   * agent in that worktree or in a new worktree; the text lands in the new
   * agent's draft once it is up.
   *
   * Gated on `agent:input` with the same first-use consent prompt as
   * {@link sendToActiveAgent}. A project plugin only ever reaches its own
   * project's panes. Never moves focus.
   *
   * Resolves `{ status: "drafted", terminalId }`, `{ status: "cancelled" }`
   * (the user dismissed the picker, or the call was aborted or the plugin
   * unloaded while it was open), or `{ status: "refused", reason }` when the
   * target cannot take a draft — see {@link PluginSendToAgentRefusalReason}.
   * Once the user picks a row that starts an agent, the launch is theirs: an
   * abort or unload no longer cancels it, and the call reports its outcome.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare
   *   `agent:input`, or the user denies the consent prompt.
   * @throws {Error} If `text` is blank or longer than 32,768 characters, or an
   *   option has the wrong type or length.
   */
  sendToAgent(
    text: string,
    options?: PluginSendToAgentOptions,
    callOptions?: PluginHostCallOptions
  ): Promise<PluginSendToAgentResult>;
  /**
   * Offer to run one of this plugin's own `contributes.recipes`, named by its
   * manifest `id`, with values for its `{{plugin.<name>}}` variables (#13797).
   * Nothing starts until the user confirms: the host shows every step with its
   * final prompt, system prompt and arguments resolved, and runs exactly that.
   *
   * Needs no capability — the recipe is the plugin's own declared content, and
   * each run is the user's decision. Only the plugin's own recipes are
   * reachable. A recipe declaring `requiresAgentTools` is refused while those
   * tools are off in the project; this never turns them on.
   *
   * Resolves `{ status: "ran", spawnedCount, failedCount }`,
   * `{ status: "cancelled" }` (the user dismissed it, or the call was aborted
   * or the plugin unloaded before they answered), or
   * `{ status: "refused", reason }` — see {@link PluginRunRecipeRefusalReason}.
   * Once the user confirms, the run is theirs: an abort no longer cancels it.
   *
   * @throws {Error} If `recipeId` names no recipe this plugin contributes, or a
   *   variable is undeclared, not a string, holds control characters, or is
   *   longer than 8,192 characters (32,768 across all of them).
   */
  runRecipe(
    recipeId: string,
    options?: PluginRunRecipeOptions,
    callOptions?: PluginHostCallOptions
  ): Promise<PluginRunRecipeResult>;
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
   * so plugins never clobber each other's badge on the same panel. Any panel id
   * is accepted, but a badge on a panel of a kind this plugin did not contribute
   * is drawn neutral and names the plugin (see {@link PluginPanelBadgeColor}).
   * Setting the badge a panel already carries sends nothing. A plugin badges at
   * most 256 panels at once: a new panel past that rejects, while an update or
   * a clear always goes through.
   *
   * Like {@link invalidateFileDecorations} this is NOT revoke-guarded: plugins
   * call it from post-activation subscription callbacks and timers, and it
   * becomes a silent no-op once the plugin is unloaded (all of the plugin's
   * badges are cleared on unload). An invalid `panelId` or badge shape (e.g. a
   * `label` longer than {@link PLUGIN_PANEL_BADGE_LABEL_MAX} characters) rejects
   * so authoring mistakes surface loudly. (For a dev-mode plugin running in the
   * hot-reload worker this is fire-and-forget like
   * {@link invalidateFileDecorations}: a malformed badge shape is logged in the
   * host rather than rejected back to the `await`, though an empty `panelId` is
   * still rejected synchronously worker-side.)
   */
  setPanelBadge(panelId: string, badge: PluginPanelBadge | null): Promise<void>;
  /**
   * Set (or clear) a live badge on one of this plugin's own toolbar buttons —
   * `buttonId` is a `contributes.toolbarButtons[].id` from this plugin's
   * manifest — so a count or status stays visible while the plugin's panel is
   * closed. Takes the same {@link PluginPanelBadge} shape and limits as
   * {@link setPanelBadge}; pass `null` to clear it.
   *
   * The badge shows in full on the button's plugin-tray row and in the overflow
   * menu. On a button the user promoted to the toolbar, a numeric `label`
   * shows as a count pill (capped at `9+`), and a `dot` or any other label shows
   * as a pip, with the full text in its tooltip. While the tray is collapsed,
   * its own button shows a dot for any badged row that isn't promoted.
   *
   * Like {@link setPanelBadge} this is NOT revoke-guarded, becomes a silent
   * no-op once the plugin is unloaded (all of its toolbar badges are cleared on
   * unload), and rejects an empty or foreign `buttonId` or an invalid badge.
   * (In the hot-reload worker an empty `buttonId` still rejects; a foreign id or
   * malformed badge is logged in the host instead.)
   */
  setToolbarButtonBadge(buttonId: string, badge: PluginPanelBadge | null): Promise<void>;
  /**
   * Set (or clear) the live state of one of this plugin's own toolbar buttons —
   * `buttonId` is a `contributes.toolbarButtons[].id` from this plugin's
   * manifest — so a toggle shows whether it is on, a button can say why it
   * can't run, and running work shows on the button that started it. Each call
   * replaces the button's whole {@link PluginToolbarButtonRuntimeState}; pass
   * `null` to return it to the manifest's defaults.
   *
   * State shows on a promoted button, its plugin-tray row and its overflow-menu
   * entry. A disabled or busy button ignores clicks; the action itself stays
   * dispatchable from keybindings, the palette and `host.dispatch`. The label
   * never changes with state.
   *
   * Like {@link setToolbarButtonBadge} this is NOT revoke-guarded and becomes a
   * silent no-op once the plugin is unloaded; all of its button state is cleared
   * on unload and whenever its worker is replaced or shut down. An empty or
   * foreign `buttonId` or an invalid state rejects, in a worker as in process.
   */
  setToolbarButtonState(
    buttonId: string,
    state: PluginToolbarButtonRuntimeState | null
  ): Promise<void>;
  /**
   * Publish one of this plugin's own context keys to `when` clauses, so a
   * keybinding or `contributes.contextMenus` entry can turn on and off with the
   * plugin's state. The host namespaces the key under this plugin's manifest
   * name: `setContext("needsYou", true)` from `acme.beads` is read as
   * `acme.beads.needsYou`. A plugin can never set a built-in key or another
   * plugin's. Pass `null` to clear the key.
   *
   * A key is letters, digits, `_` and `-`, at most
   * {@link PLUGIN_CONTEXT_KEY_LENGTH_MAX} characters, with no dots; a string
   * value is at most {@link PLUGIN_CONTEXT_VALUE_LENGTH_MAX} characters; a
   * plugin holds at most {@link PLUGIN_CONTEXT_KEYS_MAX} keys at once. A
   * violation rejects. As in every `when` clause, a bare key is true for `true`
   * or a non-empty string, and `==` compares exactly.
   *
   * Native application menu `menuItems` do not see these keys. Keys are not
   * persisted and are cleared when the plugin unloads or its worker is
   * replaced, so republish them after a restart. Like {@link setPanelBadge}
   * this is NOT revoke-guarded and becomes a silent no-op once the plugin is
   * unloaded.
   */
  setContext(key: string, value: PluginContextValue | null): Promise<void>;
  /**
   * Show (or clear) this plugin's status on one worktree's card — a short
   * one-line `label` with an optional `tooltip` for the detail. Pass `null` to
   * clear it. A plugin holds one status per worktree, so a second call
   * replaces the first; every plugin that marks a card gets its own chip,
   * named after the plugin, so several plugins never hide each other.
   *
   * `worktreeId` is a worktree this host can see right now: the `id` (or
   * `worktreeId`) of an entry in {@link getWorktreesResult}. A project plugin
   * only ever reaches its own project's worktrees. The call rejects when the
   * id is not one of them, when the host has no worktree answer yet, or when
   * the label is empty, multi-line or longer than
   * {@link PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX} characters, or the tooltip
   * longer than {@link PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX}.
   *
   * An optional `command` makes the chip a button for one of the plugin's own
   * actions, written `"{manifestId}.{id}"`: a click dispatches it with
   * `{ worktreeId }`, the card's own id, so a declared `inputSchema` must
   * accept that. A command in any other namespace, or one that names a
   * built-in action, rejects. It need not be registered yet; until it is, the
   * chip stays a plain status.
   *
   * Statuses are not persisted. They are cleared when the worktree is
   * removed, when its project closes, and when the plugin unloads or its
   * worker is replaced, so republish them after a restart. Like
   * {@link setPanelBadge} this is NOT revoke-guarded and becomes a silent
   * no-op once the plugin is unloaded.
   */
  setWorktreeCardStatus(worktreeId: string, status: PluginWorktreeCardStatus | null): Promise<void>;
  /**
   * Publish (or clear) this plugin's advisory readiness checks for one
   * worktree. They show attributed to the plugin in the Review Hub's readiness
   * rail and in the `worktree.reviewReadiness` tool's `pluginChecks`, and never
   * change whether commit or push is ready. Each call replaces the plugin's
   * whole list for that worktree; pass `null` or `[]` to clear it.
   *
   * `worktreeId` is a worktree this host can see right now, as for
   * {@link setWorktreeCardStatus}. The call rejects when it is not one of
   * them, when the host has no worktree answer yet, when a check is malformed
   * (empty or multi-line label longer than
   * {@link PLUGIN_WORKTREE_REVIEW_CHECK_LABEL_MAX}, a severity other than
   * `"warning"` or `"info"`, detail longer than
   * {@link PLUGIN_WORKTREE_REVIEW_CHECK_DETAIL_MAX}), or when the list holds
   * more than {@link PLUGIN_WORKTREE_REVIEW_CHECKS_MAX} checks. A `command`
   * follows the rules of {@link PluginWorktreeCardStatus.command}.
   *
   * Checks are not persisted. They are cleared when the worktree is removed,
   * when its project closes, and when the plugin unloads or its worker is
   * replaced, so republish them after a restart. Like {@link setPanelBadge}
   * this is NOT revoke-guarded and becomes a silent no-op once the plugin is
   * unloaded.
   */
  setWorktreeReviewChecks(
    worktreeId: string,
    checks: readonly PluginWorktreeReviewCheck[] | null
  ): Promise<void>;
  /**
   * Show (or clear) this plugin's status chip on one terminal's header (#13802)
   * — a short one-line `label` with an optional `tooltip` for the detail. Pass
   * `null` to clear it. A plugin holds one status per terminal, so a second
   * call replaces the first; every plugin that marks a terminal gets its own
   * chip, named after the plugin. The chip is colourless: the pane's accent
   * and glyphs stay with agent state.
   *
   * Requires `agent:read`. `terminalId` is the `terminalId` of an entry in
   * {@link PluginAgentsApi.list} right now, so a project plugin only ever
   * reaches its own project's agent terminals. The call rejects when the id is
   * not one of them, when the host cannot read the list, when the plugin holds
   * the maximum of {@link PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT} statuses in
   * the project, or when the label is empty, multi-line or longer than
   * {@link PLUGIN_TERMINAL_STATUS_LABEL_MAX} characters or the tooltip longer
   * than {@link PLUGIN_TERMINAL_STATUS_TOOLTIP_MAX}.
   *
   * An optional `command` makes the chip a button for one of the plugin's own
   * actions, written `"{manifestId}.{id}"`: a click dispatches it with
   * `{ terminalId, worktreeId? }` (the terminal's worktree, when it has one),
   * so a declared `inputSchema` must accept that. A command in any other
   * namespace, or one that names a built-in action, rejects. It need not be
   * registered yet; until it is, the chip stays a plain status.
   *
   * Statuses are not persisted. They are cleared when the project closes and
   * when the plugin unloads or its worker is replaced, so republish them after
   * a restart. Like {@link setPanelBadge} this is NOT revoke-guarded and
   * becomes a silent no-op once the plugin is unloaded.
   */
  setTerminalStatus(terminalId: string, status: PluginTerminalStatus | null): Promise<void>;
  /**
   * Report (or clear) what this plugin is doing on one of its own panels
   * (#13820): `working`, `waiting` on the user, `finished` or `failed`, with an
   * optional one-line `reason`. Pass `null` to clear it. The host draws it the
   * way it draws agent activity — working and waiting borders in the grid
   * (when the user's grid highlights are on), a glyph in the panel header and
   * on the dock chip — and every mark reads "Reported by" your plugin. A
   * `finished` report draws as unread until the panel has been in front of the
   * user; a `failed` one stays until you change or clear it.
   *
   * Only panels of a kind this plugin contributes with `reportsActivity: true`.
   * The call rejects for another plugin's panel, a built-in panel, a kind that
   * does not declare `reportsActivity`, a `reason` that is empty, multi-line or
   * longer than {@link PLUGIN_PANEL_ACTIVITY_REASON_MAX} characters, or a new
   * panel past {@link PLUGIN_PANEL_ACTIVITY_MAX_PANELS} reports. A panel id
   * the host has not seen yet (one `panel.openPluginPanel` just returned) is
   * accepted and drawn once the panel shows up as yours; a report on a panel
   * that has closed is dropped. Reporting the state a panel already shows
   * sends nothing.
   *
   * Reports are not persisted, and are cleared when the plugin unloads or its
   * worker is replaced. Like {@link setPanelBadge} this is NOT revoke-guarded
   * and becomes a silent no-op once the plugin is unloaded.
   */
  setPanelActivity(panelId: string, activity: PluginPanelActivity | null): Promise<void>;
  /**
   * Publish the contextual actions the ⋯ and right-click menus of one of this
   * plugin's own panels offer right now — the backend-side twin of the view's
   * `PanelViewProps.setMenuItems`, and the only way a PTY-backed panel (which
   * has no view) gets entries of its own. They appear in the plugin's group,
   * after the manifest's `menu` entries and any the view published; the host's
   * own entries keep their place and order.
   *
   * Each call replaces this plugin's list for that panel; `null` (or `[]`)
   * clears it. Every `actionId` must be one of your own actions, written
   * `"{manifestId}.{id}"`; an entry shows while its action is registered and is
   * dispatched with `{ panelId }`, through the action's own danger tier. At most
   * five entries; labels default to the action's title and are cut at 80
   * characters.
   * Panel ids come from {@link onDidChangePanelLifecycle} or the `{ panelId }`
   * that `panel.openPluginPanel` returns.
   *
   * Entries only ever show on a panel of a kind this plugin contributed. The
   * list is not persisted: clear it when the panel reports `removed`, and
   * republish after a restart. Every list this plugin published is dropped when
   * it unloads.
   *
   * Like {@link setPanelBadge} this is NOT revoke-guarded and becomes a silent
   * no-op once the plugin is unloaded. An empty `panelId` or an invalid list (a
   * foreign or built-in action, a duplicate, too many entries) rejects. (In a
   * worker the list is vetted before it crosses the port, so those still
   * reject; only the host's 256-panel cap is logged there rather than
   * rejected.)
   */
  setPanelMenuItems(
    panelId: string,
    items: readonly PanelMenuItemContribution[] | null
  ): Promise<void>;
  /**
   * Ask the host to discard one of this plugin's own panel views and mount a
   * fresh one (#12610) — the backend-side twin of the view's
   * `PanelViewProps.requestReload`. Use it when the worker has finished work
   * whose view should start clean, without restarting the worker and rebinding
   * every panel it owns. Panel ids come from {@link onDidChangePanelLifecycle}.
   *
   * No capability is required: only panels of kinds this plugin instance
   * contributed can be targeted, and the caller's identity comes from this
   * host, never from an argument. A project plugin reaches only its own
   * project's panels.
   *
   * Resolves with a {@link PanelReloadResult} — a scheduling acknowledgment,
   * never confirmation of a render. Reloads draw on the same per-panel budget
   * as `requestReload` (three per rolling 30 seconds, after which the view is
   * stopped until the user reloads it). A panel that is not mounted resolves
   * `"not-mounted"` and is not opened or focused.
   *
   * Like {@link setPanelBadge} this is NOT revoke-guarded, and resolves
   * `"unavailable"` once the plugin is unloaded.
   *
   * @throws {Error} (as a rejection) if `panelId` is not a non-empty string,
   *   names another plugin's panel, or names a panel that belongs to no plugin.
   */
  reloadPanel(panelId: string): Promise<PanelReloadResult>;
  /**
   * Restart this plugin's own worker (#13410): the same restart as the
   * "Restart plugin" button. Panels rebind to the new worker rather than
   * closing. Use it to recover when host calls keep timing out — every host
   * call still outstanding in the old worker is abandoned with it.
   *
   * Resolves with a {@link WorkerRestartResult} before the restart begins.
   * One request per 30 seconds is accepted; the rest resolve
   * `"rate-limited"`, and nothing is queued. A plugin that runs in
   * process (a builtin) has no worker and resolves `"unavailable"`.
   *
   * No capability is required. NOT revoke-guarded, and resolves
   * `"unavailable"` once the plugin is unloaded.
   */
  restartWorker(): Promise<WorkerRestartResult>;
  /**
   * Surface a toast notification. The host prefixes the message with the
   * plugin's manifest `displayName` (or `name` when it has none),
   * `{displayName}: {message}`, for provenance. The label is resolved host-side
   * from the `pluginId` bound at activation rather than taken from the plugin;
   * the id itself is never shown, since a project plugin's id is an instance
   * key. Display names need not be unique. Routes
   * through the app's `notify()` path so rate-limit, quiet-hours, and
   * inbox-history semantics apply identically to plugin toasts. One rate limit
   * covers all of a plugin's toasts, whatever their `type`, and its
   * {@link notify} calls; past it in main a toast is dropped quietly. The inbox
   * row names the plugin and its project, and a toast from a plugin the user
   * silenced, or from a project the user muted, is never sent.
   *
   * Like {@link invalidateFileDecorations} this is NOT revoke-guarded: plugins
   * call it from post-activation subscription callbacks and timers. It becomes
   * a silent no-op once the plugin is unloaded. Invalid options (empty message,
   * unknown `type`) reject so authoring mistakes surface loudly.
   */
  showToast(options: PluginToastOptions): Promise<void>;
  /**
   * Raise a notification with up to {@link PLUGIN_NOTIFY_MAX_ACTIONS} buttons,
   * each running one of the caller's own actions (#13505). It routes through
   * the app's notification path like {@link showToast} — inbox, focus, quiet
   * hours, session mute and the plugin's rate limit, shared with its toasts —
   * and the title carries the plugin's display name for provenance. A call
   * past that limit shows, pages and replaces nothing, and so does a call from
   * a plugin the user silenced or in a project the user muted.
   *
   * `delivery: "passive"` keeps it to the inbox. A `severity: "error"` needs
   * exactly one action and can't be passive. A `target` gives the inbox row a
   * Go to source.
   *
   * `os: true` also asks for an OS banner. Banners carry no buttons: clicking
   * one brings the plugin's project forward and runs the first action. The
   * call rejects when `notification:os` isn't declared; with it declared and
   * the user's switch off, the banner is quietly dropped.
   *
   * NOT revoke-guarded, like {@link showToast}: it resolves with an id and
   * shows nothing once the plugin is unloaded. Invalid options and actions
   * outside the plugin's namespace reject.
   */
  notify(options: PluginNotifyOptions): Promise<PluginNotifyResult>;
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
   *
   * `options.projectId` sends the dispatch to that project's view instead of
   * the focused one (#13119). An installed plugin must declare
   * `project:dispatch` and the user must turn on "Allow project targeting" for
   * it, or the call rejects with `PERMISSION_REQUIRED`. A project-bound plugin
   * may only name its own project. A project with no live view rejects with
   * `PROJECT_VIEW_UNAVAILABLE` — nothing opens or wakes a closed project —
   * except an installed plugin's targeted `terminal.close`, which Daintree
   * runs itself and answers with `{ closedIds }` (#13507).
   */
  dispatch(
    actionId: ActionId,
    args?: unknown,
    options?: PluginDispatchOptions
  ): Promise<ActionDispatchResult>;
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
   *
   * Aborting `callOptions.signal` dismisses the open palette and resolves
   * `undefined` rather than rejecting — a cancelled prompt is a dismissal, not a
   * failure, so the never-throws contract above still holds (#12279). This is
   * the one place {@link PluginHostCallOptions} settles instead of rejecting.
   *
   * The one rejection a well-formed prompt can meet is `NO_FRONTEND_ATTACHED:`,
   * when the project is on a host nobody is attached to; see
   * {@link PluginPromptCallOptions.whenNoFrontend}.
   */
  showQuickPick(
    items: PluginQuickPickItem[],
    options: PluginQuickPickOptions & { canSelectMany: true },
    callOptions?: PluginPromptCallOptions
  ): Promise<PluginQuickPickItem[] | undefined>;
  showQuickPick(
    items: PluginQuickPickItem[],
    options?: PluginQuickPickOptions,
    callOptions?: PluginPromptCallOptions
  ): Promise<PluginQuickPickItem | undefined>;
  /**
   * Imperatively prompt the user for a line of text, rendered through the app's
   * dialog surface. Resolves with the entered string, or `undefined` if the user
   * cancels (Escape / Cancel). A non-empty {@link PluginInputBoxOptions.validationPattern}
   * is enforced client-side at submit time.
   *
   * Async and NOT revoke-guarded for the same reason as {@link showQuickPick};
   * resolves `undefined` if the plugin is unloaded while the dialog is open, and
   * aborting `callOptions.signal` dismisses it and resolves `undefined` too.
   */
  showInputBox(
    options?: PluginInputBoxOptions,
    callOptions?: PluginPromptCallOptions
  ): Promise<string | undefined>;
  /**
   * Imperatively ask the user to confirm an action, rendered through the app's
   * `ConfirmDialog`. Resolves `true` if confirmed, `false` if cancelled,
   * dismissed, or the plugin is unloaded while the dialog is open.
   *
   * Async and NOT revoke-guarded for the same reason as {@link showQuickPick}.
   * Aborting `callOptions.signal` dismisses the dialog and resolves `false`.
   * For an irreversible action set {@link PluginConfirmOptions.destructive} and
   * use a verb-noun `confirmLabel`.
   */
  showConfirm(
    options: PluginConfirmOptions,
    callOptions?: PluginPromptCallOptions
  ): Promise<boolean>;
  /**
   * Persistent, plugin-scoped key/value settings. JSON storage with `chmod 0o600`
   * on POSIX; declared secrets are encrypted through the OS keychain. See
   * {@link SettingsApi}.
   */
  readonly settings: SettingsApi;
  /**
   * The host-managed account declared in `contributes.account`. See
   * {@link PluginAccountApi}. NOT revoke-guarded: plugins ask for a token from
   * timers and callbacks. `getState` and `getAccessToken` reject when the
   * manifest declares no account, and once the plugin is unloaded.
   */
  readonly account: PluginAccountApi;
  /**
   * Calls into services other plugins provide (#14105). See
   * {@link PluginServicesApi}. NOT revoke-guarded; calls made before
   * `activate()` returns resolve as `unavailable`.
   */
  readonly services: PluginServicesApi;
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
   * Host-managed SQLite databases declared in `contributes.databases`. See
   * {@link PluginDatabaseApi}. NOT revoke-guarded: open and query from timers
   * and callbacks. Open handles close when the plugin unloads.
   */
  readonly db: PluginDatabaseApi;
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
   * Long-running work shown in the host's background-work readout (#13819).
   * See {@link PluginTaskApi}. Needs no capability.
   *
   * NOT revoke-guarded: plugins start tasks from commands and timers long
   * after activate(). Once the plugin is unloaded `start` hands back an inert
   * handle, and handles it gave out earlier stop doing anything.
   */
  readonly tasks: PluginTaskApi;
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
   * on `clipboard:write`. Text reads/writes plus bounded PNG writes; runs in the
   * main process so it works from a headless plugin. See
   * {@link PluginClipboardApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}.
   */
  readonly clipboard: PluginClipboardApi;
  /**
   * Host-mediated "open with the default app" / "reveal in file manager"
   * surface, scoped to the plugin's own declared filesystem roots — including
   * its implicit `~/.daintree/plugin-data/<plugin-id>/` namespace, which the
   * renderer's built-in `system.openPath` action cannot reach. Gated on the
   * `fs:*` capability matching the resolved root's class. See
   * {@link PluginSystemApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}.
   */
  readonly system: PluginSystemApi;
  /**
   * Host-mediated document export — HTML to PDF, rendered in the main process
   * and written under the same gates as {@link PluginFsApi.writeFile}. See
   * {@link PluginDocumentsApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}.
   */
  readonly documents: PluginDocumentsApi;
  /**
   * Host-managed large files — imports, provider downloads and uploads, and
   * playback in views — gated on `artifact:store`. Bytes never cross the
   * plugin's channel. See {@link PluginArtifactApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}. Unloading
   * cancels the plugin's transfers and drops its artifacts.
   */
  readonly artifacts: PluginArtifactApi;
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
  /**
   * JSON Schema the action's result must match, with `type: "object"` at the
   * root. Compiled when the action registers (JSON Schema 2020-12 unless
   * `$schema` names draft-07; references resolve only inside the schema) and
   * refused there if it can't be enforced as written. Each result is checked in
   * its JSON form, and that copy is what the caller receives — a `Date` arrives
   * as its ISO string — but nothing is coerced, defaulted or stripped to make it
   * fit. One that does not match fails the dispatch with
   * `RESULT_VALIDATION_ERROR`. Published to callers as the catalog entry's
   * `outputSchema`, and to agents as the MCP tool's.
   */
  resultSchema?: PluginActionResultSchema;
  /**
   * `when` clause over the plugin's own context keys (`host.setContext`). While
   * it is false the command is left out of the command palette. Palette-only:
   * keybindings, context menus, MCP and `host.dispatch` never evaluate it, so it
   * decides what is offered, not what can run. A clause that fails to parse is
   * refused at registration.
   */
  when?: string;
  /**
   * Same grammar as {@link when}. While it is false the command stays in the
   * palette, greyed out with a short reason, and Enter does nothing. Also
   * palette-only.
   */
  enablement?: string;
  /**
   * Per-action capability intent: the subset of the plugin's declared
   * `manifest.capabilities` this specific action actually exercises. Mirrors
   * {@link PluginChannelSchema.requires} in both spelling and enforcement — the
   * host rejects registration if any entry is missing from the manifest, so an
   * action can never claim authority the plugin never asked the user for.
   *
   * This narrows which capabilities the danger computation consults, so a
   * no-authority action in a high-authority plugin stays one click:
   *
   * - **omitted** — every manifest capability is consulted (today's behavior,
   *   preserved verbatim so existing plugins need no migration and a plugin
   *   that never opts in cannot accidentally de-escalate).
   * - **`[]`** — the action declares no capability intent and may stay `"safe"`
   *   even when the plugin holds `shell:exec` elsewhere.
   * - **non-empty** — only the listed capabilities are consulted, both for the
   *   flat high-risk set and the compound-capability lattice.
   *
   * It is a *classification* input only: it never grants access. Host APIs
   * still gate on `manifest.capabilities` at call time, so listing a capability
   * here neither adds nor removes runtime authority. Declaring
   * `danger: "confirm"` still pins the action to confirm regardless.
   */
  requires?: readonly BuiltInPluginCapability[];
}

/** A {@link PluginActionContribution.resultSchema}: a JSON Schema whose root is an object. */
export type PluginActionResultSchema = { type: "object" } & Record<string, unknown>;

export interface PluginActionDescriptor extends PluginActionContribution {
  pluginId: string;
  /**
   * The providing plugin's name, set by the host from its manifest
   * (`displayName`, else `name`) — never from the contribution.
   */
  pluginName?: string;
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
   *
   * When the contribution declares {@link PluginActionContribution.requires},
   * the capabilities consulted here narrow to that subset — the host still
   * derives the verdict itself, it just asks a more precise question. Omitting
   * `requires` keeps the whole-manifest derivation.
   */
  effectiveDanger: "safe" | "confirm";
}

/**
 * Durable scope a plugin's persisted per-plugin state belongs to. `"global"`
 * covers installed and builtin plugins, which are app-wide by design; a
 * project-scoped plugin uses its app-minted `projectId` (see `mintProjectId`),
 * which is derived from the normalized folder path and stored outside the
 * repository — so a repository cannot forge or address another project's key.
 */
export type PluginScopeKey = "global" | (string & {});

/**
 * Hostname segment of a `plugin://` URL. Minted per loaded plugin instance and
 * invalidated on unload, so a URL captured before an unload resolves to
 * nothing rather than into whatever now occupies that plugin id.
 *
 * Not a secret. It is a namespace, not a capability — never build
 * authorization on possession of one.
 */
export type PluginProtocolAuthority = string & {
  readonly __brand: "PluginProtocolAuthority";
};

/**
 * Binds a plugin's host API to one project. Built once per plugin instance and
 * captured by every closure in the host object, so "which project?" is
 * answerable from the binding instead of from whichever window happens to be
 * focused when the plugin calls.
 *
 * `projectId: null` marks an unbound plugin — installed and builtin plugins,
 * which stay app-global. Unbound host surfaces still resolve their target from
 * focus; each such site says so explicitly at the call site. A bound plugin
 * never consults focus, because a plugin acting on a project it does not
 * belong to is never right.
 */
export interface PluginHostBinding {
  /** Owning project, or null for an app-global (installed/builtin) plugin. */
  readonly projectId: string | null;
  /** Absolute, realpath-resolved project root. Null iff `projectId` is null. */
  readonly projectRoot: string | null;
}

/** An unbound binding — the app-global default for installed and builtin plugins. */
export const UNBOUND_PLUGIN_HOST_BINDING: PluginHostBinding = {
  projectId: null,
  projectRoot: null,
};

/**
 * What the user decided about a project's `.daintree/plugins/` folder.
 *
 * `"session"` is deliberately absent from the persisted record — an
 * enable-for-this-session choice lives in memory only and is gone on relaunch,
 * which is the whole point of offering it.
 */
export type ProjectPluginTrustDecision = "enabled" | "disabled" | "session";

/** The persisted half of a project's plugin trust state. */
export interface ProjectPluginTrustRecord {
  /** Persisted decisions only. A `"session"` enable never reaches this record. */
  decision: "enabled" | "disabled";
  /** Epoch ms of the decision, for the plugin manager's audit line. */
  decidedAt: number;
  /**
   * Manifest ids this project has already surfaced to the user — activated,
   * declined, or merely staged. A plugin id absent from here is NEW, and new is
   * the one content change worth a notification. A plugin that disappears and
   * comes back is still in this list, so it is treated as known, not new.
   */
  knownPluginIds: string[];
  /**
   * Manifest ids staged and not activated. Staged plugins are parsed but never
   * executed. A declined stage stays here so it does not re-notify on every
   * subsequent edit.
   */
  stagedPluginIds: string[];
  /**
   * Manifest ids the user switched off individually. Skipped by the reconcile
   * exactly the way staged ids are, so a muted plugin is parsed and described
   * but never run.
   *
   * Deliberately NOT a trust decision. Trust is granted once, at the folder, and
   * stays there; muting is the ordinary case of two plugins in one repo where
   * one should stay quiet. Keeping it a separate list is what lets the switch
   * exist without giving trust a per-plugin granularity it does not have — and
   * why unmuting re-loads rather than re-prompting.
   */
  mutedPluginIds: string[];
}

/**
 * Per-project visibility for INSTALLED (global) plugins — the overlay that lets
 * one installed plugin be on in project A and off in project B.
 *
 * Keyed by manifest id; `true` is an explicit allow and `false` an explicit
 * deny. A plugin absent from the map takes the default, which is visible — so
 * the overlay is empty in an app where nobody has changed anything, and every
 * contribution filter short-circuits to the identity it had before this
 * existed. Storing the tri-state rather than a bare deny list is what would let
 * a future "off by default, opt in per project" mode flip the default without
 * rewriting anyone's stored decisions.
 *
 * This lives in Daintree's own store keyed by project id, never in the
 * repository — the same place VS Code keeps workspace enablement, and for the
 * same reason: it is one person's choice about one checkout, not a fact about
 * the project that every collaborator should inherit.
 */
export interface ProjectPluginVisibility {
  /**
   * Manifest ids hidden by DEFAULT — in every project that has not said
   * otherwise. This is the half that makes "on only in the projects I pick"
   * expressible: without it the only reachable shape is "on everywhere, minus
   * the projects I have visited and switched off", which silently turns itself
   * back on in every project created afterwards.
   */
  defaultHiddenPluginIds: string[];
  /**
   * Explicit decisions for THIS project, keyed by manifest id. An entry beats
   * the default in either direction; absence takes the default.
   */
  overrides: Record<string, boolean>;
}

/**
 * `plugin:project-plugin-visibility-changed` — the full overlay for one
 * project, pushed to that project's renderers after any change so the settings
 * tab is reactive rather than refetching.
 */
export interface ProjectPluginVisibilityChangedEvent {
  projectId: string;
  visibility: ProjectPluginVisibility;
}

/** Runtime state of one plugin directory found under a project's `.daintree/plugins/`. */
export type ProjectPluginState =
  /**
   * Registered with the host. It is a load observation, not an activation one:
   * a lazy plugin is `active` before its `activate()` has ever run, and one
   * whose `activate()` threw stays `active` and carries {@link
   * ProjectPluginInfo.loadError}. Collapsing the two would conflate the trust
   * and load lifecycle with the most recent activation outcome.
   */
  | "active"
  /** Manifest valid, trust granted, but the id is new — parsed, never executed. */
  | "staged"
  /** Manifest valid; no trust decision, or trust is disabled. Never executed. */
  | "blocked"
  /** The directory does not hold a loadable manifest. Never executed. */
  | "invalid";

/** One row of the project's plugin list, as the plugin manager and the trust gate render it. */
export interface ProjectPluginInfo {
  /** Owning project. */
  projectId: string;
  /** Manifest id (`publisher.name`), or the directory name when the manifest is unreadable. */
  id: string;
  /** The key this plugin loads under. Absent for an invalid manifest. */
  instanceId?: string;
  displayName: string;
  version: string;
  description?: string;
  /** Declared capabilities, disclosed in the manager. Never a consent gate. */
  capabilities: PluginCapability[];
  /** The manifest's `worksWith`, disclosed in the manager. Absent when it lists none. */
  worksWith?: string[];
  /** Declared `contributes.databases`, disclosed in the manager. */
  databases?: PluginDatabaseContribution[];
  /**
   * Declared `contributes.settings`, so the plugin's Settings section can still
   * say what it holds while the plugin isn't running and no loaded instance
   * carries its manifest. Absent when it declares none.
   */
  settings?: SettingDefinition[];
  /** The manifest declares a `location: "settings"` view. */
  declaresSettingsView?: boolean;
  /** The manifest declares `contributes.worktreeDeleteNotes`, so the manager offers its mute (#13805). */
  declaresWorktreeDeleteNotes?: boolean;
  /** Directory name under `.daintree/plugins/`. Not required to equal `id`. */
  dirName: string;
  state: ProjectPluginState;
  /**
   * The user switched this plugin off on its own. Orthogonal to {@link state}:
   * a muted plugin never loads, so it reads as `"blocked"` like any other
   * plugin that is not running — this is what says the folder is trusted and
   * this one plugin is the thing that was turned off.
   */
  muted: boolean;
  /** Why the directory was rejected at discovery. Set iff `state === "invalid"`. */
  error?: string;
  /**
   * Most recent load or activation failure for the loaded instance — a thrown
   * `activate()`, a worker that failed to fork, an activation that never
   * settled, or a manifest command that could not be registered (#12232).
   *
   * Distinct from {@link error}, which is a discovery-time rejection of a
   * directory that never loaded. This one describes a plugin that *did* load,
   * so it is orthogonal to `state` and can accompany `"active"`. Held in
   * memory only for the life of the load: a project plugin has no installed
   * provenance record to persist it into, by design.
   */
  loadError?: PluginLoadError;
  /**
   * An installed or builtin plugin already claims this manifest id. Both load —
   * the instance key keeps them apart — and the collision is surfaced here
   * rather than resolved silently.
   */
  collidesWithGlobal: boolean;
}

/** The trust state a renderer needs to decide whether to prompt. */
export interface ProjectPluginTrustState {
  projectId: string;
  /** `null` when no decision is on record — the only state that may prompt. */
  decision: ProjectPluginTrustDecision | null;
  /** Whether project plugins are currently permitted to run. */
  enabled: boolean;
  /**
   * True when the decision is durably on disk. A decision the store refused to
   * write is still in force while the project stays open but is not remembered,
   * so the next open reads whatever record it replaced.
   */
  persisted: boolean;
}

/**
 * `plugin:project-trust-prompt` — the one signal that may open the project
 * plugin trust dialog. The controller emits it only when the folder holds at
 * least one valid manifest and no decision is on record, so the renderer never
 * decides for itself that a prompt is due.
 */
export interface ProjectPluginTrustPromptEvent {
  projectId: string;
  /** Every valid manifest in the folder, named so the dialog can list them. */
  plugins: Array<{ id: string; displayName: string }>;
}

/**
 * `plugin:project-plugins-changed` — a full snapshot, emitted on every project
 * open, trust change and staged activation. It carries everything the plugin
 * manager renders, so the manager can be purely reactive rather than refetching.
 */
export interface ProjectPluginsChangedEvent {
  projectId: string;
  plugins: ProjectPluginInfo[];
  trust: ProjectPluginTrustState;
  /** The project's application, or `null` when none of its plugins declares one. */
  application?: ProjectApplicationState | null;
}

/**
 * `plugin:project-plugin-staged` — a manifest id this project has never had
 * appeared in a trusted folder. Non-blocking, and emitted once per new id: a
 * staged plugin the user ignored or declined never re-announces itself.
 */
export interface ProjectPluginStagedEvent {
  projectId: string;
  pluginId: string;
  displayName: string;
}

/**
 * Health of the artifact watcher behind a `daintree-plugin dev` session.
 *
 * - `watching` — armed on the plugin root; rebuilds reload the plugin.
 * - `waiting` — the plugin directory is not there yet (a session started before
 *   the first build landed). Rebuilds are not observed, but the session is
 *   healthy and will arm itself when the directory appears.
 * - `degraded` — the watch stopped reporting and could not be re-armed. Hot
 *   reload is off until the session restarts; this is the state that has to be
 *   visible, because the symptom is otherwise indistinguishable from "my
 *   rebuild changed nothing".
 */
export type PluginDevWatcherState = "watching" | "waiting" | "degraded";

/**
 * Lifecycle of one plugin's backend worker, as a mounted panel sees it (#12278).
 *
 * Every user-installed plugin (dev and prod alike) runs its `activate()` inside
 * a forked `utilityProcess`. Until now nothing told a panel what that process
 * was doing, so a worker that crashed left the panel rendering stale content
 * with no way to understand it. These are the states the shell renders on the
 * plugin's behalf, and they come from explicit lifecycle edges only:
 *
 * - `starting` — a worker process exists (or is being forked) but has not yet
 *   completed its `ready` handshake. Also the state a crash respawn lands in,
 *   which is what the shell renders as "Reloading".
 * - `activating` — the handshake landed; the plugin's `activate()` is running.
 * - `ready` — activation committed. It describes a settled activation, NOT
 *   continuous proof of responsiveness: a worker that wedges on a request
 *   afterwards still reads `ready`, because nothing on this channel probes it.
 * - `failed` — terminal for this generation. Nothing will recover it on its own;
 *   `reason` says why, and the user's way out is a restart.
 * - `stopped` — no worker, deliberately: idle-disposed by governance, or
 *   deactivated. Distinct from `failed`, which is an accident.
 *
 * Never inferred from `PluginDevWorkerHost.isReady()`, which only reports that a
 * child process object exists — true long before `activate()` has run and still
 * true for a worker whose activation failed.
 */
export type PluginWorkerState = "stopped" | "starting" | "activating" | "ready" | "failed";

/**
 * Why a worker is in its current state. Closed by design: each member names a
 * real producer in `PluginService`, so a renderer can branch on the cause
 * without parsing `detail`, which is free-form and may carry plugin-authored
 * text.
 */
export type PluginWorkerReason =
  | "fork-failed"
  | "crashed"
  | "crash-loop"
  | "activation-failed"
  | "activation-timeout"
  | "protocol-violation"
  | "deactivated";

export interface PluginWorkerStatus {
  /**
   * Monotonic id of the worker PROCESS, bumped on every fork including the
   * supervisor's own crash respawns. Deliberately not `viewGeneration`, which
   * counts published module URLs and does not move when only the backend is
   * replaced — a panel needs to know its backend was swapped even though its
   * module specifier did not change.
   */
  generation: number;
  state: PluginWorkerState;
  /** When the worker entered {@link state}, for the shell's stalled-recovery gate. */
  stateSince: number;
  reason: PluginWorkerReason | null;
  /** Free-form cause. May contain plugin-authored text — never render it raw. */
  detail: string | null;
}

/** The `daintree-plugin dev` half of a runtime status (#12277). */
export interface PluginDevSessionStatus {
  /** Completed artifact reloads this session, for the "did my save land?" read. */
  reloadCount: number;
  watcher: PluginDevWatcherState;
  /** Why the watcher is in a non-`watching` state, or the last reload error. */
  detail: string | null;
}

/**
 * Live runtime state of one plugin instance (#12277, #12278).
 *
 * Deliberately a per-plugin snapshot rather than a change notification: the
 * point is that whatever reads it — a panel, a worker diagnostic — agrees on
 * which generation is live, which a fire-and-forget "reloaded" event cannot
 * give you. New facets of an instance's health belong here as additional fields
 * on the same channel, not as a second channel.
 *
 * The two halves are independent and either may be absent:
 * - `worker: null` — this instance has no utility-process backend at all (a
 *   builtin, which activates in-process, or a plugin that has never been
 *   activated). It is NOT the same as `state: "stopped"`, which means a
 *   worker-backed plugin currently has none.
 * - `dev: null` — not a `daintree-plugin dev` session, i.e. every installed and
 *   project-owned plugin.
 */
export interface PluginRuntimeStatus {
  /** Plugin instance id — the key every contribution carries. */
  pluginId: string;
  /**
   * The view generation this plugin's panel kinds are currently published
   * under, i.e. the `__dtv-N` segment in their `componentPath`. `null` while
   * the plugin is not loaded (a reload whose manifest did not parse).
   */
  viewGeneration: number | null;
  worker: PluginWorkerStatus | null;
  dev: PluginDevSessionStatus | null;
}

/**
 * `plugin:runtime-status-changed` — one instance's current state, replacing any
 * prior state for that plugin. A `null` status means the instance left the
 * inventory entirely (unloaded, uninstalled, dev session ended).
 *
 * A worker that FAILED keeps its status after its entry is torn down: the
 * teardown is what the user needs explained, so dropping the status with the
 * worker would erase the only account of why the panel went dark.
 */
export interface PluginRuntimeStatusChangedEvent {
  pluginId: string;
  status: PluginRuntimeStatus | null;
}
