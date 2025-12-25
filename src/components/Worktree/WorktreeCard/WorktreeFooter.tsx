import type React from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../../ui/tooltip";
import { Check, Copy, Folder } from "lucide-react";

export interface WorktreeFooterProps {
  worktreePath: string;
  displayPath: string;
  pathCopied: boolean;
  onCopyPath: (e: React.MouseEvent) => void | Promise<void>;
  onOpenPath: () => void;
}

export function WorktreeFooter({
  worktreePath,
  displayPath,
  pathCopied,
  onCopyPath,
  onOpenPath,
}: WorktreeFooterProps) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenPath();
        }}
        className={cn(
          "flex items-center gap-1.5 text-xs text-canopy-text/40 hover:text-canopy-text/60 font-mono truncate min-w-0 flex-1 text-left rounded px-1 -mx-1",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
        )}
        title={`Open folder: ${worktreePath}`}
      >
        <Folder className="w-3 h-3 shrink-0 opacity-60" />
        <span className="truncate">{displayPath}</span>
      </button>

      <TooltipProvider>
        <Tooltip open={pathCopied ? true : undefined} delayDuration={0}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCopyPath}
              className={cn(
                "shrink-0 p-1 rounded transition-colors",
                pathCopied
                  ? "text-green-400 bg-green-400/10"
                  : "text-canopy-text/40 hover:text-canopy-text/60 hover:bg-white/5",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              )}
              title={pathCopied ? "Copied!" : "Copy full path"}
              aria-label={pathCopied ? "Path copied" : "Copy path to clipboard"}
            >
              {pathCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <span role="status" aria-live="polite">
              {pathCopied ? "Copied!" : "Copy path"}
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
