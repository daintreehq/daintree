import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";

/**
 * Tools a built-in plugin adds to the dev preview panel: a toggle in the
 * preview's toolbar and, while toggled on, a strip under that toolbar and an
 * optional drawer beside the page. The dev preview owns the chrome and the
 * lifecycle; the tool owns what is inside it.
 *
 * Like `builtinRendererRegistry`, this is the seam that lets host UI render
 * plugin components without importing them. Registration is unconditional at
 * module eval; resolution hides a tool until its plugin is known to be loaded
 * and enabled — a default-off built-in must not flash its button before the
 * first plugin snapshot arrives.
 */

export interface DevPreviewToolContext {
  /** The dev preview panel hosting the tool. */
  panelId: string;
  projectId: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
  /** The page the preview is showing, or empty before one loads. */
  url: string;
  isWebviewReady: boolean;
}

/**
 * What a session sees of its preview, refreshed for the life of the session —
 * including while no surface is mounted, which is why `visible` is part of it
 * rather than something a surface has to report.
 */
export interface DevPreviewToolSessionContext extends DevPreviewToolContext {
  /** Whether any of the tool's surfaces are mounted right now. */
  visible: boolean;
  /** Aborted when the session is disposed. */
  signal: AbortSignal;
}

/**
 * A tool's state for one preview, owned by the host: created when the tool is
 * switched on, kept across surface unmounts, and disposed when the tool goes
 * off, the preview is trashed or removed, or the owning plugin is disabled.
 */
export interface DevPreviewToolSession {
  /** The context changed — a new page, a moved worktree, a surface mounting. */
  update?: (context: DevPreviewToolSessionContext) => void;
  dispose: () => void;
}

export interface DevPreviewToolSurfaceProps<
  TSession extends DevPreviewToolSession = DevPreviewToolSession,
> extends DevPreviewToolContext {
  /**
   * The host-owned session for this preview. Null only for a tool that
   * declares no `createSession`; a tool that declares one is not given
   * surfaces until its session exists.
   */
  session: TSession | null;
  /** Turn the tool off, as the toolbar toggle would. */
  onClose: () => void;
}

export interface DevPreviewToolButtonProps extends DevPreviewToolContext {
  active: boolean;
  onToggle: () => void;
}

export interface DevPreviewTool<TSession extends DevPreviewToolSession = DevPreviewToolSession> {
  /** Namespaced by plugin, e.g. `daintree.sveltekit-builder.builder`. */
  id: string;
  /** Owning plugin (manifest name); the tool disappears while it is disabled. */
  pluginId: string;
  /** User-facing name, used for error fallbacks and the default tooltip. */
  label: string;
  /**
   * The toolbar toggle. Renders nothing when the tool doesn't apply to this
   * preview (a Svelte tool on a Next.js site), so the button only appears where
   * it can do something.
   */
  Button: ComponentType<DevPreviewToolButtonProps>;
  /**
   * Builds the tool's session for one preview. Called by the host when the
   * tool is switched on, before any surface mounts, and may load the tool's
   * real implementation on the way (a promise is awaited; a session that
   * resolves after its preview let go is disposed immediately).
   */
  createSession?: (context: DevPreviewToolSessionContext) => TSession | Promise<TSession>;
  /** A strip directly under the browser toolbar while the tool is on. */
  Toolbar?: ComponentType<DevPreviewToolSurfaceProps<TSession>>;
  /** A drawer docked beside the page while the tool is on. Returns null to stay closed. */
  Drawer?: ComponentType<DevPreviewToolSurfaceProps<TSession>>;
}

const TOOLS = new Map<string, DevPreviewTool>();
let snapshot: readonly DevPreviewTool[] = [];
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = [...TOOLS.values()];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): readonly DevPreviewTool[] => snapshot;

export function registerDevPreviewTool<TSession extends DevPreviewToolSession>(
  tool: DevPreviewTool<TSession>
): void {
  // The session type is the tool's own business: the host only ever hands a
  // surface the session that the same tool's `createSession` produced, so the
  // registry can hold them all under the base type.
  TOOLS.set(tool.id, tool as DevPreviewTool);
  publish();
}

export function unregisterDevPreviewTool(toolId: string): void {
  if (TOOLS.delete(toolId)) publish();
}

export function getDevPreviewTool(toolId: string): DevPreviewTool | undefined {
  return TOOLS.get(toolId);
}

/** A registered tool whose plugin is loaded and enabled right now; undefined otherwise. */
export function getAvailableDevPreviewTool(toolId: string): DevPreviewTool | undefined {
  const tool = TOOLS.get(toolId);
  if (!tool) return undefined;
  const { pluginMetaById, disabledPluginIds } = usePluginRuntimeStore.getState();
  return pluginMetaById.has(tool.pluginId) && !disabledPluginIds.has(tool.pluginId)
    ? tool
    : undefined;
}

/** Registered tools whose plugin is loaded and enabled right now. */
export function useDevPreviewTools(): readonly DevPreviewTool[] {
  const tools = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const disabled = usePluginRuntimeStore((s) => s.disabledPluginIds);
  const known = usePluginRuntimeStore((s) => s.pluginMetaById);
  const init = usePluginRuntimeStore((s) => s.init);
  useEffect(() => init(), [init]);
  return tools.filter((tool) => known.has(tool.pluginId) && !disabled.has(tool.pluginId));
}

export function __resetDevPreviewToolsForTests(): void {
  TOOLS.clear();
  publish();
  useDevPreviewToolStore.setState({ activeByPanel: {} });
}
