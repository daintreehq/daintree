import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import { getPendingActivationProjectIds } from "./projectActivationClaims.js";
import { isScratchWorkspaceId } from "../../shared/utils/workspaceIds.js";
import type {
  ProjectPresenceEntry,
  ProjectPresenceSnapshot,
  ProjectPresenceState,
} from "../../shared/types/ipc/projectPresence.js";

const STATE_RANK: Record<ProjectPresenceState, number> = {
  foreground: 0,
  activating: 1,
  cached: 2,
};

/**
 * Where every project has a live view, split into the requesting window's own
 * and everyone else's (#12597). Read fresh from each window's own manager on
 * every call — nothing here is remembered between calls.
 *
 * Classified by the same rule as `findOtherProjectOwner`, so a row marked as
 * open elsewhere is one a switch would send elsewhere: the active pointer is
 * foreground, another live view is cached, and a claim with no view yet is
 * activating — the manager's own inventory outranking a claim it has outlived.
 * Where a fleet built before the one-view rule holds a project twice, the entry
 * kept is the one a switch would pick: nearest to showing it, then registry
 * order.
 *
 * Scratches are left out. A scratch switch never goes looking for an owner, so
 * marking one as open elsewhere would promise a jump that doesn't happen.
 */
export function buildProjectPresence(
  registry: WindowRegistry | undefined,
  requester: { windowId?: number; projectViewManager?: ProjectViewManager | null }
): ProjectPresenceSnapshot {
  const thisWindow: ProjectPresenceEntry[] = [];
  const others = new Map<string, ProjectPresenceEntry>();
  if (!registry) return { thisWindow, otherWindows: [] };

  for (const context of registry.all()) {
    let entries: ProjectPresenceEntry[];
    let pvm: ProjectViewManager | undefined;
    try {
      if (context.browserWindow.isDestroyed()) continue;
      pvm = context.services.projectViewManager;
      if (!pvm) continue;
      entries = collectWindowPresence(pvm, context.windowId);
    } catch {
      // A window tearing down can throw from any of these reads, and a switch
      // can't be sent to it either.
      continue;
    }

    const isRequester =
      context.windowId === requester.windowId || pvm === requester.projectViewManager;
    if (isRequester) {
      thisWindow.push(...entries);
      continue;
    }
    for (const entry of entries) {
      const held = others.get(entry.projectId);
      if (!held || STATE_RANK[entry.state] < STATE_RANK[held.state]) {
        others.set(entry.projectId, entry);
      }
    }
  }

  // A project the requester holds a view of switches in place, whoever else
  // holds one too (`findOwnerElsewhere`), so it is never "elsewhere".
  const local = new Set(thisWindow.map((entry) => entry.projectId));
  const otherWindows = [...others.values()].filter((entry) => !local.has(entry.projectId));
  return { thisWindow, otherWindows };
}

function collectWindowPresence(pvm: ProjectViewManager, windowId: number): ProjectPresenceEntry[] {
  const entries: ProjectPresenceEntry[] = [];
  const seen = new Set<string>();
  const add = (projectId: string, state: ProjectPresenceState): void => {
    if (seen.has(projectId) || isScratchWorkspaceId(projectId)) return;
    seen.add(projectId);
    entries.push({ projectId, windowId, state });
  };

  const activeProjectId = pvm.getActiveProjectId();
  if (activeProjectId) add(activeProjectId, "foreground");
  for (const entry of pvm.getAllViews()) {
    if (entry.view.webContents.isDestroyed()) continue;
    add(entry.projectId, "cached");
  }
  for (const projectId of getPendingActivationProjectIds(windowId)) {
    add(projectId, "activating");
  }
  return entries;
}
