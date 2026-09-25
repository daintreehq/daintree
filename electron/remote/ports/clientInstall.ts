import type {
  ForwardPortPayload,
  HostListeningPort,
  PortForward,
  PortForwardsEvent,
} from "../../../shared/types/ipc/portForwards.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { isDevPreviewProxyUrl, isForwardedLoopbackUrl } from "../../../shared/utils/urlUtils.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  getDevPreviewProxyPort,
  setRemoteDevPreviewResolver,
} from "../../ipc/handlers/devPreview.js";
import { setRemoteWebviewSrcGate } from "../../window/ProjectViewHandlers.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import { controlPathFor } from "../client/sshTransport.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import { PortForwardManager } from "./PortForwardManager.js";
import type { SshMuxTarget } from "./sshForward.js";

/** What the Shell's `portForwards` handlers reach through the remote-hosts runtime. */
export interface PortForwardService {
  list(): PortForward[];
  forward(payload: ForwardPortPayload): Promise<PortForward>;
  stop(forwardId: string): Promise<void>;
  listHostPorts(hostId: HostId): Promise<HostListeningPort[]>;
}

declare module "../runtime.js" {
  interface RemoteServices {
    portForwards: PortForwardService;
  }
}

export interface PortForwardClientDeps {
  onEndpointOpened(listener: (hostId: HostId, info: { session: LinkSession }) => void): () => void;
  /** The view's host, or null when it runs on this machine. */
  hostForView(webContentsId: number): HostId | null;
  isKnownHost(hostId: HostId): boolean;
  /**
   * The host's open session whether or not a local view has an endpoint on
   * it, so a port can be forwarded from a host no window is showing.
   */
  sessionFor?(hostId: HostId): LinkSession | null;
  /** Every host in the list, for preview lookups on hosts no view is showing. */
  hostIds?(): HostId[];
  /** The SSH target the host is dialled with, or null for a host reached another way. */
  sshTargetFor(hostId: HostId): string | null;
  /** The Daintree-owned directory holding the hosts' ControlMaster sockets. */
  clientDir: string;
}

/** The preview proxy's own origin: any other `*.localhost` port is this machine's service. */
function isLiveProxyUrl(src: string, proxyPort: number): boolean {
  if (proxyPort === 0 || !isDevPreviewProxyUrl(src)) return false;
  try {
    return Number(new URL(src).port || 80) === proxyPort;
  } catch {
    return false;
  }
}

function broadcastLocal(event: PortForwardsEvent): void {
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.PORT_FORWARDS_EVENT, event);
    } catch {
      // A view mid-teardown.
    }
  }
}

/**
 * Shell side of port forwarding: the forward registry behind `portForwards`,
 * dev previews whose server runs on a host, and the webview rule that makes a
 * forwarded port the host's localhost in that host's windows.
 */
export function installPortForwardClient(deps: PortForwardClientDeps): () => Promise<void> {
  const sessions = new Map<HostId, LinkSession>();
  const liveSession = (hostId: HostId): LinkSession | null => {
    const current = deps.sessionFor?.(hostId) ?? null;
    if (current?.isOpen) return current;
    const session = sessions.get(hostId);
    return session?.isOpen ? session : null;
  };
  const manager = new PortForwardManager({
    sessionFor: liveSession,
    connectedHosts: () =>
      [...new Set([...sessions.keys(), ...(deps.hostIds?.() ?? [])])].filter(
        (hostId) => liveSession(hostId) !== null
      ),
    isKnownHost: deps.isKnownHost,
    sshMuxFor(hostId): SshMuxTarget | null {
      const target = deps.sshTargetFor(hostId);
      if (!target) return null;
      try {
        return { target, controlPath: controlPathFor(deps.clientDir, target) };
      } catch {
        return null;
      }
    },
    onChange: (forwards) => broadcastLocal({ type: "changed", forwards }),
  });

  const service: PortForwardService = {
    list: () => manager.list(),
    forward: (payload) => manager.forward(payload),
    stop: (forwardId) => manager.stop(forwardId),
    listHostPorts: (hostId) => manager.listHostPorts(hostId),
  };

  const disposers = [
    deps.onEndpointOpened((hostId, { session }) => {
      sessions.set(hostId, session);
      session.onClose(() => {
        if (sessions.get(hostId) === session) sessions.delete(hostId);
      });
    }),
    registerRemoteService("portForwards", service),
    setRemoteDevPreviewResolver((subdomain) => manager.resolvePreview(subdomain)),
    setRemoteWebviewSrcGate((webContentsId, src) => {
      const hostId = deps.hostForView(webContentsId);
      if (!hostId) return null;
      return (
        isLiveProxyUrl(src, getDevPreviewProxyPort()) ||
        isForwardedLoopbackUrl(src, manager.localPortsFor(hostId))
      );
    }),
  ];

  // Resolves once listeners are closed and ssh forwards cancelled, so a stop
  // finishes before the host connections these ride on are torn down.
  return async () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    sessions.clear();
    await manager.dispose();
  };
}
