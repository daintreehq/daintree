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
  /**
   * The document the relay's port went to has navigated away (or is about
   * to), so the next distribution must hand the new document its own port.
   */
  documentChanged: boolean;
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
    const markDocumentChanged = () => {
      const current = relays.get(wcId);
      if (current) current.documentChanged = true;
    };
    const onNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
    ) => {
      if (details.isMainFrame && !details.isSameDocument) markDocumentChanged();
    };
    viewWebContents.once("destroyed", onDestroyed);
    // Both ends of a navigation: a port posted between its start and commit
    // reached the outgoing document, so the commit invalidates it again.
    viewWebContents.on("did-start-navigation", onNavigation);
    viewWebContents.on("did-navigate", markDocumentChanged);
    entry = {
      relay,
      hostId,
      documentChanged: false,
      cleanup: () => {
        viewWebContents.removeListener("destroyed", onDestroyed);
        viewWebContents.removeListener("did-start-navigation", onNavigation);
        viewWebContents.removeListener("did-navigate", markDocumentChanged);
      },
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
 * the relayed port for a remote view whose document actually changed. A remote view whose endpoint has not
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
    } else if (entry && (entry.documentChanged || !entry.relay.hasRendererPort)) {
      // Only a new document (or a port that has gone away) needs a new port:
      // re-delivering to a document that still holds a live one would make
      // the relay treat it as a replacement and repaint every terminal from
      // a snapshot on each project or scratch re-distribution.
      if (entry.relay.deliverPort()) entry.documentChanged = false;
    }
    return true;
  });
}
