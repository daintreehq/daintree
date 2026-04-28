import { useCallback } from "react";
import type React from "react";
import type { StagingFileEntry } from "@shared/types";
import type { GitStatus } from "@shared/types";
import { cn } from "@/lib/utils";
import { Plus, Minus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

const STATUS_CONFIG: Record<GitStatus, { label: string; bg: string; text: string }> = {
  modified: {
    label: "M",
    bg: "bg-status-warning/15",
    text: "text-status-warning",
  },
  added: {
    label: "A",
    bg: "bg-status-success/15",
    text: "text-status-success",
  },
  deleted: {
    label: "D",
    bg: "bg-status-error/15",
    text: "text-status-error",
  },
  untracked: {
    label: "?",
    bg: "bg-status-success/15",
    text: "text-status-success",
  },
  renamed: {
    label: "R",
    bg: "bg-status-info/15",
    text: "text-status-info",
  },
  copied: {
    label: "C",
    bg: "bg-status-info/15",
    text: "text-status-info",
  },
  ignored: {
    label: "I",
    bg: "bg-tint/[0.06]",
    text: "text-daintree-text/40",
  },
  conflicted: {
    label: "!",
    bg: "bg-status-error/15",
    text: "text-status-error",
  },
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

  return (
    <div
      onClick={handleClick}
      className={cn(
        "group/stagerow flex items-center text-xs rounded px-1.5 py-1.5 transition-colors",
        isStaged ? "bg-status-success/[0.06] hover:bg-status-success/[0.10]" : "hover:bg-tint/5"
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleToggle}
            className={cn(
              "w-5 h-5 flex items-center justify-center rounded shrink-0 mr-2 transition-colors",
              "hover:bg-tint/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
            )}
            aria-label={isStaged ? `Unstage ${file.path}` : `Stage ${file.path}`}
          >
            {isStaged ? (
              <Minus className="w-3 h-3 text-status-error" />
            ) : (
              <Plus className="w-3 h-3 text-status-success" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{isStaged ? "Unstage" : "Stage"}</TooltipContent>
      </Tooltip>

      <TruncatedTooltip content={file.path}>
        <button
          type="button"
          aria-label={`View diff: ${file.path}`}
          className={cn(
            "flex min-w-0 flex-1 items-baseline rounded text-left",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daintree-accent"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex items-center justify-center rounded-sm px-1 mr-2 shrink-0",
              "text-[10px] font-medium leading-4 h-4 min-w-[16px]",
              config.bg,
              config.text
            )}
          >
            {config.label}
          </span>
          {dir && (
            <span className="shrink truncate text-daintree-text/50 group-hover/stagerow:text-daintree-text/70 font-mono text-[11px] transition-colors">
              {dir}/
            </span>
          )}
          <span className="shrink truncate text-daintree-text group-hover/stagerow:text-daintree-text font-medium font-mono text-[11px] transition-colors">
            {base}
          </span>
        </button>
      </TruncatedTooltip>
    </div>
  );
}
