import type {
  WorktreePortAction,
  WorktreePortPayload,
  WorktreePortResult,
} from "../../shared/types/worktree-port.js";
import { CHANNELS } from "../ipc/channels.js";
import {
  BrokerError,
  RequestResponseBroker,
  encodeBrokerError,
} from "../services/rpc/RequestResponseBroker.js";
import { resolveWorktreePortTimeout } from "../utils/worktreePortTimeouts.js";
import type { PreloadIpcRenderer } from "./types.js";

// ── Worktree Port Client (Phase 1) ──────────────────────────────────────────
// New dedicated port for worktree data with request/response correlation.

type WorktreePortEventCallback = (data: unknown) => void;

export class WorktreePortClient {
  private port: MessagePort | null = null;
  private broker = new RequestResponseBroker({
    idPrefix: "worktree",
    defaultTimeoutMs: 10000,
  });
  private eventListeners = new Map<string, Set<WorktreePortEventCallback>>();
  private readyCallbacks: Array<() => void> = [];
  private disconnectedCallbacks: Array<() => void> = [];
  private fatalCallbacks: Array<() => void> = [];
  private _isReady = false;
  // Monotonic counter so stale close signals (e.g. a delayed IPC
  // WORKTREE_HOST_DISCONNECTED that arrives AFTER a replacement port has
  // already been attached) are ignored and do not clobber the new port.
  private portGeneration = 0;

  attach(newPort: MessagePort): void {
    // Bump generation FIRST so any synchronous close event fired by the old
    // port during detach() will be recognised as stale by _handlePortClose
    // and ignored — the disconnect callbacks must only fire on unexpected
    // host crashes, never on normal port replacement.
    const attachedGeneration = ++this.portGeneration;

    if (this.port) {
      this.detach();
    }

    this.port = newPort;
    this._isReady = true;

    // Fires when the peer (workspace host UtilityProcess) dies — Electron's
    // MessagePort delivers a `close` event even on SIGKILL via the Mojo
    // channel.  The generation guard ensures stale close events from old
    // ports cannot reject requests on a newer port.
    newPort.addEventListener("close", () => this._handlePortClose(attachedGeneration));

    this.port.onmessage = (msg: MessageEvent) => {
      const data = msg.data;
      if (!data) return;

      // Response to a request
      if (data.id && this.broker.has(data.id)) {
        if (data.error != null) {
          this.broker.reject(data.id, new Error(String(data.error)));
        } else {
          this.broker.resolve(data.id, data.result);
        }
        return;
      }

      // Spontaneous event from host
      if (data.type === "event" && data.event?.type) {
        const listeners = this.eventListeners.get(data.event.type);
        if (listeners) {
          for (const cb of listeners) {
            try {
              cb(data.event);
            } catch {
              // Don't let listener errors crash the port
            }
          }
        }
      }
    };

    // Fire ready callbacks (kept for re-attach — not cleared)
    for (const cb of this.readyCallbacks) {
      try {
        cb();
      } catch {
        // ignore
      }
    }

    console.log("[Preload] Worktree port connected");
  }

  private detach(): void {
    if (!this.port) return;

    try {
      this.port.close();
    } catch {
      // ignore
    }

    // Clear pending BEFORE nulling state — preserves the invariant that no
    // request can be registered after clearance but before the null check.
    // Port replacement is a transient/recoverable condition (host restart,
    // project switch within window), not app shutdown — surface HOST_EXITED
    // so callers can retry rather than treating it as terminal.
    this.broker.clear(encodeBrokerError(new BrokerError("HOST_EXITED", "Worktree port replaced")));

    this.port = null;
    this._isReady = false;
  }

  /**
   * Handle unexpected port closure (workspace host crashed or was killed).
   * Idempotent — safe to call multiple times.  Rejects pending requests
   * immediately so the UI does not wait for per-request timeouts.
   *
   * @param generation The port generation the caller was registered against.
   *   If it no longer matches the current generation, this is a stale signal
   *   from a previous port lifetime and is ignored.
   */
  _handlePortClose(generation: number): void {
    if (generation !== this.portGeneration) return;
    if (!this.port) return;

    try {
      this.port.close();
    } catch {
      // ignore
    }

    this.broker.clear(
      encodeBrokerError(new BrokerError("HOST_EXITED", "Worktree port disconnected"))
    );

    this.port = null;
    this._isReady = false;

    for (const cb of this.disconnectedCallbacks) {
      try {
        cb();
      } catch {
        // Don't let listener errors block other listeners
      }
    }
  }

  request<K extends WorktreePortAction>(
    action: K,
    payload?: WorktreePortPayload<K>,
    timeoutMs?: number
  ): Promise<WorktreePortResult<K>> {
    if (!this.port) {
      // Main can't see this rejection — it never reaches the broker — so without
      // this line a failed request leaves no trace beside the brokering log.
      // For app and project views, console capture tags it with the view's
      // webContentsId, the same key WorktreePortBroker logs under (#12759).
      console.warn(`[Preload] Worktree port request "${String(action)}" rejected: port not ready`);
      return Promise.reject(
        encodeBrokerError(new BrokerError("HOST_EXITED", "Worktree port not ready"))
      );
    }

    const id = this.broker.generateId();
    // Resolve the per-action timeout (#8551): create/delete-worktree,
    // resource-action, and run-lifecycle-setup legitimately run longer than
    // the 10s default. The broker's own getEffectiveTimeout only validates a
    // single defaultTimeoutMs, so the per-action table must be applied here.
    const effectiveTimeout = resolveWorktreePortTimeout(action, timeoutMs);
    const promise = this.broker.register<WorktreePortResult<K>>(id, {
      method: String(action),
      timeoutMs: effectiveTimeout,
    });

    try {
      this.port.postMessage({ id, action, payload: payload ?? {} });
    } catch (error) {
      this.broker.reject(id, error instanceof Error ? error : new Error(String(error)));
    }

    // Encode BrokerError rejections (TIMEOUT, HOST_EXITED, APP_SHUTDOWN) so
    // the renderer can decode the discriminant via `isClientBrokerError`.
    // contextBridge strips own Error properties, so the prefix is the only
    // reliable carrier across the realm boundary.
    return promise.catch((err: unknown) => {
      if (err instanceof BrokerError) {
        throw encodeBrokerError(err);
      }
      throw err;
    });
  }

  onEvent(type: string, callback: WorktreePortEventCallback): () => void {
    let listeners = this.eventListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(type, listeners);
    }
    listeners.add(callback);

    return () => {
      listeners!.delete(callback);
      if (listeners!.size === 0) {
        this.eventListeners.delete(type);
      }
    };
  }

  isReady(): boolean {
    return this._isReady;
  }

  onReady(callback: () => void): () => void {
    if (this._isReady) {
      callback();
    }
    // Always register for future re-attaches (port replacement on host restart)
    this.readyCallbacks.push(callback);
    return () => {
      const idx = this.readyCallbacks.indexOf(callback);
      if (idx >= 0) this.readyCallbacks.splice(idx, 1);
    };
  }

  onDisconnected(callback: () => void): () => void {
    this.disconnectedCallbacks.push(callback);
    return () => {
      const idx = this.disconnectedCallbacks.indexOf(callback);
      if (idx >= 0) this.disconnectedCallbacks.splice(idx, 1);
    };
  }

  onFatalDisconnect(callback: () => void): () => void {
    this.fatalCallbacks.push(callback);
    return () => {
      const idx = this.fatalCallbacks.indexOf(callback);
      if (idx >= 0) this.fatalCallbacks.splice(idx, 1);
    };
  }

  /**
   * Fire fatal callbacks when the workspace host exhausts its restart budget.
   * Callers should surface a terminal error state (e.g. "Workspace host
   * crashed — please restart") since no further port will arrive.
   */
  _handleFatal(): void {
    for (const cb of this.fatalCallbacks) {
      try {
        cb();
      } catch {
        // Don't let listener errors block other listeners
      }
    }
  }
}

export function connectWorktreePortClient(ipcRenderer: PreloadIpcRenderer): WorktreePortClient {
  const worktreePortClient = new WorktreePortClient();

  ipcRenderer.on("worktree-port", (event: Electron.IpcRendererEvent, payload: unknown) => {
    if (!event.ports || event.ports.length === 0) return;
    worktreePortClient.attach(event.ports[0]);
    // Main can't observe delivery — a port posted before this listener existed
    // is dropped silently — so it only reuses a channel this receipt confirms
    // (#12576). Sent after attach so the ready callbacks have already run.
    const token = (payload as { token?: unknown } | null | undefined)?.token;
    if (typeof token === "number") {
      ipcRenderer.send(CHANNELS.WORKTREE_PORT_ACK, { token });
    }
  });

  // Main broadcasts this on every host exit.  Only the fatal payload is acted
  // on in the renderer — it marks max-restart-budget exhaustion and means no
  // replacement port will arrive, so the UI must transition to a terminal
  // error state instead of staying in the reconnecting spinner forever.
  // Non-fatal broadcasts are ignored here; the MessagePort `close` event is
  // the authoritative disconnect signal for the transient case.
  ipcRenderer.on(
    "worktree:host-disconnected",
    (_event: Electron.IpcRendererEvent, payload: { fatal?: boolean } | undefined) => {
      if (payload?.fatal) {
        worktreePortClient._handleFatal();
      }
    }
  );

  return worktreePortClient;
}
