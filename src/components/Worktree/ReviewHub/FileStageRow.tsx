import { useCallback } from "react";
import type React from "react";
import type { StagingFileEntry } from "@shared/types";
import type { GitStatus } from "@shared/types";
import { cn } from "@/lib/utils";
import { Plus, Minus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

const STATUS_CONFIG: Record<GitStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "text-[var(--color-status-warning)]" },
  added: { label: "A", color: "text-[var(--color-status-success)]" },
  deleted: { label: "D", color: "text-[var(--color-status-error)]" },
  untracked: { label: "?", color: "text-[var(--color-status-success)]" },
  renamed: { label: "R", color: "text-[var(--color-status-info)]" },
  copied: { label: "C", color: "text-[var(--color-status-info)]" },
  ignored: { label: "I", color: "text-canopy-text/40" },
  conflicted: { label: "!", color: "text-[var(--color-status-error)]" },
};

interface FileStageRowProps {
  file: StagingFileEntry;
  isStaged: boolean;
  onToggle: (filePath: string) => void;
  onFileClick: (filePath: string, status: GitStatus) => void;
}

function splitPath(filePath: string): { dir: string; base: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", base: normalized };
  return { dir: normalized.slice(0, lastSlash), base: normalized.slice(lastSlash + 1) };
}

export function FileStageRow({ file, isStaged, onToggle, onFileClick }: FileStageRowProps) {
  const config = STATUS_CONFIG[file.status] || STATUS_CONFIG.untracked;
  const { dir, base } = splitPath(file.path);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle(file.path);
    },
    [onToggle, file.path]
  );

  const handleClick = useCallback(() => {
    onFileClick(file.path, file.status);
  }, [onFileClick, file.path, file.status]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onFileClick(file.path, file.status);
      }
    },
    [onFileClick, file.path, file.status]
  );

  return (
    <div
      role="button"
      tabIndex={0}
      className="group flex items-center text-xs font-mono hover:bg-white/5 rounded px-1.5 py-0.5 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleToggle}
              className={cn(
                "w-5 h-5 flex items-center justify-center rounded shrink-0 mr-1 transition-colors",
                "hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              )}
              aria-label={isStaged ? `Unstage ${file.path}` : `Stage ${file.path}`}
            >
              {isStaged ? (
                <Minus className="w-3 h-3 text-[var(--color-status-error)]" />
              ) : (
                <Plus className="w-3 h-3 text-[var(--color-status-success)]" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{isStaged ? "Unstage" : "Stage"}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <span className={cn("w-4 font-bold shrink-0", config.color)}>{config.label}</span>

      <div className="flex-1 min-w-0 flex items-center mr-2">
        {dir && (
          <span className="truncate min-w-0 text-canopy-text/60 opacity-60 group-hover:opacity-80">
            {dir}/
          </span>
        )}
        <span className="text-canopy-text group-hover:text-white font-medium truncate min-w-0">
          {base}
        </span>
      </div>
    </div>
  );
}
