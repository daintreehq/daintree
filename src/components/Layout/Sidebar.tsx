import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ProjectSwitcher,
  ProjectSettingsDialog,
  ProjectResourceBadge,
  QuickRun,
} from "@/components/Project";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useNativeContextMenu } from "@/hooks";
import type { MenuItemOption } from "@/types";
import { systemClient } from "@/clients/systemClient";
import { DEFAULT_SIDEBAR_WIDTH } from "./AppLayout";

interface SidebarProps {
  width: number;
  onResize: (width: number) => void;
  children?: ReactNode;
  className?: string;
}

const RESIZE_STEP = 10;

export function Sidebar({ width, onResize, children, className }: SidebarProps) {
  const { showMenu } = useNativeContextMenu();
  const [isResizing, setIsResizing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const currentProject = useProjectStore((state) => state.currentProject);
  const openCreateWorktreeDialog = useWorktreeSelectionStore((state) => state.openCreateDialog);
  const { refresh: refreshWorktrees } = useWorktrees();

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

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[role='separator']")) return;

      const template: MenuItemOption[] = [
        { id: "worktree:new", label: "New Worktree..." },
        { id: "worktree:refresh", label: "Refresh Worktrees" },
        { type: "separator" },
        { id: "project:reveal", label: "Reveal Project in Finder", enabled: !!currentProject },
        { id: "project:settings", label: "Project Settings...", enabled: !!currentProject },
        { type: "separator" },
        { id: "sidebar:reset-width", label: "Reset Sidebar Width" },
        { id: "settings:worktree", label: "Worktree Settings..." },
      ];

      const actionId = await showMenu(event, template);
      if (!actionId) return;

      switch (actionId) {
        case "worktree:new":
          openCreateWorktreeDialog();
          break;
        case "worktree:refresh":
          void refreshWorktrees();
          break;
        case "project:reveal":
          if (currentProject) {
            void systemClient.openPath(currentProject.path);
          }
          break;
        case "project:settings":
          setIsSettingsOpen(true);
          break;
        case "sidebar:reset-width":
          handleResetWidth();
          break;
        case "settings:worktree":
          window.dispatchEvent(new CustomEvent("canopy:open-settings-tab", { detail: "worktree" }));
          break;
      }
    },
    [currentProject, handleResetWidth, openCreateWorktreeDialog, refreshWorktrees, showMenu]
  );

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
    <>
      <aside
        ref={sidebarRef}
        className={cn(
          "relative border-r border-canopy-border bg-canopy-sidebar shrink-0 flex flex-col",
          className
        )}
        style={{ width }}
        onContextMenu={handleContextMenu}
      >
        <div className="shrink-0 border-b border-canopy-border">
          <div className="flex items-center">
            <div className="flex-1">
              <ProjectSwitcher />
            </div>
            {currentProject && (
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 mr-1 text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-border/50 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                title="Project Settings"
              >
                <Settings className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">{children}</div>

        <ProjectResourceBadge />

        {currentProject && <QuickRun projectId={currentProject.id} />}

        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={200}
          aria-valuemax={600}
          tabIndex={0}
          className={cn(
            "group absolute top-0 -right-0.5 w-1.5 h-full cursor-col-resize flex items-center justify-center z-50",
            "hover:bg-white/[0.03] transition-colors focus-visible:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-canopy-accent/50",
            isResizing && "bg-canopy-accent/20"
          )}
          onMouseDown={startResizing}
          onKeyDown={handleKeyDown}
          onDoubleClick={handleResetWidth}
        >
          <div
            className={cn(
              "w-px h-8 rounded-full transition-colors",
              "bg-canopy-text/20",
              "group-hover:bg-canopy-text/35 group-focus-visible:bg-canopy-accent",
              isResizing && "bg-canopy-accent"
            )}
          />
        </div>
      </aside>

      {/* Project Settings Dialog - Only mount when open to avoid duplicate hook calls */}
      {currentProject && isSettingsOpen && (
        <ProjectSettingsDialog
          projectId={currentProject.id}
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </>
  );
}
