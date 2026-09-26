import { AsyncLocalStorage } from "node:async_hooks";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * The frontend a plugin's host round-trip (a prompt, a consent question, a
 * clipboard write, an open-file request) should reach.
 *
 * - `local`: a view of this process, found the way it always was.
 * - `remote`: the renderer on another machine that drives the project, under
 *   drive lease `leaseId` when the project has a holder. A prompt shown there
 *   belongs to that lease: a takeover makes it someone else's.
 * - `none`: nobody is attached who could answer. `reserved` means the driver
 *   stepped away inside its lease's grace; `vacant` means nobody drives at all.
 */
export type PluginFrontend =
  | { kind: "local" }
  | { kind: "remote"; endpoint: ClientEndpoint; leaseId?: number }
  | { kind: "none"; reason: "vacant" | "reserved" | "lookup-failed" };

/**
 * Decides where a plugin's person-facing calls go. Installed by the remote
 * hosts module in Host mode; the drive lease is a remote-hosts service, so
 * core code never reads it directly.
 */
export interface PluginFrontendRouter {
  resolve(target: { projectId: string | null; pluginId: string }): PluginFrontend;
  /** A driver attached, left, or changed. */
  onChange(listener: () => void): () => void;
}

const LOCAL: PluginFrontend = { kind: "local" };

let router: PluginFrontendRouter | null = null;
let routerChangeCleanup: (() => void) | null = null;
const changeListeners = new Set<() => void>();

/**
 * Who a plugin invocation came from, carried with the invocation itself. An
 * app-global plugin has no project of its own, so its prompts and clipboard
 * calls follow the frontend and project of the call they happen inside, never
 * a per-plugin "last caller" that a concurrent call from another project could
 * overwrite. `projectId` is the caller's project when the call was made.
 */
export interface PluginInvocationScope {
  readonly pluginId: string;
  readonly endpoint: ClientEndpoint;
  readonly projectId: string | null;
}

const invocationScope = new AsyncLocalStorage<PluginInvocationScope>();

function notifyChange(): void {
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch (error) {
      console.error("[PluginFrontend] change listener failed:", error);
    }
  }
}

export function setPluginFrontendRouter(next: PluginFrontendRouter | null): () => void {
  routerChangeCleanup?.();
  routerChangeCleanup = null;
  router = next;
  if (next) routerChangeCleanup = next.onChange(notifyChange);
  notifyChange();
  return () => {
    if (router !== next) return;
    routerChangeCleanup?.();
    routerChangeCleanup = null;
    router = null;
    notifyChange();
  };
}

/**
 * Whether Host-mode routing decides plugin frontends. Off, every plugin call
 * targets this machine's views exactly as it did before remote hosts existed.
 */
export function isPluginFrontendRoutingEnabled(): boolean {
  return router !== null;
}

/**
 * Where a plugin's person-facing call for `projectId` goes. `local` whenever
 * no router is installed. A failed lookup is `none`, never `local`: guessing a
 * local window then could hand a remote driver's question to whoever happens
 * to be sitting at this machine.
 */
export function resolvePluginFrontend(projectId: string | null, pluginId: string): PluginFrontend {
  if (router === null) return LOCAL;
  let frontend: PluginFrontend;
  try {
    frontend = router.resolve({ projectId, pluginId });
  } catch (error) {
    console.warn("[PluginFrontend] Frontend lookup failed:", error);
    return { kind: "none", reason: "lookup-failed" };
  }
  if (frontend.kind === "remote" && frontend.endpoint.isClosed()) {
    return { kind: "none", reason: "reserved" };
  }
  return frontend;
}

/** Called whenever a frontend attaches, leaves, or takes over. Returns a disposer. */
export function onPluginFrontendChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * Run a plugin invocation from `endpoint` so an app-global plugin's prompt or
 * clipboard call made while it runs (including across its awaits) reaches the
 * person who made this call. Only while routing is on: off, `fn` runs as it
 * always did.
 */
export function runInPluginInvocation<T>(
  pluginId: string,
  endpoint: ClientEndpoint,
  fn: () => T
): T {
  if (router === null) return fn();
  return invocationScope.run({ pluginId, endpoint, projectId: endpoint.projectId }, fn);
}

/** The invocation the current async context belongs to, if any. */
export function currentPluginInvocation(): PluginInvocationScope | null {
  return invocationScope.getStore() ?? null;
}

/**
 * Re-enter a captured invocation for work that lost its async context (a
 * worker's callback, a prompt re-routed later). `null` runs `fn` outside any
 * invocation, so it can never inherit an unrelated caller's.
 */
export function runWithPluginInvocation<T>(scope: PluginInvocationScope | null, fn: () => T): T {
  return scope === null ? invocationScope.exit(fn) : invocationScope.run(scope, fn);
}

/**
 * The invocation `pluginId` is running inside, or null when the current work
 * belongs to no call of that plugin (background work, or a call of another
 * plugin). Kept after the caller's endpoint closes: the call still belongs to
 * the caller's project, whose current driver answers for it, and must never
 * fall through to whatever window happens to be open.
 */
export function getPluginInvokeOrigin(pluginId: string): PluginInvocationScope | null {
  const scope = invocationScope.getStore();
  if (!scope || scope.pluginId !== pluginId) return null;
  return scope;
}

/** Message prefix a plugin can match without importing anything. */
export const NO_FRONTEND_ATTACHED_PREFIX = "NO_FRONTEND_ATTACHED";

/**
 * Nobody is attached who could answer. Deliberately not the dismiss value a
 * cancelled prompt resolves with: a plugin must be able to tell "the person
 * said no" from "there was no person".
 */
export function noFrontendAttached(pluginId: string, detail: string): AppError {
  return new AppError({
    code: "NO_FRONTEND_ATTACHED",
    message: `${NO_FRONTEND_ATTACHED_PREFIX}: plugin "${pluginId}" ${detail}: nobody is attached to answer it`,
    userMessage: "Nobody is attached to this host to answer.",
    context: { pluginId },
  });
}

export function isNoFrontendAttachedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "NO_FRONTEND_ATTACHED";
}

/** @internal Tests only. */
export function _resetPluginFrontendRoutingForTesting(): void {
  routerChangeCleanup?.();
  routerChangeCleanup = null;
  router = null;
  changeListeners.clear();
}
