import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../ipc/channels.js";
import type { PanelReloadResult } from "../../../shared/types/plugin.js";
import type {
  PluginPanelReloadRejection,
  PluginPanelReloadRequest,
} from "../../../shared/types/pluginPanelReload.js";
import type { PanelReloadTarget } from "./PluginPanelLifecycleBroker.js";

/**
 * How long a `host.reloadPanel()` round-trip may take. The renderer answers as
 * soon as it has queued (or refused) the reload, so this only ever elapses for
 * a renderer that is frozen, hung, or gone — all of which are `"unavailable"`.
 */
export const PLUGIN_PANEL_RELOAD_TIMEOUT_MS = 10_000;

/** The slice of `Electron.WebContents` the round-trip needs. */
export interface PanelReloadWebContents {
  readonly id: number;
  send(channel: string, payload: PluginPanelReloadRequest): void;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export interface PluginPanelReloadDispatcherDeps {
  isDisposed: () => boolean;
  locate: (panelId: string, pluginId: string) => PanelReloadTarget;
  /** A live, non-destroyed WebContents for the id, or `null`. */
  resolveWebContents: (webContentsId: number) => PanelReloadWebContents | null;
  /** Whether the id is a cached (deactivated) project view. */
  isCached: (webContentsId: number) => boolean;
  /** The project a project view belongs to, or `null` when unknown. */
  projectFor: (webContentsId: number) => string | null;
  now?: () => number;
}

interface PendingReload {
  pluginId: string;
  panelId: string;
  webContentsId: number;
  resolve: (result: PanelReloadResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  destroyedCleanup: () => void;
}

const RESULTS = new Set<PanelReloadResult>([
  "scheduled",
  "not-mounted",
  "rate-limited",
  "unavailable",
]);
const REJECTIONS = new Set<PluginPanelReloadRejection>(["foreign", "non-plugin"]);

function rejectionError(pluginId: string, panelId: string, reason: PluginPanelReloadRejection) {
  return new Error(
    reason === "foreign"
      ? `Plugin "${pluginId}" reloadPanel: panel "${panelId}" belongs to another plugin`
      : `Plugin "${pluginId}" reloadPanel: panel "${panelId}" is not a plugin panel`
  );
}

/**
 * Carries `host.reloadPanel()` to the one renderer that holds the panel's view
 * (#12610).
 *
 * Deliberately not `PluginRendererDispatcher`: that transport picks a renderer
 * by focus or project and carries no caller identity, which is right for "run
 * this action where the user is" and wrong for "reload this exact view". Here
 * the destination comes from the lifecycle broker's record of which renderer
 * reported the panel, and ownership is settled before anything is sent.
 */
export class PluginPanelReloadDispatcher {
  private readonly pending = new Map<string, PendingReload>();
  private listenerCleanup: (() => void) | null = null;

  constructor(private readonly deps: PluginPanelReloadDispatcherDeps) {}

  /**
   * Resolve with the renderer's acknowledgment, or reject when the target is
   * another plugin's panel or no plugin's panel. `boundProjectId` is the
   * caller's host binding; a bound host never reaches another project's view.
   */
  reload(
    pluginId: string,
    panelId: string,
    boundProjectId: string | null
  ): Promise<PanelReloadResult> {
    if (this.deps.isDisposed()) return Promise.resolve("unavailable");
    const target = this.deps.locate(panelId, pluginId);
    switch (target.kind) {
      case "foreign":
      case "non-plugin":
        return Promise.reject(rejectionError(pluginId, panelId, target.kind));
      case "missing":
      case "not-mounted":
        return Promise.resolve("not-mounted");
      case "unavailable":
        return Promise.resolve("unavailable");
      case "located":
        break;
    }

    const { sourceId } = target;
    if (boundProjectId !== null) {
      const sourceProject = this.deps.projectFor(sourceId);
      if (sourceProject !== null && sourceProject !== boundProjectId) {
        return Promise.reject(rejectionError(pluginId, panelId, "foreign"));
      }
    }
    // A cached project view is parked: sending would queue the request until the
    // user switches back, long after the worker stopped caring.
    if (this.deps.isCached(sourceId)) return Promise.resolve("unavailable");
    const webContents = this.deps.resolveWebContents(sourceId);
    if (!webContents) return Promise.resolve("unavailable");

    this.ensureListener();

    return new Promise<PanelReloadResult>((resolve, reject) => {
      const requestId = randomUUID();
      const now = this.deps.now?.() ?? Date.now();
      const settleUnavailable = () => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.destroyedCleanup();
        resolve("unavailable");
      };
      const onDestroyed = () => settleUnavailable();
      const timer = setTimeout(settleUnavailable, PLUGIN_PANEL_RELOAD_TIMEOUT_MS);
      webContents.once("destroyed", onDestroyed);
      this.pending.set(requestId, {
        pluginId,
        panelId,
        webContentsId: webContents.id,
        resolve,
        reject,
        timer,
        destroyedCleanup: () => {
          try {
            webContents.removeListener("destroyed", onDestroyed);
          } catch {
            // best-effort; the WebContents may already be gone
          }
        },
      });
      try {
        webContents.send(CHANNELS.PLUGIN_PANEL_RELOAD_REQUEST, {
          requestId,
          panelId,
          pluginId,
          expiresAt: now + PLUGIN_PANEL_RELOAD_TIMEOUT_MS,
        });
      } catch {
        settleUnavailable();
      }
    });
  }

  /** Settle a plugin's in-flight reloads as `"unavailable"` (unload). */
  cancelPlugin(pluginId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.pluginId !== pluginId) continue;
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.destroyedCleanup();
      entry.resolve("unavailable");
    }
  }

  dispose(): void {
    this.listenerCleanup?.();
    this.listenerCleanup = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.destroyedCleanup();
      entry.resolve("unavailable");
    }
    this.pending.clear();
  }

  private ensureListener(): void {
    if (this.listenerCleanup) return;
    const handler = (event: Electron.IpcMainEvent, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const { requestId, result, rejected } = payload as {
        requestId?: unknown;
        result?: unknown;
        rejected?: unknown;
      };
      if (typeof requestId !== "string") return;
      const entry = this.pending.get(requestId);
      if (!entry) return;
      // Only the renderer the request went to may answer it.
      if (event.sender.id !== entry.webContentsId) return;
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.destroyedCleanup();
      if (typeof rejected === "string" && REJECTIONS.has(rejected as PluginPanelReloadRejection)) {
        entry.reject(
          rejectionError(entry.pluginId, entry.panelId, rejected as PluginPanelReloadRejection)
        );
        return;
      }
      entry.resolve(
        typeof result === "string" && RESULTS.has(result as PanelReloadResult)
          ? (result as PanelReloadResult)
          : "unavailable"
      );
    };
    ipcMain.on(CHANNELS.PLUGIN_PANEL_RELOAD_RESPONSE, handler);
    this.listenerCleanup = () => {
      ipcMain.removeListener(CHANNELS.PLUGIN_PANEL_RELOAD_RESPONSE, handler);
    };
  }
}
