import type { HostId } from "../../../shared/types/remoteHosts.js";
import { reconcileAfterConfigWrite, runConfigWrite } from "../../services/configBundleRuntime.js";
import type { RemoteHostsClient } from "../client/RemoteHostsClient.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import { ClientSettingsControl } from "./ClientSettingsControl.js";
import { HostSettingsControl } from "./HostSettingsControl.js";
import { loadHostSettingsLeaves } from "./hostLeaves.js";

declare module "../runtime.js" {
  interface RemoteServices {
    settingsControlClient: ClientSettingsControl;
  }
}

export interface SettingsControlClientDeps {
  client: Pick<RemoteHostsClient, "list">;
  /** The host's current open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  holdHost?(hostId: HostId): () => void;
}

/**
 * Shell side: register the service the `hostSettings` IPC namespace and this
 * machine's assistants reach a host's own settings through (#14167).
 */
export function installSettingsControlClient(deps: SettingsControlClientDeps): () => void {
  const entry = (hostId: HostId) =>
    deps.client.list().find((candidate) => candidate.descriptor.id === hostId);
  return registerRemoteService(
    "settingsControlClient",
    new ClientSettingsControl({
      sessionFor: deps.sessionFor,
      holdHost: deps.holdHost,
      isKnownHost: (hostId) => entry(hostId) !== undefined,
      hostLabel: (hostId) => entry(hostId)?.descriptor.name || hostId,
    })
  );
}

export interface SettingsControlHostServer {
  onSession(listener: (ctx: { session: LinkSession }) => void): () => void;
}

/** Host mode: read and change this machine's named settings when an attached Shell asks. */
export function installSettingsControlHost(server: SettingsControlHostServer): () => void {
  const host = new HostSettingsControl({
    load: loadHostSettingsLeaves,
    runWrite: runConfigWrite,
    reconcile: reconcileAfterConfigWrite,
  });
  const off = server.onSession(({ session }) => host.attach(session));
  return () => {
    off();
    host.dispose();
  };
}
