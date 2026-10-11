import { dialog, webContents as electronWebContents } from "electron";
import { parseRemotePluginAssetPath } from "../../../shared/types/pluginRemoteView.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
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
import { persistedPluginViewConsent } from "./pluginViewConsent.js";
import { PluginViewGate, type PluginViewQuestion } from "./pluginViewGate.js";
import { defaultHostName, installPluginShellRequests } from "./shellRequests.js";

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

interface ActivePluginClient {
  gate: PluginViewGate;
  assets: ClientPluginAssets;
  hostForView(webContentsId: number): HostId | null;
}

let active: ActivePluginClient | null = null;

/**
 * A remote view, before it imports a host plugin's view: settle this
 * machine's consent for that bundle first, outside the view's load deadline,
 * with the question parented to the asking window. False when it won't run.
 */
export async function preparePluginView(webContentsId: number, url: string): Promise<boolean> {
  const client = active;
  if (!client) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "plugin:" || !parsed.hostname) return false;
  const remote = parseRemotePluginAssetPath(parsed.pathname);
  if (!remote || remote === "malformed") return false;
  // The window's own host, never one the renderer names.
  if (client.hostForView(webContentsId) !== remote.hostId) return false;
  const authority = parsed.hostname;
  return client.gate.prepare({
    hostId: remote.hostId,
    authority,
    webContentsId,
    loadManifest: () => client.assets.loadManifest(remote.hostId, authority),
  });
}

/** The plugins refused on a host this run, which Settings lists beside the allowed ones. */
export function pluginViewRefusals(hostId: HostId): string[] {
  return active?.gate.refusals(hostId) ?? [];
}

/** Settings reset this machine's answer: this run's answers go too, and any open question is void. */
export function revokePluginViewDecisions(hostId: HostId, pluginId?: string): void {
  active?.gate.revoke(hostId, pluginId);
  active?.assets.revokeHost(hostId, pluginId);
}

/**
 * Shell side: answer host plugins' prompts, consent and clipboard requests for
 * the views that drive their projects, and load their view bundles from the
 * host. Returns a teardown.
 */
export function installPluginClient(
  feed: PluginEndpointFeed,
  hostForView: (webContentsId: number) => HostId | null = () => null
): () => void {
  const gate = new PluginViewGate({ consent: persistedPluginViewConsent, ask: askToRunPluginView });
  const assets = new ClientPluginAssets(gate);
  const client: ActivePluginClient = { gate, assets, hostForView };
  active = client;
  const disposers = [
    installPluginShellRequests({
      onEndpointOpened: feed.onEndpointOpened,
      onEndpointClosed: feed.onEndpointClosed,
    }),
    feed.onEndpointOpened((hostId, info) => assets.noteEndpointOpened(hostId, info)),
    feed.onEndpointClosed((hostId, info) => assets.noteEndpointClosed(hostId, info)),
    setRemotePluginAssetProxy(assets.proxy),
    () => {
      if (active === client) active = null;
    },
  ];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}

/** The plugin's name without the project prefix a project plugin's instance id carries. */
function pluginLabel(pluginId: string): string {
  const parts = pluginId.split("__");
  return parts[parts.length - 1] ?? pluginId;
}

let dialogs: Promise<unknown> = Promise.resolve();
let waitingDialogs = 0;
/** Questions queued past this aren't asked: a host can't stack dialogs. */
const MAX_WAITING_DIALOGS = 3;

/**
 * Ask in a native dialog, owned by this machine's main process: a question
 * drawn in the renderer could be answered by host code already running there.
 * One at a time, and only a few waiting.
 */
function askToRunPluginView(question: PluginViewQuestion): Promise<boolean | null> {
  // Not a no: the view isn't run now, and its next load asks again.
  if (waitingDialogs >= MAX_WAITING_DIALOGS) return Promise.resolve(null);
  waitingDialogs++;
  const answer = dialogs.then(() => showPluginViewDialog(question));
  dialogs = answer.catch(() => {});
  return answer.finally(() => waitingDialogs--);
}

async function showPluginViewDialog(question: PluginViewQuestion): Promise<boolean> {
  const host = defaultHostName(question.hostId);
  const plugin = pluginLabel(question.pluginId);
  const wc =
    question.webContentsId === null
      ? undefined
      : electronWebContents.fromId(question.webContentsId);
  const parent = wc && !wc.isDestroyed() ? getWindowForWebContents(wc) : null;
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Run plugin", "Don't run"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message:
      question.kind === "new"
        ? `Run "${plugin}" from ${host} on this computer?`
        : `${host} changed the code of "${plugin}". Run the new version?`,
    detail: `Its view runs in this window with the same access as Daintree itself has on this computer, including your files, terminals and other hosts. Only run it if you trust ${host} and the plugin. You can change this in Settings → Hosts → ${host} → Plugin views.`,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
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
