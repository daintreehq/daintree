import type {
  ForwardPortPayload,
  HostListeningPort,
  PortForward,
  PortForwardsEvent,
  ReleasePortForwardsPayload,
} from "../../../shared/types/ipc/portForwards.js";
import {
  isLocalHostId,
  parseHostScopedKey,
  type HostConnection,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import {
  buildDevPreviewSubdomain,
  parseDevPreviewProxyHost,
  sanitizeSubdomainToken,
} from "../../../shared/utils/devPreviewProxy.js";
import { isBoundLoopbackUrl } from "../../../shared/utils/urlUtils.js";
import { CHANNELS } from "../../ipc/channels.js";
import { AppError } from "../../utils/errorTypes.js";
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
import { sshTargetOf } from "../client/connection.js";
import { controlPathFor } from "../client/sshTransport.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import {
  isValidPanelId,
  panelOwner,
  PortForwardManager,
  viewOwnerPrefix,
} from "./PortForwardManager.js";
import type { SshMuxTarget } from "./sshForward.js";

/** The view a `portForwards` call came from, as the IPC layer saw it, never as the call claims. */
export interface PortForwardCaller {
  webContentsId: number;
}

/** What the Shell's `portForwards` handlers reach through the remote-hosts runtime. */
export interface PortForwardService {
  list(): PortForward[];
  /** A payload naming a `panelId` is held for that panel of `caller`'s view until it lets go. */
  forward(payload: ForwardPortPayload, caller?: PortForwardCaller): Promise<PortForward>;
  /** The panel closed: its forwards go once nothing else holds them. */
  release(payload: ReleasePortForwardsPayload, caller: PortForwardCaller): void;
  stop(forwardId: string): Promise<void>;
  listHostPorts(hostId: HostId): Promise<HostListeningPort[]>;
  /**
   * The host was removed or re-pointed: its forwards close, retired ones
   * included, and its preview origins are no longer its.
   */
  forgetHost(hostId: HostId): Promise<void>;
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
  /** Keep a host's connection open while this says so (it has forwards). */
  addUseCheck?(check: (hostId: HostId) => boolean): () => void;
  /** The host list changed: a removed host's forwards are closed. */
  onHostsChanged?(listener: () => void): () => void;
  /**
   * The host's open session whether or not a local view has an endpoint on
   * it, so a port can be forwarded from a host no window is showing.
   */
  sessionFor?(hostId: HostId): LinkSession | null;
  /** How the host is reached, or null for a host not in the list. */
  connectionFor(hostId: HostId): HostConnection | null;
  /** The Daintree-owned directory holding the hosts' ControlMaster sockets. */
  clientDir: string;
  /** A host's name for copy, or null for a host not in the list. */
  hostName?(hostId: HostId): string | null;
  /**
   * Call `onGone` once the view is destroyed (at once for one already gone);
   * returns an unwatch. Without it, a view's panels let go only by releasing.
   */
  watchView?(webContentsId: number, onGone: () => void): () => void;
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

function invalidPanel(): AppError {
  return new AppError({ code: "VALIDATION", message: "Invalid browser panel id" });
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
  /** False when another host or project already has the origin. */
  const registerPreview = (subdomain: string, project: ViewProject): boolean => {
    const existing = registeredPreviews.get(subdomain);
    // Two projects whose ids sanitise alike: the first to start the panel keeps it.
    if (
      existing &&
      (existing.hostId !== project.hostId || existing.projectId !== project.projectId)
    ) {
      return false;
    }
    registeredPreviews.delete(subdomain);
    registeredPreviews.set(subdomain, project);
    if (registeredPreviews.size > MAX_REGISTERED_PREVIEWS) {
      const oldest = registeredPreviews.keys().next().value;
      if (oldest !== undefined) registeredPreviews.delete(oldest);
    }
    return true;
  };
  const isPreviewOwner = (subdomain: string, project: ViewProject): boolean | null => {
    const owner = registeredPreviews.get(subdomain) ?? previewOwners.get(subdomain);
    if (!owner) return null;
    return owner.hostId === project.hostId && owner.projectId === project.projectId;
  };
  /** Whether a call from `project` speaks for the origin: no other host or project has it. */
  const ownsPreview = (subdomain: string, project: ViewProject): boolean =>
    isPreviewOwner(subdomain, project) !== false;
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
      if (registered.hostId !== project.hostId || registered.projectId !== project.projectId) {
        return false;
      }
      notePreviewView(subdomain, webContentsId);
      return true;
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
    notePreviewView(subdomain, webContentsId);
    return true;
  };
  const liveSession = (hostId: HostId): LinkSession | null => {
    const current = deps.sessionFor?.(hostId) ?? null;
    if (current?.isOpen) return current;
    const session = sessions.get(hostId);
    return session?.isOpen ? session : null;
  };
  const forwards = new PortForwardManager({
    sessionFor: liveSession,
    previewOwner: (subdomain) =>
      registeredPreviews.get(subdomain)?.hostId ?? livePreviewOwner(subdomain),
    isKnownHost: deps.isKnownHost,
    sshMuxFor(hostId): SshMuxTarget | null {
      // `-O forward` needs an ssh master; any other connection forwards over the link.
      const connection = deps.connectionFor(hostId);
      const target = connection ? sshTargetOf(connection) : null;
      if (!target) return null;
      try {
        return { target, controlPath: controlPathFor(deps.clientDir, target) };
      } catch {
        return null;
      }
    },
    onChange: (list) => broadcastLocal({ type: "changed", forwards: list }),
    hostName: deps.hostName,
  });
  // Views watched for their end, so the panels and previews they held let go.
  const watchedViews = new Map<number, () => void>();
  // The views each remote preview was started or loaded in: it lets go with the last of them.
  const previewViews = new Map<string, Set<number>>();
  // Each worktree's remote previews (by host, project and worktree), for a stop of the worktree's server.
  const previewWorktrees = new Map<string, Set<string>>();
  const worktreeKey = (project: ViewProject, worktreeId: string): string =>
    `${project.hostId}\u0000${project.projectId}\u0000${worktreeId}`;
  const viewGone = (webContentsId: number): void => {
    watchedViews.delete(webContentsId);
    forwards.releaseAll(viewOwnerPrefix(webContentsId));
    for (const [subdomain, views] of previewViews) {
      if (!views.delete(webContentsId) || views.size > 0) continue;
      previewViews.delete(subdomain);
      forwards.releasePreview(subdomain);
    }
  };
  const watchView = (webContentsId: number): void => {
    if (!deps.watchView || watchedViews.has(webContentsId)) return;
    // Set first: a view already gone calls back on a later microtask, which deletes it.
    watchedViews.set(webContentsId, () => {});
    const unwatch = deps.watchView(webContentsId, () => viewGone(webContentsId));
    if (watchedViews.has(webContentsId)) watchedViews.set(webContentsId, unwatch);
  };
  const notePreviewView = (subdomain: string, webContentsId: number): void => {
    let views = previewViews.get(subdomain);
    if (!views) {
      views = new Set();
      previewViews.set(subdomain, views);
    }
    views.add(webContentsId);
    watchView(webContentsId);
  };
  const hostOfWorktreeKey = (key: string): string => key.slice(0, key.indexOf("\u0000"));
  /**
   * The host's preview origins, and the session they were looked up on, were
   * claimed for the machine it named until now: another under the same id
   * must claim them afresh.
   */
  const forgetHostPreviews = (hostId: HostId): void => {
    const subdomains = new Set<string>();
    for (const [subdomain, project] of registeredPreviews) {
      if (project.hostId !== hostId) continue;
      registeredPreviews.delete(subdomain);
      subdomains.add(subdomain);
    }
    for (const [subdomain, owner] of previewOwners) {
      if (owner.hostId !== hostId) continue;
      previewOwners.delete(subdomain);
      subdomains.add(subdomain);
    }
    for (const [key, previews] of previewWorktrees) {
      if (hostOfWorktreeKey(key) !== hostId) continue;
      previewWorktrees.delete(key);
      for (const subdomain of previews) subdomains.add(subdomain);
    }
    for (const subdomain of subdomains) {
      // Still claimed means another host has it now: its views stay.
      if (!registeredPreviews.has(subdomain) && !previewOwners.has(subdomain)) {
        previewViews.delete(subdomain);
      }
    }
    sessions.delete(hostId);
  };
  /** Hosts no longer in the list lose their previews as well as their forwards. */
  const pruneUnknownHosts = (): void => {
    const hostIds = new Set<HostId>(sessions.keys());
    for (const project of registeredPreviews.values()) hostIds.add(project.hostId);
    for (const owner of previewOwners.values()) hostIds.add(owner.hostId);
    for (const key of previewWorktrees.keys()) hostIds.add(hostOfWorktreeKey(key));
    for (const hostId of hostIds) if (!deps.isKnownHost(hostId)) forgetHostPreviews(hostId);
    void forwards.pruneUnknownHosts();
  };

  const service: PortForwardService = {
    list: () => forwards.list(),
    forward: async (payload, caller) => {
      const panelId = (payload as { panelId?: unknown } | null | undefined)?.panelId;
      if (panelId === undefined) return forwards.forward(payload);
      if (!caller || !isValidPanelId(panelId)) throw invalidPanel();
      watchView(caller.webContentsId);
      return forwards.forward(payload, panelOwner(caller.webContentsId, panelId));
    },
    release: (payload, caller) => {
      const panelId = (payload as { panelId?: unknown } | null | undefined)?.panelId;
      if (!isValidPanelId(panelId)) throw invalidPanel();
      forwards.release(panelOwner(caller.webContentsId, panelId));
    },
    stop: (forwardId) => forwards.stop(forwardId),
    listHostPorts: (hostId) => forwards.listHostPorts(hostId),
    forgetHost: async (hostId) => {
      forgetHostPreviews(hostId);
      await forwards.forgetHost(hostId);
    },
  };

  const disposers = [
    deps.onEndpointOpened((hostId, { session }) => {
      sessions.set(hostId, session);
      session.onClose(() => {
        if (sessions.get(hostId) === session) sessions.delete(hostId);
      });
      void forwards.reestablish(hostId);
    }),
    deps.onSessionOpened?.((hostId) => void forwards.reestablish(hostId)) ?? (() => {}),
    deps.onHostsChanged?.(pruneUnknownHosts) ?? (() => {}),
    deps.addUseCheck?.((hostId) => forwards.hasForwardsFor(hostId)) ?? (() => {}),
    registerRemoteService("portForwards", service),
    observeForwardedInvokes(({ hostId, webContentsId, hostProjectId, channel, args }) => {
      if (!hostProjectId) return;
      // A preview is registered to this machine's own view key, never to the request's project.
      const project: ViewProject = { hostId, projectId: hostProjectId };
      const request = args[0] as
        { panelId?: unknown; projectId?: unknown; worktreeId?: unknown } | null | undefined;
      const worktreeId = typeof request?.worktreeId === "string" ? request.worktreeId : null;
      // A worktree's servers were stopped: its previews' panels look nothing up again.
      if (
        channel === CHANNELS.DEV_PREVIEW_STOP_BY_WORKTREE ||
        channel === CHANNELS.DEV_PREVIEW_STOP_DEV_SERVER_BY_WORKTREE
      ) {
        if (worktreeId === null) return;
        // Kept: a restart from the dashboard brings them back with no ensure to note them again.
        const previews = previewWorktrees.get(worktreeKey(project, worktreeId)) ?? [];
        for (const subdomain of previews) forwards.releasePreview(subdomain);
        return;
      }
      const panelId = request?.panelId;
      if (typeof panelId !== "string" || panelId.length === 0) return;
      const subdomain = buildDevPreviewSubdomain(hostProjectId, panelId);
      switch (channel) {
        case CHANNELS.DEV_PREVIEW_ENSURE: {
          if (!registerPreview(subdomain, project)) return;
          notePreviewView(subdomain, webContentsId);
          if (worktreeId === null) return;
          const key = worktreeKey(project, worktreeId);
          const previews = previewWorktrees.get(key) ?? new Set<string>();
          previews.add(subdomain);
          previewWorktrees.set(key, previews);
          return;
        }
        // The panel closed, or its dev server was stopped: nothing will look its preview up again.
        case CHANNELS.DEV_PREVIEW_STOP_BY_PANEL:
          if (!ownsPreview(subdomain, project)) return;
          previewViews.delete(subdomain);
          for (const previews of previewWorktrees.values()) previews.delete(subdomain);
          forwards.releasePreview(subdomain);
          return;
        case CHANNELS.DEV_PREVIEW_STOP: {
          // The dev server dashboard stops any project's server on the host from
          // one view. The host has already stopped the session the request
          // names, so that session's preview goes, never the sender's
          // same-named panel.
          const stoppedProjectId =
            typeof request?.projectId === "string" && request.projectId.length > 0
              ? request.projectId
              : hostProjectId;
          const stopped: ViewProject = { hostId, projectId: stoppedProjectId };
          const stoppedSubdomain = buildDevPreviewSubdomain(stoppedProjectId, panelId);
          // A view speaks for its own project's previews; another project's goes
          // only while it is still recorded as that project's, since an origin
          // with no record may be another host's.
          const releasable =
            stoppedProjectId === hostProjectId
              ? ownsPreview(stoppedSubdomain, stopped)
              : isPreviewOwner(stoppedSubdomain, stopped) === true;
          if (releasable) forwards.releasePreview(stoppedSubdomain);
          return;
        }
      }
    }),
    setRemoteDevPreviewResolver((subdomain) => forwards.resolvePreview(subdomain)),
    setRemoteWebviewSrcGate(
      (webContentsId, src) => {
        const hostId = deps.hostForView(webContentsId);
        if (!hostId) return null;
        if (isBoundLoopbackUrl(src, forwards.boundEndpointsFor(hostId))) return true;
        const subdomain = proxySubdomainOf(src, getDevPreviewProxyPort());
        return subdomain !== null && claimPreview(subdomain, webContentsId, hostId);
      },
      (webContentsId) => deps.hostForView(webContentsId) !== null,
      (webContentsId) => deps.hostForView(webContentsId)
    ),
  ];

  // Resolves once listeners are closed and ssh forwards cancelled, so a stop
  // finishes before the host connections these ride on are torn down.
  return async () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    for (const unwatch of watchedViews.values()) unwatch();
    watchedViews.clear();
    previewViews.clear();
    previewWorktrees.clear();
    sessions.clear();
    previewOwners.clear();
    registeredPreviews.clear();
    await forwards.dispose();
  };
}
