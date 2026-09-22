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
  const heldHere = new Set<string>();
  if (!registry) return { thisWindow, otherWindows: [] };

  for (const context of registry.all()) {
    let presence: WindowPresence;
    let pvm: ProjectViewManager | undefined;
    try {
      if (context.browserWindow.isDestroyed()) continue;
      pvm = context.services.projectViewManager;
      if (!pvm) continue;
      presence = collectWindowPresence(pvm, context.windowId);
    } catch {
      // A window tearing down can throw from any of these reads, and a switch
      // can't be sent to it either.
      continue;
    }
    const { entries, liveViewIds } = presence;

    const isRequester =
      context.windowId === requester.windowId || pvm === requester.projectViewManager;
    if (isRequester) {
      thisWindow.push(...entries);
      for (const projectId of liveViewIds) heldHere.add(projectId);
      continue;
    }
    for (const entry of entries) {
      const held = others.get(entry.projectId);
      if (!held || STATE_RANK[entry.state] < STATE_RANK[held.state]) {
        others.set(entry.projectId, entry);
      }
    }
  }

  // A project the requester holds a live view of switches in place, whoever
  // else holds one too, so it is never "elsewhere". Only a live view exempts
  // it — the same test `findOwnerElsewhere` applies — since a bare pointer or
  // a claim here still leaves the pick to go to the other window.
  const otherWindows = [...others.values()].filter((entry) => !heldHere.has(entry.projectId));
  return { thisWindow, otherWindows };
}

interface WindowPresence {
  entries: ProjectPresenceEntry[];
  /** Projects with a view whose renderer is still alive, scratches included. */
  liveViewIds: Set<string>;
}

function collectWindowPresence(pvm: ProjectViewManager, windowId: number): WindowPresence {
  const entries: ProjectPresenceEntry[] = [];
  const liveViewIds = new Set<string>();
  const seen = new Set<string>();
  const add = (projectId: string, state: ProjectPresenceState): void => {
    if (seen.has(projectId) || isScratchWorkspaceId(projectId)) return;
    seen.add(projectId);
    entries.push({ projectId, windowId, state });
  };

  // Read before the inventory, so a view that can't be read costs only itself:
  // the owner lookup counts the active pointer as showing the project without
  // ever touching the views.
  const activeProjectId = pvm.getActiveProjectId();
  if (activeProjectId) add(activeProjectId, "foreground");
  let views: ReturnType<ProjectViewManager["getAllViews"]>;
  try {
    views = pvm.getAllViews();
  } catch {
    views = [];
  }
  for (const entry of views) {
    if (!isLiveView(entry)) continue;
    liveViewIds.add(entry.projectId);
    add(entry.projectId, "cached");
  }
  for (const projectId of getPendingActivationProjectIds(windowId)) {
    add(projectId, "activating");
  }
  return { entries, liveViewIds };
}

function isLiveView(entry: ReturnType<ProjectViewManager["getAllViews"]>[number]): boolean {
  try {
    return !entry.view.webContents.isDestroyed();
  } catch {
    return false;
  }
}
