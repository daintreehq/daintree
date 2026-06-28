import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../ipc/channels.js";
import { getWindowRegistry, getProjectViewManager } from "../../window/windowRef.js";
import type {
  ActionDispatchResult,
  PluginActionManifestEntry,
} from "../../../shared/types/actions.js";

/**
 * Time budget for a `host.dispatch()` main→renderer round-trip. Matches the MCP
 * dispatch timeout (`MCP_DISPATCH_TIMEOUT_MS`); without it a destroyed or
 * unresponsive renderer would leak entries in `pendingPluginDispatches` forever.
 * On timeout the pending request resolves with an `EXECUTION_ERROR` result.
 */
const PLUGIN_DISPATCH_TIMEOUT_MS = 30_000;

/**
 * A `host.dispatch()` request awaiting its renderer response. Unlike the MCP
 * bridge's `PendingRequest`, the promise always resolves with an
 * {@link ActionDispatchResult} (never rejects) — `host.dispatch` returns the
 * `{ ok: false }` envelope on failure rather than throwing.
 */
interface PendingPluginDispatch {
  resolve: (result: ActionDispatchResult) => void;
  timer: ReturnType<typeof setTimeout>;
  webContentsId: number;
  destroyedCleanup?: () => void;
}

/**
 * A `host.actions.list()` / `host.actions.get()` round-trip awaiting its
 * renderer response. Like {@link PendingPluginDispatch} the promise always
 * resolves (with the projected result or a fallback) and never rejects.
 */
interface PendingActionsRequest {
  resolve: (value: unknown) => void;
  /** Result handed back if the round-trip is torn down by {@link PluginRendererDispatcher.dispose}. */
  fallback: unknown;
  timer: ReturnType<typeof setTimeout>;
  webContentsId: number;
  destroyedCleanup?: () => void;
}

interface PluginRendererDispatcherDeps {
  /** Getter so the collaborator never holds a stale snapshot of the disposed flag. */
  isDisposed: () => boolean;
}

/**
 * Owns the `host.dispatch` main→renderer round-trip: resolving the active
 * renderer WebContents, the lazy `ipcMain` response listener, the
 * pending-request map with per-request timeout + destroyed-cleanup, and the
 * teardown of pending dispatches on disposal.
 */
export class PluginRendererDispatcher {
  private readonly deps: PluginRendererDispatcherDeps;

  /**
   * In-flight `host.dispatch()` round-trips keyed by `requestId`. Each entry is
   * resolved by the {@link CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE} listener,
   * the timeout, the renderer's `destroyed` event, or {@link dispose}.
   */
  private pendingPluginDispatches = new Map<string, PendingPluginDispatch>();
  /**
   * Removes the lazily-registered `ipcMain` response listener for plugin
   * dispatch. `null` until the first `host.dispatch()` registers it; cleared in
   * {@link dispose}.
   */
  private pluginDispatchListenerCleanup: (() => void) | null = null;

  /**
   * In-flight `host.actions.list()` / `host.actions.get()` round-trips, keyed by
   * `requestId`. Shared across both catalog channels — request ids are UUIDs, so
   * a single map is unambiguous. Each entry resolves with the projected result
   * (or its fallback on failure) and never rejects, mirroring
   * {@link pendingPluginDispatches}.
   */
  private pendingActionsRequests = new Map<string, PendingActionsRequest>();
  /**
   * Cleanups for the lazily-registered `ipcMain` response listeners, keyed by
   * response channel so each is registered at most once. Cleared in
   * {@link dispose}.
   */
  private actionsListenerCleanups = new Map<string, () => void>();

  constructor(deps: PluginRendererDispatcherDeps) {
    this.deps = deps;
  }

  /**
   * Resolve the active project's renderer WebContents, mirroring the MCP
   * renderer bridge's resolution order: walk every live window's active
   * project view first, then fall back to the global `ProjectViewManager`.
   * Returns `null` (rather than throwing) when no renderer is available so
   * {@link sendDispatchToRenderer} can return an error result.
   */
  private resolveActiveWebContents(): Electron.WebContents | null {
    const registry = getWindowRegistry();
    if (registry) {
      // Plugin dispatches carry no source window, so target the focused window
      // (getPrimary) before falling back to scanning all windows in insertion
      // order — otherwise every dispatch lands in the oldest window's view.
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
   * Lazily register the single `ipcMain` listener that resolves plugin dispatch
   * responses. Registered on first `host.dispatch()` and torn down in
   * {@link dispose}. The handler validates `event.sender.id` against the
   * pending request's `webContentsId` so a renderer in another window cannot
   * resolve a dispatch initiated for a different window (#4641).
   */
  private ensurePluginDispatchListener(): void {
    if (this.pluginDispatchListenerCleanup) return;
    const handler = (
      event: Electron.IpcMainEvent,
      payload: { requestId: string; result: ActionDispatchResult }
    ) => {
      if (!payload || typeof payload.requestId !== "string") return;
      const pending = this.pendingPluginDispatches.get(payload.requestId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[PluginService] Ignoring dispatch response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
        );
        return;
      }
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      this.pendingPluginDispatches.delete(payload.requestId);
      pending.resolve(payload.result);
    };
    ipcMain.on(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE, handler);
    this.pluginDispatchListenerCleanup = () => {
      ipcMain.removeListener(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE, handler);
    };
  }

  /**
   * Send a plugin-sourced action dispatch to the active renderer and await its
   * response. Always resolves with an {@link ActionDispatchResult} — failures
   * (no renderer, timeout, destroyed view, send error) come back as
   * `EXECUTION_ERROR` rather than a rejected promise.
   */
  sendDispatchToRenderer(actionId: string, args: unknown): Promise<ActionDispatchResult> {
    return new Promise((resolve) => {
      if (this.deps.isDisposed()) {
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: "PluginService is disposed",
          },
        });
        return;
      }
      const webContents = this.resolveActiveWebContents();
      if (!webContents) {
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: "No active renderer available to dispatch plugin action",
          },
        });
        return;
      }

      this.ensurePluginDispatchListener();

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = this.pendingPluginDispatches.get(requestId);
        if (!pending) return;
        pending.destroyedCleanup?.();
        this.pendingPluginDispatches.delete(requestId);
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: `Plugin action dispatch timed out: ${actionId}`,
          },
        });
      }, PLUGIN_DISPATCH_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = this.pendingPluginDispatches.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingPluginDispatches.delete(requestId);
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: "Renderer destroyed before plugin action dispatch resolved",
          },
        });
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort; webContents may already be gone
        }
      };

      this.pendingPluginDispatches.set(requestId, {
        resolve,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST, { requestId, actionId, args });
      } catch {
        clearTimeout(timer);
        destroyedCleanup();
        this.pendingPluginDispatches.delete(requestId);
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: `Failed to dispatch plugin action: ${actionId}`,
          },
        });
      }
    });
  }

  /**
   * Project `ActionService.list()` to the active renderer for the plugin
   * action catalog (#10561). Resolves `[]` (never rejects) when no renderer is
   * available, the round-trip times out, or the view is destroyed.
   */
  sendActionsListToRenderer(): Promise<PluginActionManifestEntry[]> {
    return this.requestFromRenderer<PluginActionManifestEntry[]>({
      requestChannel: CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST,
      responseChannel: CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
      buildRequest: (requestId) => ({ requestId }),
      extract: (payload) => {
        const entries = (payload as { entries?: unknown }).entries;
        return Array.isArray(entries) ? (entries as PluginActionManifestEntry[]) : [];
      },
      fallback: [],
    });
  }

  /**
   * Look up a single projected action entry on the active renderer (#10561).
   * Resolves `null` (never rejects) when the action is absent or the round-trip
   * fails.
   */
  sendActionsGetToRenderer(actionId: string): Promise<PluginActionManifestEntry | null> {
    return this.requestFromRenderer<PluginActionManifestEntry | null>({
      requestChannel: CHANNELS.PLUGIN_ACTIONS_GET_REQUEST,
      responseChannel: CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      buildRequest: (requestId) => ({ requestId, actionId }),
      extract: (payload) =>
        ((payload as { entry?: unknown }).entry ?? null) as PluginActionManifestEntry | null,
      fallback: null,
    });
  }

  /**
   * Lazily register the single `ipcMain` listener for a catalog response
   * channel, registered on first use and torn down in {@link dispose}. Mirrors
   * {@link ensurePluginDispatchListener}'s sender-id guard so a renderer in
   * another window cannot resolve a request initiated for a different window.
   */
  private ensureActionsListener(
    responseChannel: string,
    extract: (payload: Record<string, unknown>) => unknown
  ): void {
    if (this.actionsListenerCleanups.has(responseChannel)) return;
    const handler = (
      event: Electron.IpcMainEvent,
      payload: { requestId?: unknown } & Record<string, unknown>
    ) => {
      if (!payload || typeof payload.requestId !== "string") return;
      const pending = this.pendingActionsRequests.get(payload.requestId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[PluginService] Ignoring actions response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
        );
        return;
      }
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      this.pendingActionsRequests.delete(payload.requestId);
      pending.resolve(extract(payload));
    };
    ipcMain.on(responseChannel, handler);
    this.actionsListenerCleanups.set(responseChannel, () => {
      ipcMain.removeListener(responseChannel, handler);
    });
  }

  /**
   * Generic main→renderer request/response round-trip for the read-only catalog
   * surface. Always resolves with the extracted result or `fallback` — failures
   * (no renderer, timeout, destroyed view, send error) come back as the fallback
   * rather than a rejected promise. Shares the resolution/timeout/cleanup
   * discipline of {@link sendDispatchToRenderer}.
   */
  private requestFromRenderer<T>(opts: {
    requestChannel: string;
    responseChannel: string;
    buildRequest: (requestId: string) => Record<string, unknown>;
    extract: (payload: Record<string, unknown>) => T;
    fallback: T;
  }): Promise<T> {
    return new Promise((resolve) => {
      if (this.deps.isDisposed()) {
        resolve(opts.fallback);
        return;
      }
      const webContents = this.resolveActiveWebContents();
      if (!webContents) {
        resolve(opts.fallback);
        return;
      }

      this.ensureActionsListener(
        opts.responseChannel,
        opts.extract as (payload: Record<string, unknown>) => unknown
      );

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = this.pendingActionsRequests.get(requestId);
        if (!pending) return;
        pending.destroyedCleanup?.();
        this.pendingActionsRequests.delete(requestId);
        resolve(opts.fallback);
      }, PLUGIN_DISPATCH_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = this.pendingActionsRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingActionsRequests.delete(requestId);
        resolve(opts.fallback);
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort; webContents may already be gone
        }
      };

      this.pendingActionsRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        fallback: opts.fallback,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send(opts.requestChannel, opts.buildRequest(requestId));
      } catch {
        clearTimeout(timer);
        destroyedCleanup();
        this.pendingActionsRequests.delete(requestId);
        resolve(opts.fallback);
      }
    });
  }

  /**
   * Tear down the lazily-registered response listeners and reject every pending
   * dispatch with an `EXECUTION_ERROR`. Invoked from `PluginService.dispose`.
   */
  dispose(): void {
    this.pluginDispatchListenerCleanup?.();
    this.pluginDispatchListenerCleanup = null;
    for (const pending of this.pendingPluginDispatches.values()) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.resolve({
        ok: false,
        error: {
          code: "EXECUTION_ERROR",
          message: "PluginService disposed before plugin action dispatch resolved",
        },
      });
    }
    this.pendingPluginDispatches.clear();

    for (const cleanup of this.actionsListenerCleanups.values()) {
      cleanup();
    }
    this.actionsListenerCleanups.clear();
    // Catalog round-trips resolve with their fallback ([] / null) on disposal —
    // the read-only surface has no error envelope, so an in-flight list/get
    // degrades to "empty" rather than throwing into the plugin.
    for (const pending of this.pendingActionsRequests.values()) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.resolve(pending.fallback);
    }
    this.pendingActionsRequests.clear();
  }
}
