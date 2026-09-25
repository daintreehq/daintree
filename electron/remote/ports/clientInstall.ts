import type {
  ForwardPortPayload,
  HostListeningPort,
  PortForward,
  PortForwardsEvent,
} from "../../../shared/types/ipc/portForwards.js";
import {
  isLocalHostId,
  parseHostScopedKey,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import {
  buildDevPreviewSubdomain,
  parseDevPreviewProxyHost,
  sanitizeSubdomainToken,
} from "../../../shared/utils/devPreviewProxy.js";
import { isBoundLoopbackUrl } from "../../../shared/utils/urlUtils.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  getDevPreviewProxyPort,
  resolveLocalDevPreviewUpstream,
  setRemoteDevPreviewResolver,
} from "../../ipc/handlers/devPreview.js";
import { setRemoteWebviewSrcGate } from "../../window/ProjectViewHandlers.js";
import {
  getAllAppWebContents,
  getProjectForWebContents,
} from "../../window/webContentsRegistry.js";
import { observeForwardedInvokes } from "../client/RemoteRouter.js";
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
  /** Every session as it opens, view or not, so forwards retired with the last one come back. */
  onSessionOpened?(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** The view's host, or null when it runs on this machine. */
  hostForView(webContentsId: number): HostId | null;
  /** The host and project (the host's own id for it) a view shows, or null for none. */
  projectForView?(webContentsId: number): ViewProject | null;
  isKnownHost(hostId: HostId): boolean;
  /**
   * The host's open session whether or not a local view has an endpoint on
   * it, so a port can be forwarded from a host no window is showing.
   */
  sessionFor?(hostId: HostId): LinkSession | null;
  /** The SSH target the host is dialled with, or null for a host reached another way. */
  sshTargetFor(hostId: HostId): string | null;
  /** The Daintree-owned directory holding the hosts' ControlMaster sockets. */
  clientDir: string;
}

interface ViewProject {
  hostId: HostId;
  projectId: string;
}

/** Most preview origins remembered; the oldest is forgotten first. */
const MAX_REGISTERED_PREVIEWS = 512;

interface PreviewOwner extends ViewProject {
  views: Set<number>;
}

function defaultProjectForView(webContentsId: number): ViewProject | null {
  const key = getProjectForWebContents(webContentsId);
  if (key === null) return null;
  const { hostId, projectId } = parseHostScopedKey(key);
  return isLocalHostId(hostId) ? null : { hostId, projectId };
}

/**
 * The preview subdomain an http or ws URL on this machine's preview proxy
 * names, or null. Any other `*.localhost` port is one of this machine's own
 * services.
 */
function proxySubdomainOf(src: string, proxyPort: number): string | null {
  if (proxyPort === 0) return null;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "ws:") return null;
    if (url.username || url.password) return null;
    if (Number(url.port || 80) !== proxyPort) return null;
    return parseDevPreviewProxyHost(url.hostname);
  } catch {
    return null;
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
  const projectForView = deps.projectForView ?? defaultProjectForView;
  // Which host and project each remote preview origin belongs to. Claimed by
  // this machine when one of that project's views loads it; the proxy asks
  // only that host, and no other view may load it.
  const previewOwners = new Map<string, PreviewOwner>();
  // Origins this Shell registered when one of its views asked a host to start
  // that preview: the authority wherever one exists; the claim below is the
  // fallback for a preview started before this Shell saw it (a restored panel).
  const registeredPreviews = new Map<string, ViewProject>();
  const registerPreview = (subdomain: string, project: ViewProject): void => {
    const existing = registeredPreviews.get(subdomain);
    // Two projects whose ids sanitise alike: the first to start the panel keeps it.
    if (
      existing &&
      (existing.hostId !== project.hostId || existing.projectId !== project.projectId)
    ) {
      return;
    }
    registeredPreviews.delete(subdomain);
    registeredPreviews.set(subdomain, project);
    if (registeredPreviews.size > MAX_REGISTERED_PREVIEWS) {
      const oldest = registeredPreviews.keys().next().value;
      if (oldest !== undefined) registeredPreviews.delete(oldest);
    }
  };
  const showsProject = (webContentsId: number, owner: ViewProject): boolean => {
    const project = projectForView(webContentsId);
    return project?.hostId === owner.hostId && project.projectId === owner.projectId;
  };
  /** The owner's host while one of its views still shows the project; otherwise the claim lapses. */
  const livePreviewOwner = (subdomain: string): HostId | null => {
    const owner = previewOwners.get(subdomain);
    if (!owner) return null;
    for (const view of owner.views) if (!showsProject(view, owner)) owner.views.delete(view);
    if (owner.views.size > 0) return owner.hostId;
    previewOwners.delete(subdomain);
    return null;
  };
  const claimPreview = (subdomain: string, webContentsId: number, hostId: HostId): boolean => {
    const project = projectForView(webContentsId);
    if (!project || project.hostId !== hostId) return false;
    // A preview this machine serves belongs to a local project.
    if (resolveLocalDevPreviewUpstream(subdomain).kind !== "unknown-subdomain") return false;
    const registered = registeredPreviews.get(subdomain);
    if (registered) {
      return registered.hostId === project.hostId && registered.projectId === project.projectId;
    }
    // The subdomain carries its project's id; a view claims only its own project's.
    if (!subdomain.startsWith(`dp-${sanitizeSubdomainToken(project.projectId)}-`)) return false;
    livePreviewOwner(subdomain);
    let owner = previewOwners.get(subdomain);
    if (owner && (owner.hostId !== project.hostId || owner.projectId !== project.projectId)) {
      return false;
    }
    if (!owner) {
      owner = { ...project, views: new Set() };
      previewOwners.set(subdomain, owner);
    }
    owner.views.add(webContentsId);
    return true;
  };
  const liveSession = (hostId: HostId): LinkSession | null => {
    const current = deps.sessionFor?.(hostId) ?? null;
    if (current?.isOpen) return current;
    const session = sessions.get(hostId);
    return session?.isOpen ? session : null;
  };
  const manager = new PortForwardManager({
    sessionFor: liveSession,
    previewOwner: (subdomain) =>
      registeredPreviews.get(subdomain)?.hostId ?? livePreviewOwner(subdomain),
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
      void manager.reestablish(hostId);
    }),
    deps.onSessionOpened?.((hostId) => void manager.reestablish(hostId)) ?? (() => {}),
    registerRemoteService("portForwards", service),
    observeForwardedInvokes(({ hostId, hostProjectId, channel, args }) => {
      if (channel !== CHANNELS.DEV_PREVIEW_ENSURE || !hostProjectId) return;
      const request = args[0] as { panelId?: unknown } | null | undefined;
      const panelId = request?.panelId;
      if (typeof panelId !== "string" || panelId.length === 0) return;
      // The project comes from this machine's own view key, never from the request.
      registerPreview(buildDevPreviewSubdomain(hostProjectId, panelId), {
        hostId,
        projectId: hostProjectId,
      });
    }),
    setRemoteDevPreviewResolver((subdomain) => manager.resolvePreview(subdomain)),
    setRemoteWebviewSrcGate(
      (webContentsId, src) => {
        const hostId = deps.hostForView(webContentsId);
        if (!hostId) return null;
        if (isBoundLoopbackUrl(src, manager.boundEndpointsFor(hostId))) return true;
        const subdomain = proxySubdomainOf(src, getDevPreviewProxyPort());
        return subdomain !== null && claimPreview(subdomain, webContentsId, hostId);
      },
      (webContentsId) => deps.hostForView(webContentsId) !== null
    ),
  ];

  // Resolves once listeners are closed and ssh forwards cancelled, so a stop
  // finishes before the host connections these ride on are torn down.
  return async () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    sessions.clear();
    previewOwners.clear();
    registeredPreviews.clear();
    await manager.dispose();
  };
}
