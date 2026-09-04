import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import type { ProjectPluginVisibility } from "../../../shared/types/plugin.js";

/**
 * Per-project visibility for INSTALLED (global) plugins.
 *
 * A global plugin runs once for the whole app, and until now its contributions
 * were visible in every project view. This is the second, orthogonal filter that
 * lets one of them be on in project A and off in project B.
 *
 * Two levels, because one is not enough. A per-project decision alone can only
 * express "on everywhere, except where I have been and turned it off" — which
 * quietly turns itself back on in every project created afterwards, and is not
 * what "enable this only in my Python projects" means. So a plugin also has a
 * DEFAULT (visible, or hidden), and a project may override it in either
 * direction:
 *
 *     visible = overrides[projectId]?.[pluginId] ?? !defaultHidden.has(pluginId)
 *
 * Deliberately NOT folded into `PROJECT_SCOPED_PLUGINS` in
 * `PluginContributionBroadcaster`. That map answers a different question — which
 * single project a project-LOCAL plugin's contributions belong to — and it has
 * exactly one answer per plugin. Overloading it would make "installed plugin,
 * hidden in one project" indistinguishable from "project plugin owned by that
 * project", and the two have opposite defaults.
 *
 * Module-level, mirroring the scope map it filters alongside: the registries
 * both consult are module singletons, and a per-service copy would disagree
 * with them.
 *
 * **Visibility only.** The plugin's worker stays global and keeps running — this
 * hides what a project's views see, it does not unload anything, and the
 * contribution families the broadcaster does not scope (agents, recipes, forge
 * providers) are unaffected. VS Code excludes a workspace-disabled extension
 * from activation outright; matching that here means per-project plugin
 * instances, which is a much larger change than the filter this module is. The
 * UI says which of the two it is doing rather than implying the stronger one.
 */
const OVERRIDES = new Map<string, Map<string, boolean>>();

/** Manifest ids hidden in any project that has not decided for itself. */
const DEFAULT_HIDDEN = new Set<string>();

/** True once the store has been read, so the broadcaster never filters on an empty map. */
let hydrated = false;

const STORE_KEY = "projectPluginVisibility";

interface StoredVisibility {
  defaultHiddenPluginIds?: unknown;
  projectOverrides?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read the persisted profile into memory. Defensive about every level: the file
 * is user-editable, and a malformed entry must degrade to "visible", which is
 * the pre-overlay behaviour, rather than hiding contributions nobody asked to
 * hide.
 */
export function hydrateProjectPluginVisibility(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = store.get(STORE_KEY) as StoredVisibility | undefined;
    if (!raw || typeof raw !== "object") return;

    if (Array.isArray(raw.defaultHiddenPluginIds)) {
      for (const id of raw.defaultHiddenPluginIds) {
        if (isNonEmptyString(id)) DEFAULT_HIDDEN.add(id);
      }
    }

    const projectOverrides = raw.projectOverrides;
    if (!projectOverrides || typeof projectOverrides !== "object") return;
    for (const [projectId, entries] of Object.entries(
      projectOverrides as Record<string, unknown>
    )) {
      if (!isProjectWorkspaceId(projectId)) continue;
      if (!entries || typeof entries !== "object") continue;
      const map = new Map<string, boolean>();
      for (const [pluginId, allowed] of Object.entries(entries as Record<string, unknown>)) {
        if (!isNonEmptyString(pluginId)) continue;
        if (typeof allowed !== "boolean") continue;
        map.set(pluginId, allowed);
      }
      if (map.size > 0) OVERRIDES.set(projectId, map);
    }
  } catch (err) {
    // Fail open: an unreadable profile is not a reason to hide a plugin the
    // user never turned off.
    console.warn("[projectPluginVisibility] Failed to read stored visibility:", err);
  }
}

/**
 * Write the whole profile.
 *
 * Throws on failure rather than swallowing: callers report success to the
 * renderer and rebroadcast on the strength of this returning, so a silently
 * dropped write would leave a switch that looks flipped, filters this session,
 * and is gone on the next launch.
 */
function persist(): void {
  const projectOverrides: Record<string, Record<string, boolean>> = {};
  for (const [projectId, map] of OVERRIDES) {
    if (map.size === 0) continue;
    projectOverrides[projectId] = Object.fromEntries(map);
  }
  // Whole-key rewrite: electron-store dot-notation would nest on a key
  // containing dots, and both a project id and a manifest id are opaque here.
  store.set(STORE_KEY, {
    defaultHiddenPluginIds: [...DEFAULT_HIDDEN],
    projectOverrides,
  });
}

/**
 * Whether anything at all has been decided. False in an app where nobody has
 * changed anything, which is what lets every contribution filter keep the
 * byte-for-byte identity fast path it had before this existed.
 */
export function hasProjectPluginVisibilityOverrides(): boolean {
  hydrateProjectPluginVisibility();
  return DEFAULT_HIDDEN.size > 0 || OVERRIDES.size > 0;
}

/**
 * Is a global plugin's contribution visible in a view of `projectId`?
 *
 * `null` (a renderer with no project binding) and an empty id both fall back to
 * the default rather than to an override: an override is a statement about one
 * named project, and a view that cannot name its project is not that project.
 */
export function isPluginVisibleInProject(pluginId: string, projectId: string | null): boolean {
  // Hydrates itself rather than trusting a caller to have done it. This is the
  // hot path — called once per contribution per broadcast — but after the first
  // call it is a boolean check, and the alternative is a filter whose
  // correctness depends on some other function having run first. That ordering
  // held only by accident of who the broadcaster calls in which order.
  hydrateProjectPluginVisibility();
  if (DEFAULT_HIDDEN.size === 0 && OVERRIDES.size === 0) return true;
  if (projectId !== null && projectId.length > 0) {
    const override = OVERRIDES.get(projectId)?.get(pluginId);
    if (override !== undefined) return override;
  }
  return !DEFAULT_HIDDEN.has(pluginId);
}

/** The profile as one project sees it, for the settings UI. */
export function getProjectPluginVisibility(projectId: string): ProjectPluginVisibility {
  hydrateProjectPluginVisibility();
  const map = OVERRIDES.get(projectId);
  return {
    defaultHiddenPluginIds: [...DEFAULT_HIDDEN],
    overrides: map ? Object.fromEntries(map) : {},
  };
}

function assertPluginId(pluginId: string): void {
  if (!isNonEmptyString(pluginId)) {
    throw new Error("project plugin visibility: pluginId must be a non-empty string");
  }
}

/**
 * Record this project's decision about one installed plugin. `null` clears the
 * override so the project follows the default again — which is what "back to
 * normal" has to mean, and is why turning something on in a
 * visible-by-default world leaves no residue behind.
 *
 * Returns whether anything actually changed, so callers can skip the
 * rebroadcast on a redundant write.
 */
export function setProjectPluginVisibility(
  projectId: string,
  pluginId: string,
  visible: boolean | null
): boolean {
  hydrateProjectPluginVisibility();
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("project plugin visibility: projectId must be a project workspace id");
  }
  assertPluginId(pluginId);

  const map = OVERRIDES.get(projectId);
  const current = map?.get(pluginId) ?? null;
  if (current === visible) return false;

  if (visible === null) {
    if (!map) return false;
    map.delete(pluginId);
    if (map.size === 0) OVERRIDES.delete(projectId);
  } else if (map) {
    map.set(pluginId, visible);
  } else {
    OVERRIDES.set(projectId, new Map([[pluginId, visible]]));
  }
  persist();
  return true;
}

/**
 * Set whether a plugin is hidden in projects that have not decided for
 * themselves — the "show it everywhere" / "show it only where I turn it on"
 * choice.
 *
 * Existing per-project overrides are left alone: they are explicit answers, and
 * a change to what the *unanswered* projects do is not a reason to discard
 * them.
 */
export function setPluginVisibilityDefault(pluginId: string, hidden: boolean): boolean {
  hydrateProjectPluginVisibility();
  assertPluginId(pluginId);
  if (DEFAULT_HIDDEN.has(pluginId) === hidden) return false;
  if (hidden) DEFAULT_HIDDEN.add(pluginId);
  else DEFAULT_HIDDEN.delete(pluginId);
  persist();
  return true;
}

/**
 * Drop every decision recorded about `pluginId`, in every project and in the
 * default set. Called when the plugin is uninstalled: a manifest id is
 * author-controlled, so a rule left behind would silently reapply itself to
 * whatever reclaims that id later — the same reason consent is purged on
 * uninstall rather than kept.
 */
export function clearProjectPluginVisibilityForPlugin(pluginId: string): void {
  hydrateProjectPluginVisibility();
  let changed = DEFAULT_HIDDEN.delete(pluginId);
  for (const [projectId, map] of [...OVERRIDES]) {
    if (!map.delete(pluginId)) continue;
    changed = true;
    if (map.size === 0) OVERRIDES.delete(projectId);
  }
  if (changed) persist();
}

/** Test isolation: drop the in-memory profile and force a re-read. */
export function __resetProjectPluginVisibilityForTesting(): void {
  OVERRIDES.clear();
  DEFAULT_HIDDEN.clear();
  hydrated = false;
}
