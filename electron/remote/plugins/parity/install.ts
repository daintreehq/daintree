import { BrowserWindow, dialog } from "electron";
import type { HostId } from "../../../../shared/types/remoteHosts.js";
import type {
  PluginInstallPhase,
  PluginInstallProgressEvent,
  PluginInstallResult,
} from "../../../../shared/types/plugin.js";
import { describePluginInstallSource } from "../../../../shared/utils/pluginInstallSource.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { getIpcDispatcher } from "../../../ipc/dispatcher.js";
import type { HybridSplit, IpcDispatcher } from "../../../ipc/endpoint.js";
import type { IpcContext } from "../../../ipc/types.js";
import { AppError } from "../../../utils/errorTypes.js";
import {
  getWindowForWebContents,
  resolveLiveWebContents,
} from "../../../window/webContentsRegistry.js";
import type { RemoteHostsClient } from "../../client/RemoteHostsClient.js";
import type { LinkSession } from "../../link/session.js";
import { getRemoteService, registerRemoteService } from "../../runtime.js";
import { ClientPluginParity, type LocalPlugins } from "./ClientPluginParity.js";
import { HostPluginParity } from "./HostPluginParity.js";

declare module "../../runtime.js" {
  interface RemoteServices {
    pluginParityClient: ClientPluginParity;
  }
}

async function pluginService() {
  return (await import("../../../services/PluginService.js")).pluginService;
}

const localPlugins: LocalPlugins = {
  async inventory() {
    return (await pluginService()).getPluginInventory();
  },
  async installedDir(pluginId) {
    const info = (await pluginService())
      .listPlugins()
      .find(
        (candidate) =>
          candidate.instanceId === pluginId && candidate.origin === "global" && !candidate.isBuiltin
      );
    return info?.dir ?? null;
  },
};

async function packPlugin(dir: string, outputPath: string): Promise<void> {
  const { packPluginArchive } = await import("../../../services/PluginArchive.js");
  await packPluginArchive(dir, outputPath, { sourcemaps: true });
}

export interface PluginParityClientDeps {
  client: Pick<RemoteHostsClient, "list">;
  /** The host's current open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
}

export function createPluginParityClient(deps: PluginParityClientDeps): ClientPluginParity {
  const entry = (hostId: HostId) =>
    deps.client.list().find((candidate) => candidate.descriptor.id === hostId);
  return new ClientPluginParity({
    sessionFor: deps.sessionFor,
    isKnownHost: (hostId) => entry(hostId) !== undefined,
    hostLabel: (hostId) => entry(hostId)?.descriptor.name || hostId,
    local: localPlugins,
    pack: packPlugin,
  });
}

/**
 * Shell side: register the parity service the `pluginParity` IPC namespace
 * reaches through the runtime. It works per session, so Settings can compare
 * and install with no window on the host; it does nothing until asked.
 */
export function installPluginParityClient(deps: PluginParityClientDeps): () => void {
  return registerRemoteService("pluginParityClient", createPluginParityClient(deps));
}

function notRunning(): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: "Remote hosts client is not running",
  });
}

// Same bound the local install handlers put on a renderer-minted job id.
const INSTALL_JOB_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

function validJobId(value: unknown): string | undefined {
  return typeof value === "string" && INSTALL_JOB_ID_PATTERN.test(value) ? value : undefined;
}

/** Push an install's phases to the window that asked, as the local install does. */
function progressTo(webContentsId: number, jobId: string, localPath: string) {
  const source = describePluginInstallSource(localPath);
  return (phase: PluginInstallPhase) => {
    const wc = resolveLiveWebContents(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    const event: PluginInstallProgressEvent = {
      jobId,
      phase,
      cancellable: phase !== "activating",
      source,
    };
    wc.send(CHANNELS.PLUGIN_INSTALL_PROGRESS, event);
  };
}

/**
 * The window's job id travels with the package: the host registers it, so the
 * window's Cancel (sent to the host) stops the transfer or the install up to
 * its commit point, and the host's install phases come back to the window.
 */
function installOnHost(
  hostId: HostId,
  webContentsId: number,
  localPath: string,
  jobIdArg: unknown
): Promise<PluginInstallResult> {
  const parity = getRemoteService("pluginParityClient");
  if (!parity) throw notRunning();
  const jobId = validJobId(jobIdArg);
  return parity.installLocalPackageOnHost(
    hostId,
    localPath,
    jobId === undefined ? {} : { jobId, onPhase: progressTo(webContentsId, jobId, localPath) }
  );
}

/**
 * In a window attached to a host, a `.dntr` dropped or picked on this machine
 * installs on the host: the window's plugins are the host's. The file and the
 * picker are this machine's, so the split sends the package over and the
 * host runs its own install path on it.
 */
export function createPluginInstallSplits(
  pick: (webContentsId: number) => Promise<string | null>
): Record<string, HybridSplit> {
  return {
    [CHANNELS.PLUGIN_INSTALL_FROM_PATH]: async ({ hostId, webContentsId, args }) => {
      const localPath = args[0];
      if (typeof localPath !== "string" || localPath.length === 0 || localPath.includes("\0")) {
        return { status: "failed", errors: [{ code: "archive_invalid", message: "Invalid path" }] };
      }
      return installOnHost(hostId, webContentsId, localPath, args[1]);
    },
    [CHANNELS.PLUGIN_INSTALL_FROM_FILE]: async ({ hostId, webContentsId, args }) => {
      const localPath = await pick(webContentsId);
      if (localPath === null) return { status: "cancelled" };
      return installOnHost(hostId, webContentsId, localPath, args[0]);
    },
  };
}

async function pickLocalArchive(webContentsId: number): Promise<string | null> {
  const wc = resolveLiveWebContents(webContentsId);
  const win = (wc ? getWindowForWebContents(wc) : null) ?? BrowserWindow.getFocusedWindow();
  const options = {
    title: "Install plugin",
    filters: [{ name: "Daintree plugins", extensions: ["dntr"] }],
    properties: ["openFile" as const],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** Shell side: register the install splits over the base refusals. */
export function installPluginInstallSplits(
  dispatcher: Pick<IpcDispatcher<IpcContext>, "registerHybridSplit"> = getIpcDispatcher(),
  pick: (webContentsId: number) => Promise<string | null> = pickLocalArchive
): () => void {
  const disposers = Object.entries(createPluginInstallSplits(pick)).map(([channel, split]) =>
    dispatcher.registerHybridSplit(channel, split)
  );
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}

export interface PluginParityHostServer {
  onSession(listener: (ctx: { session: LinkSession }) => void): () => void;
}

/**
 * Host mode: report this machine's plugins to attached Shells and install a
 * package one sends when its person asks.
 */
export function installPluginParityHost(server: PluginParityHostServer): () => void {
  const host = new HostPluginParity({ plugins: pluginService });
  const off = server.onSession(({ session }) => host.attach(session));
  return () => {
    off();
    host.dispose();
  };
}
