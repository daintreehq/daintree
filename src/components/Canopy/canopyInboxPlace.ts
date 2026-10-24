import { ALL_HOSTS_ID } from "@/store/canopyStore";
import type { HostId } from "@shared/types/remoteHosts";
import { parseAllHostsKey } from "./canopyAllHosts";
import type { CanopyItem } from "./canopyModel";

/**
 * Where a run really is. In All hosts a run is named by its host and its id
 * there; a host of null is the window's own, which acts on it as it always has.
 */
export function placeOf(
  item: Pick<CanopyItem, "runId" | "workspaceId">,
  hostId: HostId | null,
  ownHostId: HostId
): { hostId: HostId | null; runId: string; workspaceId: string } {
  if (hostId !== ALL_HOSTS_ID) return { hostId, runId: item.runId, workspaceId: item.workspaceId };
  const run = parseAllHostsKey(item.runId);
  const workspace = parseAllHostsKey(item.workspaceId);
  const host = run?.hostId ?? ownHostId;
  return {
    hostId: host === ownHostId ? null : host,
    runId: run?.id ?? item.runId,
    workspaceId: workspace?.id ?? item.workspaceId,
  };
}
