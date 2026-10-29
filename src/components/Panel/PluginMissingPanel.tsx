import { useEffect, useState, type ReactNode } from "react";
import { Puzzle } from "lucide-react";
import {
  projectIdFromRuntimePanelKindId,
  toPersistedPanelKindRef,
} from "@shared/config/panelKindRegistry";
import { parseProjectPluginInstanceKey } from "@shared/types/plugin/instanceKeys";
import type {
  LoadedPluginInfo,
  ProjectPluginInfo,
  ProjectPluginVisibility,
} from "@shared/types/plugin";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { PluginNotOnHostPlaceholder } from "@/components/Plugin/PluginNotOnHostPlaceholder";
import { pluginViewHostId } from "@/components/Plugin/remotePluginView";
import { actionService } from "@/services/ActionService";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { logWarn } from "@/utils/logger";

export interface PluginMissingPanelProps {
  /**
   * Display identifier of the plugin that registered this panel's kind. When
   * missing, the placeholder recovers it from `kind` — see
   * {@link displayNameFor}.
   */
  pluginId?: string;
  /** Raw panel kind string used as a fallback source for the plugin name. */
  kind: string;
  /** Invoked when the user asks to permanently remove this orphaned panel. */
  onRemove: () => void;
}

/**
 * The plugin name to show. `pluginId` is authoritative; without it the manifest
 * id is recovered from the kind string through the same parse persistence uses,
 * which knows both the global (`{manifestId}.{kindId}`) and project-qualified
 * (`project:{projectId}/{manifestId}/{kindId}`) runtime forms. Splitting on the
 * first dot instead would name `daintree.github.prs` as "daintree". A kind that
 * is not plugin-shaped at all falls through to the raw string.
 */
function displayNameFor(kind: string, pluginId: string | undefined): string {
  if (pluginId) return pluginId;
  return toPersistedPanelKindRef(kind)?.pluginId ?? kind;
}

/** Which plugin a missing panel belongs to, as far as the panel itself can say. */
export interface MissingPluginIdentity {
  manifestId: string;
  /** `project` for a project-qualified kind or a project instance key. */
  scope: "global" | "project";
  projectId: string | null;
  /**
   * Whether the project instance is an installed package's (`true`) or the
   * repository's own (`false`). Only a live panel's instance key says so: a
   * restored one carries the bare manifest id, so this is `null`.
   */
  installedInstance: boolean | null;
}

export function identifyMissingPlugin(
  kind: string,
  pluginId: string | undefined
): MissingPluginIdentity {
  const instance = pluginId ? parseProjectPluginInstanceKey(pluginId) : null;
  if (instance) {
    return {
      manifestId: instance.manifestId,
      scope: "project",
      projectId: instance.projectId,
      installedInstance: instance.installed,
    };
  }
  const ref = toPersistedPanelKindRef(kind, pluginId);
  return {
    manifestId: displayNameFor(kind, pluginId),
    scope: ref?.origin === "project" ? "project" : "global",
    projectId: projectIdFromRuntimePanelKindId(kind),
    installedInstance: null,
  };
}

export type PluginRecoveryHome = "manager" | "project";
export type PluginRecoveryState = "off" | "hidden" | "blocked" | "missing" | "unknown";

export interface PluginRecovery {
  /** Where the plugin is turned back on, or reinstalled. */
  home: PluginRecoveryHome;
  state: PluginRecoveryState;
  /** The plugin's own name, once a list carries it. */
  displayName: string | null;
  /** The id Project settings → Plugins selects, when its row is known to be there. */
  settingsTarget: string | null;
}

function managerRecovery(
  state: PluginRecoveryState,
  row: LoadedPluginInfo | undefined
): PluginRecovery {
  return {
    home: "manager",
    state,
    displayName: row?.manifest.displayName ?? null,
    settingsTarget: null,
  };
}

/**
 * What the panel's plugin is doing now and where it is switched back on. Only a
 * list that was read can prove a plugin absent, so an unread one says
 * `unknown`; so does a plugin every list shows as on, since a running plugin
 * can still stop offering a panel kind. A repository plugin is never looked for
 * in `inventory` alone: switched off, it has no loaded row there at all.
 */
export function resolvePluginRecovery(
  identity: MissingPluginIdentity,
  inventory: readonly LoadedPluginInfo[] | null,
  repository: readonly ProjectPluginInfo[],
  visibility: ProjectPluginVisibility
): PluginRecovery {
  const { manifestId, projectId } = identity;

  if (identity.scope === "global") {
    if (inventory === null) return managerRecovery("unknown", undefined);
    const row = inventory.find((p) => p.instanceId === manifestId);
    if (!row) return managerRecovery("missing", undefined);
    if (row.blocklisted) return managerRecovery("blocked", row);
    if (row.disabled) return managerRecovery("off", row);
    // Hiding an installed plugin in a project withdraws its panel kinds there.
    const shown =
      visibility.overrides[manifestId] ?? !visibility.defaultHiddenPluginIds.includes(manifestId);
    if (!shown) {
      return {
        home: "project",
        state: "hidden",
        displayName: row.manifest.displayName ?? null,
        settingsTarget: row.instanceId,
      };
    }
    return managerRecovery("unknown", row);
  }

  if (identity.installedInstance !== true) {
    const repo = repository.find(
      (p) => p.id === manifestId && (projectId === null || p.projectId === projectId)
    );
    if (repo) {
      // Only a mute is the user's own off switch. A staged plugin, an untrusted
      // folder or a broken manifest each need something else done in its pane.
      return {
        home: "project",
        state: repo.muted ? "off" : "unknown",
        displayName: repo.displayName,
        settingsTarget: repo.instanceId ?? null,
      };
    }
  }

  if (identity.installedInstance !== false && inventory !== null) {
    const pkg = inventory.find((p) => p.instanceMode === "project" && p.instanceId === manifestId);
    if (pkg) {
      if (pkg.blocklisted) return managerRecovery("blocked", pkg);
      if (pkg.disabled) return managerRecovery("off", pkg);
      const onHere = projectId !== null && pkg.enabledInProjects?.includes(projectId) === true;
      return {
        home: "project",
        state: onHere ? "unknown" : "off",
        displayName: pkg.manifest.displayName ?? null,
        settingsTarget: pkg.instanceId,
      };
    }
    if (identity.installedInstance === true) return managerRecovery("missing", undefined);
    // A restored panel can't say whose instance it was, and neither list
    // carries it. Of the two, only a package can be brought back from inside
    // Daintree, and that happens in the plugin manager.
    return managerRecovery("unknown", undefined);
  }

  return { home: "project", state: "unknown", displayName: null, settingsTarget: null };
}

interface RecoveryCopy {
  title: string;
  /** What the plugin is doing, after "This panel comes from the {name} plugin, ". */
  status: string;
  next: string;
}

function recoveryCopy({ home, state }: PluginRecovery): RecoveryCopy {
  if (home === "project") {
    switch (state) {
      case "off":
        return {
          title: "Turn on this plugin",
          status: "which is turned off in this project.",
          next: "Turn it on in Project settings to restore the panel.",
        };
      case "hidden":
        return {
          title: "Show this plugin in this project",
          status: "which is hidden in this project.",
          next: "Show it in Project settings to restore the panel.",
        };
      default:
        return {
          title: "Check this plugin",
          status: "which isn't offering it in this project right now.",
          next: "Project settings shows its status.",
        };
    }
  }
  switch (state) {
    case "off":
      return {
        title: "Enable this plugin",
        status: "which is turned off.",
        next: "Enable it in the plugin manager to restore the panel.",
      };
    case "missing":
      return {
        title: "Install this plugin",
        status: "which isn't installed.",
        next: "Install it from the plugin manager to restore the panel.",
      };
    case "blocked":
      return {
        title: "See why this plugin is blocked",
        status: "which Daintree has blocked.",
        next: "The plugin manager shows the reason.",
      };
    default:
      return {
        title: "Check this plugin",
        status: "which isn't offering it right now.",
        next: "The plugin manager shows its status.",
      };
  }
}

const HOME_ACTION_LABEL: Record<PluginRecoveryHome, string> = {
  manager: "Open plugin manager",
  project: "Open project settings",
};

function openRecoveryHome({ home, settingsTarget }: PluginRecovery): void {
  if (home === "manager") {
    void actionService.dispatch("app.pluginManager", undefined, { source: "user" });
    return;
  }
  // Only a row the tab lists: a request it can't match would wait for the next one.
  if (settingsTarget !== null) {
    usePluginManagerStore.getState().requestSettings({ pluginId: settingsTarget, home: "project" });
  }
  void actionService.dispatch(
    "app.settings.openTab",
    { tab: "project:plugins" },
    { source: "user" }
  );
}

/**
 * The plugin list, or `null` until a read succeeds. Read again on every
 * install, uninstall and enable switch, so the copy follows the plugin while
 * this placeholder is up; a plugin coming back swaps the placeholder out
 * through the panel kind registry instead. A failed read keeps what was known.
 */
function usePluginInventory(): LoadedPluginInfo[] | null {
  const [inventory, setInventory] = useState<LoadedPluginInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    const load = () => {
      const request = ++latest;
      window.electron.plugin.list().then(
        (list) => {
          if (!cancelled && request === latest) setInventory(list);
        },
        (error: unknown) => {
          if (!cancelled && request === latest) {
            logWarn("[PluginMissingPanel] couldn't read the plugin list", { error });
          }
        }
      );
    };
    const unsubscribe = window.electron.plugin.onProvenanceChanged(load);
    load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return inventory;
}

/**
 * Rendered inside ContentPanel when a panel's kind is no longer registered
 * because its owning plugin is disabled or uninstalled. The panel's
 * `extensionState` is preserved on disk so re-enabling the plugin restores
 * the panel transparently. The leading action goes to where the plugin is
 * switched back on, or reinstalled; removing the panel, which discards that
 * state, comes second.
 *
 * The body scrolls rather than clips: a pane can be shorter than the
 * explanation, and the action has to stay reachable.
 */
export function PluginMissingPanel({ pluginId, kind, onRemove }: PluginMissingPanelProps) {
  // In a window on another machine the plugin is the host's to have: offer to
  // install this machine's copy there instead of asking to re-enable it.
  if (pluginViewHostId() !== null) {
    return (
      <PluginNotOnHostPlaceholder
        pluginId={displayNameFor(kind, pluginId)}
        kind={kind}
        onRemove={onRemove}
      />
    );
  }
  return <LocalPluginMissingPanel pluginId={pluginId} kind={kind} onRemove={onRemove} />;
}

function LocalPluginMissingPanel({ pluginId, kind, onRemove }: PluginMissingPanelProps) {
  const identity = identifyMissingPlugin(kind, pluginId);
  const inventory = usePluginInventory();
  const repository = useProjectPluginStore((s) => s.plugins);
  const visibility = useProjectPluginStore((s) => s.visibility);
  const recovery = resolvePluginRecovery(identity, inventory, repository, visibility);
  const copy = recoveryCopy(recovery);

  const name: ReactNode =
    recovery.displayName !== null ? (
      <span className="font-medium text-text-primary">{recovery.displayName}</span>
    ) : (
      <span className="font-mono text-text-primary">{identity.manifestId}</span>
    );

  return (
    <div
      role="region"
      aria-label="Plugin unavailable"
      className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-surface-panel"
    >
      <EmptyState
        variant="zero-data"
        scale="canvas"
        // The copy settles once the plugin list is read: that is the same
        // state described more precisely, not a change worth a crossfade.
        instant
        icon={<Puzzle />}
        title={copy.title}
        description={
          <>
            This panel comes from the {name} plugin, {copy.status} {copy.next}
          </>
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="contrast" size="sm" onClick={() => openRecoveryHome(recovery)}>
              {HOME_ACTION_LABEL[recovery.home]}
            </Button>
            <Button variant="ghost" size="sm" onClick={onRemove}>
              Remove panel
            </Button>
          </div>
        }
        className="my-auto"
      />
    </div>
  );
}
