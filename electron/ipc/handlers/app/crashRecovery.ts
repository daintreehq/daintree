import { CHANNELS } from "../../channels.js";
import { getCrashRecoveryService } from "../../../services/CrashRecoveryService.js";
import { getCrashLoopGuard } from "../../../services/CrashLoopGuardService.js";
import { projectStore } from "../../../services/ProjectStore.js";
import type { ProjectState } from "../../../types/index.js";
import type {
  CrashRecoveryAction,
  CrashRecoveryConfig,
} from "../../../../shared/types/ipc/crashRecovery.js";
import {
  isFleetRestoreEligible,
  requestCrashFleetRestore,
} from "../../../lifecycle/crashWindowRestore.js";
import { typedHandle, typedHandleWithContext } from "../../utils.js";

export function registerCrashRecoveryHandlers(): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.CRASH_RECOVERY_GET_PENDING, () => {
      if (getCrashLoopGuard().isSafeMode()) {
        return null;
      }
      const pending = getCrashRecoveryService().getPendingCrash();
      if (!pending) return null;
      return { ...pending, crashCount: getCrashLoopGuard().getCrashCount() };
    })
  );

  handlers.push(
    typedHandleWithContext(
      CHANNELS.CRASH_RECOVERY_RESOLVE,
      async (ctx, action: CrashRecoveryAction) => {
        const service = getCrashRecoveryService();
        if (action.kind === "restore") {
          // Per-project layouts survive the crash on disk, so a deselected panel
          // has to be removed from its workspace's state before anything hydrates.
          // Done before restoreBackup, which drops the pre-crash snapshot on
          // success, and undone on any failure so a retry — possibly with a
          // wider selection — still finds every panel.
          const legacyPanelList = !service.hasProjectPanelLayouts();
          const originals = new Map<string, ProjectState>();
          try {
            await removeDeselectedProjectPanels(
              service.getDeselectedProjectPanels(action.panelIds),
              originals
            );
          } catch (err) {
            console.error("[CrashRecovery] Failed to remove deselected panels:", err);
            await rollBackProjectPanels(originals);
            throw new Error("Crash recovery restore failed", { cause: err });
          }
          const ok = service.restoreBackup(action.panelIds);
          if (!ok) await rollBackProjectPanels(originals);
          if (ok) {
            // The hydration filter makes the restored global list outrank a
            // workspace's own state. With per-project layouts that list is not
            // what the user chose from, so the filter would drop their panels.
            if (legacyPanelList) service.setPanelFilter(action.panelIds);
            service.clearPendingCrash();
            // One crash brings the whole window set back; a loop keeps the one
            // recovery window (#12801). Not awaited — see requestCrashFleetRestore.
            if (isFleetRestoreEligible(getCrashLoopGuard())) {
              requestCrashFleetRestore(ctx.webContentsId);
            }
          } else {
            // Propagate the failure to the renderer. `restoreBackup` returns
            // false for: no parseable snapshot, zero-match panel filter, no
            // restorable content, or apply-time exceptions. Throwing here
            // routes the failure through the dialog's existing
            // "Recovery failed" inline banner (and skips the false-positive
            // "Session restored" confirmation on the auto-restore path).
            // The backup is preserved on disk by the service so the user can
            // retry — see FILTER_WITH_NO_MATCHES_KEEPS_RECOVERY_SOURCE_FOR_RETRY.
            throw new Error("Crash recovery restore failed");
          }
        } else {
          service.resetToFresh();
          service.clearPendingCrash();
        }
      }
    )
  );

  handlers.push(
    typedHandle(CHANNELS.CRASH_RECOVERY_GET_CONFIG, () => {
      return getCrashRecoveryService().getConfig();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.CRASH_RECOVERY_SET_CONFIG, (config: Partial<CrashRecoveryConfig>) => {
      return getCrashRecoveryService().setConfig(config);
    })
  );

  return () => handlers.forEach((cleanup) => cleanup());
}

async function removeDeselectedProjectPanels(
  deselected: Record<string, string[]>,
  originals: Map<string, ProjectState>
): Promise<void> {
  for (const [projectId, panelIds] of Object.entries(deselected)) {
    const removed = new Set(panelIds);
    await projectStore.enqueueProjectStateUpdate(projectId, (existing) => {
      if (!existing || !existing.terminals.some((t) => removed.has(t.id))) return null;
      originals.set(projectId, existing);
      const tabGroups = existing.tabGroups
        // Hydration skips malformed groups too; one must not block the restore.
        ?.filter((group) => Array.isArray(group?.panelIds))
        .map((group) => {
          const groupPanelIds = group.panelIds.filter((id) => !removed.has(id));
          return {
            ...group,
            panelIds: groupPanelIds,
            activeTabId: groupPanelIds.includes(group.activeTabId)
              ? group.activeTabId
              : (groupPanelIds[0] ?? group.activeTabId),
          };
        })
        // A group of one is implicit, so dropping to one member dissolves it.
        .filter((group) => group.panelIds.length > 1);
      const next = {
        ...existing,
        terminals: existing.terminals.filter((t) => !removed.has(t.id)),
        tabGroups,
      };
      if (existing.terminalSizes) {
        next.terminalSizes = omitKeys(existing.terminalSizes, removed);
      }
      if (existing.draftInputs) next.draftInputs = omitKeys(existing.draftInputs, removed);
      return next;
    });
  }
}

async function rollBackProjectPanels(originals: Map<string, ProjectState>): Promise<void> {
  for (const [projectId, original] of originals) {
    try {
      await projectStore.enqueueProjectStateUpdate(projectId, () => original);
    } catch (err) {
      console.error(`[CrashRecovery] Failed to roll back panels for ${projectId}:`, err);
    }
  }
}

function omitKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));
}
