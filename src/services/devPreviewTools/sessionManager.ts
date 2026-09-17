import { useSyncExternalStore } from "react";
import { logError } from "@/utils/logger";
import {
  getAvailableDevPreviewTool,
  getDevPreviewTool,
  type DevPreviewTool,
  type DevPreviewToolContext,
  type DevPreviewToolSession,
  type DevPreviewToolSessionContext,
} from "@/registry/devPreviewToolRegistry";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { usePanelStore } from "@/store/panelStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

/**
 * One tool session per dev preview, owned by the host rather than by whichever
 * surface happened to mount first.
 *
 * A tool's surfaces come and go for reasons that have nothing to do with the
 * tool: the preview's dock tab is hidden, a sibling is maximised, the grid
 * remounts. The events that really end a tool are different ones — the tool is
 * switched off, the preview is trashed or removed, its plugin is disabled — and
 * they are all the host's to see. So the session is created when
 * `activeByPanel` names the tool, kept while that entry stands, and disposed
 * when it goes; surfaces only consume it.
 *
 * Store reads all happen inside function bodies, never at module evaluation,
 * so the static store imports here cannot form an eval-time cycle
 * (`docs/architecture/store-init-order.md`).
 */

/** A session and its identity, for surfaces to consume and key UI on. */
export interface DevPreviewToolSessionHandle {
  readonly toolId: string;
  /** Null while an asynchronous `createSession` is still resolving. */
  readonly session: DevPreviewToolSession | null;
  /** Changes with the session, so a boundary keyed on it resets for a new one. */
  readonly key: number;
}

interface SessionEntry {
  readonly toolId: string;
  readonly abort: AbortController;
  readonly key: number;
  session: DevPreviewToolSession | null;
  handle: DevPreviewToolSessionHandle;
  disposed: boolean;
}

const entries = new Map<string, SessionEntry>();
/** Last context each preview published; kept while its pane is unmounted. */
const contexts = new Map<string, DevPreviewToolContext>();
const mountedSurfaces = new Map<string, number>();
const listeners = new Set<() => void>();
let nextKey = 1;
let unsubscribe: (() => void) | null = null;
let reconciling = false;
let reconcileAgain = false;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function fallbackContext(panelId: string): DevPreviewToolContext {
  return {
    panelId,
    projectId: null,
    worktreeId: null,
    worktreePath: null,
    url: "",
    isWebviewReady: false,
  };
}

function sessionContext(panelId: string, signal: AbortSignal): DevPreviewToolSessionContext {
  return {
    ...(contexts.get(panelId) ?? fallbackContext(panelId)),
    visible: (mountedSurfaces.get(panelId) ?? 0) > 0,
    signal,
  };
}

function sameContext(a: DevPreviewToolContext, b: DevPreviewToolContext): boolean {
  return (
    a.projectId === b.projectId &&
    a.worktreeId === b.worktreeId &&
    a.worktreePath === b.worktreePath &&
    a.url === b.url &&
    a.isWebviewReady === b.isWebviewReady
  );
}

function setHandle(entry: SessionEntry): void {
  entry.handle = { toolId: entry.toolId, session: entry.session, key: entry.key };
  notify();
}

function pushContext(panelId: string): void {
  const entry = entries.get(panelId);
  if (!entry?.session) return;
  try {
    entry.session.update?.(sessionContext(panelId, entry.abort.signal));
  } catch (error) {
    logError(`Dev preview tool "${entry.toolId}" failed to take its context`, error);
  }
}

function adopt(panelId: string, entry: SessionEntry, session: DevPreviewToolSession): void {
  if (entry.disposed || entries.get(panelId) !== entry) {
    disposeSession(entry.toolId, session);
    return;
  }
  entry.session = session;
  setHandle(entry);
  pushContext(panelId);
}

function disposeSession(toolId: string, session: DevPreviewToolSession): void {
  try {
    session.dispose();
  } catch (error) {
    logError(`Dev preview tool "${toolId}" failed to dispose its session`, error);
  }
}

function createEntry(panelId: string, tool: DevPreviewTool): void {
  const createSession = tool.createSession;
  if (!createSession) return;
  const abort = new AbortController();
  const key = nextKey++;
  const entry: SessionEntry = {
    toolId: tool.id,
    abort,
    key,
    session: null,
    handle: { toolId: tool.id, session: null, key },
    disposed: false,
  };
  entries.set(panelId, entry);
  let created: DevPreviewToolSession | Promise<DevPreviewToolSession>;
  try {
    created = createSession(sessionContext(panelId, abort.signal));
  } catch (error) {
    failEntry(panelId, entry, error);
    return;
  }
  if (created instanceof Promise) {
    notify();
    void created.then(
      (session) => adopt(panelId, entry, session),
      (error) => failEntry(panelId, entry, error)
    );
    return;
  }
  // Through `adopt` like an awaited one: a factory that switched its own tool
  // off before returning has already had this entry reconciled away, and the
  // session it then hands back is nobody's.
  adopt(panelId, entry, created);
}

/**
 * A session that could not be built. The tool is switched off rather than left
 * on with nothing behind it — a toggle that is pressed and shows no strip is
 * worse than one that springs back. A factory that lost its entry in the
 * meantime is not this preview's failure and says nothing.
 */
function failEntry(panelId: string, entry: SessionEntry, error: unknown): void {
  if (entries.get(panelId) !== entry) return;
  entries.delete(panelId);
  entry.disposed = true;
  entry.abort.abort();
  logError(`Dev preview tool "${entry.toolId}" failed to start`, error);
  notify();
  useDevPreviewToolStore.getState().setActive(panelId, null);
}

function disposeEntry(panelId: string, entry: SessionEntry): void {
  if (entries.get(panelId) === entry) entries.delete(panelId);
  if (entry.disposed) {
    notify();
    return;
  }
  entry.disposed = true;
  // Aborted before disposal: a session cancelling in-flight work wants the
  // signal while its transport is still there to cancel through.
  entry.abort.abort();
  const session = entry.session;
  entry.session = null;
  if (session) disposeSession(entry.toolId, session);
  notify();
}

/**
 * Bring the live sessions in line with which tool each preview has switched on.
 *
 * Serialised: creating and disposing runs a tool's own code, which may switch a
 * tool off (or on) as it goes. A nested call would leave the outer one acting
 * on a store snapshot that has since moved, so it asks for another pass instead
 * and the loop settles on what the store actually says.
 */
function reconcile(): void {
  if (reconciling) {
    reconcileAgain = true;
    return;
  }
  reconciling = true;
  try {
    do {
      reconcileAgain = false;
      reconcileOnce();
    } while (reconcileAgain);
  } finally {
    reconciling = false;
  }
}

function reconcileOnce(): void {
  const active = useDevPreviewToolStore.getState().activeByPanel;
  for (const [panelId, entry] of [...entries]) {
    if (active[panelId] !== entry.toolId) disposeEntry(panelId, entry);
  }
  for (const [panelId, toolId] of Object.entries(active)) {
    if (entries.has(panelId)) continue;
    const tool = getAvailableDevPreviewTool(toolId);
    if (tool?.createSession) createEntry(panelId, tool);
  }
}

/**
 * The transitions the tool store cannot see for itself: a preview that was
 * trashed or removed, and a plugin that was disabled. Both end the tool, so
 * both clear the active entry — which is what disposes the session and what
 * stops a restored preview coming back holding a tool nothing is running.
 *
 * A preview the panel store no longer holds is gone, including when it was the
 * last one: a cleared store means this view's panels are over, which is exactly
 * when a bound preview and an open source workspace must not be left behind.
 * The visibility count is left to the retains that own it, so a panel id
 * removed while a surface is still unmounting cannot take a successor's count
 * with it.
 */
function enforceLifetime(): void {
  const active = useDevPreviewToolStore.getState().activeByPanel;
  const panels = usePanelStore.getState();
  const { disabledPluginIds } = usePluginRuntimeStore.getState();
  for (const [panelId, toolId] of Object.entries(active)) {
    const panel = panels.panelsById[panelId];
    const gone = panel === undefined || panel.location === "trash";
    const tool = getDevPreviewTool(toolId);
    if (gone || (tool !== undefined && disabledPluginIds.has(tool.pluginId))) {
      useDevPreviewToolStore.getState().setActive(panelId, null);
    }
  }
  for (const panelId of [...contexts.keys()]) {
    if (panels.panelsById[panelId] === undefined) contexts.delete(panelId);
  }
}

/**
 * Start watching the stores. Idempotent, and called from every entry point
 * rather than at module evaluation: the manager is only needed once a preview
 * with tools is on screen, and nothing may read a store while modules evaluate.
 */
export function startDevPreviewToolSessions(): void {
  if (unsubscribe) return;
  const offTools = useDevPreviewToolStore.subscribe(reconcile);
  const offPanels = usePanelStore.subscribe(enforceLifetime);
  const offPlugins = usePluginRuntimeStore.subscribe(() => {
    enforceLifetime();
    reconcile();
  });
  unsubscribe = () => {
    offTools();
    offPanels();
    offPlugins();
  };
  enforceLifetime();
  reconcile();
}

/**
 * What the preview is showing right now. Published by the tool host whenever
 * the pane is mounted, so a session switched on from an action — with no pane
 * anywhere — still gets the real context as soon as one appears.
 */
export function publishDevPreviewToolContext(context: DevPreviewToolContext): void {
  const previous = contexts.get(context.panelId);
  contexts.set(context.panelId, context);
  startDevPreviewToolSessions();
  if (previous !== undefined && sameContext(previous, context)) return;
  pushContext(context.panelId);
}

/** Count one mounted surface for a preview; the returned function un-counts it. */
export function retainDevPreviewToolVisibility(panelId: string): () => void {
  startDevPreviewToolSessions();
  mountedSurfaces.set(panelId, (mountedSurfaces.get(panelId) ?? 0) + 1);
  pushContext(panelId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (mountedSurfaces.get(panelId) ?? 1) - 1;
    if (remaining > 0) mountedSurfaces.set(panelId, remaining);
    else mountedSurfaces.delete(panelId);
    pushContext(panelId);
  };
}

function subscribeSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function handleFor(
  panelId: string,
  toolId: string | undefined
): DevPreviewToolSessionHandle | null {
  if (toolId === undefined) return null;
  const entry = entries.get(panelId);
  return entry && entry.toolId === toolId ? entry.handle : null;
}

/** The live session for a preview's tool, as the host's surfaces read it. */
export function useDevPreviewToolSessionHandle(
  panelId: string,
  toolId: string | undefined
): DevPreviewToolSessionHandle | null {
  return useSyncExternalStore(
    subscribeSessions,
    () => handleFor(panelId, toolId),
    () => handleFor(panelId, toolId)
  );
}

/** The live session for a preview, whatever tool it belongs to. Never creates. */
export function peekDevPreviewToolSession(panelId: string): DevPreviewToolSession | null {
  return entries.get(panelId)?.session ?? null;
}

export function __resetDevPreviewToolSessionsForTests(): void {
  for (const [panelId, entry] of [...entries]) disposeEntry(panelId, entry);
  entries.clear();
  contexts.clear();
  mountedSurfaces.clear();
  unsubscribe?.();
  unsubscribe = null;
}
