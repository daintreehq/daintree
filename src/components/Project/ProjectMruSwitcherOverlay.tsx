import { memo } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import type { Project } from "@shared/types";

export interface ProjectMruSwitcherOverlayProps {
  isVisible: boolean;
  projects: Project[];
  selectedIndex: number;
}

const MAX_VISIBLE_ROWS = 9;

function ProjectMruSwitcherOverlayInner({
  isVisible,
  projects,
  selectedIndex,
}: ProjectMruSwitcherOverlayProps): React.ReactElement | null {
  if (!isVisible || projects.length < 2 || typeof document === "undefined") {
    return null;
  }

  const startIndex = Math.max(0, Math.min(selectedIndex - 1, projects.length - MAX_VISIBLE_ROWS));
  const visible = projects.slice(startIndex, startIndex + MAX_VISIBLE_ROWS);

  const content = (
    <div
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
      role="presentation"
      aria-hidden="true"
      tabIndex={-1}
    >
      <div
        className="pointer-events-none min-w-[320px] max-w-[420px] rounded-lg border border-palette-border bg-palette-bg/95 p-2 shadow-xl backdrop-blur-md"
        tabIndex={-1}
      >
        <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-palette-muted">
          Recent projects
        </div>
        <ul className="flex flex-col gap-0.5">
          {visible.map((project, index) => {
            const absoluteIndex = startIndex + index;
            const isSelected = absoluteIndex === selectedIndex;
            const isCurrent = absoluteIndex === 0;
            return (
              <li
                key={project.id}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1.5 text-sm",
                  isSelected
                    ? "bg-palette-accent/15 ring-1 ring-inset ring-palette-accent text-palette-fg"
                    : "text-palette-fg/80"
                )}
              >
                <span
                  className="flex h-6 w-6 items-center justify-center rounded text-sm"
                  style={{ background: getProjectGradient(project.color) }}
                >
                  {project.emoji || "🌲"}
                </span>
                <span className="flex-1 truncate">{project.name}</span>
                {isCurrent && (
                  <span className="text-[10px] uppercase tracking-wide text-palette-muted">
                    current
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

export const ProjectMruSwitcherOverlay = memo(ProjectMruSwitcherOverlayInner);
