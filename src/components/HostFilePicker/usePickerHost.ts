import { LOCAL_HOST_ID, type HostPlatform } from "@shared/types/remoteHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useHostList } from "@/components/Hosts/hostList";
import { clientPlatform, localHostLabel } from "@/components/Hosts/hostModel";

export interface PickerHost {
  /** What the machine is called: its host name, or "This Mac" for this machine. */
  name: string;
  remote: boolean;
  /** For the Apple or Linux mark; null while unknown. */
  platform: HostPlatform | null;
}

/**
 * The machine a picker browses. A request without a host browses the window's
 * own host, which is remote in a window attached to one — so an omitted host
 * never means this machine by itself.
 */
export function usePickerHost(requestHostId: string | undefined): PickerHost {
  const hostList = useHostList();
  const windowHostName = useHostConnectionStore((s) => s.hostName);
  const hostId = requestHostId ?? getViewHostId() ?? LOCAL_HOST_ID;

  if (hostId === LOCAL_HOST_ID) {
    const platform = clientPlatform();
    return {
      name: localHostLabel(platform),
      remote: false,
      platform: platform === "win32" ? null : platform,
    };
  }
  const entry = hostList.hosts.find((host) => host.descriptor.id === hostId);
  const ownWindowName = requestHostId === undefined ? windowHostName : null;
  return {
    name: ownWindowName ?? entry?.descriptor.name ?? hostId,
    remote: true,
    platform: entry?.descriptor.platform ?? null,
  };
}
