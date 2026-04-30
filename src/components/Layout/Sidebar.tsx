import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ProjectResourceBadge, QuickRun } from "@/components/Project";
import { useProjectStore } from "@/store/projectStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { usePreferencesStore } from "@/store";
import { DEFAULT_SIDEBAR_WIDTH } from "./AppLayout";
import { actionService } from "@/services/ActionService";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
  children?: ReactNode;
  className?: string;
}

const RESIZE_STEP = 10;

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

export function Sidebar({ width, onResize, children, className }: SidebarProps) {
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const currentProject = useProjectStore((state) => state.currentProject);
  const isMacroFocused = useMacroFocusStore((state) => state.focusedRegion === "sidebar");
  const reduceAnimations = usePreferencesStore((s) => s.reduceAnimations);
  const animateWidth = !isResizing && !reduceAnimations;

  useEffect(() => {
    useMacroFocusStore.getState().setRegionRef("sidebar", sidebarRef.current);
    return () => useMacroFocusStore.getState().setRegionRef("sidebar", null);
  }, []);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
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
          data-macro-focus={isMacroFocused ? "true" : undefined}
          className={cn(
            "sidebar-root",
            "relative shrink-0 flex flex-col outline-hidden overflow-hidden",
            "surface-chrome",
            "border-r border-divider",
            "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
            animateWidth &&
              "transition-[width] duration-[var(--duration-250)] ease-[var(--ease-out-expo)] motion-reduce:transition-none",
            width === 0 && "pointer-events-none",
            className
          )}
          style={{ width }}
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
            tabIndex={width === 0 ? -1 : 0}
            aria-hidden={width === 0 ? "true" : undefined}
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
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch("worktree.createDialog.open", undefined, {
              source: "context-menu",
            })
          }
        >
          <GitBranchPlus className={ICON_CLASS} />
          New Worktree...
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch("worktree.refresh", undefined, { source: "context-menu" })
          }
        >
          <RefreshCw className={ICON_CLASS} />
          Refresh Sidebar
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!currentProject}
          onSelect={() => {
            if (currentProject) {
              void actionService.dispatch(
                "system.openPath",
                { path: currentProject.path },
                { source: "context-menu" }
              );
            }
          }}
        >
          <FolderOpen className={ICON_CLASS} />
          Reveal Project in Finder
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!currentProject}
          onSelect={() =>
            void actionService.dispatch("project.settings.open", undefined, {
              source: "context-menu",
            })
          }
        >
          <Settings className={ICON_CLASS} />
          Project Settings...
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch("ui.sidebar.resetWidth", undefined, {
              source: "context-menu",
            })
          }
        >
          <Ruler className={ICON_CLASS} />
          Reset Sidebar Width
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "worktree" },
              { source: "context-menu" }
            )
          }
        >
          <SlidersHorizontal className={ICON_CLASS} />
          Worktree Settings...
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
