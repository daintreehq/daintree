import { ipcMain, webContents } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../ipc/channels.js";
import { resolveTargetWebContents, type PluginTargetProjectId } from "./rendererTargeting.js";
import {
  promptOpensDialog,
  type PluginUiPromptParams,
  type PluginUiPromptResultValue,
} from "../../../shared/types/pluginUiPrompt.js";

/**
 * The cancel/dismiss outcome for a prompt kind: `false` for a confirm (the user
 * did not confirm), `{ status: "cancelled" }` for a send-to-agent, `undefined`
 * for quick-pick / input-box (no selection). Used whenever a prompt resolves
 * without an explicit user answer — renderer gone, plugin unloaded, or service
 * disposed.
 */
function cancelValueFor(kind: PluginUiPromptParams["kind"]): PluginUiPromptResultValue {
  if (kind === "confirm") return false;
  if (kind === "sendToAgent") return { status: "cancelled" };
  return undefined;
}

/**
 * The answer for a prompt turned away because the plugin already has one open.
 * A send-to-agent says so, since "cancelled" would claim the user dismissed a
 * picker they never saw; the other kinds keep their dismiss value.
 */
function busyValueFor(params: PluginUiPromptParams): PluginUiPromptResultValue {
  if (params.kind === "sendToAgent") {
    return { status: "refused", reason: promptOpensDialog(params) ? "prompt-open" : "busy" };
  }
  return cancelValueFor(params.kind);
}

/**
 * What a request that opens no dialog resolves to when the renderer does not
 * answer in time. A targeted send-to-agent that never came back did not draft
 * as far as anyone can tell, and the project view that should have answered is
 * the thing that is missing.
 */
function timeoutValueFor(params: PluginUiPromptParams): PluginUiPromptResultValue {
  if (params.kind === "sendToAgent") return { status: "refused", reason: "project-unavailable" };
  return cancelValueFor(params.kind);
}

/**
 * One in-flight prompt per plugin (#10621). A plugin host prompt is a modal
 * round-trip with no deadline; without a cap a buggy or adversarial plugin can
 * fire prompts faster than the user dismisses them, stacking unbounded dialogs
 * and leaking a `pending` entry each time. A second request while one is open
 * resolves immediately instead of being sent. Only dialogs count here: a
 * targeted send-to-agent answers without one and has its own cap below.
 */
const MAX_PENDING_PROMPTS_PER_PLUGIN = 1;

/**
 * Targeted send-to-agent requests in flight per plugin. They draft and answer
 * at once, so a handful covers a plugin handing several cards out together;
 * anything beyond that is a loop, and is refused as `busy` rather than queued.
 */
export const MAX_PENDING_TARGETED_SENDS_PER_PLUGIN = 8;

/**
 * How long a request that opens no dialog may wait for the renderer. It has no
 * user in the loop — the renderer answers as soon as it has drafted — so this
 * only elapses for a view that is frozen, hung or gone. The request carries the
 * deadline too, so a renderer that wakes after it drops the draft instead of
 * writing one main has already reported as refused.
 */
export const IMMEDIATE_PROMPT_TIMEOUT_MS = 10_000;

/**
 * An imperative UI prompt awaiting its renderer response. Unlike the dispatch
 * bridge a dialog has NO per-request timeout: a user-facing prompt has no
 * deadline racing it (mirrors `pluginConfirmStore`'s no-timeout stance). A
 * request that opens no dialog is the exception and times out. It
 * settles on the renderer response, a renderer `destroyed`, a caller's aborted
 * signal, a per-plugin cancel (unload), or {@link PluginUIPromptDispatcher.dispose}.
 */
interface PendingPrompt {
  resolve: (value: PluginUiPromptResultValue) => void;
  webContentsId: number;
  pluginId: string;
  /** Value to resolve with when the prompt is cancelled rather than answered. */
  cancelValue: PluginUiPromptResultValue;
  /** Whether it put a dialog on screen, which is what the per-plugin cap counts. */
  opensDialog: boolean;
  /**
   * Detaches every listener this prompt registered — the WebContents
   * `destroyed` hook and the caller's `abort` hook. One combined disposer so a
   * settlement path can never remember to drop one and leak the other; called
   * on every terminal path.
   */
  cleanup?: () => void;
}

interface PluginUIPromptDispatcherDeps {
  /** Getter so the collaborator never holds a stale snapshot of the disposed flag. */
  isDisposed: () => boolean;
}

/**
 * Owns the imperative `host.showQuickPick`/`showInputBox`/`showConfirm`
 * main→renderer round-trip (#10522): resolving the active renderer WebContents,
 * the lazy `ipcMain` response listener, the pending-request map with
 * destroyed-cleanup, the per-plugin cancel drain on unload, and teardown of
 * pending prompts on disposal. Mirrors {@link PluginRendererDispatcher} but
 * resolves a value (never an error envelope) — a dismissed or cancelled prompt
 * is `undefined`/`false`, not a failure.
 */
export class PluginUIPromptDispatcher {
  private readonly deps: PluginUIPromptDispatcherDeps;

  /** In-flight prompts keyed by `promptId`. */
  private pending = new Map<string, PendingPrompt>();
  /** Removes the lazily-registered `ipcMain` response listener. */
  private responseListenerCleanup: (() => void) | null = null;

  constructor(deps: PluginUIPromptDispatcherDeps) {
    this.deps = deps;
  }

  /**
   * Lazily register the single `ipcMain` listener that resolves prompt
   * responses. The handler validates `event.sender.id` against the pending
   * request's `webContentsId` so a renderer in another window cannot resolve a
   * prompt initiated for a different window (mirrors the dispatch bridge, #4641).
   */
  private ensureResponseListener(): void {
    if (this.responseListenerCleanup) return;
    const handler = (
      event: Electron.IpcMainEvent,
      payload: { promptId: string; result: PluginUiPromptResultValue }
    ) => {
      if (!payload || typeof payload.promptId !== "string") return;
      const pending = this.pending.get(payload.promptId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[PluginService] Ignoring UI-prompt response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, promptId=${payload.promptId})`
        );
        return;
      }
      pending.cleanup?.();
      this.pending.delete(payload.promptId);
      pending.resolve(payload.result);
    };
    ipcMain.on(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, handler);
    this.responseListenerCleanup = () => {
      ipcMain.removeListener(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, handler);
    };
  }

  /**
   * Send a prompt request to a renderer and await the user's answer. Resolves
   * with a {@link PluginUiPromptResultValue} — no renderer, renderer destroyed,
   * plugin unload, and disposal all resolve the kind's cancel value rather than
   * rejecting.
   *
   * `projectId` binds the prompt to one project's renderer, including a cached
   * (not currently visible) view so the user finds it on switching back; it is
   * the only path that can reject, with `PROJECT_VIEW_UNAVAILABLE`.
   *
   * `signal` ties the prompt to the lifetime of whatever asked for it. Aborting
   * dismisses the open dialog and resolves the cancel value — it never rejects,
   * because a cancelled prompt is a dismissal and callers document a
   * never-throws contract. This is what lets a dev worker's retired generation
   * take its own questions off the user's screen (#12279).
   */
  requestPrompt(
    pluginId: string,
    params: PluginUiPromptParams,
    projectId?: PluginTargetProjectId,
    signal?: AbortSignal
  ): Promise<PluginUiPromptResultValue> {
    const cancelValue = cancelValueFor(params.kind);
    return new Promise((resolve) => {
      if (this.deps.isDisposed()) {
        resolve(cancelValue);
        return;
      }
      // Already cancelled before anything reached the renderer — never open a
      // dialog the caller has stopped waiting for.
      if (signal?.aborted) {
        resolve(cancelValue);
        return;
      }
      // Unbound: deliberately ambient — an installed plugin's prompt belongs in
      // front of whoever is looking, which is the focused project view.
      const webContents = resolveTargetWebContents(projectId, `Plugin ${params.kind} prompt`);
      if (!webContents) {
        resolve(cancelValue);
        return;
      }

      // Enforce the per-plugin cap before sending so a runaway plugin can't stack
      // dialogs or leak `pending` entries. Checked here (not renderer-side) so the
      // guard holds regardless of renderer queue behavior.
      // Dialogs and immediate requests are counted separately, so neither can
      // starve the other.
      const opensDialog = promptOpensDialog(params);
      let activeOfKind = 0;
      for (const pending of this.pending.values()) {
        if (pending.pluginId === pluginId && pending.opensDialog === opensDialog) {
          activeOfKind += 1;
        }
      }
      const cap = opensDialog
        ? MAX_PENDING_PROMPTS_PER_PLUGIN
        : MAX_PENDING_TARGETED_SENDS_PER_PLUGIN;
      if (activeOfKind >= cap) {
        resolve(busyValueFor(params));
        return;
      }

      this.ensureResponseListener();

      const promptId = randomUUID();
      const webContentsId = webContents.id;

      const onDestroyed = () => {
        const pending = this.pending.get(promptId);
        if (!pending) return;
        pending.cleanup?.();
        this.pending.delete(promptId);
        resolve(cancelValue);
      };
      webContents.once("destroyed", onDestroyed);

      // Settles this one prompt when its caller goes away. Scoped by `promptId`
      // so a late abort can only ever dismiss the request it belongs to — never
      // a successor the same plugin opened after this one settled.
      const onAbort = () => {
        const pending = this.pending.get(promptId);
        if (!pending) return;
        pending.cleanup?.();
        this.pending.delete(promptId);
        this.sendCancel(webContentsId, pluginId, promptId);
        resolve(cancelValue);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      // An immediate request has no user in the loop, so an unanswered one is a
      // stuck renderer — settle it rather than hold the caller and the entry.
      const expiresAt = opensDialog ? undefined : Date.now() + IMMEDIATE_PROMPT_TIMEOUT_MS;
      const timer = opensDialog
        ? undefined
        : setTimeout(() => {
            const pending = this.pending.get(promptId);
            if (!pending) return;
            pending.cleanup?.();
            this.pending.delete(promptId);
            resolve(timeoutValueFor(params));
          }, IMMEDIATE_PROMPT_TIMEOUT_MS);

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort; webContents may already be gone
        }
        signal?.removeEventListener("abort", onAbort);
      };

      this.pending.set(promptId, {
        resolve,
        webContentsId,
        pluginId,
        cancelValue,
        opensDialog,
        cleanup,
      });

      try {
        webContents.send(CHANNELS.PLUGIN_UI_PROMPT_REQUEST, {
          promptId,
          pluginId,
          params,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
      } catch {
        cleanup();
        this.pending.delete(promptId);
        resolve(cancelValue);
      }
    });
  }

  /**
   * Resolve every pending prompt for `pluginId` with its cancel value and tell
   * the renderer to dismiss the open dialog. Invoked from `unloadPlugin` so a
   * plugin that is disabled/unloaded mid-prompt doesn't leave the caller's
   * promise hanging or a stranded dialog on screen.
   */
  cancelForPlugin(pluginId: string): void {
    let notifiedWebContentsId: number | null = null;
    for (const [promptId, pending] of [...this.pending.entries()]) {
      if (pending.pluginId !== pluginId) continue;
      pending.cleanup?.();
      this.pending.delete(promptId);
      // Dismiss the visible dialog. One broadcast per affected window suffices —
      // the renderer drops every queued prompt for this plugin.
      if (notifiedWebContentsId !== pending.webContentsId) {
        notifiedWebContentsId = pending.webContentsId;
        this.sendCancel(pending.webContentsId, pluginId);
      }
      pending.resolve(pending.cancelValue);
    }
  }

  /**
   * Tell a renderer to drop prompts for `pluginId`. With `promptId` only that
   * one request is dismissed; without it every prompt for the plugin goes.
   */
  private sendCancel(webContentsId: number, pluginId: string, promptId?: string): void {
    // Target the window the prompt was originally sent to by id — NOT the
    // currently-focused window. In a multi-window session the user may have
    // switched projects between prompt-open and unload; resolving "active" here
    // would deliver the dismiss to the wrong window and strand the dialog.
    const target = webContents.fromId(webContentsId);
    if (target && !target.isDestroyed()) {
      try {
        target.send(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, {
          pluginId,
          ...(promptId ? { promptId } : {}),
        });
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Tear down the response listener and resolve every pending prompt with its
   * cancel value. Invoked from `PluginService.dispose`. Never rejects (#9322).
   */
  dispose(): void {
    this.responseListenerCleanup?.();
    this.responseListenerCleanup = null;
    for (const pending of this.pending.values()) {
      try {
        pending.cleanup?.();
        pending.resolve(pending.cancelValue);
      } catch {
        // best-effort — one prompt's resolve must not strand the rest
      }
    }
    this.pending.clear();
  }
}
