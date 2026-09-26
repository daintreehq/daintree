import { MessageChannelMain } from "electron";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { getDriveLeaseService } from "../../services/DriveLeaseService.js";
import { getLifecycleLedger } from "../../services/pty/lifecycleLedger.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import type { LinkSession } from "../link/session.js";
import { wrapMainPort, type PortLike } from "./ports.js";
import { TerminalStreamBridge, type TerminalStreamBridgeOptions } from "./TerminalStreamBridge.js";

/**
 * Host wiring for remote endpoints' terminal streams. A bridge lives as long
 * as its endpoint, not its link session: when the client drops and resumes,
 * the resumed session re-attaches to the same bridge and its ring replays what
 * the client missed.
 */

const bridges = new Map<string, { bridge: TerminalStreamBridge; cleanup: () => void }>();

type BridgeOverrides = Partial<
  Omit<TerminalStreamBridgeOptions, "endpointId" | "openPort" | "releasePort">
>;

/**
 * Connect the pty-host to `endpoint` as a synthetic window keyed by its
 * negative handle, scoped to the endpoint's project.
 */
export function createPtyHostPortFactory(
  handle: number,
  getClient: () => PtyClient | null,
  onRefresh: () => void
): Pick<TerminalStreamBridgeOptions, "openPort" | "releasePort"> {
  if (handle >= 0) throw new Error("A remote endpoint's pty-host connection needs a negative id");
  return {
    openPort: (projectId: string): PortLike | null => {
      const ptyClient = getClient();
      if (!ptyClient) return null;
      const { port1, port2 } = new MessageChannelMain();
      // Context before connect: the pty-host derives the owning shard and the
      // project filter from it.
      ptyClient.registerAuxConnectionContext(handle, projectId);
      ptyClient.setAuxConnectionRefresh(handle, onRefresh);
      // The handle doubles as the port holder, so the pty-host's IPC fallback
      // skips this endpoint for chunks its port already carried.
      ptyClient.connectMessagePort(handle, port2, handle);
      return wrapMainPort(port1);
    },
    releasePort: () => {
      const ptyClient = getClient();
      if (!ptyClient) return;
      ptyClient.setAuxConnectionRefresh(handle, null);
      ptyClient.disconnectMessagePort(handle);
    },
  };
}

/**
 * A remote endpoint as the host's registry knows it, plus the id its Shell
 * uses for it. Stream messages carry the Shell's id, so that is what the
 * bridge matches on; the registry id keys the bridge on this host.
 */
export type RemoteStreamEndpoint = ClientEndpoint & { readonly clientEndpointId: string };

export function attachTerminalBridge(
  session: LinkSession,
  endpoint: RemoteStreamEndpoint,
  overrides: BridgeOverrides = {}
): TerminalStreamBridge {
  let entry = bridges.get(endpoint.endpointId);
  if (entry && entry.bridge.isDisposed) {
    entry.cleanup();
    entry = undefined;
  }
  if (!entry) {
    let bridge: TerminalStreamBridge | null = null;
    const ports = createPtyHostPortFactory(endpoint.handle, getPtyClient, () =>
      bridge?.reconnect()
    );
    bridge = new TerminalStreamBridge({
      endpointId: endpoint.clientEndpointId,
      ...ports,
      getIncarnation: (id) => getLifecycleLedger().currentGeneration(id) ?? 0,
      // Main's spawn records are written before any output exists and dropped
      // when the terminal goes, so they decide what this endpoint may touch.
      ownerOf: (id) => getPtyClient()?.getTerminalProjectId(id) ?? null,
      driveLease: () =>
        endpoint.projectId === null
          ? false
          : getDriveLeaseService().drivingLeaseId(endpoint.projectId, endpoint),
      ...overrides,
    });
    const created = bridge;
    const closeSub = endpoint.onClose(() => detachTerminalBridge(endpoint.endpointId));
    const offChange = getEndpointRegistry().onChange(() => {
      if (!endpoint.isClosed()) created.setProject(endpoint.projectId);
    });
    entry = {
      bridge: created,
      cleanup: () => {
        closeSub.dispose();
        offChange();
      },
    };
    bridges.set(endpoint.endpointId, entry);
  }
  entry.bridge.setProject(endpoint.projectId);
  entry.bridge.attach(session);
  return entry.bridge;
}

/** Tear down an endpoint's stream for good (endpoint closed or its session expired). */
export function detachTerminalBridge(endpointId: string): void {
  const entry = bridges.get(endpointId);
  if (!entry) return;
  bridges.delete(endpointId);
  entry.cleanup();
  entry.bridge.dispose();
}

export function disposeAllTerminalBridges(): void {
  for (const endpointId of [...bridges.keys()]) detachTerminalBridge(endpointId);
}
