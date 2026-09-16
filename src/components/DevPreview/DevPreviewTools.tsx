import { Suspense, createElement, useCallback } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
// createElement rather than JSX on `tool.Button` and friends: the React Compiler
// can fold an alias of a registered component into an intrinsic element name,
// which renders an empty unknown tag instead of the tool.
import {
  useDevPreviewTools,
  type DevPreviewTool,
  type DevPreviewToolContext,
} from "@/registry/devPreviewToolRegistry";

export interface DevPreviewToolHostProps {
  panelId: string;
  projectId: string | undefined;
  worktreeId: string | undefined;
  url: string;
  isWebviewReady: boolean;
}

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

/** The active tool's strip under the browser toolbar. */
export function DevPreviewToolToolbar(props: DevPreviewToolHostProps) {
  const tool = useActiveTool(props.panelId);
  const context = useToolContext(props);
  const setActive = useDevPreviewToolStore((s) => s.setActive);
  if (!tool?.Toolbar) return null;
  return (
    <ErrorBoundary variant="component" componentName={`${tool.label} toolbar`}>
      <Suspense fallback={null}>
        {createElement(tool.Toolbar, {
          ...context,
          onClose: () => setActive(props.panelId, null),
        })}
      </Suspense>
    </ErrorBoundary>
  );
}

/** The active tool's drawer beside the page. */
export function DevPreviewToolDrawer(props: DevPreviewToolHostProps) {
  const tool = useActiveTool(props.panelId);
  const context = useToolContext(props);
  const setActive = useDevPreviewToolStore((s) => s.setActive);
  if (!tool?.Drawer) return null;
  return (
    <ErrorBoundary variant="component" componentName={`${tool.label} panel`}>
      <Suspense fallback={null}>
        {createElement(tool.Drawer, {
          ...context,
          onClose: () => setActive(props.panelId, null),
        })}
      </Suspense>
    </ErrorBoundary>
  );
}
