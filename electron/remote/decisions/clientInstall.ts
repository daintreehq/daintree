import type { HostRegistry } from "../client/HostRegistry.js";
import type { RemoteHostManager } from "../client/RemoteHostManager.js";
import type { LinkSession } from "../link/session.js";
import { store } from "../../store.js";
import { ownerStateOf } from "../../types/decisionsHosts.js";
import { setDecisionsHostsPort } from "../../window/serviceRefs.js";
import { DecisionsHostsClient } from "./client.js";

export interface DecisionsHostsClientInstallDeps {
  registry: Pick<HostRegistry, "list" | "onChange">;
  manager: Pick<RemoteHostManager, "hold" | "onSessionOpened" | "onStateChange">;
  sessionFor(hostId: string): LinkSession | null;
  /** The saved Decisions setting: the app's store unless a test says otherwise. */
  readSetting?: () => unknown;
}

/**
 * Shell side: the connected Hosts the Decisions owner here enrolls as devices
 * (#16021), told whether its Decisions is on as each link comes up (#16022).
 * A computer with no owner identity tells them nothing. Publishing the port
 * costs nothing; Decisions reads it only once it is on and set up as an owner.
 */
export function installDecisionsHostsClient(deps: DecisionsHostsClientInstallDeps): () => void {
  const readSetting = deps.readSetting ?? (() => store.get("decisions"));
  const client = new DecisionsHostsClient({
    hosts: () => deps.registry.list().map((host) => ({ hostId: host.id, name: host.name })),
    sessionFor: deps.sessionFor,
    onSessionOpened: (listener) => deps.manager.onSessionOpened(listener),
    onHostsChanged: (listener) => {
      const offs = [deps.registry.onChange(listener), deps.manager.onStateChange(() => listener())];
      return () => {
        for (const off of offs) off();
      };
    },
    hold: (hostId) => deps.manager.hold(hostId),
    ownerState: () => ownerStateOf(readSetting()),
  });
  const stop = client.start();
  const unpublish = setDecisionsHostsPort(client);
  return () => {
    unpublish();
    stop();
  };
}
