import type {
  PluginApplicationNavigation,
  PluginApplicationDestination,
  PluginNavigationLocation,
  PluginNavigationRefusal,
  PluginNavigationResult,
  ProjectApplicationState,
} from "@shared/types/plugin";
import {
  decodeNavigationLocation,
  defaultNavigationLocation,
  navigationLocationsEqual,
  persistableNavigationHistory,
  pushNavigationHistory,
  restoreNavigationHistory,
  type NavigationHistory,
} from "@shared/utils/applicationNavigation";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import { currentProjectSurface } from "@/hooks/useRenderableSurfaceClaim";
import {
  selectApplicationNavigationRecord,
  useApplicationNavigationStore,
  type ApplicationNavigationRecord,
} from "@/store/applicationNavigationStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectHomeStore } from "@/store/projectHomeStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { hasViewUnsavedChanges } from "./pluginPanelLifecycle";

/** The application in force in this project view, when it declares navigation. */
export interface ApplicationNavigationContext {
  /** Host-scoped project id the location is kept under. */
  key: string;
  ownerId: string;
  /** The owner's instance key: the only plugin whose views may navigate. */
  instanceId: string;
  destination: PluginApplicationDestination;
  navigation: PluginApplicationNavigation;
}

/**
 * Whether `application` puts navigation in force for the project keyed
 * `key`. Only an active application does: one loading, disabled, unavailable
 * or replaced is the standard workspace, and its record stays on disk untouched
 * until it is active again.
 */
export function applicationNavigationContext(
  application: ProjectApplicationState | null,
  key: string | null
): ApplicationNavigationContext | null {
  if (key === null || application === null || application.status !== "active") return null;
  const { instanceId, ownerId } = application;
  const navigation = application.application.navigation;
  if (instanceId === undefined || navigation === undefined) return null;
  return {
    key,
    ownerId,
    instanceId,
    destination: application.application.destination,
    navigation,
  };
}

export function currentProjectNavigationKey(): string | null {
  const workspaceId = getViewWorkspaceId();
  return workspaceId ? hostScopedKey(workspaceId) : null;
}

function currentContext(): ApplicationNavigationContext | null {
  return applicationNavigationContext(
    useProjectPluginStore.getState().application,
    currentProjectNavigationKey()
  );
}

/** The project's history, resolved against the live declaration. */
export function resolveApplicationNavigationHistory(
  context: ApplicationNavigationContext,
  record: ApplicationNavigationRecord | null
): NavigationHistory {
  return restoreNavigationHistory(context.navigation, record?.entries, record?.index);
}

function readHistory(context: ApplicationNavigationContext): NavigationHistory {
  const record = selectApplicationNavigationRecord(
    useApplicationNavigationStore.getState(),
    context.key,
    { ownerId: context.ownerId, version: context.navigation.version }
  );
  return resolveApplicationNavigationHistory(context, record);
}

/**
 * The mounted views of each plugin that were handed navigation, by the panel
 * id their unsaved-work flag is kept under. Registered while mounted, so the
 * leave check asks only about views that could lose a form to a move.
 */
const viewsByPlugin = new Map<string, Map<string, number>>();

export function registerApplicationNavigationView(pluginId: string, panelId: string): () => void {
  let views = viewsByPlugin.get(pluginId);
  if (views === undefined) {
    views = new Map();
    viewsByPlugin.set(pluginId, views);
  }
  views.set(panelId, (views.get(panelId) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const current = viewsByPlugin.get(pluginId);
    const count = current?.get(panelId) ?? 0;
    if (count <= 1) current?.delete(panelId);
    else current?.set(panelId, count - 1);
    if (current?.size === 0) viewsByPlugin.delete(pluginId);
  };
}

function holdsUnsavedWork(pluginId: string): boolean {
  for (const panelId of viewsByPlugin.get(pluginId)?.keys() ?? []) {
    if (hasViewUnsavedChanges(panelId)) return true;
  }
  return false;
}

function refuse(reason: PluginNavigationRefusal): PluginNavigationResult {
  return { ok: false, reason };
}

/** Focus has nowhere to be: the document, a node gone from it, or one gone inert. */
function isFocusStranded(): boolean {
  const element = document.activeElement;
  return (
    element === null ||
    element === document.body ||
    !element.isConnected ||
    element.closest("[inert]") !== null
  );
}

/**
 * Bring the application's destination forward. Switching the main area
 * unmounts whatever held focus there, so focus that is left with nowhere to be
 * after the switch lands on the main area; focus anywhere else — the sidebar
 * view the user clicked in, an overlay — is left where it is.
 */
function reveal(context: ApplicationNavigationContext): void {
  const home = useProjectHomeStore.getState();
  if (context.destination === "home") {
    const surface = currentProjectSurface("projectHome");
    // Only the application's own Home: one the user turned off, or another
    // plugin's, is not a place this application may send them.
    if (surface === null || surface.claim.pluginId !== context.instanceId) return;
    usePanelStore.getState().exitMaximize();
    home.showHome();
  } else {
    home.showGrid();
  }
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    if (!isFocusStranded()) return;
    useMacroFocusStore
      .getState()
      .refs.get("grid")
      ?.focus({ preventScroll: true, focusVisible: false });
  });
}

function commit(
  context: ApplicationNavigationContext,
  history: NavigationHistory,
  revealDestination: boolean
): PluginNavigationResult {
  useApplicationNavigationStore
    .getState()
    .commit(
      context.key,
      { ownerId: context.ownerId, version: context.navigation.version },
      history,
      persistableNavigationHistory(context.navigation, history)
    );
  if (revealDestination) reveal(context);
  const location = history.entries[history.index];
  return location === undefined ? refuse("stale") : { ok: true, location };
}

function isIntentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const INTENT_KEYS: ReadonlySet<string> = new Set(["sectionId", "params", "replace", "reveal"]);

/**
 * Move the project application's location (#14108), on behalf of a view of
 * the plugin `pluginId`. The single write path for intents: the intent is
 * admitted against the live declaration before anything moves, and a refusal
 * leaves the location, the history, the main area and focus as they were.
 *
 * Refused with `unsaved` while any of the application's mounted views reports
 * unsaved work, so moving the shared location never replaces a pending form.
 */
export function navigateApplication(pluginId: string, intent: unknown): PluginNavigationResult {
  const context = currentContext();
  if (context === null || context.instanceId !== pluginId) return refuse("stale");
  if (!isIntentRecord(intent)) return refuse("invalid-intent");
  const fields = intent;
  if (Object.keys(fields).some((name) => !INTENT_KEYS.has(name))) return refuse("invalid-intent");
  const { sectionId, params, replace, reveal: revealOption } = fields;
  if (replace !== undefined && typeof replace !== "boolean") return refuse("invalid-intent");
  if (revealOption !== undefined && typeof revealOption !== "boolean") {
    return refuse("invalid-intent");
  }
  const decoded = decodeNavigationLocation(context.navigation, sectionId, params);
  if (!decoded.ok) return refuse(decoded.reason);
  const history = readHistory(context);
  const next = pushNavigationHistory(history, decoded.location, replace === true);
  if (next === history) {
    if (revealOption !== false) reveal(context);
    return { ok: true, location: history.entries[history.index] ?? decoded.location };
  }
  if (holdsUnsavedWork(pluginId)) return refuse("unsaved");
  return commit(context, next, revealOption !== false);
}

function step(pluginId: string, delta: -1 | 1): PluginNavigationResult {
  const context = currentContext();
  if (context === null || context.instanceId !== pluginId) return refuse("stale");
  const history = readHistory(context);
  const index = history.index + delta;
  if (index < 0 || index >= history.entries.length) return refuse("no-history");
  if (holdsUnsavedWork(pluginId)) return refuse("unsaved");
  return commit(context, { entries: history.entries, index }, true);
}

export function navigateApplicationBack(pluginId: string): PluginNavigationResult {
  return step(pluginId, -1);
}

export function navigateApplicationForward(pluginId: string): PluginNavigationResult {
  return step(pluginId, 1);
}

/** Test-only: forget every registered view. */
export function _resetApplicationNavigationViewsForTest(): void {
  viewsByPlugin.clear();
  lastSnapshots.clear();
}

/** What a view is handed besides the callbacks. */
export interface ApplicationNavigationSnapshot {
  readonly location: PluginNavigationLocation;
  readonly sections: readonly { readonly id: string; readonly title: string }[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** The last snapshot per project, so an unchanged location keeps its identity across snapshots. */
const lastSnapshots = new Map<string, ApplicationNavigationSnapshot>();

function sameSections(
  left: ApplicationNavigationSnapshot["sections"],
  right: ApplicationNavigationSnapshot["sections"]
): boolean {
  return (
    left.length === right.length &&
    left.every((section, index) => {
      const other = right[index];
      return other !== undefined && other.id === section.id && other.title === section.title;
    })
  );
}

/**
 * The project's navigation as views see it. Every view of the application
 * reads the same object while nothing about it changed — a plugin snapshot
 * that re-sends the same declaration, or a default location rebuilt — so a
 * view keying an effect on `location` runs it only when the location moves.
 */
export function applicationNavigationSnapshot(
  context: ApplicationNavigationContext,
  history: NavigationHistory
): ApplicationNavigationSnapshot {
  const location = history.entries[history.index] ?? defaultNavigationLocation(context.navigation);
  const previous = lastSnapshots.get(context.key);
  const sections = context.navigation.sections.map(({ id, title }) => Object.freeze({ id, title }));
  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.entries.length - 1;
  if (
    previous !== undefined &&
    navigationLocationsEqual(previous.location, location) &&
    sameSections(previous.sections, sections) &&
    previous.canGoBack === canGoBack &&
    previous.canGoForward === canGoForward
  ) {
    return previous;
  }
  const snapshot: ApplicationNavigationSnapshot = Object.freeze({
    location:
      previous !== undefined && navigationLocationsEqual(previous.location, location)
        ? previous.location
        : location,
    sections:
      previous !== undefined && sameSections(previous.sections, sections)
        ? previous.sections
        : Object.freeze(sections),
    canGoBack,
    canGoForward,
  });
  lastSnapshots.set(context.key, snapshot);
  return snapshot;
}
