import { clipboard } from "electron";
import { parseHostScopedKey, type HostId } from "../../../shared/types/remoteHosts.js";
import type { PluginUiPromptParams } from "../../../shared/types/pluginUiPrompt.js";
import { requestConsentInWebContents } from "../../ipc/handlers/pluginCapability.js";
import { PluginRendererDispatcher } from "../../services/plugin/PluginRendererDispatcher.js";
import { PluginUIPromptDispatcher } from "../../services/plugin/PluginUIPromptDispatcher.js";
import {
  PluginActionsGetPayloadSchema,
  PluginActionsListPayloadSchema,
  PluginClipboardPayloadSchema,
  PluginConsentPayloadSchema,
  PluginDispatchPayloadSchema,
  PluginFrontendMethod,
  PluginPromptCancelPayloadSchema,
  PluginPromptPayloadSchema,
  PluginToastPayloadSchema,
  REMOTE_CLIPBOARD_IMAGE_MAX_BYTES,
  REMOTE_CLIPBOARD_SHELL_BUDGET_MS,
  REMOTE_CLIPBOARD_TEXT_MAX_BYTES,
} from "../../services/plugin/pluginFrontendRequests.js";
import {
  isSafePluginInstanceId,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../../services/plugin/projectPluginIdentity.js";
import { CHANNELS } from "../../ipc/channels.js";
import { decodeClipboardPng } from "../../utils/clipboardImage.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  getProjectForWebContents,
  getWindowForWebContents,
  isCachedViewWebContents,
  resolveLiveWebContents,
} from "../../window/webContentsRegistry.js";
import type { ViewReverseRequest } from "../client/RemoteHostManager.js";
import { registerReverseRequestMethod } from "../client/reverseRequests.js";
import { getRemoteService } from "../runtime.js";
import { isHostPluginDispatchable } from "./pluginDispatchAllowlist.js";
import {
  persistedClipboardGrants,
  type ClipboardAccess,
  type ClipboardGrantStore,
} from "./clipboardGrants.js";
import type { PluginCapabilityConsentOutcome } from "../../../shared/types/pluginCapabilityConsent.js";

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
  /** The person's clipboard answers per host and plugin. Defaults to this machine's settings. */
  clipboardGrants?: ClipboardGrantStore;
  now?: () => number;
  /** Puts a clipboard question to the person in `wc`. Defaults to the capability consent dialog. */
  askClipboardGrant?: (
    wc: Electron.WebContents,
    question: { hostId: HostId; pluginId: string; access: ClipboardAccess }
  ) => Promise<PluginCapabilityConsentOutcome>;
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

function refuseClipboard(message: string): AppError {
  return new AppError({ code: "PERMISSION", message });
}

/**
 * A host's plugin reaches this machine's clipboard only through the view the
 * person is looking at: its window focused and the view the one it shows.
 */
function requireFrontView(wc: Electron.WebContents): void {
  if (getWindowForWebContents(wc)?.isFocused() !== true || isCachedViewWebContents(wc.id)) {
    throw refuseClipboard(
      "The host's window isn't in front, so its plugins can't use this computer's clipboard"
    );
  }
}

function defaultAskClipboardGrant(
  wc: Electron.WebContents,
  question: { hostId: HostId; pluginId: string; access: ClipboardAccess }
): Promise<PluginCapabilityConsentOutcome> {
  return requestConsentInWebContents(wc, {
    pluginId: question.pluginId,
    pluginDisplayName: pluginManifestIdFromInstanceKey(question.pluginId),
    capability: question.access === "read" ? "clipboard:read" : "clipboard:write",
    declaredCapabilities: [],
  });
}

/**
 * Shell side of a host plugin's person-facing calls, for the view that drives
 * the plugin's project: its prompts, first-use consent, clipboard, and the
 * actions it dispatches or looks up. Each is
 * validated, scoped to the view's own project, and shown through the same
 * dialogs a local plugin uses. Returns a teardown.
 */
export function installPluginShellRequests(deps: PluginShellRequestDeps = {}): () => void {
  const hostName = deps.hostName ?? defaultHostName;
  const clipboardGrants = deps.clipboardGrants ?? persistedClipboardGrants;
  const askClipboardGrant = deps.askClipboardGrant ?? defaultAskClipboardGrant;
  const now = deps.now ?? Date.now;
  /** One question per host, plugin and access at a time; callers behind it share its answer. */
  const openGrantQuestions = new Map<string, Promise<boolean>>();
  let disposed = false;
  const prompts = new PluginUIPromptDispatcher({ isDisposed: () => disposed });
  const actions = new PluginRendererDispatcher({ isDisposed: () => disposed });
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

  /**
   * Whether the person lets this host's plugin have `access` to this
   * machine's clipboard. Asked once per host and plugin, in this machine's own
   * dialog, and remembered here; the host has no say in the answer.
   */
  const clipboardGranted = async (
    wc: Electron.WebContents,
    hostId: HostId,
    pluginId: string,
    access: ClipboardAccess
  ): Promise<boolean> => {
    const known = clipboardGrants.get(hostId, pluginId, access);
    if (known !== null) return known === "allow";
    const key = `${hostId}\0${pluginId}\0${access}`;
    let question = openGrantQuestions.get(key);
    if (!question) {
      question = (async () => {
        let outcome: PluginCapabilityConsentOutcome;
        try {
          outcome = await askClipboardGrant(wc, { hostId, pluginId, access });
        } catch {
          outcome = "undeliverable";
        }
        if (outcome === "approved-and-pin") {
          clipboardGrants.set(hostId, pluginId, access, "allow");
          return true;
        }
        if (outcome === "approved-once") return true;
        if (outcome === "rejected") clipboardGrants.set(hostId, pluginId, access, "deny");
        // A dialog that never reached anyone, or timed out, decided nothing.
        return false;
      })().finally(() => openGrantQuestions.delete(key));
      openGrantQuestions.set(key, question);
    }
    return question;
  };

  const useClipboard = async (request: ViewReverseRequest): Promise<unknown> => {
    const parsed = PluginClipboardPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("clipboard");
    const payload = parsed.data;
    const wc = scopeView(request, payload.pluginId);
    requireFrontView(wc);
    const access: ClipboardAccess = payload.op === "readText" ? "read" : "write";
    const arrivedAt = now();
    if (!(await clipboardGranted(wc, request.hostId, payload.pluginId, access))) {
      throw refuseClipboard(
        access === "read"
          ? `A plugin on ${hostName(request.hostId)} isn't allowed to read this computer's clipboard`
          : `A plugin on ${hostName(request.hostId)} isn't allowed to write to this computer's clipboard`
      );
    }
    // The question may have taken a while: the view must still be the one in
    // front, on the same host, when the clipboard is actually touched.
    if (disposed || wc.isDestroyed()) {
      throw new AppError({ code: "HOST_DISCONNECTED", message: "The view has gone away" });
    }
    scopeView(request, payload.pluginId);
    requireFrontView(wc);
    // The host's wait covers the consent dialog's own lifetime, so this only
    // trips on a call whose answer came after the host had given up on it.
    if (now() - arrivedAt > REMOTE_CLIPBOARD_SHELL_BUDGET_MS) {
      // The answer is remembered; this call is not carried out after its caller gave up.
      throw new AppError({
        code: "STALE_GENERATION",
        message: "The clipboard call outlived the host's wait; the plugin can try again",
      });
    }
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
      case "readText":
        return clipboard.readText();
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

  /**
   * A host plugin's `host.dispatch()`, run in the view that drives its
   * project, and only for an action this Shell lets a host's plugins run
   * (`HOST_PLUGIN_DISPATCHABLE_ACTION_IDS`). It always runs there as
   * `source: "plugin"`, so the view's ActionService still applies the plugin
   * source's rules (no restricted actions, no confirm bypass).
   */
  const dispatchAction = async (request: ViewReverseRequest): Promise<unknown> => {
    const parsed = PluginDispatchPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("dispatch");
    const wc = scopeView(request, parsed.data.pluginId);
    if (!isHostPluginDispatchable(parsed.data.actionId)) {
      // An answer, not a transport failure: the plugin reads it as the refusal it is.
      return {
        ok: false,
        error: {
          code: "RESTRICTED",
          message: `Action "${parsed.data.actionId}" can't be run by a plugin on ${hostName(request.hostId)}`,
        },
      };
    }
    return actions.sendDispatchToWebContents(wc, parsed.data.actionId, parsed.data.args);
  };

  /** The catalog a host's plugin sees is the one it may dispatch from. */
  const listActions = async (request: ViewReverseRequest): Promise<unknown> => {
    const parsed = PluginActionsListPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("actions list");
    const { entries } = await actions.sendActionsListToWebContents(
      scopeView(request, parsed.data.pluginId)
    );
    return { entries: entries.filter((entry) => isHostPluginDispatchable(entry.id)) };
  };

  const getAction = async (request: ViewReverseRequest): Promise<unknown> => {
    const parsed = PluginActionsGetPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw malformed("actions get");
    const wc = scopeView(request, parsed.data.pluginId);
    if (!isHostPluginDispatchable(parsed.data.actionId)) return { entry: null };
    return actions.sendActionsGetToWebContents(wc, parsed.data.actionId);
  };

  const disposers = [
    registerReverseRequestMethod(PluginFrontendMethod.DISPATCH, dispatchAction),
    registerReverseRequestMethod(PluginFrontendMethod.ACTIONS_LIST, listActions),
    registerReverseRequestMethod(PluginFrontendMethod.ACTIONS_GET, getAction),
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
    actions.dispose();
  };
}
