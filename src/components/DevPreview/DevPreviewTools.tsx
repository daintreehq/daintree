import {
  Suspense,
  createElement,
  useCallback,
  useEffect,
  useState,
  type ComponentType,
} from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { DevPreviewToolDrawerChrome } from "./DevPreviewToolDrawerChrome";
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

/** One tool in one preview: what its toggle and its surfaces are tagged with. */
function surfaceTag(panelId: string, toolId: string): string {
  return `${panelId}:${toolId}`;
}

/** A control in the same toolbar that outlives the toggle, for the case below. */
function toolbarNeighbour(wrapper: Element | null): HTMLElement | null {
  for (const sibling of [wrapper?.previousElementSibling, wrapper?.nextElementSibling]) {
    const button = sibling?.matches("button") ? sibling : sibling?.querySelector("button");
    if (button instanceof HTMLElement) return button;
  }
  return null;
}

/**
 * Hand focus back to the toggle that opened the tool when the close came from
 * inside one of the tool's own surfaces (`.claude/rules/overlay-focus.md`): the
 * control is about to unmount, and focus would otherwise land on
 * `document.body`. A programmatic close from elsewhere moves nothing.
 *
 * Read from the DOM rather than a ref the surface holds: a ref reaching the
 * tool's props is a React Compiler bailout, and the tags are already there.
 */
function returnFocusToToggle(tag: string): void {
  const from = document.activeElement;
  const surface = from?.closest("[data-dev-preview-tool-surface]");
  if (surface?.getAttribute("data-dev-preview-tool-surface") !== tag) return;
  // A keyboard close keeps its ring, as the overlay policy has it; a pointer
  // close restores ringlessly and suppresses the toggle's tooltip, which Radix
  // would otherwise open with the pointer nowhere near it.
  const keyboard = focusVisible(from);
  const wrapper = document.querySelector(`[data-dev-preview-tool-toggle="${tag}"]`);
  const neighbour = toolbarNeighbour(wrapper);
  const toggle = wrapper?.querySelector("button");
  if (toggle instanceof HTMLElement) {
    if (!keyboard) armTooltipFocusSuppression();
    toggle.focus(keyboard ? undefined : { preventScroll: true, focusVisible: false });
  }
  // The toggle itself can go with the surfaces — an active tool the
  // availability predicate no longer vouches for is only on screen because it
  // is active — and then the restore above has focused something that is about
  // to unmount. Check once the tool is off, and land on a surviving control.
  requestAnimationFrame(() => {
    if (document.activeElement !== document.body) return;
    if (!neighbour?.isConnected) return;
    if (!keyboard) armTooltipFocusSuppression();
    neighbour.focus(keyboard ? undefined : { preventScroll: true, focusVisible: false });
  });
}

/** Whether the element is showing a focus ring, i.e. the user is on the keyboard. */
function focusVisible(element: Element | null | undefined): boolean {
  try {
    return element?.matches(":focus-visible") ?? false;
  } catch {
    // jsdom and older engines do not know the selector; treat it as a pointer
    // close, which is what all but a handful of closes are.
    return false;
  }
}

/**
 * Whether the tool applies to this preview, re-asked as the preview moves. The
 * answer is remembered with the worktree it was about, so a preview switching
 * worktrees never shows a button the old answer earned.
 */
function useToolApplies(tool: DevPreviewTool, context: DevPreviewToolContext): boolean {
  const { panelId, projectId, worktreeId, worktreePath, url, isWebviewReady } = context;
  const isAvailable = tool.isAvailable;
  const [answer, setAnswer] = useState<{ worktreePath: string | null; ok: boolean } | null>(null);
  useEffect(() => {
    if (!isAvailable) return;
    let cancelled = false;
    // Called inside the chain, not before it: a predicate that throws
    // synchronously would otherwise take the toolbar down instead of hiding
    // its own tool. Either way the next context change asks again.
    void Promise.resolve()
      .then(() =>
        isAvailable({ panelId, projectId, worktreeId, worktreePath, url, isWebviewReady })
      )
      .catch(() => false)
      .then((ok) => {
        if (!cancelled) setAnswer({ worktreePath, ok });
      });
    return () => {
      cancelled = true;
    };
  }, [isAvailable, panelId, projectId, worktreeId, worktreePath, url, isWebviewReady]);
  if (!isAvailable) return true;
  return answer !== null && answer.ok && answer.worktreePath === worktreePath;
}

function DevPreviewToolButton({
  tool,
  context,
  active,
  onToggle,
}: {
  tool: DevPreviewTool;
  context: DevPreviewToolContext;
  active: boolean;
  onToggle: () => void;
}) {
  const applies = useToolApplies(tool, context);
  // An active tool stays reachable whatever the predicate says or hasn't said
  // yet: the one control that switches it off must not vanish under the user.
  if (!active && !applies) return null;
  return (
    // `contents` so the toggle keeps sitting in the toolbar's own flex row.
    <span className="contents" data-dev-preview-tool-toggle={surfaceTag(context.panelId, tool.id)}>
      {createElement(tool.Button, { ...context, active, onToggle })}
    </span>
  );
}

/** Toolbar toggles for every enabled tool that applies to this preview. */
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
          <DevPreviewToolButton
            tool={tool}
            context={context}
            active={activeId === tool.id}
            onToggle={() => toggle(props.panelId, tool.id)}
          />
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
  chrome,
}: {
  tool: DevPreviewTool;
  Surface: ComponentType<DevPreviewToolSurfaceProps>;
  role: string;
  handle: DevPreviewToolSessionHandle | null;
  context: DevPreviewToolContext;
  /** Wrap the tool's surface in the host's drawer chrome. */
  chrome?: boolean;
}) {
  const panelId = context.panelId;
  useEffect(() => retainDevPreviewToolVisibility(panelId), [panelId]);
  const setActive = useDevPreviewToolStore((s) => s.setActive);
  const tag = surfaceTag(panelId, tool.id);
  const close = useCallback(() => {
    returnFocusToToggle(tag);
    setActive(panelId, null);
  }, [panelId, tag, setActive]);
  const key = `${tool.id}:${handle?.key ?? 0}`;
  const surface = (
    <Suspense fallback={null}>
      {createElement(Surface, {
        ...context,
        session: handle?.session ?? null,
        onClose: close,
      })}
    </Suspense>
  );
  return (
    <ErrorBoundary
      key={key}
      resetKeys={[key]}
      variant="component"
      componentName={`${tool.label} ${role}`}
    >
      {chrome ? (
        <DevPreviewToolDrawerChrome surfaceTag={tag}>{surface}</DevPreviewToolDrawerChrome>
      ) : (
        // `contents` so the strip keeps its own place in the pane's column.
        <div data-dev-preview-tool-surface={tag} className="contents">
          {surface}
        </div>
      )}
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

/** The active tool's drawer beside the page, inside the host's drawer chrome. */
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
      chrome
    />
  );
}
