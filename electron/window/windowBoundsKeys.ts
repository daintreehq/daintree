/**
 * What a window's saved bounds are keyed on, for workspaces with no folder on
 * this machine.
 *
 * A local project's bounds are keyed on its folder, as they always were, so
 * saved positions survive an upgrade. A scratch and a host's project have no
 * folder here, so they are keyed on their ids under a prefix no absolute path
 * can start with: POSIX paths start with a separator, Windows ones with a
 * single drive letter or a separator. A host's project keeps its host in the
 * key, because the same folder on two hosts gives the same project id.
 *
 * Dependency-free so the pruning side in windowState.ts and the resolving side
 * in windowStateTracking.ts share it without either importing the other.
 */

import { isValidRemoteHostId } from "../../shared/types/remoteHosts.js";
import { isScratchWorkspaceId } from "../../shared/utils/workspaceIds.js";
import { isRemoteWorkspaceKey } from "../services/persistence/windowManifest.js";

const SCRATCH_PREFIX = "scratch:";
const HOST_PREFIX = "host:";

export function scratchBoundsKey(scratchId: string): string {
  return `${SCRATCH_PREFIX}${scratchId}`;
}

/** Every key of `hostId`'s projects starts with this; null for an id that names no host. */
export function hostBoundsKeyPrefix(hostId: string): string | null {
  return isValidRemoteHostId(hostId) ? `${HOST_PREFIX}${hostId}:` : null;
}

/**
 * The key of a host's project (`<hostId>:<projectId>`) or a scratch, or null
 * for an id that is neither: a local project, keyed on its folder instead.
 */
export function folderlessBoundsKey(workspaceId: string): string | null {
  if (isRemoteWorkspaceKey(workspaceId)) return `${HOST_PREFIX}${workspaceId}`;
  if (isScratchWorkspaceId(workspaceId)) return scratchBoundsKey(workspaceId);
  return null;
}
