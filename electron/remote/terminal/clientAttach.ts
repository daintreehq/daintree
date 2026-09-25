import type { WebContents } from "electron";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { postTerminalPortToView, setTerminalPortOverride } from "../../window/portDistribution.js";
import type { LinkSession } from "../link/session.js";
import { ClientTerminalRelay } from "./ClientTerminalRelay.js";
import { wrapMainPort } from "./ports.js";

/**
 * Client wiring for remote views' terminal streams, keyed by the view's
 * WebContents. A relay belongs to one (host, endpoint) pair and outlives link
 * sessions so it can resume its terminals on the next one; it goes when the
 * view does, when its endpoint is discarded, or when the view moves to
 * another host.
 */

interface RelayEntry {
  relay: ClientTerminalRelay;
  hostId: HostId;
  cleanup: () => void;
}

const relays = new Map<number, RelayEntry>();

export function attachClientTerminalRelay(
  session: LinkSession,
  viewWebContents: WebContents,
  endpointId: string,
  hostId: HostId
): ClientTerminalRelay {
  const wcId = viewWebContents.id;
  let entry = relays.get(wcId);
  if (entry && (entry.relay.endpointId !== endpointId || entry.hostId !== hostId)) {
    detachClientTerminalRelay(wcId);
    entry = undefined;
  }
  if (!entry) {
    const relay = new ClientTerminalRelay({
      endpointId,
      hostId,
      openRendererPort: () => {
        const port = postTerminalPortToView(viewWebContents);
        return port ? wrapMainPort(port) : null;
      },
    });
    const onDestroyed = () => detachClientTerminalRelay(wcId);
    viewWebContents.once("destroyed", onDestroyed);
    entry = {
      relay,
      hostId,
      cleanup: () => viewWebContents.removeListener("destroyed", onDestroyed),
    };
    relays.set(wcId, entry);
    relay.deliverPort();
  }
  entry.relay.attach(session);
  return entry.relay;
}

export function detachClientTerminalRelay(webContentsId: number): void {
  const entry = relays.get(webContentsId);
  if (!entry) return;
  relays.delete(webContentsId);
  entry.cleanup();
  entry.relay.dispose();
}

/** Retire a view's relay only while it still belongs to this (host, endpoint). */
export function detachClientTerminalRelayFor(
  webContentsId: number,
  hostId: HostId,
  endpointId: string
): void {
  const entry = relays.get(webContentsId);
  if (entry?.hostId === hostId && entry.relay.endpointId === endpointId) {
    detachClientTerminalRelay(webContentsId);
  }
}

export function disposeAllClientTerminalRelays(): void {
  for (const webContentsId of [...relays.keys()]) detachClientTerminalRelay(webContentsId);
}

export function getClientTerminalRelay(webContentsId: number): ClientTerminalRelay | undefined {
  return relays.get(webContentsId)?.relay;
}

/**
 * Route local port distribution by the view's authoritative host, so the
 * paths that re-broker a view's port (load, reload, project switch) re-deliver
 * the relayed port for a remote view. A remote view whose endpoint has not
 * opened yet is still claimed: it waits for its relay rather than being handed
 * this machine's pty-host.
 */
export function installClientTerminalPortOverride(
  hostForView: (webContentsId: number) => HostId | null
): () => void {
  return setTerminalPortOverride((targetWc) => {
    const hostId = hostForView(targetWc.id);
    if (hostId === null) return false;
    const entry = relays.get(targetWc.id);
    if (entry && entry.hostId !== hostId) {
      detachClientTerminalRelay(targetWc.id);
    } else if (entry) {
      entry.relay.deliverPort();
    }
    return true;
  });
}
