import { clipboard } from "electron";
import { parseHostScopedKey, type HostId } from "../../../shared/types/remoteHosts.js";
import type { PluginUiPromptParams } from "../../../shared/types/pluginUiPrompt.js";
import { requestConsentInWebContents } from "../../ipc/handlers/pluginCapability.js";
import { PluginUIPromptDispatcher } from "../../services/plugin/PluginUIPromptDispatcher.js";
import {
  PluginClipboardPayloadSchema,
  PluginConsentPayloadSchema,
  PluginFrontendMethod,
  PluginPromptCancelPayloadSchema,
  PluginPromptPayloadSchema,
  PluginToastPayloadSchema,
  REMOTE_CLIPBOARD_IMAGE_MAX_BYTES,
  REMOTE_CLIPBOARD_TEXT_MAX_BYTES,
} from "../../services/plugin/pluginFrontendRequests.js";
import {
  isSafePluginInstanceId,
  projectIdFromPluginInstanceKey,
} from "../../services/plugin/projectPluginIdentity.js";
import { CHANNELS } from "../../ipc/channels.js";
import { decodeClipboardPng } from "../../utils/clipboardImage.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  getProjectForWebContents,
  getWindowForWebContents,
  resolveLiveWebContents,
} from "../../window/webContentsRegistry.js";
import type { ViewReverseRequest } from "../client/RemoteHostManager.js";
import { registerReverseRequestMethod } from "../client/reverseRequests.js";
import { getRemoteService } from "../runtime.js";

export interface PluginShellRequestDeps {
  /** How the person at this screen knows a host. */
  hostName?: (hostId: HostId) => string;
  /**
   * The link each view's endpoint rides. A prompt comes down when that link
   * closes, even if the endpoint later resumes: the host re-asks after a
   * resume, and a dialog nobody can deliver an answer from must not linger.
   */
  onEndpointOpened?: (
    listener: (
      hostId: HostId,
      info: { session: { onClose(cb: () => void): () => void }; webContentsId: number }
    ) => void
  ) => () => void;
  /** Tells us a view's endpoint on a host is gone, so its open prompts come down. */
  onEndpointClosed?: (
    listener: (hostId: HostId, info: { webContentsId: number; endpointId: string }) => void
  ) => () => void;
}

function refuse(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function malformed(method: string): AppError {
  return refuse(`Malformed ${method} request from the host`);
}

function defaultHostName(hostId: HostId): string {
  try {
    const entry = getRemoteService("remoteHostsClient")
      ?.list()
      .find((candidate) => candidate.descriptor.id === hostId);
    if (entry) return entry.descriptor.name;
  } catch {
    // The id is still an honest name.
  }
  return hostId;
}

/**
 * The view a host's plugin request is for, checked against this Shell's own
 * binding of it: the view must show a project on that same host, and a project
 * plugin may only reach a view of its own project. Nothing in the request
 * names the project; the view's binding does.
 */
function scopeView(request: ViewReverseRequest, pluginId: string): Electron.WebContents {
  const wc = resolveLiveWebContents(request.webContentsId);
  if (!wc) {
    throw new AppError({ code: "HOST_DISCONNECTED", message: "The view has gone away" });
  }
  const viewKey = getProjectForWebContents(request.webContentsId);
  if (viewKey === null) throw refuse("The view shows no project");
  const view = parseHostScopedKey(viewKey);
  if (view.hostId !== request.hostId) throw refuse("The view belongs to another host");
  if (!isSafePluginInstanceId(pluginId)) throw refuse("Malformed plugin id");
  const owner = projectIdFromPluginInstanceKey(pluginId);
  if (owner !== null && owner !== view.projectId) {
    throw refuse("The plugin belongs to another project");
  }
  return wc;
}

/**
 * Shell side of a host plugin's person-facing calls, for the view that drives
 * the plugin's project: its prompts, first-use consent and clipboard. Each is
 * validated, scoped to the view's own project, and shown through the same
 * dialogs a local plugin uses. Returns a teardown.
 */
export function installPluginShellRequests(deps: PluginShellRequestDeps = {}): () => void {
  const hostName = deps.hostName ?? defaultHostName;
  let disposed = false;
  const prompts = new PluginUIPromptDispatcher({ isDisposed: () => disposed });
  const openPrompts = new Map<
    string,
    { controller: AbortController; hostId: HostId; webContentsId: number; pluginId: string }
  >();
  const promptKey = (hostId: HostId, promptId: string) => `${hostId}\0${promptId}`;
  const viewSessions = new Map<string, { onClose(cb: () => void): () => void }>();
  const sessionKey = (hostId: HostId, webContentsId: number) => `${hostId}\0${webContentsId}`;

  const showPrompt = async (request: ViewReverseRequest): Promise<unknown> => {
    const parsed = PluginPromptPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("prompt");
    const payload = parsed.data;
    const wc = scopeView(request, payload.pluginId);
    const key = promptKey(request.hostId, payload.promptId);
    if (openPrompts.has(key)) throw refuse("A prompt with that id is already open");
    const controller = new AbortController();
    const offSessionClose = viewSessions
      .get(sessionKey(request.hostId, request.webContentsId))
      ?.onClose(() => controller.abort());
    openPrompts.set(key, {
      controller,
      hostId: request.hostId,
      webContentsId: request.webContentsId,
      pluginId: payload.pluginId,
    });
    const params = {
      ...payload.params,
      ...(payload.askedAt !== undefined
        ? { waited: { hostName: hostName(request.hostId), askedAt: payload.askedAt } }
        : {}),
    } as PluginUiPromptParams;
    try {
      return await prompts.showInWebContents(wc, payload.pluginId, params, controller.signal);
    } finally {
      offSessionClose?.();
      openPrompts.delete(key);
    }
  };

  const cancelPrompts = (request: ViewReverseRequest): null => {
    const parsed = PluginPromptCancelPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("prompt cancel");
    const { pluginId, promptId } = parsed.data;
    for (const entry of [...openPrompts.values()]) {
      if (entry.hostId !== request.hostId || entry.webContentsId !== request.webContentsId)
        continue;
      if (entry.pluginId !== pluginId) continue;
      if (
        promptId !== undefined &&
        openPrompts.get(promptKey(request.hostId, promptId)) !== entry
      ) {
        continue;
      }
      entry.controller.abort();
    }
    return null;
  };

  const askConsent = async (request: ViewReverseRequest): Promise<unknown> => {
    const parsed = PluginConsentPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("consent");
    const wc = scopeView(request, parsed.data.pluginId);
    return requestConsentInWebContents(wc, parsed.data);
  };

  const useClipboard = (request: ViewReverseRequest): unknown => {
    const parsed = PluginClipboardPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("clipboard");
    const payload = parsed.data;
    const wc = scopeView(request, payload.pluginId);
    switch (payload.op) {
      case "writeText":
        if (Buffer.byteLength(payload.text, "utf8") > REMOTE_CLIPBOARD_TEXT_MAX_BYTES) {
          throw new AppError({ code: "PAYLOAD_TOO_LARGE", message: "Clipboard text is too large" });
        }
        clipboard.writeText(payload.text);
        return null;
      case "writeImage": {
        if (payload.png.byteLength > REMOTE_CLIPBOARD_IMAGE_MAX_BYTES) {
          throw new AppError({
            code: "PAYLOAD_TOO_LARGE",
            message: "Clipboard image is too large",
          });
        }
        const image = decodeClipboardPng(payload.png);
        if (image === null) throw refuse("The clipboard image could not be decoded");
        clipboard.writeImage(image);
        return null;
      }
      case "readText": {
        // Reading hands this machine's clipboard to another one, so only while
        // the person is actually in that host's window.
        if (getWindowForWebContents(wc)?.isFocused() !== true) {
          throw new AppError({
            code: "PERMISSION",
            message: "The host's window isn't focused, so its plugins can't read this clipboard",
          });
        }
        return clipboard.readText();
      }
    }
  };

  const showToast = (request: ViewReverseRequest): null => {
    const parsed = PluginToastPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("toast");
    const { pluginId, type, message, durationMs } = parsed.data;
    const wc = scopeView(request, pluginId);
    // Straight to the one view: the push filter keeps this machine's own
    // toasts out of a host's window, and this one is the host's.
    wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type,
      message,
      duration: durationMs,
      rateLimitKey: `plugin:${request.hostId}:${pluginId}:${type}`,
    });
    return null;
  };

  const disposers = [
    registerReverseRequestMethod(PluginFrontendMethod.PROMPT, showPrompt),
    registerReverseRequestMethod(PluginFrontendMethod.PROMPT_CANCEL, cancelPrompts),
    registerReverseRequestMethod(PluginFrontendMethod.CONSENT, askConsent),
    registerReverseRequestMethod(PluginFrontendMethod.CLIPBOARD, useClipboard),
    registerReverseRequestMethod(PluginFrontendMethod.TOAST, showToast),
  ];
  if (deps.onEndpointOpened) {
    disposers.push(
      deps.onEndpointOpened((hostId, { session, webContentsId }) => {
        viewSessions.set(sessionKey(hostId, webContentsId), session);
      })
    );
  }
  if (deps.onEndpointClosed) {
    // The host can no longer hear an answer, so the question comes down.
    disposers.push(
      deps.onEndpointClosed((hostId, { webContentsId }) => {
        viewSessions.delete(sessionKey(hostId, webContentsId));
        for (const entry of [...openPrompts.values()]) {
          if (entry.hostId === hostId && entry.webContentsId === webContentsId) {
            entry.controller.abort();
          }
        }
      })
    );
  }
  return () => {
    disposed = true;
    for (const dispose of disposers.splice(0).reverse()) dispose();
    for (const entry of openPrompts.values()) entry.controller.abort();
    openPrompts.clear();
    prompts.dispose();
  };
}
