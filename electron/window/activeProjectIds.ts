import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import { logError } from "../utils/logger.js";

export type ProjectViewManagersProvider = () => ProjectViewManager[];

/**
 * Projects a remote Shell is displaying from this machine. Installed by Host
 * mode (core code never imports remote modules), so a local-only app never
 * has one and the active set is exactly what its own windows show.
 */
let remoteVisibleProjectIds: (() => Iterable<string>) | null = null;

export function setRemoteVisibleProjectIdsProvider(
  provider: (() => Iterable<string>) | null
): () => void {
  remoteVisibleProjectIds = provider;
  return () => {
    if (remoteVisibleProjectIds === provider) remoteVisibleProjectIds = null;
  };
}

/**
 * Adapt a WindowRegistry into the lazy provider shape above. Callers that hold
 * a registry directly (the IPC handlers, via `HandlerDependencies`) use this
 * instead of the `setProjectViewManagersProvider` closure the long-lived global
 * services are wired with. Stays lazy: windows open and close between calls.
 */
export function projectViewManagersFrom(
  registry: WindowRegistry | undefined
): ProjectViewManagersProvider {
  return () =>
    registry
      ?.all()
      .map((wCtx) => wCtx.services.projectViewManager)
      .filter((pvm): pvm is ProjectViewManager => pvm !== undefined) ?? [];
}

/**
 * Collect the set of project IDs that are foreground in ANY window.
 *
 * The SQLite current-project pointer only tracks the LAST-FOCUSED window, so a
 * project on-screen in a second, unfocused window looks like a background
 * project to anything that compares against it alone (#11102). Every decision
 * that reclaims a project's resources — hibernation, PTY teardown, close,
 * idle nudges — must consult all windows instead.
 *
 * `outgoingBridgeProjectId` counts as visible: during a cold project switch the
 * outgoing project stays painted behind the anti-flash bridge until the paint
 * gate settles, even though `activeProjectId` already points at the incoming one.
 *
 * `fallbackProjectId` (the DB pointer) is unioned in ADDITIVELY, never used as
 * the sole check — it covers the early-startup window before the provider is
 * wired, so a first sweep still skips the active project (#6016).
 *
 * Projects a remote Shell is displaying from this machine (Host mode) count too:
 * their views live in another app, so no local manager knows about them.
 *
 * @param source Short identifier for the calling site, attached to error logs.
 */
export function collectActiveProjectIds(
  provider: ProjectViewManagersProvider | null,
  fallbackProjectId: string | null,
  source: string
): Set<string> {
  const activeIds = new Set<string>();

  if (provider) {
    let managers: ProjectViewManager[] = [];
    try {
      managers = provider();
    } catch (error) {
      // The window registry may be tearing down — best-effort. Fall through to
      // the DB pointer so we never reclaim a project we couldn't verify.
      logError("active-project-ids-provider-failed", error, { source });
    }

    for (const manager of managers) {
      try {
        const activeId = manager.getActiveProjectId();
        if (activeId) activeIds.add(activeId);
        const outgoingId = manager.getOutgoingBridgeProjectId();
        if (outgoingId) activeIds.add(outgoingId);
      } catch (error) {
        // A disposing ProjectViewManager can throw — isolate per window so one
        // failure doesn't drop the rest of the active set (#8607).
        logError("active-project-ids-manager-failed", error, { source });
      }
    }
  }

  if (remoteVisibleProjectIds) {
    try {
      for (const id of remoteVisibleProjectIds()) activeIds.add(id);
    } catch (error) {
      logError("active-project-ids-remote-failed", error, { source });
    }
  }

  if (fallbackProjectId) activeIds.add(fallbackProjectId);

  return activeIds;
}
