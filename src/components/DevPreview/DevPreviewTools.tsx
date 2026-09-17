import { Suspense, createElement, useCallback, useEffect, type ComponentType } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import {
  publishDevPreviewToolContext,
  retainDevPreviewToolVisibility,
  useDevPreviewToolSessionHandle,
  type DevPreviewToolSessionHandle,
} from "@/services/devPreviewTools/sessionManager";
// createElement rather than JSX on `tool.Button` and friends: the React Compiler
// can fold an alias of a registered component into an intrinsic element name,
// which renders an empty unknown tag instead of the tool.
import {
  useDevPreviewTools,
  type DevPreviewTool,
  type DevPreviewToolContext,
  type DevPreviewToolSurfaceProps,
} from "@/registry/devPreviewToolRegistry";

export interface DevPreviewToolHostProps {
  panelId: string;
  projectId: string | undefined;
  worktreeId: string | undefined;
  url: string;
  isWebviewReady: boolean;
}

/**
 * The context every surface and every session of this preview sees. Published
 * to the session manager from here rather than from a surface: the sessions
 * outlive their surfaces, and this runs wherever the pane is mounted.
 */
function useToolContext({
  panelId,
  projectId,
  worktreeId,
  url,
  isWebviewReady,
}: DevPreviewToolHostProps): DevPreviewToolContext {
  const worktreePath = useWorktreeStoreOptional(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? null) : null),
      [worktreeId]
    ),
    null
  );
  useEffect(() => {
    publishDevPreviewToolContext({
      panelId,
      projectId: projectId ?? null,
      worktreeId: worktreeId ?? null,
      worktreePath,
      url,
      isWebviewReady,
    });
  }, [panelId, projectId, worktreeId, worktreePath, url, isWebviewReady]);
  return {
    panelId,
    projectId: projectId ?? null,
    worktreeId: worktreeId ?? null,
    worktreePath,
    url,
    isWebviewReady,
  };
}

function useActiveTool(panelId: string): DevPreviewTool | undefined {
  const tools = useDevPreviewTools();
  const activeId = useDevPreviewToolStore((s) => s.activeByPanel[panelId]);
  return activeId ? tools.find((tool) => tool.id === activeId) : undefined;
}

/** Toolbar toggles for every enabled tool; each decides whether it applies here. */
export function DevPreviewToolButtons(props: DevPreviewToolHostProps) {
  const tools = useDevPreviewTools();
  const context = useToolContext(props);
  const activeId = useDevPreviewToolStore((s) => s.activeByPanel[props.panelId]);
  const toggle = useDevPreviewToolStore((s) => s.toggle);
  if (tools.length === 0) return null;
  return (
    <>
      {tools.map((tool) => (
        <ErrorBoundary key={tool.id} variant="component" componentName={`${tool.label} button`}>
          {createElement(tool.Button, {
            ...context,
            active: activeId === tool.id,
            onToggle: () => toggle(props.panelId, tool.id),
          })}
        </ErrorBoundary>
      ))}
    </>
  );
}

/**
 * One of the active tool's surfaces, mounted only once its session exists.
 *
 * The boundary is keyed by tool and session: an error belongs to the tool that
 * threw it, so switching straight to another tool — or getting a new session
 * for this one — must not hand the newcomer the old failure.
 */
function DevPreviewToolSurface({
  tool,
  Surface,
  role,
  handle,
  context,
}: {
  tool: DevPreviewTool;
  Surface: ComponentType<DevPreviewToolSurfaceProps>;
  role: string;
  handle: DevPreviewToolSessionHandle | null;
  context: DevPreviewToolContext;
}) {
  const panelId = context.panelId;
  useEffect(() => retainDevPreviewToolVisibility(panelId), [panelId]);
  const setActive = useDevPreviewToolStore((s) => s.setActive);
  const key = `${tool.id}:${handle?.key ?? 0}`;
  return (
    <ErrorBoundary
      key={key}
      resetKeys={[key]}
      variant="component"
      componentName={`${tool.label} ${role}`}
    >
      <Suspense fallback={null}>
        {createElement(Surface, {
          ...context,
          session: handle?.session ?? null,
          onClose: () => setActive(panelId, null),
        })}
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Whether the tool is ready to be shown: a tool that owns a session waits for
 * it, so no surface ever renders against a session that does not exist yet.
 */
function ready(tool: DevPreviewTool, handle: DevPreviewToolSessionHandle | null): boolean {
  return tool.createSession === undefined || handle?.session != null;
}

/** The active tool's strip under the browser toolbar. */
export function DevPreviewToolToolbar(props: DevPreviewToolHostProps) {
  const tool = useActiveTool(props.panelId);
  const context = useToolContext(props);
  const handle = useDevPreviewToolSessionHandle(props.panelId, tool?.id);
  const Surface = tool?.Toolbar;
  if (!tool || !Surface || !ready(tool, handle)) return null;
  return (
    <DevPreviewToolSurface
      tool={tool}
      Surface={Surface}
      role="toolbar"
      handle={handle}
      context={context}
    />
  );
}

/** The active tool's drawer beside the page. */
export function DevPreviewToolDrawer(props: DevPreviewToolHostProps) {
  const tool = useActiveTool(props.panelId);
  const context = useToolContext(props);
  const handle = useDevPreviewToolSessionHandle(props.panelId, tool?.id);
  const Surface = tool?.Drawer;
  if (!tool || !Surface || !ready(tool, handle)) return null;
  return (
    <DevPreviewToolSurface
      tool={tool}
      Surface={Surface}
      role="panel"
      handle={handle}
      context={context}
    />
  );
}
