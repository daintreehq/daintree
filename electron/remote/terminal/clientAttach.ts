import type { WebContents } from "electron";
import { postTerminalPortToView, setTerminalPortOverride } from "../../window/portDistribution.js";
import type { LinkSession } from "../link/session.js";
import { ClientTerminalRelay } from "./ClientTerminalRelay.js";
import { wrapMainPort } from "./ports.js";

/**
 * Client wiring for remote views' terminal streams, keyed by the view's
 * WebContents. A relay outlives link sessions so it can resume its terminals
 * on the next one; it goes when the view does.
 */

interface RelayEntry {
  relay: ClientTerminalRelay;
  cleanup: () => void;
}

const relays = new Map<number, RelayEntry>();

export function attachClientTerminalRelay(
  session: LinkSession,
  viewWebContents: WebContents,
  endpointId: string
): ClientTerminalRelay {
  const wcId = viewWebContents.id;
  let entry = relays.get(wcId);
  if (entry && entry.relay.endpointId !== endpointId) {
    detachClientTerminalRelay(wcId);
    entry = undefined;
  }
  if (!entry) {
    const relay = new ClientTerminalRelay({
      endpointId,
      openRendererPort: () => {
        const port = postTerminalPortToView(viewWebContents);
        return port ? wrapMainPort(port) : null;
      },
    });
    const onDestroyed = () => detachClientTerminalRelay(wcId);
    viewWebContents.once("destroyed", onDestroyed);
    entry = {
      relay,
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

export function getClientTerminalRelay(webContentsId: number): ClientTerminalRelay | undefined {
  return relays.get(webContentsId)?.relay;
}

/**
 * Route local port distribution for relayed views to their relay, so a view
 * reload or project switch re-delivers the relayed port instead of a local one.
 */
export function installClientTerminalPortOverride(): () => void {
  return setTerminalPortOverride((targetWc) => {
    const entry = relays.get(targetWc.id);
    if (!entry) return false;
    entry.relay.deliverPort();
    return true;
  });
}
