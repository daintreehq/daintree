import type { Scratch, VoiceSessionElsewhere } from "@shared/types";
import {
  LOCAL_HOST_ID,
  isLocalHostId,
  type HostId,
  type HostListEntry,
} from "@shared/types/remoteHosts";
import { currentHostId } from "@/hooks/useHostPlatform";
import { clientPlatform, localHostLabel } from "@/components/Hosts/hostModel";
import { scratchName } from "@/store/scratchStore";

export function isSameHost(a: HostId, b: HostId): boolean {
  return (isLocalHostId(a) ? LOCAL_HOST_ID : a) === (isLocalHostId(b) ? LOCAL_HOST_ID : b);
}

/**
 * Whether words about a dictation another view owns name its host (#14773):
 * one on another machine always does, and one on this machine does when this
 * view is on a host, where the same project name could be either.
 */
export function namesSessionHost(
  session: Pick<VoiceSessionElsewhere, "hostId">,
  viewHostId: HostId = currentHostId()
): boolean {
  return !isLocalHostId(session.hostId) || !isSameHost(session.hostId, viewHostId);
}

/** The host as the host menu names it. */
export function sessionHostName(hostId: HostId, hosts: readonly HostListEntry[]): string {
  if (isLocalHostId(hostId)) return localHostLabel(clientPlatform());
  return hosts.find((entry) => entry.descriptor.id === hostId)?.descriptor.name ?? hostId;
}

/**
 * The workspace's name: the one the owning view gave, else this view's own
 * name for a scratch, looked up only when it is on this view's host, whose
 * scratches those are.
 */
export function sessionWorkspaceName(
  session: Pick<VoiceSessionElsewhere, "hostId" | "projectId" | "projectName">,
  scratches: readonly Scratch[],
  viewHostId: HostId = currentHostId()
): string | null {
  if (session.projectName) return session.projectName;
  return isSameHost(session.hostId, viewHostId) ? scratchName(scratches, session.projectId) : null;
}

/** " in Alpha on studio", " in Alpha", " on studio", or "" when nothing is known. */
export function sessionPlacePhrase(workspace: string | null, hostName: string | null): string {
  const inWorkspace = workspace ? ` in ${workspace}` : "";
  return hostName ? `${inWorkspace} on ${hostName}` : inWorkspace;
}
