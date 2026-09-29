import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SidebarFooter } from "./SidebarFooter";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { useWorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "./AppLayout";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FolderGit2, FolderOpen, GitBranchPlus, RefreshCw, Ruler, Settings } from "lucide-react";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";

interface SidebarProps {
  width: number;
  onResize: (width: number) => void;
  /**
   * Fires at the start of a pointer drag-resize so the parent can suppress
   * its `transition-[width]` while the user drags. Issue #7627.
   */
  onResizeStart?: () => void;
  /**
   * Fires at the end of a pointer drag-resize. Restores the parent transition
   * for non-drag width changes (collapse/expand toggle, double-click reset).
   */
  onResizeEnd?: () => void;
  isVisible?: boolean;
  children?: ReactNode;
  className?: string;
}

const RESIZE_STEP = 10;
const RESIZE_STEP_LARGE = 50;

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

export function Sidebar({
  width,
  onResize,
  onResizeStart,
  onResizeEnd,
  isVisible = true,
  children,
  className,
}: SidebarProps) {
  const [isResizing, setIsResizing] = useState(false);
  // Mirrors `isResizing` synchronously so the unmount-only effect below can
  // detect a mid-drag teardown without relying on stale closure state.
  const isResizingRef = useRef(false);
  const sidebarRef = useRef<HTMLElement>(null);
  // The sidebar now mounts in every workspace kind (#11499), so the background
  // menu has to stop offering worktree-shaped commands to workspaces that have
  // no worktrees. Absent rather than disabled, matching the rows themselves: a
  // greyed-out "New worktree…" in a scratch is the same dead-control lie in a
  // quieter font.
  //
  // Every entry keys off the view's own workspace, never the globally broadcast
  // `currentProject`: a sibling window switching projects repoints that in every
  // view, so a scratch view would label its reveal "Project" and offer project
  // settings that dispatch against the other window's project.
  const workspaceRoot = useWorkspaceRoot();
  const isGitBackedWorkspace = workspaceRoot?.isGitBacked ?? false;
  // A folder opened without git is still a project — it has real settings and a
  // name. A scratch is not, so nothing project-shaped applies to it.
  const projectId = workspaceRoot?.kind === "project" ? workspaceRoot.id : null;
  const revealPath = workspaceRoot?.path;
  const isMacroFocused = useMacroFocusStore((state) => state.focusedRegion === "sidebar");
  useEffect(() => {
    useMacroFocusStore.getState().setRegionRef("sidebar", sidebarRef.current);
    return () => useMacroFocusStore.getState().setRegionRef("sidebar", null);
  }, []);

  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      onResizeStart?.();
      setIsResizing(true);
    },
    [onResizeStart]
  );

  const stopResizing = useCallback(() => {
    isResizingRef.current = false;
    setIsResizing(false);
    onResizeEnd?.();
  }, [onResizeEnd]);

  // If the sidebar unmounts mid-drag (e.g. the view loses its workspace because
  // the user closed the project or scratch), the listener-attaching
  // effect below tears down its document listeners but stopResizing never
  // fires — leaving AppLayout's `isSidebarResizing` flag stuck true and
  // silently disabling the collapse/expand animation for the rest of the
  // session. Surface onResizeEnd here so the parent transition is restored.
  // The prop is mirrored through a ref so this unmount-only effect's deps
  // can stay empty without disabling exhaustive-deps.
  const onResizeEndRef = useRef(onResizeEnd);
  useEffect(() => {
    onResizeEndRef.current = onResizeEnd;
  });
  useEffect(() => {
    return () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        onResizeEndRef.current?.();
      }
    };
  }, []);

  const handleResetWidth = useCallback(() => {
    onResize(DEFAULT_SIDEBAR_WIDTH);
  }, [onResize]);

  const handleKeyDown = useSplitterKeys({
    growKey: "ArrowRight",
    value: width,
    min: MIN_SIDEBAR_WIDTH,
    max: MAX_SIDEBAR_WIDTH,
    step: RESIZE_STEP,
    largeStep: RESIZE_STEP_LARGE,
    onChange: onResize,
    onReset: handleResetWidth,
  });

  const resize = useCallback(
    (e: MouseEvent) => {
      if (isResizing && sidebarRef.current) {
        const newWidth = e.clientX - sidebarRef.current.getBoundingClientRect().left;
        onResize(newWidth);
      }
    },
    [isResizing, onResize]
  );

  useEffect(() => {
    if (isResizing) {
      document.addEventListener("mousemove", resize);
      document.addEventListener("mouseup", stopResizing);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", resize);
      document.removeEventListener("mouseup", stopResizing);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, resize, stopResizing]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <aside
          ref={sidebarRef}
          role="region"
          tabIndex={-1}
          aria-label="Sidebar"
          aria-hidden={!isVisible}
          // `inert` removes descendant buttons from the focus / a11y tree while
          // the sidebar is slid out — `aria-hidden` alone leaves them
          // focusable, which axe flags as `aria-hidden-focus` (WCAG 2.2 AA).
          inert={!isVisible || undefined}
          data-macro-focus={isMacroFocused ? "true" : undefined}
          className={cn(
            "sidebar-root",
            // Clip, not hidden: the resize handle straddles the right edge, and a
            // clip margin lets its outer half through to the wrapper's own 6px
            // margin (#9864) instead of halving the 12px target.
            "relative w-full h-full flex flex-col outline-hidden overflow-clip [overflow-clip-margin:6px]",
            "surface-chrome",
            "border-r border-divider",
            "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset",
            className
          )}
        >
          <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

          <SidebarFooter projectId={projectId} />

          <ResizeHandle
            growKey="ArrowRight"
            edge="right"
            label="Resize sidebar"
            value={width}
            min={MIN_SIDEBAR_WIDTH}
            max={MAX_SIDEBAR_WIDTH}
            isResizing={isResizing}
            tabIndex={isVisible ? 0 : -1}
            aria-hidden={!isVisible ? "true" : undefined}
            className="z-50"
            onMouseDown={startResizing}
            onKeyDown={handleKeyDown}
            onReset={handleResetWidth}
            onContextMenu={(e) => e.stopPropagation()}
          />
        </aside>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {isGitBackedWorkspace && (
          <>
            <ContextMenuActionItem actionId="worktree.createDialog.open">
              <GitBranchPlus className={ICON_CLASS} />
              New worktree…
            </ContextMenuActionItem>
            <ContextMenuActionItem actionId="worktree.refresh">
              <RefreshCw className={ICON_CLASS} />
              Refresh sidebar
            </ContextMenuActionItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuActionItem
          actionId="system.openPath"
          args={revealPath ? { path: revealPath } : undefined}
          disabled={!revealPath}
        >
          <FolderOpen className={ICON_CLASS} />
          {projectId != null ? "Reveal project in Finder" : "Reveal workspace in Finder"}
        </ContextMenuActionItem>
        {projectId != null && (
          <ContextMenuActionItem actionId="project.settings.open">
            <Settings className={ICON_CLASS} />
            Project settings…
          </ContextMenuActionItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuActionItem actionId="ui.sidebar.resetWidth">
          <Ruler className={ICON_CLASS} />
          Reset sidebar width
        </ContextMenuActionItem>
        {isGitBackedWorkspace && (
          <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "worktree" }}>
            <FolderGit2 className={ICON_CLASS} />
            Worktree settings…
          </ContextMenuActionItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
