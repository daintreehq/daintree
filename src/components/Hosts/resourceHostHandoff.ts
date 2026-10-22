import {
  isReservedHostName,
  sameHostAccount,
  sameHostName,
  sshConnection,
  type HostConnectionState,
  type HostDescriptor,
  type HostListEntry,
} from "@shared/types/remoteHosts";
import { isValidSshTarget } from "@shared/utils/sshTarget";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { requestHostSwitch } from "@/components/HostSwitch/hostSwitchRequests";
import { defaultHostName } from "@/components/Settings/Hosts/hostLabels";
import { openHostsSettingsTab } from "@/components/Settings/Hosts/hostSettingsRequests";
import { requestHostUpdate } from "@/components/Settings/Hosts/hostUpdateRequests";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteShellSupported, remoteConnectionKind } from "@/lib/remoteHosts";
import { ClientAppError } from "@/utils/clientAppError";

export interface ResourceBox {
  worktreeId: string;
  worktreePath: string;
  projectId: string;
  /** The ssh target the resource's `status` reported for its box. */
  sshTarget: string;
  /** Asked for by an agent or a plugin: the switch dialog never moves the window by itself. */
  askFirst?: boolean;
}

/**
 * Where the handoff left off: the switch dialog is placing the worktree on
 * the box, or the box needs Daintree set up first and Settings → Hosts has
 * opened its setup.
 */
export type ResourceHandoffOutcome =
  { status: "placing"; hostId: string } | { status: "setup"; hostId: string };

/**
 * A box can be offered as a host only from a window on this machine (a remote
 * window's worktree lives on its host, not here), and only where hosts are
 * reached over ssh: a Windows Shell reaches them through WSL.
 */
export function canOpenResourceBoxOnHost(sshTarget: string | undefined): sshTarget is string {
  return (
    typeof sshTarget === "string" &&
    isValidSshTarget(sshTarget) &&
    isRemoteShellSupported() &&
    remoteConnectionKind() === "ssh" &&
    getViewHostId() === null
  );
}

/** The box's default name, numbered past any host already called that. */
export function freeHostName(sshTarget: string, hosts: HostListEntry[]): string {
  const base = defaultHostName(sshTarget);
  const taken = (name: string) =>
    isReservedHostName(name) || hosts.some((entry) => sameHostName(entry.descriptor.name, name));
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

function isUsable(state: HostConnectionState): boolean {
  return state.status === "connected" || state.status === "driven-elsewhere";
}

/**
 * Open a worktree on the box its resource environment provisioned, as a
 * Remote Host. A host already in the list for that target is used as it is
 * and stays the user's; otherwise one is added, owned by the worktree, so it
 * goes when the worktree or its resource does. A box whose Daintree isn't
 * listening gets Settings → Hosts' own setup (install, Host mode); one that is
 * goes straight to the switch dialog, which places the branch there.
 */
export async function openResourceBoxOnHost(box: ResourceBox): Promise<ResourceHandoffOutcome> {
  if (!canOpenResourceBoxOnHost(box.sshTarget)) {
    throw new ClientAppError(
      "UNSUPPORTED",
      "The resource's machine can't be opened as a host here",
      "This window can't open the resource's machine as a host."
    );
  }
  const connection = sshConnection(box.sshTarget);
  // Asked before anything is added: a box ssh can't reach leaves no record behind.
  const probe = await remoteHostsClient.probe(connection);
  if (!probe.reachable) {
    throw new ClientAppError(
      "HOST_DISCONNECTED",
      `ssh couldn't reach ${box.sshTarget}`,
      probe.sshError ?? `ssh couldn't reach ${box.sshTarget}.`
    );
  }
  const hosts = await remoteHostsClient.list();
  const existing: HostDescriptor | undefined = hosts.find((entry) =>
    sameHostAccount(entry.descriptor.connection, connection)
  )?.descriptor;
  // One owner per host: another worktree's teardown would take it from under this one.
  if (existing?.ownerWorktreeId && existing.ownerWorktreeId !== box.worktreeId) {
    throw new ClientAppError(
      "VALIDATION",
      `${box.sshTarget} already belongs to another worktree's resource`,
      `${existing.name} was added for another worktree's resource. Remove it in Settings → Hosts, or open that worktree on it instead.`
    );
  }
  const host =
    existing ??
    (await remoteHostsClient.add({
      name: freeHostName(box.sshTarget, hosts),
      connection,
      ownerWorktreeId: box.worktreeId,
    }));

  const setup = (): ResourceHandoffOutcome => {
    requestHostUpdate(host.id);
    openHostsSettingsTab();
    return { status: "setup", hostId: host.id };
  };
  if (!probe.hostModeListening) return setup();
  const state = await remoteHostsClient.connectAndSettle(host.id);
  if (!isUsable(state)) return setup();

  const requestId = requestHostSwitch({
    toHostId: host.id,
    projectId: box.projectId,
    worktreePath: box.worktreePath,
    askFirst: box.askFirst ?? false,
  });
  if (requestId === null) {
    throw new ClientAppError(
      "UNSUPPORTED",
      "No view can show the host switch dialog",
      "Couldn't open the host switch dialog in this window."
    );
  }
  return { status: "placing", hostId: host.id };
}
