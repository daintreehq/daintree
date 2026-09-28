import type { HostId } from "../../../shared/types/remoteHosts.js";
import { getDriveLeaseService } from "../../services/DriveLeaseService.js";
import { fetchLocalPluginAsset, setRemotePluginAssetProxy } from "../../setup/protocols.js";
import type { LinkSession } from "../link/session.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { ClientPluginAssets } from "./ClientPluginAssets.js";
import { installPluginHostRouting } from "./hostRouting.js";
import {
  HostPluginAssetService,
  type HostPluginAssetEndpoint,
  type HostPluginAssetPlugin,
} from "./HostPluginAssetService.js";
import { installPluginShellRequests } from "./shellRequests.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostPluginAssets: HostPluginAssetService;
  }
}

export interface PluginEndpointFeed {
  onEndpointOpened(
    listener: (
      hostId: HostId,
      info: { session: LinkSession; webContentsId: number; endpointId: string }
    ) => void
  ): () => void;
  onEndpointClosed(
    listener: (hostId: HostId, info: { webContentsId: number; endpointId: string }) => void
  ): () => void;
}

/**
 * Shell side: answer host plugins' prompts, consent and clipboard requests for
 * the views that drive their projects, and load their view bundles from the
 * host. Returns a teardown.
 */
export function installPluginClient(feed: PluginEndpointFeed): () => void {
  const assets = new ClientPluginAssets();
  const disposers = [
    installPluginShellRequests({
      onEndpointOpened: feed.onEndpointOpened,
      onEndpointClosed: feed.onEndpointClosed,
    }),
    feed.onEndpointOpened((hostId, info) => assets.noteEndpointOpened(hostId, info)),
    feed.onEndpointClosed((hostId, info) => assets.noteEndpointClosed(hostId, info)),
    setRemotePluginAssetProxy(assets.proxy),
  ];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}

async function loadedPlugins(): Promise<HostPluginAssetPlugin[]> {
  const { pluginService } = await import("../../services/PluginService.js");
  return pluginService.listPlugins().map((info) => ({
    instanceId: info.instanceId,
    projectId: info.projectId,
    dir: info.dir,
    remoteUnsupported: info.manifest.remote === "unsupported",
  }));
}

/**
 * Host side (Host mode): send plugin prompts, consent and clipboard to the
 * frontend that drives each project, and serve plugin view bundles to the
 * Shells attached here. Returns a teardown.
 */
export function installPluginHost(): () => void {
  const lease = getDriveLeaseService();
  let rootForAuthority: (authority: string) => string | undefined = () => undefined;
  void import("../../services/PluginService.js").then(({ pluginService }) => {
    rootForAuthority = (authority) => pluginService.getPluginRootByAuthority(authority);
  });
  const service = new HostPluginAssetService({
    rootForAuthority: (authority) => rootForAuthority(authority),
    loadedPlugins,
    isDriving: (projectId, endpoint) => lease.isDriving(projectId, endpoint),
    fetchAsset: (request) => fetchLocalPluginAsset(request),
  });
  const disposers = [
    installPluginHostRouting(),
    registerRemoteService("hostPluginAssets", service),
  ];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    service.dispose();
  };
}

/** Host-mode boot hook: serve plugin assets for this endpoint on the link it rides now. */
export function attachHostPluginAssets(
  session: LinkSession,
  endpoint: HostPluginAssetEndpoint
): void {
  getRemoteService("hostPluginAssets")?.attach(session, endpoint);
}
