import type { HostId } from "../../../shared/types/remoteHosts.js";
import {
  getConfigBundleService,
  reconcileAfterConfigWrite,
  runConfigWrite,
} from "../../services/configBundleRuntime.js";
import type { RemoteHostsClient } from "../client/RemoteHostsClient.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import { ClientSettingsCopy } from "./ClientSettingsCopy.js";
import { HostSettingsCopy } from "./HostSettingsCopy.js";

declare module "../runtime.js" {
  interface RemoteServices {
    settingsCopyClient: ClientSettingsCopy;
  }
}

export interface SettingsCopyClientDeps {
  client: Pick<RemoteHostsClient, "list">;
  /** The host's current open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  holdHost?(hostId: HostId): () => void;
}

/**
 * Shell side: register the copy service the `settingsCopy` IPC namespace
 * reaches through the runtime. It reads this machine's own settings, so a
 * window attached to another host still copies from here.
 */
export function installSettingsCopyClient(deps: SettingsCopyClientDeps): () => void {
  const entry = (hostId: HostId) =>
    deps.client.list().find((candidate) => candidate.descriptor.id === hostId);
  return registerRemoteService(
    "settingsCopyClient",
    new ClientSettingsCopy({
      sessionFor: deps.sessionFor,
      holdHost: deps.holdHost,
      isKnownHost: (hostId) => entry(hostId) !== undefined,
      hostLabel: (hostId) => entry(hostId)?.descriptor.name || hostId,
      collect: async (ids) => (await getConfigBundleService()).collect(ids),
    })
  );
}

export interface SettingsCopyHostServer {
  onSession(listener: (ctx: { session: LinkSession }) => void): () => void;
}

/** Host mode: preview and apply settings an attached Shell copies here when its person asks. */
export function installSettingsCopyHost(server: SettingsCopyHostServer): () => void {
  const host = new HostSettingsCopy({
    service: getConfigBundleService,
    runWrite: runConfigWrite,
    reconcile: reconcileAfterConfigWrite,
  });
  const off = server.onSession(({ session }) => host.attach(session));
  return () => {
    off();
    host.dispose();
  };
}
