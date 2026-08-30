import { ipcMain, webContents as electronWebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { getProjectViewManager } from "../../window/windowRef.js";
import { getWebContentsForProject } from "../../window/webContentsRegistry.js";
import { unfreezeWebContents } from "../../utils/webContentsLifecycle.js";
import type { WorkspaceViewLeaseRegistry } from "./workspaceViewLease.js";
import type { ActionContext, ActionManifestEntry } from "../../../shared/types/actions.js";
import type { McpBearerIdentity, McpSessionOrigin } from "../../../shared/types/ipc/mcpServer.js";
import { CHANNELS } from "../../ipc/channels.js";
import type {
  PendingRequest,
  DispatchEnvelope,
  DispatchedWorkspaceRef,
  McpWorkspaceBinding,
} from "./shared.js";
import { MCP_MANIFEST_REQUEST_TIMEOUT_MS, MCP_DISPATCH_TIMEOUT_MS } from "./shared.js";

/**
 * Base for every "this session's routing target can't be reached" failure, so
 * the one `instanceof` check in `sessionServer` covers both the WebContents-pin
 * and workspace-binding routes (#11789). All of them surface to the client as
 * `SESSION_BINDING_GONE`: the session is bound to a target it cannot reach, and
 * dispatching anywhere else is exactly the retargeting these bindings exist to
 * prevent.
 */
export class McpRouteBindingError extends Error {
  readonly code = "SESSION_BINDING_GONE";
  /**
   * Whether the identical call, with the identical arguments, could succeed
   * later (#12082).
   *
   * Carried on the instance rather than derived from `code`, because both
   * subclasses report the same code and disagree about the answer. A conductor
   * reads this to decide between "wait and try again" and "give up" — and
   * getting it wrong in the recoverable direction is the same bug this issue
   * fixes, one layer down.
   */
  readonly retriable: boolean = false;
}

export class SessionBindingError extends McpRouteBindingError {
  readonly webContentsId: number;

  constructor(webContentsId: number) {
    super(
      `MCP pinned view ${webContentsId} no longer available — the renderer session this MCP session was bound to has been destroyed. Do not retry.`
    );
    this.name = "SessionBindingError";
    this.webContentsId = webContentsId;
  }
}

/**
 * Thrown when a workspace-bound external session (#11789) cannot resolve its
 * workspace to exactly one live view.
 *
 * `not-found` is recoverable in principle — the binding is to a stable workspace
 * id, so a later call succeeds once that workspace has a live view again — but
 * the *current* call fails closed rather than falling back to another window.
 * `ambiguous` means the same workspace is open in more than one view, so "the"
 * target is undefined; guessing would reintroduce the retargeting this binding
 * removes.
 */
export class WorkspaceBindingError extends McpRouteBindingError {
  readonly workspaceId: string;
  readonly reason: "not-found" | "ambiguous";
  /**
   * Always retriable, for both reasons (#12082). The binding is to a stable
   * workspace id that outlives any view, so opening the workspace — or closing
   * the duplicate — makes the very same call route, with nothing changed on the
   * caller's side. That is the definition this flag carries, and it is why
   * `SessionBindingError` answers the opposite: a destroyed pinned WebContents
   * is the session's identity, not a route it can re-resolve.
   */
  readonly retriable = true;

  constructor(workspaceId: string, reason: "not-found" | "ambiguous") {
    super(
      reason === "not-found"
        ? `No live Daintree view is open for workspace ${workspaceId}, which this MCP session is bound to. The call was not routed anywhere else. Reopen that workspace and retry.`
        : `Workspace ${workspaceId} is open in more than one Daintree view, so this MCP session's bound target is ambiguous. The call was not routed anywhere. Close the duplicate view and retry.`
    );
    this.name = "WorkspaceBindingError";
    this.workspaceId = workspaceId;
    this.reason = reason;
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

/**
 * Which binding a bridge operation is routed by, or `undefined` for the
 * unpinned focused-window path (#11790).
 *
 * A routed operation targets a view the user is not looking at, which is what
 * makes it different in three ways at once, all handled off this one value:
 *
 * 1. The target may be CDP-frozen by the efficiency profile, so it must be
 *    thawed before the dispatch IPC — a frozen renderer cannot run JS and the
 *    message would sit in Mojo until the bridge deadline fired.
 * 2. It must hold an eviction lease while the request is outstanding, or a
 *    memory-pressure pass can destroy the very view being awaited.
 * 3. Losing the target is a *binding* failure (`SESSION_BINDING_GONE`), not a
 *    generic retriable execution error — the same classification the resolver
 *    already applies when the target is gone before the send.
 *
 * The unpinned path opts out of all three: it resolves the active view, which
 * is never frozen and never an eviction candidate, so thawing it would spend a
 * CDP round trip per tool call for nothing.
 */
type BridgeRoute =
  { kind: "workspace"; workspaceId: string } | { kind: "pinned"; webContentsId: number };

/**
 * The error a routed operation should fail with when its target dies while the
 * request is in flight. Mirrors what the resolver throws when the target is
 * already gone, so "destroyed just before" and "destroyed just after" report
 * the same thing instead of the second one degrading to `EXECUTION_ERROR`.
 */
function routeLostError(route: BridgeRoute): McpRouteBindingError {
  return route.kind === "workspace"
    ? new WorkspaceBindingError(route.workspaceId, "not-found")
    : new SessionBindingError(route.webContentsId);
}

/** Names the unreachable target in a deadline message, so a timeout says which view went quiet. */
function routeTimeoutSuffix(route: BridgeRoute | undefined, timeoutMs: number): string {
  if (!route) return "";
  const target =
    route.kind === "workspace"
      ? `workspace ${route.workspaceId}`
      : `pinned view ${route.webContentsId}`;
  return ` — the view bound to ${target} did not answer within ${Math.round(timeoutMs / 1000)}s`;
}

/**
 * Thaw a routed target, then send — the fix for the stranded-dispatch half of
 * #11790.
 *
 * Under the efficiency profile a cached background view is CDP-frozen, and a
 * frozen renderer cannot run JS: the dispatch IPC queues in Mojo and nothing
 * ever answers it, so the caller waits out the full bridge deadline for what
 * looks like an execution failure. Chromium never auto-resumes a frozen
 * renderer on focus or re-attach, so an explicit `"active"` is the only thing
 * that rescues it.
 *
 * Awaited, unlike the fire-and-forget `void unfreezeWebContents(...)` at the
 * lifecycle call sites: those only need the view running again eventually,
 * whereas the IPC queued here is precisely what the thaw has to precede.
 *
 * CPU throttling is deliberately left in place, matching `unfreezeActiveAgentViews`.
 * `Emulation.setCPUThrottlingRate` is orthogonal to lifecycle state and slows
 * JS without suspending it, so a thawed-but-throttled view still answers — and
 * clearing it would hand a background workspace the CPU budget of a foreground
 * one. Nothing here attaches, shows, focuses, or activates the view either: a
 * bound session driving project A must never disturb what the user is looking at.
 */
function thawThenSend(
  webContents: Electron.WebContents,
  isStillPending: () => boolean,
  send: () => void
): void {
  void unfreezeWebContents(webContents)
    .catch(() => {
      // `unfreezeWebContents` already swallows the expected teardown/navigation
      // CDP errors, so anything landing here is unexpected. Refusing to send
      // would convert a thaw hiccup into a guaranteed deadline failure; sending
      // anyway leaves a genuinely-still-frozen view failing exactly as it did
      // before this path existed, and costs nothing when the thaw did work.
    })
    .then(() => {
      // The deadline may have fired, or the view may have been destroyed, while
      // the CDP round trip was outstanding. Either way the request is already
      // settled and its lease released, so sending now would emit an IPC for a
      // requestId nothing is waiting on.
      if (!isStillPending() || webContents.isDestroyed()) return;
      send();
    });
}

export function createRendererBridge(
  pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>,
  pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>,
  getRegistry: () => WindowRegistry | null,
  /**
   * Eviction leases for routed operations (#11790). Optional so a bridge built
   * without one (tests, older construction paths) simply takes no leases —
   * views then stay ordinary eviction candidates, the pre-#11790 behavior.
   */
  viewLeases?: WorkspaceViewLeaseRegistry
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

  // One-shot latch so a persistently broken workspace lookup can't flood the
  // log on every dispatch (#11536).
  let warnedWorkspaceResolveFailure = false;

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

  /**
   * Resolve a workspace-bound session's target renderer (#11789).
   *
   * Re-resolved for every operation rather than pinned once at handshake,
   * because a WebContents id is only stable for the life of one view: a warm
   * project switch reuses the same view, but LRU eviction destroys it and a
   * later cold start registers a *new* id under the same workspace id
   * (`ProjectViewSwitchController`). Caching the handshake id would leave the
   * session permanently `SESSION_BINDING_GONE` even after its workspace came
   * back; the workspace id is the identity that survives.
   *
   * Deliberately side-effect free — `getWebContentsForProject` is a registry
   * read that includes cached/frozen views without attaching, thawing,
   * activating, focusing, or switching anything. Binding a background workspace
   * must never disturb what the user is looking at.
   *
   * Exactly one match, or nothing: zero and many both fail closed. There is no
   * "pick the first" branch, because that is the focus-order guessing this
   * whole binding replaces. Dispatching into a *frozen* view is #11790; this
   * resolver is correct whenever the bound view is live.
   */
  function getWorkspaceWebContents(workspaceId: string): Electron.WebContents {
    const matches = getWebContentsForProject(workspaceId).filter((wc) => !wc.isDestroyed());
    if (matches.length === 0) throw new WorkspaceBindingError(workspaceId, "not-found");
    if (matches.length > 1) throw new WorkspaceBindingError(workspaceId, "ambiguous");
    return matches[0];
  }

  function normalizeError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(fallback);
  }

  /**
   * Resolve which workspace a dispatch landed on, for the response envelope
   * (#11536). Routed through the owning window's own ProjectViewManager so the
   * answer is sender-scoped — never `getCurrentProjectId()`, which reports the
   * most-recently-switched project rather than this webContents'.
   *
   * The module-singleton manager is only an identity fallback for a dispatch
   * that was already routed through it (the registry-less branch of
   * `getActiveProjectWebContents`); it is deliberately not a routing fallback.
   *
   * Never throws. Identity is decoration on an already-completed action, and
   * the caller has by now cleared the pending entry's timer, so letting an
   * exception escape would strand the awaiting promise. Ordinary teardown is
   * not an error — the accessor already converts a destroyed view to `null`, so
   * only genuinely unexpected throws are logged, once, to keep a future
   * refactor from silently degrading this to "never stamps".
   */
  function resolveDispatchedWorkspace(webContentsId: number): DispatchedWorkspaceRef | undefined {
    // The whole lookup is guarded, not just the accessor call: the registry
    // read, the window lookup and the service property access can each throw on
    // a torn-down window, and by this point the caller has already cleared the
    // pending entry's timer — so an escaping exception would strand the
    // awaiting promise rather than merely lose the stamp.
    try {
      const registry = getRegistry();
      const projectViewManager =
        registry?.getByWebContentsId(webContentsId)?.services.projectViewManager ??
        getProjectViewManager();
      // A host whose manager predates this accessor is an expected shape, not a
      // failure — resolve to "unknown" without logging.
      if (typeof projectViewManager?.getWorkspaceRefForWebContents !== "function") return undefined;
      return projectViewManager.getWorkspaceRefForWebContents(webContentsId) ?? undefined;
    } catch (err) {
      if (!warnedWorkspaceResolveFailure) {
        warnedWorkspaceResolveFailure = true;
        console.warn("[MCP] Failed to resolve the dispatched workspace for a tool result:", err);
      }
      return undefined;
    }
  }

  function sendManifestRequest(
    resolveWebContents: () => Electron.WebContents,
    onResolved: (manifest: ActionManifestEntry[]) => void,
    route?: BridgeRoute
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
        reject(
          new Error(
            `Manifest request timed out${routeTimeoutSuffix(route, MCP_MANIFEST_REQUEST_TIMEOUT_MS)}`
          )
        );
      }, MCP_MANIFEST_REQUEST_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = pendingManifests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingManifests.delete(requestId);
        settle();
        pending.reject(route ? routeLostError(route) : new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      // Idempotent: a request can settle through the response, the deadline,
      // WebContents destruction, or a synchronous `send()` throw, and more than
      // one of those can run for the same request. A double release would
      // decrement another caller's lease; a missed one would pin the view for
      // the rest of the session, quietly recreating the permanent eviction
      // floor #11790 exists to avoid.
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
        releaseLease?.();
      };

      // Taken after every listener that could throw is wired, so a failed setup
      // can never strand a lease with no settle path left to release it — and
      // still synchronously, before the thaw round trip below, so the window
      // between picking this view and sending to it is covered. An eviction
      // pass landing inside that CDP round trip would otherwise destroy the
      // target we just resolved. `tools/list` is usually a bound session's
      // first operation and has the shorter deadline, so it is the more
      // exposed of the two.
      const releaseLease = route ? (viewLeases?.acquire(webContentsId) ?? null) : null;

      pendingManifests.set(requestId, {
        resolve: (manifest) => {
          onResolved(manifest);
          resolve(manifest);
        },
        reject,
        timer,
        webContentsId,
        destroyedCleanup: settle,
      });

      const send = () => {
        try {
          webContents.send(CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST, { requestId });
        } catch (err) {
          clearTimeout(timer);
          settle();
          pendingManifests.delete(requestId);
          reject(normalizeError(err, "Failed to request action manifest"));
        }
      };

      if (route) {
        thawThenSend(webContents, () => pendingManifests.has(requestId), send);
      } else {
        send();
      }
    });
  }

  function sendDispatchRequest(
    resolveWebContents: () => Electron.WebContents,
    actionId: string,
    args: unknown,
    confirmed: boolean,
    sessionOrigin: McpSessionOrigin,
    contextOverride?: ActionContext,
    callerInfo?: McpBearerIdentity,
    route?: BridgeRoute
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
        reject(
          new Error(
            `Action dispatch timed out: ${actionId}${routeTimeoutSuffix(route, MCP_DISPATCH_TIMEOUT_MS)}`
          )
        );
      }, MCP_DISPATCH_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = pendingDispatches.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingDispatches.delete(requestId);
        settle();
        pending.reject(route ? routeLostError(route) : new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
        releaseLease?.();
      };

      // See sendManifestRequest: after the listener wiring so a throwing setup
      // can't strand it, before the thaw so the resolve → send window is
      // covered. Released by `settle()` on every outcome.
      const releaseLease = route ? (viewLeases?.acquire(webContentsId) ?? null) : null;

      pendingDispatches.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId,
        destroyedCleanup: settle,
      });

      const send = () => {
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
            // How the dispatching session authenticated (#11808), so the
            // renderer can stamp a spawn it creates as assistant-launched
            // rather than lumping every MCP-borne spawn under one origin.
            // Always present: main resolves it, the caller never sends it.
            sessionOrigin,
          });
        } catch (err) {
          clearTimeout(timer);
          settle();
          pendingDispatches.delete(requestId);
          reject(normalizeError(err, `Failed to dispatch action: ${actionId}`));
        }
      };

      if (route) {
        thawThenSend(webContents, () => pendingDispatches.has(requestId), send);
      } else {
        send();
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
    callerInfo?: McpBearerIdentity,
    sessionOrigin: McpSessionOrigin = "external"
  ): Promise<DispatchEnvelope> {
    return sendDispatchRequest(
      () => getActiveProjectWebContents(),
      actionId,
      args,
      confirmed,
      sessionOrigin,
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
      },
      // A pinned view is a project view like any other: it can be cached,
      // frozen and evicted while its help session is still live (#11790).
      // Callers that coalesce onto this in-flight fetch inherit its thaw and
      // its lease — the lease covers the fetch, not the caller, so one is
      // enough for all of them.
      { kind: "pinned", webContentsId: id }
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
    contextOverride?: ActionContext,
    sessionOrigin: McpSessionOrigin = "external"
  ): Promise<DispatchEnvelope> {
    return sendDispatchRequest(
      () => getPinnedWebContents(id),
      actionId,
      args,
      confirmed,
      sessionOrigin,
      contextOverride,
      undefined,
      { kind: "pinned", webContentsId: id }
    );
  }

  /**
   * Manifest fetch for a workspace-bound external session (#11789). Resolves
   * the workspace's current view, then reuses the per-WebContents fetch and
   * cache the pinned path already uses — so a bound session gets the same
   * cross-window isolation and the same warm cache, keyed by whichever view
   * currently owns its workspace.
   */
  function requestManifestForWorkspace(workspaceId: string): Promise<ActionManifestEntry[]> {
    let id: number;
    try {
      id = getWorkspaceWebContents(workspaceId).id;
    } catch (err) {
      return Promise.reject(normalizeError(err, "MCP workspace binding unavailable"));
    }
    return requestManifestForWebContents(id).catch((err: unknown) => {
      // The shared fetch reports a mid-flight teardown as a dead *pin* — "do
      // not retry", which is right for a help session whose window closed but
      // wrong for a workspace binding. The workspace id outlives the view, so
      // reopening it makes the very same call work (#11790).
      if (err instanceof SessionBindingError) {
        throw new WorkspaceBindingError(workspaceId, "not-found");
      }
      throw err;
    });
  }

  /**
   * Action dispatch for a workspace-bound external session (#11789). No
   * `contextOverride`: unlike a help session — which replays the ActionContext
   * snapshot taken when the user launched it — a bound external session has no
   * launch moment to replay, and the bound view's own live context already
   * describes the right workspace.
   */
  function dispatchActionForWorkspace(
    workspaceId: string,
    actionId: string,
    args: unknown,
    confirmed = false,
    sessionOrigin: McpSessionOrigin = "external"
  ): Promise<DispatchEnvelope> {
    return sendDispatchRequest(
      () => getWorkspaceWebContents(workspaceId),
      actionId,
      args,
      confirmed,
      sessionOrigin,
      undefined,
      undefined,
      { kind: "workspace", workspaceId }
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
    // Snapshot the workspace identity here, synchronously, off the sender we
    // just validated (#11536). Resolving it later — after the awaiting caller
    // in sessionServer resumes — would race view eviction and workspace
    // switching, and could report a workspace the dispatch never ran against.
    const dispatchedWorkspace = resolveDispatchedWorkspace(pending.webContentsId);
    pending.resolve({
      result: payload.result,
      confirmationDecision: payload.confirmationDecision,
      ...(dispatchedWorkspace ? { dispatchedWorkspace } : {}),
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
    requestManifestForWorkspace,
    dispatchActionForWorkspace,
    /**
     * Validate a handshake workspace selector and describe what it resolved to
     * (#11789). Throws {@link WorkspaceBindingError} when the workspace has no
     * live view or more than one. That is no longer a refusal (#12082): the
     * caller binds identity-only and reports the unreachable route per call,
     * because which windows are open is not a fact about the selector.
     *
     * The descriptive fields are best-effort: `workspaceId` is the routing
     * identity and is always returned, while `kind`/`workspacePath` come from
     * the same accessor that stamps `org.daintree/resolved-workspace` and are
     * omitted if it can't answer.
     */
    resolveWorkspaceBinding: (workspaceId: string): McpWorkspaceBinding => {
      const wc = getWorkspaceWebContents(workspaceId);
      const ref = resolveDispatchedWorkspace(wc.id);
      return ref ? { ...ref, workspaceId } : { workspaceId };
    },
    getCachedManifest: () => cachedManifest,
    getCachedManifestForWebContents: (id: number): ActionManifestEntry[] | null =>
      perWebContentsCache.get(id) ?? null,
    /**
     * Warm-cache read for a workspace-bound session (#11789). Fails closed to
     * `null` when the workspace has no single live view, so a bound session can
     * never fall back to the shared cache and serve another workspace's tool
     * surface — the same isolation `getCachedManifestForWebContents` gives the
     * pinned path.
     */
    getCachedManifestForWorkspace: (workspaceId: string): ActionManifestEntry[] | null => {
      try {
        return perWebContentsCache.get(getWorkspaceWebContents(workspaceId).id) ?? null;
      } catch {
        return null;
      }
    },
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
