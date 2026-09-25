import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * The frontend a plugin's host round-trip (a prompt, a consent question, a
 * clipboard write, an open-file request) should reach.
 *
 * - `local`: a view of this process, found the way it always was.
 * - `remote`: the renderer on another machine that drives the project.
 * - `none`: nobody is attached who could answer. `reserved` means the driver
 *   stepped away inside its lease's grace; `vacant` means nobody drives at all.
 */
export type PluginFrontend =
  | { kind: "local" }
  | { kind: "remote"; endpoint: ClientEndpoint }
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
const invokeOrigins = new Map<string, { endpoint: ClientEndpoint; release: () => void }>();

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
  if (next === null) clearInvokeOrigins();
  notifyChange();
  return () => {
    if (router !== next) return;
    routerChangeCleanup?.();
    routerChangeCleanup = null;
    router = null;
    clearInvokeOrigins();
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
 * Remember which frontend last called a plugin, so an app-global plugin's
 * prompt lands in front of the person who just used it rather than whichever
 * window is focused on this machine. Only kept while routing is on.
 */
export function notePluginInvokeOrigin(pluginId: string, endpoint: ClientEndpoint): void {
  if (router === null || endpoint.isClosed()) return;
  const existing = invokeOrigins.get(pluginId);
  if (existing?.endpoint === endpoint) return;
  existing?.release();
  const subscription = endpoint.onClose(() => {
    if (invokeOrigins.get(pluginId)?.endpoint === endpoint) invokeOrigins.delete(pluginId);
  });
  invokeOrigins.set(pluginId, { endpoint, release: () => subscription.dispose() });
}

export function getPluginInvokeOrigin(pluginId: string): ClientEndpoint | null {
  const entry = invokeOrigins.get(pluginId);
  if (!entry) return null;
  if (entry.endpoint.isClosed()) {
    entry.release();
    invokeOrigins.delete(pluginId);
    return null;
  }
  return entry.endpoint;
}

function clearInvokeOrigins(): void {
  for (const entry of invokeOrigins.values()) entry.release();
  invokeOrigins.clear();
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
  clearInvokeOrigins();
}
