/** Where a project application opens: its claimed Home, or the host's grid. */
export const PLUGIN_APPLICATION_DESTINATIONS = ["home", "grid"] as const;

export type PluginApplicationDestination = (typeof PLUGIN_APPLICATION_DESTINATIONS)[number];

/**
 * How a Home destination shares the main area (#14107): `full` gives the Home
 * the whole area, `beside-grid` draws it beside the host's own panels so agents
 * launched, chosen and focused there never hide it.
 */
export const PLUGIN_APPLICATION_ARRANGEMENTS = ["full", "beside-grid"] as const;

export type PluginApplicationArrangement = (typeof PLUGIN_APPLICATION_ARRANGEMENTS)[number];

/** The welcome tour a project application starts from, and which revision of it. */
export interface PluginApplicationTourRef {
  /** A `contributes.tours[].id` of this plugin, not scoped to a panel kind. */
  id: string;
  /**
   * The tour's welcome revision, a positive integer. Raised when the tour
   * changes enough to be worth offering again; the tour itself is unchanged.
   */
  version: number;
}

/**
 * Bounds on an application's navigation (#14108), shared by the manifest
 * schema and the runtime validator so a declaration the schema admits is one
 * the host can always hold.
 */
export const PLUGIN_APPLICATION_NAVIGATION_LIMITS = Object.freeze({
  maxVersion: 1_000_000,
  maxSections: 24,
  maxIdLength: 64,
  maxTitleLength: 64,
  maxParamsPerSection: 8,
  maxParamNameLength: 32,
  defaultStringLength: 64,
  maxStringLength: 128,
  /** Serialized size of one location, as UTF-8 JSON. */
  maxLocationBytes: 2048,
  /** Entries in one project's history, the current one included. */
  maxHistoryEntries: 30,
});

/**
 * One declared parameter of a section. Values are identifiers, not content:
 * a string holds only the manifest id vocabulary (`[A-Za-z0-9._-]`), so a
 * free-text field, a URL or a token can't be expressed. Only a parameter
 * marked `persist` is written to disk; the rest live as long as the project's renderer.
 */
export type PluginApplicationNavigationParam =
  | { type: "string"; required?: boolean; persist?: boolean; maxLength?: number }
  | { type: "integer"; required?: boolean; persist?: boolean }
  | { type: "boolean"; required?: boolean; persist?: boolean };

/** A named destination of the application: a section, and the record parameters it takes. */
export interface PluginApplicationSection {
  id: string;
  title: string;
  params?: Record<string, PluginApplicationNavigationParam>;
}

/**
 * `application.navigation` (#14108): the destinations the application's
 * views navigate between. The host keeps one location and history per project
 * for them, shared by every view of the application.
 */
export interface PluginApplicationNavigation {
  /**
   * The navigation schema's revision. Raising it drops the saved location and
   * history, so a renamed parameter never restores with its old meaning.
   */
  version: number;
  /** Where the application starts, and where a location that no longer resolves lands. */
  defaultSectionId: string;
  sections: PluginApplicationSection[];
}

/**
 * The top-level `application` block of a project plugin's manifest (#14097).
 *
 * Declarative only: it names the application and points at contributions the
 * same manifest already declares, by their bare ids, and implements none of
 * them. The owner is the plugin whose manifest carries it. Cooperating plugins
 * contribute their own parts and are disclosed through `worksWith`; at most one
 * plugin in a project may declare an application, and a second makes both
 * unavailable rather than picking a winner.
 *
 * Defaults it names (destination, presentation levels) never outrank an
 * answer the user gave, and while the application is anything but active the
 * project shows the standard workspace. See {@link ProjectApplicationState}.
 */
export interface PluginApplicationDescriptor {
  /** The application's name, as the host shows it. */
  name: string;
  /** Same vocabulary as a sidebar view's `iconId`. */
  iconId?: string;
  /** `"home"` requires `contributes.surfaces.projectHome`. */
  destination: PluginApplicationDestination;
  /**
   * The arrangement a `"home"` destination opens in; omitted means `"full"`.
   * A default only: the user's own Home, Split or Grid choice always wins.
   */
  arrangement?: PluginApplicationArrangement;
  /** A `contributes.views[].id` with `location: "sidebar"`. */
  sidebarViewId?: string;
  /** A `contributes.views[].id` with `location: "settings"`: the application's settings home. */
  settingsViewId?: string;
  welcomeTour?: PluginApplicationTourRef;
  /** The bare id of a `contributes.commands` entry of kind `"command"`. */
  firstWorkflow?: string;
  /** `contributes.agentMcp[].id` endpoints the application's agents need. */
  requiredTools?: string[];
  /** Suggested presentation levels, in the host's closed vocabulary. */
  presentation?: Partial<Record<string, "shown" | "demoted" | "hidden">>;
  navigation?: PluginApplicationNavigation;
}

/**
 * Where a project's application stands (#14097).
 *
 * - `loading` — the owner is trusted and on its way in.
 * - `active` — the owner is loaded and the application is in force.
 * - `disabled` — the project's plugins are not trusted, or the owner is muted
 *   or waiting to be turned on.
 * - `unavailable` — the owner failed to load, needs another Daintree version,
 *   failed its preflight (a required file is missing, or a database it
 *   declares was written by a newer copy), or a second plugin also declares
 *   an application.
 * - `replaced` — the owner is loaded, but another plugin holds the project
 *   Home it lands on.
 *
 * Anything but `active` means the standard workspace.
 */
export type ProjectApplicationStatus =
  "loading" | "active" | "disabled" | "unavailable" | "replaced";

export type ProjectApplicationReason =
  | "untrusted"
  | "muted"
  | "staged"
  | "load-failed"
  | "engine-incompatible"
  | "assets-missing"
  | "schema-too-new"
  | "owner-ambiguous";

/** The preflight reasons: checked on disk before the owner's code is loaded (#14113). */
export type ProjectApplicationPreflightReason = Extract<
  ProjectApplicationReason,
  "assets-missing" | "schema-too-new"
>;

/** One project's application, resolved. `null` where no plugin declares one. */
export interface ProjectApplicationState {
  status: ProjectApplicationStatus;
  /** Manifest id of the declaring plugin; the lowest one when ownership is ambiguous. */
  ownerId: string;
  /** The owner's manifest `version`: the payload this state describes. */
  version: string;
  /** The owner's instance key, once it is loaded. */
  instanceId?: string;
  application: PluginApplicationDescriptor;
  /** Why a non-active application is not in force. */
  reason?: ProjectApplicationReason;
  /** For a preflight reason, what was found on disk, one line each. */
  problems?: string[];
  /** For `owner-ambiguous`, every declaring manifest id, sorted. */
  candidates?: string[];
  /** For `replaced`, the INSTANCE key of the plugin holding the project Home. */
  heldBy?: string;
  /** What the project shows instead: always the standard workspace unless active. */
  fallback: "standard-workspace" | null;
}
