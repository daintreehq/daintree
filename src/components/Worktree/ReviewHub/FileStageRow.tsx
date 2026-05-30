import { memo, useCallback } from "react";
import type React from "react";
import type { StagingFileEntry } from "@shared/types";
import type { GitStatus } from "@shared/types";
import { cn } from "@/lib/utils";
import { Plus, Minus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { isGeneratedFile } from "../generatedFileClassifier";

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

export type FileStageRowSection = "staged" | "unstaged";

interface FileStageRowProps {
  file: StagingFileEntry;
  section: FileStageRowSection;
  isStaged: boolean;
  isSelected: boolean;
  /** Keyboard-navigation focus (roving via `aria-activedescendant`). Distinct
   * from `isSelected` (multi-select) — both can be true at once. */
  isFocused?: boolean;
  /** DOM id, referenced by the parent listbox's `aria-activedescendant`. */
  id?: string;
  /** Flat index across both sections; used by the parent to scroll the row
   * into view via `[data-row-index]`. */
  rowIndex?: number;
  onToggle: (filePath: string) => void;
  onRowClick: (
    section: FileStageRowSection,
    filePath: string,
    status: GitStatus,
    e: React.MouseEvent
  ) => void;
  density?: "comfortable" | "compact";
  viewed?: boolean;
  onViewedChange?: (viewed: boolean) => void;
}

function splitPath(filePath: string): { dir: string; base: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", base: normalized };
  return { dir: normalized.slice(0, lastSlash), base: normalized.slice(lastSlash + 1) };
}

function FileStageRowComponent({
  file,
  section,
  isStaged,
  isSelected,
  isFocused = false,
  id,
  rowIndex,
  onToggle,
  onRowClick,
  density = "comfortable",
  viewed = false,
  onViewedChange,
}: FileStageRowProps) {
  const config = STATUS_CONFIG[file.status] || STATUS_CONFIG.untracked;
  const { dir, base } = splitPath(file.path);
  const generated = isGeneratedFile(file.path);
  const insertions = file.insertions ?? 0;
  const deletions = file.deletions ?? 0;
  const hasChurn = insertions > 0 || deletions > 0;

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle(file.path);
    },
    [onToggle, file.path]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      onRowClick(section, file.path, file.status, e);
    },
    [onRowClick, section, file.path, file.status]
  );

  const handleViewedChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onViewedChange?.(e.target.checked);
    },
    [onViewedChange]
  );

  const handleViewedClick = useCallback((e: React.MouseEvent) => {
    // Don't bubble into the row's onClick (which opens the diff modal).
    e.stopPropagation();
  }, []);

  return (
    <div
      id={id}
      role="option"
      data-row-index={rowIndex}
      onClick={handleClick}
      data-testid={`file-stage-row-${file.path}`}
      data-selected={isSelected || undefined}
      data-focused={isFocused || undefined}
      aria-selected={isSelected}
      className={cn(
        "relative group/stagerow flex items-center text-xs rounded px-1.5 transition-colors",
        density === "compact" ? "py-0.5" : "py-1.5",
        isStaged ? "bg-status-success/[0.06] hover:bg-status-success/[0.10]" : "hover:bg-tint/5",
        viewed && "opacity-60"
      )}
    >
      {isSelected && (
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded bg-overlay-subtle pointer-events-none"
        />
      )}
      {isFocused && (
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded ring-1 ring-inset ring-tint/30 pointer-events-none"
        />
      )}
      <TruncatedTooltip content={file.path}>
        <button
          type="button"
          onClick={handleClick}
          aria-label={`View diff: ${file.path}`}
          className={cn(
            "relative flex min-w-0 flex-1 items-baseline rounded text-left",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
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
            <span
              data-testid="file-stage-row-dir"
              className={cn(
                "shrink truncate font-mono text-[11px] transition-colors",
                generated
                  ? "text-daintree-text/30"
                  : "text-daintree-text/50 group-hover/stagerow:text-daintree-text/70"
              )}
            >
              {dir}/
            </span>
          )}
          <span
            data-testid="file-stage-row-base"
            className={cn(
              "shrink truncate font-medium font-mono text-[11px] transition-colors",
              generated
                ? "text-daintree-text/40"
                : "text-daintree-text group-hover/stagerow:text-daintree-text"
            )}
          >
            {base}
          </span>
        </button>
      </TruncatedTooltip>

      {hasChurn && (
        <div
          data-testid="file-stage-row-churn"
          className={cn(
            "ml-2 flex items-center gap-1 shrink-0 text-[10px] tabular-nums",
            generated && "opacity-60"
          )}
        >
          {insertions > 0 && <span className="text-status-success/80">+{insertions}</span>}
          {deletions > 0 && <span className="text-status-error/80">-{deletions}</span>}
        </div>
      )}

      {onViewedChange && (
        <Tooltip>
          <TooltipTrigger asChild>
            <label
              onClick={handleViewedClick}
              className={cn(
                "flex items-center gap-1 ml-2 shrink-0 cursor-pointer select-none rounded px-1.5 py-0.5",
                "text-[10px] font-medium uppercase tracking-wider transition-colors",
                viewed
                  ? "text-daintree-text/60"
                  : "text-daintree-text/30 hover:text-daintree-text/60"
              )}
            >
              <input
                type="checkbox"
                checked={viewed}
                onChange={handleViewedChange}
                aria-label={
                  viewed ? `Mark ${file.path} as not viewed` : `Mark ${file.path} as viewed`
                }
                className={cn(
                  "w-3 h-3 rounded cursor-pointer accent-status-success",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                )}
              />
              <span>Viewed</span>
            </label>
          </TooltipTrigger>
          <TooltipContent side="left">
            {viewed ? "Mark as not viewed" : "Mark as viewed"}
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleToggle}
            className={cn(
              "w-5 h-5 flex items-center justify-center rounded shrink-0 ml-2 transition-colors",
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
        <TooltipContent side="left">{isStaged ? "Unstage" : "Stage"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export const FileStageRow = memo(FileStageRowComponent);
