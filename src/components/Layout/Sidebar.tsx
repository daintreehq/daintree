import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ProjectResourceBadge, QuickRun } from "@/components/Project";
import { useProjectStore } from "@/store/projectStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { DEFAULT_SIDEBAR_WIDTH } from "./AppLayout";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  FolderOpen,
  GitBranchPlus,
  RefreshCw,
  Ruler,
  Settings,
  SlidersHorizontal,
} from "lucide-react";

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
  const currentProject = useProjectStore((state) => state.currentProject);
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

  // If the sidebar unmounts mid-drag (e.g. `currentProject` becomes null
  // because the user switched or closed the project), the listener-attaching
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onResize(width - RESIZE_STEP);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onResize(width + RESIZE_STEP);
      }
    },
    [width, onResize]
  );

  const handleResetWidth = useCallback(() => {
    onResize(DEFAULT_SIDEBAR_WIDTH);
  }, [onResize]);

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
            "relative w-full h-full flex flex-col outline-hidden overflow-hidden",
            "surface-chrome",
            "border-r border-divider",
            "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
            className
          )}
        >
          <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

          {currentProject && <QuickRun projectId={currentProject.id} />}

          <ProjectResourceBadge />

          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuenow={width}
            aria-valuemin={200}
            aria-valuemax={600}
            tabIndex={isVisible ? 0 : -1}
            aria-hidden={!isVisible ? "true" : undefined}
            className={cn(
              "group absolute top-0 -right-1.5 w-3 h-full cursor-col-resize flex items-center justify-center z-50",
              "hover:bg-overlay-soft transition-colors focus-visible:outline-hidden focus-visible:bg-overlay-medium focus-visible:ring-1 focus-visible:ring-daintree-accent/50",
              isResizing && "bg-overlay-medium"
            )}
            onMouseDown={startResizing}
            onKeyDown={handleKeyDown}
            onDoubleClick={handleResetWidth}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <div
              className={cn(
                "w-px h-8 rounded-full transition-[width] duration-150 delay-100 group-hover:w-0.5",
                "bg-daintree-text/20",
                "group-hover:bg-daintree-text/35 group-focus-visible:bg-daintree-accent",
                isResizing && "bg-daintree-text/50"
              )}
            />
          </div>
        </aside>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuActionItem actionId="worktree.createDialog.open">
          <GitBranchPlus className={ICON_CLASS} />
          New Worktree...
        </ContextMenuActionItem>
        <ContextMenuActionItem actionId="worktree.refresh">
          <RefreshCw className={ICON_CLASS} />
          Refresh Sidebar
        </ContextMenuActionItem>
        <ContextMenuSeparator />
        <ContextMenuActionItem
          actionId="system.openPath"
          args={currentProject ? { path: currentProject.path } : undefined}
          disabled={!currentProject}
        >
          <FolderOpen className={ICON_CLASS} />
          Reveal Project in Finder
        </ContextMenuActionItem>
        <ContextMenuActionItem actionId="project.settings.open" disabled={!currentProject}>
          <Settings className={ICON_CLASS} />
          Project Settings...
        </ContextMenuActionItem>
        <ContextMenuSeparator />
        <ContextMenuActionItem actionId="ui.sidebar.resetWidth">
          <Ruler className={ICON_CLASS} />
          Reset Sidebar Width
        </ContextMenuActionItem>
        <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "worktree" }}>
          <SlidersHorizontal className={ICON_CLASS} />
          Worktree Settings...
        </ContextMenuActionItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
