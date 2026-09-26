import { randomUUID } from "node:crypto";
import { clipboard, shell } from "electron";
import type { AppState, BootResult, HydrateResult } from "../../../shared/types/ipc/app.js";
import type {
  ProjectFocusOnActivateIntent,
  ProjectSwitchPayload,
  ProjectSwitchResult,
  ProjectSwitchTrace,
} from "../../../shared/types/ipc/project.js";
import type { EditorConfig, EditorGetConfigResult } from "../../../shared/types/editor.js";
import type { SystemOpenInEditorFallback } from "../../../shared/types/ipc/system.js";
import type { ScratchSwitchPayload } from "../../../shared/types/ipc/scratch.js";
import type { Scratch } from "../../../shared/types/scratch.js";
import {
  toHostScopedKey,
  type HostDescriptor,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { HybridSplit } from "../../ipc/endpoint.js";
import type { IpcContext } from "../../ipc/types.js";
import { composeBootResult, readShellHydrateFields } from "../../ipc/handlers/app/state.js";
import { readHydrateTerminalConfig } from "../../services/AppHydrationService.js";
import { store } from "../../store.js";
import {
  APP_STATE_FIELD_OWNERSHIP,
  TERMINAL_CONFIG_FIELD_OWNERSHIP,
} from "../../storeOwnership.js";
import { AppError } from "../../utils/errorTypes.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";
import { hasLiveProjectView } from "../../window/projectOwnership.js";
import {
  getWindowForWebContents,
  resolveLiveWebContents,
} from "../../window/webContentsRegistry.js";
import { getWindowRegistry } from "../../window/windowRef.js";
import { isValidSshTarget } from "../client/sshTransport.js";
import { getRemoteService } from "../runtime.js";
import { mergeByOwnership, splitByOwnership } from "./fieldOwnership.js";
import { notificationSettingsGet, notificationSettingsSet } from "./notificationSettings.js";
import { sshTargetOf } from "../client/connection.js";

type SplitCall = Parameters<HybridSplit>[0];

function hostDescriptor(hostId: HostId): HostDescriptor | null {
  const entry = getRemoteService("remoteHostsClient")
    ?.list()
    .find((candidate) => candidate.descriptor.id === hostId);
  return entry?.descriptor ?? null;
}

function hostLabel(hostId: HostId): string {
  return hostDescriptor(hostId)?.name ?? "the host";
}

/**
 * A hybrid call with no remote half yet. Refused with a typed error naming
 * the host rather than answered from this machine, where it would act on the
 * wrong filesystem.
 */
function refuse(userMessage: (host: string) => string): HybridSplit {
  return async ({ hostId }) => {
    throw new AppError({
      code: "UNSUPPORTED",
      message: `Not available in a window attached to host ${hostId}`,
      userMessage: userMessage(hostLabel(hostId)),
      context: { hostId },
    });
  };
}

const localOnly: HybridSplit = ({ local }) => local();
const remoteOnly: HybridSplit = ({ remote }) => remote();

/** The Shell half of a hydrate merged over the host's answer. */
function mergeHydrate(host: HydrateResult): HydrateResult {
  return {
    ...host,
    ...readShellHydrateFields({ consumeOneShots: true }),
    appState: mergeByOwnership<AppState>(
      store.get("appState"),
      host.appState,
      APP_STATE_FIELD_OWNERSHIP
    ),
    terminalConfig: mergeByOwnership<HydrateResult["terminalConfig"]>(
      readHydrateTerminalConfig(),
      host.terminalConfig,
      TERMINAL_CONFIG_FIELD_OWNERSHIP
    ),
  };
}

async function hostHydrate(remote: SplitCall["remote"]): Promise<HydrateResult> {
  return (await remote(CHANNELS.APP_HYDRATE, [])) as HydrateResult;
}

const appHydrate: HybridSplit = async ({ remote }) => mergeHydrate(await hostHydrate(remote));

// The host's own crash gate describes the host process, never this window's.
const appBoot: HybridSplit = async ({ remote }): Promise<BootResult> =>
  composeBootResult(mergeHydrate(await hostHydrate(remote)));

const appGetState: HybridSplit = async ({ local, remote }) => {
  const [device, host] = await Promise.all([local(), remote()]);
  return mergeByOwnership<AppState>(device, host, APP_STATE_FIELD_OWNERSHIP);
};

const appSetState: HybridSplit = async ({ args, local, remote }) => {
  const { device, host } = splitByOwnership(args[0], APP_STATE_FIELD_OWNERSHIP);
  await Promise.all([
    Object.keys(device).length > 0 ? local([device]) : undefined,
    Object.keys(host).length > 0 ? remote(undefined, [host]) : undefined,
  ]);
};

const terminalConfigGet: HybridSplit = async ({ local, remote }) => {
  const [device, host] = await Promise.all([local(), remote()]);
  return mergeByOwnership(device, host, TERMINAL_CONFIG_FIELD_OWNERSHIP);
};

/** Which project's editor preference is the host's; which editors exist is this machine's. */
const editorGetConfig: HybridSplit = async ({ local, remote }) => {
  const [device, host] = (await Promise.all([local([undefined]), remote()])) as [
    EditorGetConfigResult,
    EditorGetConfigResult,
  ];
  return {
    preferredEditor: host.preferredEditor,
    discoveredEditors: device.discoveredEditors,
  } satisfies EditorGetConfigResult;
};

const appReloadConfig: HybridSplit = async ({ local, remote }) => {
  await remote();
  return local();
};

// The content is already here; a host cwd names nothing on this machine.
const artifactSaveToFile: HybridSplit = ({ args, local }) => {
  const options = args[0];
  if (!options || typeof options !== "object") return local();
  return local([{ ...(options as Record<string, unknown>), cwd: undefined }]);
};

// Hover prefetch warms this machine's hydrate cache, which a remote view never reads.
const prefetchHydrate: HybridSplit = async () => undefined;

function senderContext(webContentsId: number): IpcContext {
  // switchWindowHost resolves the window from the sender id alone.
  return { webContentsId, senderWindow: null } as unknown as IpcContext;
}

function projectViewManagerOf(webContentsId: number): ProjectViewManager | null {
  const wc = resolveLiveWebContents(webContentsId);
  const win = wc ? getWindowForWebContents(wc) : null;
  if (!win || win.isDestroyed()) return null;
  return getWindowRegistry()?.getByWindowId(win.id)?.services.projectViewManager ?? null;
}

interface SwitchOptions {
  focusIntent?: ProjectFocusOnActivateIntent;
  trace?: Partial<ProjectSwitchTrace>;
}

/**
 * The host activates the project (saves the outgoing layout, starts or wakes
 * its workspace and holds it for the view); this Shell then shows it, in a
 * view keyed to that host, and does what a local switch does for the view it
 * lands on: hands it the focus intent and tells it, and only it, that it was
 * switched to.
 */
const projectSwitch: HybridSplit = async ({ hostId, webContentsId, args, remote }) => {
  const result = (await remote()) as ProjectSwitchResult;
  if (result.outcome !== "switched") return result;
  const client = getRemoteService("remoteHostsClient");
  if (!client) {
    throw new AppError({
      code: "HOST_DISCONNECTED",
      message: "Remote hosts client is not running",
    });
  }
  const projectId = args[0] as string;
  const options = (args[2] && typeof args[2] === "object" ? args[2] : {}) as SwitchOptions;
  const key = toHostScopedKey(hostId, projectId);
  const pvm = projectViewManagerOf(webContentsId);
  const cacheHit = hasLiveProjectView(pvm, key);
  // Before the swap, as a local switch records it: the view consumes it on activation.
  if (options.focusIntent) pvm?.setPendingFocusIntent(key, options.focusIntent);
  await client.switchWindowHost(senderContext(webContentsId), {
    hostId,
    projectId,
    newWindow: false,
  });
  const view = pvm?.getActiveProjectId() === key ? pvm.getActiveView() : null;
  const wc = view?.webContents;
  if (wc && !wc.isDestroyed()) {
    wc.send(CHANNELS.PROJECT_ON_SWITCH, {
      project: result.project,
      switchId:
        typeof options.trace?.switchId === "string" && options.trace.switchId
          ? options.trace.switchId
          : randomUUID(),
      entryPoint: options.trace?.entryPoint ?? "api",
      cacheHit,
    } satisfies ProjectSwitchPayload);
  }
  return result;
};

/**
 * A scratch is a workspace like a project, with no project row: the host
 * confirms it and marks it opened; this Shell shows it in a view keyed to that
 * host and tells that view, and only it, that it switched. The host's own
 * current-scratch pointer describes its own windows and is left alone.
 */
const scratchSwitch: HybridSplit = async ({ hostId, webContentsId, args, remote }) => {
  const scratch = (await remote()) as Scratch | null;
  if (!scratch || typeof scratch.id !== "string" || !scratch.id) {
    throw new AppError({ code: "INTERNAL", message: "The host sent no scratch for the switch" });
  }
  const client = getRemoteService("remoteHostsClient");
  if (!client) {
    throw new AppError({
      code: "HOST_DISCONNECTED",
      message: "Remote hosts client is not running",
    });
  }
  const options = (args[1] && typeof args[1] === "object" ? args[1] : {}) as SwitchOptions;
  const key = toHostScopedKey(hostId, scratch.id);
  const pvm = projectViewManagerOf(webContentsId);
  if (options.focusIntent) pvm?.setPendingFocusIntent(key, options.focusIntent);
  await client.switchWindowHost(senderContext(webContentsId), {
    hostId,
    projectId: scratch.id,
    newWindow: false,
  });
  const view = pvm?.getActiveProjectId() === key ? pvm.getActiveView() : null;
  const wc = view?.webContents;
  if (wc && !wc.isDestroyed()) {
    wc.send(CHANNELS.SCRATCH_ON_SWITCH, {
      scratch,
      switchId: randomUUID(),
    } satisfies ScratchSwitchPayload);
  }
  return scratch;
};

/** Editors that open a folder or file on an SSH host through the VS Code remote URL. */
const REMOTE_EDITOR_SCHEMES: Partial<Record<EditorConfig["id"], string>> = {
  vscode: "vscode",
  "vscode-insiders": "vscode-insiders",
  cursor: "cursor",
  windsurf: "windsurf",
};

/** Spelled plainly after `ssh-remote+`: nothing the URI or the resolver's own `+` split reads. */
const PLAIN_AUTHORITY_TARGET = /^[A-Za-z0-9@._-]+$/;

/**
 * The `ssh-remote+` authority for a target. Anything the transport accepts
 * beyond the plain set (`+`, `%`, brackets) goes as Remote-SSH's hex-encoded
 * JSON form, which survives URI parsing untouched.
 */
function remoteSshAuthority(sshTarget: string): string {
  if (PLAIN_AUTHORITY_TARGET.test(sshTarget)) return `ssh-remote+${sshTarget}`;
  const encoded = Buffer.from(JSON.stringify({ hostName: sshTarget }), "utf8").toString("hex");
  return `ssh-remote+${encoded}`;
}

export function buildRemoteEditorUrl(options: {
  editorId: EditorConfig["id"] | null;
  sshTarget: string;
  path: string;
  line?: number;
  col?: number;
}): string | null {
  const scheme = REMOTE_EDITOR_SCHEMES[options.editorId ?? "vscode"];
  if (!scheme) return null;
  // The same grammar the connection itself accepts, so every host that connects can open files.
  if (!isValidSshTarget(options.sshTarget)) return null;
  if (!options.path.startsWith("/") || /[\0\r\n]/.test(options.path)) return null;
  const isPosition = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n > 0);
  if (!isPosition(options.line) || !isPosition(options.col)) return null;
  // Per segment, so `?` and `#` in a file name stay part of the path.
  const encodedPath = options.path.split("/").map(encodeURIComponent).join("/");
  const position =
    options.line !== undefined
      ? `:${options.line}${options.col !== undefined ? `:${options.col}` : ""}`
      : "";
  return `${scheme}://vscode-remote/${remoteSshAuthority(options.sshTarget)}${encodedPath}${position}`;
}

/**
 * No editor here can open the host's file, so its path goes to this
 * machine's clipboard instead, and the window says so, naming the host.
 */
function copyHostPathInstead(hostId: HostId, hostPath: string): SystemOpenInEditorFallback {
  clipboard.writeText(hostPath);
  return { outcome: "copied-host-path", path: hostPath, hostName: hostLabel(hostId) };
}

/**
 * The file is on the host, so the editor on this machine opens it through its
 * SSH remote. Never opens a local path for a host file: where no editor can,
 * the host path is copied instead.
 */
const openInEditor: HybridSplit = async ({ hostId, args, remote }) => {
  const payload = (args[0] ?? {}) as {
    path?: unknown;
    line?: number;
    col?: number;
    projectId?: unknown;
  };
  if (typeof payload.path !== "string" || !payload.path.startsWith("/")) {
    throw new AppError({ code: "VALIDATION", message: "An absolute host path is required" });
  }
  const hostPath = payload.path;
  const descriptor = hostDescriptor(hostId);
  if (!descriptor) return copyHostPathInstead(hostId, hostPath);

  let editorId: EditorConfig["id"] | null = null;
  if (typeof payload.projectId === "string" && payload.projectId) {
    try {
      const config = (await remote(CHANNELS.EDITOR_GET_CONFIG, [
        payload.projectId,
      ])) as EditorGetConfigResult;
      editorId = config.preferredEditor?.id ?? null;
    } catch {
      // No preference readable: the default editor still gets a chance.
    }
  }

  // The editor's remote is SSH; a host reached another way gets its path copied.
  const sshTarget = sshTargetOf(descriptor.connection);
  if (!sshTarget) return copyHostPathInstead(hostId, hostPath);
  const url = buildRemoteEditorUrl({
    editorId,
    sshTarget,
    path: hostPath,
    line: payload.line,
    col: payload.col,
  });
  if (!url) return copyHostPathInstead(hostId, hostPath);
  try {
    await shell.openExternal(url, { activate: true });
  } catch {
    // No application here handles the editor's remote URL.
    return copyHostPathInstead(hostId, hostPath);
  }
  return undefined;
};

/**
 * A remote window's reveal is "Copy host path": a file manager opened here
 * would show this machine, and one on the host's screen helps nobody.
 */
const copyHostPath: HybridSplit = async ({ args }) => {
  const targetPath = (args[0] as { path?: unknown } | undefined)?.path;
  if (typeof targetPath !== "string" || !targetPath.startsWith("/")) {
    throw new AppError({ code: "VALIDATION", message: "An absolute host path is required" });
  }
  clipboard.writeText(targetPath);
};

const openOnHost = refuse(
  (host) => `This file is on ${host}, not this computer. Use Copy host path instead.`
);

/**
 * Every hybrid invoke channel with its split for a remote-bound window. Hybrid
 * channels missing here stay refused with CHANNEL_NOT_REMOTABLE until their
 * remote half exists.
 */
export const HYBRID_SPLITS: Readonly<Record<string, HybridSplit>> = {
  [CHANNELS.APP_HYDRATE]: appHydrate,
  [CHANNELS.APP_BOOT]: appBoot,
  [CHANNELS.APP_GET_STATE]: appGetState,
  [CHANNELS.APP_SET_STATE]: appSetState,
  [CHANNELS.APP_RELOAD_CONFIG]: appReloadConfig,
  [CHANNELS.TERMINAL_CONFIG_GET]: terminalConfigGet,
  [CHANNELS.EDITOR_GET_CONFIG]: editorGetConfig,
  [CHANNELS.EDITOR_SET_CONFIG]: remoteOnly,
  [CHANNELS.NOTIFICATION_SETTINGS_GET]: notificationSettingsGet,
  [CHANNELS.NOTIFICATION_SETTINGS_SET]: notificationSettingsSet,
  [CHANNELS.PROJECT_SWITCH]: projectSwitch,
  [CHANNELS.PROJECT_REOPEN]: projectSwitch,
  [CHANNELS.PROJECT_GET_CURRENT]: remoteOnly,
  [CHANNELS.PROJECT_CLOSE]: remoteOnly,
  [CHANNELS.PROJECT_PREFETCH_HYDRATE]: prefetchHydrate,
  // Each machine holds its own power assertion for its own work.
  [CHANNELS.KEEP_AWAKE_GET_STATE]: localOnly,
  [CHANNELS.KEEP_AWAKE_UPDATE_CONFIG]: localOnly,
  // Action breadcrumbs describe this machine's UI.
  [CHANNELS.EVENTS_EMIT]: localOnly,
  // The preview's browser and its proxy live on this machine.
  [CHANNELS.DEV_PREVIEW_GET_PROXY_PORT]: localOnly,
  [CHANNELS.DEV_PREVIEW_MINT_BROWSER_TOKEN]: localOnly,
  // The records arrive from the renderer; the save dialog and file are this machine's.
  [CHANNELS.MCP_SERVER_EXPORT_AUDIT_LOG]: localOnly,
  [CHANNELS.FORGE_AUDIT_EXPORT_LOG]: localOnly,
  [CHANNELS.ARTIFACT_SAVE_TO_FILE]: artifactSaveToFile,
  [CHANNELS.SYSTEM_OPEN_IN_EDITOR]: openInEditor,
  [CHANNELS.SYSTEM_OPEN_PATH]: openOnHost,
  [CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER]: copyHostPath,
  [CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED]: copyHostPath,
  [CHANNELS.CLIPBOARD_SAVE_IMAGE]: refuse(
    (host) => `Pasting images into a terminal on ${host} isn't available yet.`
  ),
  [CHANNELS.CLIPBOARD_PICK_ATTACHMENTS]: refuse(
    (host) => `Attaching files from this computer to ${host} isn't available yet.`
  ),
  [CHANNELS.PROJECT_OPEN_GIT_INIT_DIALOG]: refuse(
    (host) => `Opening a folder on ${host} from this window isn't available yet.`
  ),
  [CHANNELS.SCRATCH_SWITCH]: scratchSwitch,
  [CHANNELS.PLUGIN_INSTALL_FROM_FILE]: refuse(
    (host) => `Installing a plugin file from this computer on ${host} isn't available yet.`
  ),
  [CHANNELS.PLUGIN_INSTALL_FROM_PATH]: refuse(
    (host) => `Installing a plugin folder from this computer on ${host} isn't available yet.`
  ),
  [CHANNELS.CONFIG_BUNDLE_EXPORT]: refuse(
    (host) => `Export configuration from a window on this computer, not one attached to ${host}.`
  ),
  [CHANNELS.CONFIG_BUNDLE_PREVIEW_IMPORT]: refuse(
    (host) => `Import configuration from a window on this computer, not one attached to ${host}.`
  ),
  [CHANNELS.CONFIG_BUNDLE_APPLY_IMPORT]: refuse(
    (host) => `Import configuration from a window on this computer, not one attached to ${host}.`
  ),
};

/**
 * Hybrid channels a remote Shell's splits invoke on this host (the `remote`
 * legs above, plus sends whose deciding half runs here). The host admits each
 * for link calls; everything else hybrid stays refused over a link, since
 * answering it wholesale would leak this machine's Shell half.
 */
export const HYBRID_HOST_LEGS: readonly string[] = [
  CHANNELS.APP_HYDRATE,
  CHANNELS.APP_GET_STATE,
  CHANNELS.APP_SET_STATE,
  CHANNELS.APP_RELOAD_CONFIG,
  CHANNELS.TERMINAL_CONFIG_GET,
  CHANNELS.EDITOR_GET_CONFIG,
  CHANNELS.EDITOR_SET_CONFIG,
  CHANNELS.PROJECT_SWITCH,
  CHANNELS.PROJECT_REOPEN,
  CHANNELS.PROJECT_GET_CURRENT,
  CHANNELS.PROJECT_CLOSE,
  CHANNELS.SCRATCH_SWITCH,
  // The picker split's host leg (see pickers.ts), with the folder chosen in the host picker.
  CHANNELS.SCRATCH_SAVE_AS_PROJECT,
  CHANNELS.NOTIFICATION_SETTINGS_GET,
  CHANNELS.NOTIFICATION_SETTINGS_SET,
  CHANNELS.NOTIFICATION_SYNC_WATCHED,
  CHANNELS.NOTIFICATION_SESSION_MUTE_SET,
];
