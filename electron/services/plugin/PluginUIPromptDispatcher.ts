import { ipcMain, webContents } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../ipc/channels.js";
import { getWindowRegistry, getProjectViewManager } from "../../window/windowRef.js";
import type {
  PluginUiPromptParams,
  PluginUiPromptResultValue,
} from "../../../shared/types/pluginUiPrompt.js";

/**
 * The cancel/dismiss outcome for a prompt kind: `false` for a confirm (the user
 * did not confirm), `undefined` for quick-pick / input-box (no selection). Used
 * whenever a prompt resolves without an explicit user answer — renderer gone,
 * plugin unloaded, or service disposed.
 */
function cancelValueFor(kind: PluginUiPromptParams["kind"]): PluginUiPromptResultValue {
  return kind === "confirm" ? false : undefined;
}

/**
 * One in-flight prompt per plugin (#10621). A plugin host prompt is a modal
 * round-trip with no deadline; without a cap a buggy or adversarial plugin can
 * fire prompts faster than the user dismisses them, stacking unbounded dialogs
 * and leaking a `pending` entry each time. A second request while one is open
 * resolves immediately to the kind's cancel value instead of being sent.
 */
const MAX_PENDING_PROMPTS_PER_PLUGIN = 1;

/**
 * An imperative UI prompt awaiting its renderer response. Unlike the dispatch
 * bridge there is NO per-request timeout: a user-facing prompt has no deadline
 * racing the dialog (mirrors `pluginConfirmStore`'s no-timeout stance). It
 * settles on the renderer response, a renderer `destroyed`, a per-plugin cancel
 * (unload), or {@link PluginUIPromptDispatcher.dispose}.
 */
interface PendingPrompt {
  resolve: (value: PluginUiPromptResultValue) => void;
  webContentsId: number;
  pluginId: string;
  /** Value to resolve with when the prompt is cancelled rather than answered. */
  cancelValue: PluginUiPromptResultValue;
  destroyedCleanup?: () => void;
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
   * Resolve the active project's renderer WebContents, mirroring
   * {@link PluginRendererDispatcher.resolveActiveWebContents}: the focused
   * window first (prompts carry no source window), then every live window, then
   * the global `ProjectViewManager`. Returns `null` when no renderer is
   * available so {@link requestPrompt} resolves the cancel value.
   */
  private resolveActiveWebContents(): Electron.WebContents | null {
    const registry = getWindowRegistry();
    if (registry) {
      const primary = registry.getPrimary();
      if (primary && !primary.browserWindow.isDestroyed()) {
        const primaryWc = primary.services.projectViewManager?.getActiveView()?.webContents;
        if (primaryWc && !primaryWc.isDestroyed()) {
          return primaryWc;
        }
      }
      for (const ctx of registry.all()) {
        if (ctx.browserWindow.isDestroyed()) continue;
        const webContents = ctx.services.projectViewManager?.getActiveView()?.webContents;
        if (webContents && !webContents.isDestroyed()) {
          return webContents;
        }
      }
    }
    const fallback = getProjectViewManager()?.getActiveView()?.webContents;
    if (fallback && !fallback.isDestroyed()) {
      return fallback;
    }
    return null;
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
      pending.destroyedCleanup?.();
      this.pending.delete(payload.promptId);
      pending.resolve(payload.result);
    };
    ipcMain.on(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, handler);
    this.responseListenerCleanup = () => {
      ipcMain.removeListener(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, handler);
    };
  }

  /**
   * Send a prompt request to the active renderer and await the user's answer.
   * Always resolves with a {@link PluginUiPromptResultValue} — no renderer,
   * renderer destroyed, plugin unload, and disposal all resolve the kind's
   * cancel value rather than rejecting.
   */
  requestPrompt(
    pluginId: string,
    params: PluginUiPromptParams
  ): Promise<PluginUiPromptResultValue> {
    const cancelValue = cancelValueFor(params.kind);
    return new Promise((resolve) => {
      if (this.deps.isDisposed()) {
        resolve(cancelValue);
        return;
      }
      const webContents = this.resolveActiveWebContents();
      if (!webContents) {
        resolve(cancelValue);
        return;
      }

      // Enforce the per-plugin cap before sending so a runaway plugin can't stack
      // dialogs or leak `pending` entries. Checked here (not renderer-side) so the
      // guard holds regardless of renderer queue behavior.
      let activeForPlugin = 0;
      for (const pending of this.pending.values()) {
        if (pending.pluginId === pluginId) activeForPlugin += 1;
      }
      if (activeForPlugin >= MAX_PENDING_PROMPTS_PER_PLUGIN) {
        resolve(cancelValue);
        return;
      }

      this.ensureResponseListener();

      const promptId = randomUUID();
      const webContentsId = webContents.id;

      const onDestroyed = () => {
        const pending = this.pending.get(promptId);
        if (!pending) return;
        this.pending.delete(promptId);
        resolve(cancelValue);
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort; webContents may already be gone
        }
      };

      this.pending.set(promptId, {
        resolve,
        webContentsId,
        pluginId,
        cancelValue,
        destroyedCleanup,
      });

      try {
        webContents.send(CHANNELS.PLUGIN_UI_PROMPT_REQUEST, { promptId, pluginId, params });
      } catch {
        destroyedCleanup();
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
      pending.destroyedCleanup?.();
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

  private sendCancel(webContentsId: number, pluginId: string): void {
    // Target the window the prompt was originally sent to by id — NOT the
    // currently-focused window. In a multi-window session the user may have
    // switched projects between prompt-open and unload; resolving "active" here
    // would deliver the dismiss to the wrong window and strand the dialog.
    const target = webContents.fromId(webContentsId);
    if (target && !target.isDestroyed()) {
      try {
        target.send(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, { pluginId });
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
        pending.destroyedCleanup?.();
        pending.resolve(pending.cancelValue);
      } catch {
        // best-effort — one prompt's resolve must not strand the rest
      }
    }
    this.pending.clear();
  }
}
