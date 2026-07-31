import { ipcMain, webContents as electronWebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { getProjectViewManager } from "../../window/windowRef.js";
import type { ActionContext, ActionManifestEntry } from "../../../shared/types/actions.js";
import type { McpBearerIdentity } from "../../../shared/types/ipc/mcpServer.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { PendingRequest, DispatchEnvelope, DispatchedProjectRef } from "./shared.js";
import { MCP_MANIFEST_REQUEST_TIMEOUT_MS, MCP_DISPATCH_TIMEOUT_MS } from "./shared.js";

export class SessionBindingError extends Error {
  readonly code = "SESSION_BINDING_GONE";
  readonly webContentsId: number;

  constructor(webContentsId: number) {
    super(
      `MCP pinned view ${webContentsId} no longer available — the renderer session this MCP session was bound to has been destroyed. Do not retry.`
    );
    this.name = "SessionBindingError";
    this.webContentsId = webContentsId;
  }
}

// Thrown when an unpinned dispatch can't reach any live renderer to route a
// tool call through. For confirm-gated tools this is the "no confirmation
// channel reachable" case: a headless conductor with no Daintree window open
// has nowhere to surface the native ConfirmDialog. The caller reclassifies it
// to CONFIRMATION_REQUIRED for confirm-gated tools (#10640) so the assistant
// learns it needs human approval it can't currently obtain, rather than seeing
// an opaque, retriable EXECUTION_ERROR.
export class RendererBridgeUnavailableError extends Error {
  constructor() {
    super("MCP renderer bridge unavailable");
    this.name = "RendererBridgeUnavailableError";
  }
}

export function createRendererBridge(
  pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>,
  pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>,
  getRegistry: () => WindowRegistry | null
) {
  let cachedManifest: ActionManifestEntry[] | null = null;

  // Per-WebContents manifest cache for pinned help sessions (#9887). The shared
  // `cachedManifest` is bypassed for pinned routing (#7002) so window A's
  // manifest can never be served to a session pinned to window B — but with no
  // replacement, every CallTool dispatch re-fetched the full ~287-entry
  // manifest over IPC (lookupManifestEntry in sessionServer.ts). These per-id
  // maps restore a cache while keeping the cross-window isolation: each entry
  // is keyed strictly by `webContentsId`, so a pinned session only ever reads
  // its own window's manifest. The manifest is the full, tier-independent
  // action list (tier filtering happens server-side), so it stays valid for the
  // view's lifetime — invalidation is by WebContents teardown and server
  // stop/restart only, not by tier elevation/decay.
  const perWebContentsCache = new Map<number, ActionManifestEntry[]>();
  // In-flight fetches, for singleflight coalescing of concurrent callers. This
  // is read-only for freshness: callers never short-circuit on the resolved
  // `perWebContentsCache`, only on a live in-flight promise, so a pinned
  // `tools/list` always reflects runtime action-set changes (plugin
  // enable/disable) exactly as the unpinned shared path does. Each entry pairs
  // the coalesced promise with a stable identity `token`; the resurrection
  // guard compares tokens (not the promise itself) so it never reads a
  // not-yet-assigned `const` and stays correct even if a fetch were to resolve
  // synchronously.
  const perWebContentsInflight = new Map<
    number,
    { token: object; promise: Promise<ActionManifestEntry[]> }
  >();
  // WebContents ids that already have a teardown-eviction listener wired, so we
  // never double-register one across repeated fetches or a server restart.
  const perWebContentsEvictionWired = new Set<number>();

  function getActiveProjectWebContents(): Electron.WebContents {
    const registry = getRegistry();
    if (registry) {
      // Most-recently-focused first, not registration order (#11536). With
      // `all()` an unpinned external/api-key client drove whichever window
      // happened to register first, regardless of what the user was looking
      // at. `focusOrder()` keeps never-focused windows (appended in
      // registration order) and falls back to registration order before the
      // first focus event, so single-window and cold-start behaviour is
      // unchanged — only the multi-window pick moves to the focused window.
      for (const ctx of registry.focusOrder()) {
        if (ctx.browserWindow.isDestroyed()) continue;
        const view = ctx.services.projectViewManager?.getActiveView();
        const webContents = view?.webContents;
        if (webContents && !webContents.isDestroyed()) {
          return webContents;
        }
      }
    }

    const fallback = getProjectViewManager()?.getActiveView()?.webContents;
    if (fallback && !fallback.isDestroyed()) {
      return fallback;
    }

    throw new RendererBridgeUnavailableError();
  }

  /**
   * Resolves a renderer WebContents by id, throwing if the view is missing or
   * destroyed. Used by per-session pinned dispatch (#7002) so an MCP tool
   * call from window A's assistant fails closed rather than silently routing
   * to window B when window A's view has been torn down.
   */
  function getPinnedWebContents(id: number): Electron.WebContents {
    const wc = electronWebContents.fromId(id);
    if (!wc || wc.isDestroyed()) {
      throw new SessionBindingError(id);
    }
    return wc;
  }

  function normalizeError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(fallback);
  }

  /**
   * Resolve which project a dispatch landed on, for the response envelope
   * (#11536). Routed through the owning window's own ProjectViewManager so the
   * answer is sender-scoped — never `getCurrentProjectId()`, which reports the
   * most-recently-switched project rather than this webContents'.
   *
   * The module-singleton manager is only an identity fallback for a dispatch
   * that was already routed through it (the registry-less branch of
   * `getActiveProjectWebContents`); it is deliberately not a routing fallback.
   *
   * Never throws: identity is decoration on an already-completed action, so a
   * torn-down view — or a host whose manager predates this accessor — yields
   * `undefined` and simply omits the field.
   */
  function resolveDispatchedProject(webContentsId: number): DispatchedProjectRef | undefined {
    try {
      const registry = getRegistry();
      const projectViewManager =
        registry?.getByWebContentsId(webContentsId)?.services.projectViewManager ??
        getProjectViewManager();
      return projectViewManager?.getProjectRefForWebContents(webContentsId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  function sendManifestRequest(
    resolveWebContents: () => Electron.WebContents,
    onResolved: (manifest: ActionManifestEntry[]) => void
  ): Promise<ActionManifestEntry[]> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = resolveWebContents();
      } catch (err) {
        reject(normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = pendingManifests.get(requestId);
        pending?.destroyedCleanup?.();
        pendingManifests.delete(requestId);
        reject(new Error("Manifest request timed out"));
      }, MCP_MANIFEST_REQUEST_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = pendingManifests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingManifests.delete(requestId);
        pending.reject(new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
      };

      pendingManifests.set(requestId, {
        resolve: (manifest) => {
          onResolved(manifest);
          resolve(manifest);
        },
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send(CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST, { requestId });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        pendingManifests.delete(requestId);
        reject(normalizeError(err, "Failed to request action manifest"));
      }
    });
  }

  function sendDispatchRequest(
    resolveWebContents: () => Electron.WebContents,
    actionId: string,
    args: unknown,
    confirmed: boolean,
    contextOverride?: ActionContext,
    callerInfo?: McpBearerIdentity
  ): Promise<DispatchEnvelope> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = resolveWebContents();
      } catch (err) {
        reject(normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = pendingDispatches.get(requestId);
        pending?.destroyedCleanup?.();
        pendingDispatches.delete(requestId);
        reject(new Error(`Action dispatch timed out: ${actionId}`));
      }, MCP_DISPATCH_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = pendingDispatches.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingDispatches.delete(requestId);
        pending.reject(new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
      };

      pendingDispatches.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send(CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST, {
          requestId,
          actionId,
          args,
          confirmed,
          // Only pinned help-session dispatch passes a contextOverride; the
          // unpinned external/api-key path leaves this undefined so the
          // renderer keeps its live focused-window context (#8317).
          context: contextOverride,
          // Display-only requesting-bearer identity for the confirm dialog
          // (#9157). Only the unpinned external path supplies it; absent for
          // pinned help-session dispatch so the dialog stays provenance-free.
          callerInfo,
        });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        pendingDispatches.delete(requestId);
        reject(normalizeError(err, `Failed to dispatch action: ${actionId}`));
      }
    });
  }

  function requestManifest(): Promise<ActionManifestEntry[]> {
    return sendManifestRequest(
      () => getActiveProjectWebContents(),
      (manifest) => {
        cachedManifest = manifest;
      }
    );
  }

  function dispatchAction(
    actionId: string,
    args: unknown,
    confirmed = false,
    callerInfo?: McpBearerIdentity
  ): Promise<DispatchEnvelope> {
    return sendDispatchRequest(
      () => getActiveProjectWebContents(),
      actionId,
      args,
      confirmed,
      undefined,
      callerInfo
    );
  }

  /** Evict every cached manifest reference for a torn-down WebContents. */
  function evictWebContentsManifest(id: number): void {
    perWebContentsCache.delete(id);
    perWebContentsInflight.delete(id);
  }

  /**
   * Wire a one-shot teardown listener that drops the pinned view's cached
   * manifest when its WebContents is destroyed (LRU eviction, window close).
   * Registered once per id — `perWebContentsEvictionWired` guards against
   * double-registration across repeated fetches and survives a server restart
   * (the listener is still live, so `clearCache()` leaves the set intact).
   */
  function ensureManifestEviction(id: number): void {
    if (perWebContentsEvictionWired.has(id)) return;
    const wc = electronWebContents.fromId(id);
    if (!wc || wc.isDestroyed()) return;
    perWebContentsEvictionWired.add(id);
    wc.once("destroyed", () => {
      evictWebContentsManifest(id);
      perWebContentsEvictionWired.delete(id);
    });
  }

  /**
   * Manifest fetch pinned to a specific renderer WebContents (per-session
   * routing for #7002). Writes a per-id cache (#9887) — keyed by
   * `webContentsId` so a session pinned to window B never reads window A's
   * manifest, preserving the isolation the shared `cachedManifest` bypass was
   * meant to protect. Concurrent callers coalesce onto one in-flight fetch, but
   * a fully resolved cache never short-circuits a new call: each invocation
   * still fetches fresh (mirroring the unpinned `requestManifest`) so a pinned
   * `tools/list` reflects runtime action-set changes. The cache it populates is
   * read back by `getCachedManifestForWebContents`, which is what the per-call
   * `lookupManifestEntry` hot path consults to avoid re-fetching every dispatch.
   */
  function requestManifestForWebContents(id: number): Promise<ActionManifestEntry[]> {
    const inflight = perWebContentsInflight.get(id);
    if (inflight) return inflight.promise;

    // Stable identity for this fetch, created before the request so the
    // resurrection guard never dereferences a not-yet-assigned binding.
    const token: object = {};
    const fetchPromise = sendManifestRequest(
      () => getPinnedWebContents(id),
      (manifest) => {
        // Resurrection guard (#7554): only publish to the cache if this fetch
        // is still the live in-flight request for the id. A view destroyed (or
        // a `clearCache()`) mid-flight drops the inflight entry, so a late
        // resolve must not repopulate a dead/cleared id.
        if (perWebContentsInflight.get(id)?.token === token) {
          perWebContentsCache.set(id, manifest);
          perWebContentsInflight.delete(id);
        }
      }
    );
    perWebContentsInflight.set(id, { token, promise: fetchPromise });
    // Drop the inflight marker on failure so the next call retries — never cache
    // errors. Identity-guarded so a stale rejection can't evict a newer fetch.
    fetchPromise.catch(() => {
      if (perWebContentsInflight.get(id)?.token === token) {
        perWebContentsInflight.delete(id);
      }
    });
    ensureManifestEviction(id);
    return fetchPromise;
  }

  /**
   * Action dispatch pinned to a specific renderer WebContents (#7002).
   * Throws fail-closed when the pinned view is destroyed so the assistant
   * sees an explicit error rather than silently re-routing to the focused
   * window.
   */
  function dispatchActionForWebContents(
    id: number,
    actionId: string,
    args: unknown,
    confirmed = false,
    contextOverride?: ActionContext
  ): Promise<DispatchEnvelope> {
    return sendDispatchRequest(
      () => getPinnedWebContents(id),
      actionId,
      args,
      confirmed,
      contextOverride
    );
  }

  const manifestHandler = (
    event: Electron.IpcMainEvent,
    payload: { requestId: string; manifest: unknown }
  ) => {
    if (!payload || typeof payload.requestId !== "string") return;
    const pending = pendingManifests.get(payload.requestId);
    if (!pending) return;
    if (event.sender.id !== pending.webContentsId) {
      console.warn(
        `[MCP] Ignoring manifest response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
      );
      return;
    }
    clearTimeout(pending.timer);
    pending.destroyedCleanup?.();
    pendingManifests.delete(payload.requestId);
    const manifest = Array.isArray(payload.manifest)
      ? (payload.manifest as ActionManifestEntry[])
      : [];
    // The cache write happens inside the resolve wrapper attached at request
    // time — non-pinned helpers populate `cachedManifest`, pinned helpers
    // (#7002) deliberately do not, so window A's manifest can never be
    // served to a session pinned to window B.
    pending.resolve(manifest);
  };

  const dispatchHandler = (
    event: Electron.IpcMainEvent,
    payload: {
      requestId: string;
      result: import("../../../shared/types/actions.js").ActionDispatchResult;
      confirmationDecision?: import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision;
    }
  ) => {
    if (!payload || typeof payload.requestId !== "string") return;
    const pending = pendingDispatches.get(payload.requestId);
    if (!pending) return;
    if (event.sender.id !== pending.webContentsId) {
      console.warn(
        `[MCP] Ignoring dispatch response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
      );
      return;
    }
    clearTimeout(pending.timer);
    pending.destroyedCleanup?.();
    pendingDispatches.delete(payload.requestId);
    // Snapshot the project identity here, synchronously, off the sender we just
    // validated (#11536). Resolving it later — after the awaiting caller in
    // sessionServer resumes — would race view eviction and project switching,
    // and could report a project the dispatch never ran against.
    const dispatchedProject = resolveDispatchedProject(pending.webContentsId);
    pending.resolve({
      result: payload.result,
      confirmationDecision: payload.confirmationDecision,
      ...(dispatchedProject ? { dispatchedProject } : {}),
    });
  };

  function setupListeners(cleanupListeners: Array<() => void>): void {
    ipcMain.on(CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE, manifestHandler);
    ipcMain.on(CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE, dispatchHandler);

    cleanupListeners.push(
      () => ipcMain.removeListener(CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE, manifestHandler),
      () => ipcMain.removeListener(CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE, dispatchHandler)
    );
  }

  return {
    setupListeners,
    requestManifest,
    dispatchAction,
    requestManifestForWebContents,
    dispatchActionForWebContents,
    getCachedManifest: () => cachedManifest,
    getCachedManifestForWebContents: (id: number): ActionManifestEntry[] | null =>
      perWebContentsCache.get(id) ?? null,
    clearCache: () => {
      cachedManifest = null;
      // Drop all per-WebContents manifest knowledge in lockstep (#9887) so a
      // server stop/restart can't leave a stale pinned manifest alive. The
      // teardown-eviction listeners stay registered (they self-remove on real
      // WebContents destruction and only ever evict their own id), so
      // `perWebContentsEvictionWired` is deliberately left intact to avoid
      // double-registering on the next fetch.
      perWebContentsCache.clear();
      perWebContentsInflight.clear();
    },
  };
}
