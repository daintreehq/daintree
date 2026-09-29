import type { FleetSavedScope, ProjectSettings } from "@shared/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { projectClient } from "@/clients";
import { notify } from "@/lib/notify";
import {
  positionOf,
  reinsert,
  UNDO_TOAST_DURATION_MS,
  type RemovedPosition,
} from "@/lib/undoToast";
import { actionService } from "@/services/ActionService";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectStore } from "@/store/projectStore";

function inMemoryScopes(projectId: string): FleetSavedScope[] | null {
  const { projectId: storeProjectId, settings } = useProjectSettingsStore.getState();
  return storeProjectId === projectId && settings ? (settings.fleetSavedScopes ?? []) : null;
}

/**
 * Puts a deleted fleet back beside the fleets it sat between, id and all, so a
 * recall shortcut or usage history that named it still finds it. A no-op once
 * it is back.
 */
export async function restoreSavedFleet(
  projectId: string,
  scope: FleetSavedScope,
  position: RemovedPosition
): Promise<void> {
  try {
    const store = useProjectSettingsStore.getState();
    if (store.projectId === projectId && store.settings) {
      const current = store.settings.fleetSavedScopes ?? [];
      if (current.some((s) => s.id === scope.id)) return;
      const nextSettings: ProjectSettings = {
        ...store.settings,
        fleetSavedScopes: reinsert(current, scope, position),
      };
      useProjectSettingsStore.setState({ settings: nextSettings });
      try {
        await projectClient.saveSettings(projectId, nextSettings);
      } catch (saveError) {
        // Take back only this insertion: anything else changed while the save
        // was in flight stays.
        const latest = useProjectSettingsStore.getState();
        if (latest.projectId === projectId && latest.settings) {
          useProjectSettingsStore.setState({
            settings: {
              ...latest.settings,
              fleetSavedScopes: (latest.settings.fleetSavedScopes ?? []).filter(
                (s) => s.id !== scope.id
              ),
            },
          });
        }
        throw saveError;
      }
      return;
    }
    const current = await projectClient.getSettings(projectId);
    const scopes = current.fleetSavedScopes ?? [];
    if (scopes.some((s) => s.id === scope.id)) return;
    await projectClient.saveSettings(projectId, {
      ...current,
      fleetSavedScopes: reinsert(scopes, scope, position),
    });
  } catch (error) {
    notify({
      type: "error",
      title: "Couldn't restore fleet",
      message: formatErrorMessage(error, "Couldn't update project settings"),
      duration: 8000,
      action: { label: "Retry", onClick: () => restoreSavedFleet(projectId, scope, position) },
    });
  }
}

/**
 * Deletes a saved fleet at once and offers it back. A saved fleet is a name
 * and a selection rule; the terminals it points to are untouched, so the
 * deletion is exactly restorable and a confirm would only train a click-through.
 */
export async function deleteSavedFleetWithUndo(scope: FleetSavedScope): Promise<void> {
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  if (!projectId) return;
  const position = positionOf(inMemoryScopes(projectId) ?? [], scope.id);
  const result = await actionService.dispatch(
    "fleet.deleteNamedFleet",
    { id: scope.id },
    { source: "user" }
  );
  if (!result.ok) return;
  // The action reports its own failure and rolls the list back; a fleet still
  // listed was never deleted, so there is nothing to undo.
  if (inMemoryScopes(projectId)?.some((s) => s.id === scope.id)) return;
  notify({
    type: "success",
    title: "Fleet deleted",
    message: scope.name,
    priority: "high",
    transient: true,
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: "Undo",
      onClick: () => restoreSavedFleet(projectId, scope, position),
    },
  });
}
