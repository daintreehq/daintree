import type React from "react";
import type { Dispatch, Ref, RefObject, SetStateAction } from "react";
import type { GitStatus, StagingFileEntry } from "@shared/types";
import {
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Search,
  Square,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileStageRow, type FileStageRowSection } from "./FileStageRow";
import { isGeneratedFile } from "../generatedFileClassifier";
import {
  type ChurnTotals,
  type SectionViewState,
  applySortChange,
  isDensity,
  truncateFilterQuery,
} from "./reviewHubUtils";

interface FileSectionProps {
  /** Drives every staged/unstaged copy, testid, and toggle-verb choice below. */
  isStaged: boolean;
  files: StagingFileEntry[];
  /** Unfiltered section source — only used for the "only generated files" empty-state check. */
  allFiles: StagingFileEntry[];
  churn: ChurnTotals;
  /** Row index offset into the shared staged+unstaged flat keyboard-nav list; 0 for staged. */
  indexOffset: number;
  focusedIndex: number;
  selectionSection: FileStageRowSection | null;
  selectedPaths: Set<string>;
  hasSelection: boolean;
  view: SectionViewState;
  setView: Dispatch<SetStateAction<SectionViewState>>;
  inputRef: RefObject<HTMLInputElement | null>;
  setFilterQuery: (q: string) => void;
  clearFilter: () => void;
  onToggle: (filePath: string) => void;
  onRowClick: (
    section: FileStageRowSection,
    filePath: string,
    status: GitStatus,
    e: React.MouseEvent
  ) => void;
  onBulkAction: () => void;
  viewedFiles: ReadonlySet<string>;
  onViewedChange: (viewedKey: string, viewed: boolean) => void;
  sectionRef?: Ref<HTMLDivElement>;
}

export function FileSection({
  isStaged,
  files,
  allFiles,
  churn,
  indexOffset,
  focusedIndex,
  selectionSection,
  selectedPaths,
  hasSelection,
  view,
  setView,
  inputRef,
  setFilterQuery,
  clearFilter,
  onToggle,
  onRowClick,
  onBulkAction,
  viewedFiles,
  onViewedChange,
  sectionRef,
}: FileSectionProps) {
  const section: FileStageRowSection = isStaged ? "staged" : "unstaged";
  const title = isStaged ? "Staged" : "Changes";
  const countTestId = isStaged ? "staged-section-count-chip" : "changes-section-count-chip";
  const bulkActionTestId = isStaged
    ? "review-hub-unstage-section-button"
    : "review-hub-stage-section-button";
  const bulkActionVerb = isStaged ? "Unstage" : "Stage";
  const BulkActionIcon = isStaged ? Square : CheckSquare;
  const emptyNothingTitle = isStaged ? "Nothing staged" : "All changes staged";
  const emptyGeneratedTitle = isStaged
    ? "Only generated files staged"
    : "Only generated files changed";
  const emptyFilteredNoun = isStaged ? "staged files" : "changed files";

  return (
    <div ref={sectionRef} className={cn(isStaged && "border-b border-divider")}>
      <div className="flex items-center justify-between px-4 py-2 bg-overlay-subtle gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60 shrink-0">
          {title}
          <span
            data-testid={countTestId}
            className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal inline-flex items-center gap-1"
          >
            <span>
              {files.length} file{files.length !== 1 ? "s" : ""}
            </span>
            {(churn.ins > 0 || churn.del > 0) && (
              <>
                <span aria-hidden="true" className="text-daintree-text/30">
                  ·
                </span>
                {churn.ins > 0 && <span className="text-status-success/80">{`+${churn.ins}`}</span>}
                {churn.del > 0 && <span className="text-status-error/80">{`-${churn.del}`}</span>}
              </>
            )}
          </span>
        </span>
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="relative flex items-center">
            <Search className="absolute left-1.5 w-3 h-3 text-daintree-text/30 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Filter…"
              defaultValue={view.filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className={cn(
                "w-[120px] h-5 pl-6 pr-1.5 rounded text-[11px]",
                "bg-tint/[0.04] border border-tint/[0.08]",
                "text-daintree-text placeholder:text-text-placeholder",
                "focus:outline-hidden focus:border-daintree-accent/40",
                "hover:bg-tint/[0.06] transition-colors"
              )}
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "p-1 rounded transition-colors",
                  "text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06]",
                  "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent"
                )}
                aria-label="View options"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={view.sortKey}
                onValueChange={(v) => setView((prev) => applySortChange(prev, v))}
              >
                <DropdownMenuRadioItem value="path">
                  <span className="flex items-center gap-2 flex-1">
                    Path
                    {view.sortKey === "path" &&
                      (view.sortDir === "asc" ? (
                        <ChevronUp className="w-3 h-3 ml-auto text-daintree-text/40" />
                      ) : (
                        <ChevronDown className="w-3 h-3 ml-auto text-daintree-text/40" />
                      ))}
                  </span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="status">
                  <span className="flex items-center gap-2 flex-1">
                    Status
                    {view.sortKey === "status" &&
                      (view.sortDir === "asc" ? (
                        <ChevronUp className="w-3 h-3 ml-auto text-daintree-text/40" />
                      ) : (
                        <ChevronDown className="w-3 h-3 ml-auto text-daintree-text/40" />
                      ))}
                  </span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="churn">
                  <span className="flex items-center gap-2 flex-1">
                    Churn
                    {view.sortKey === "churn" &&
                      (view.sortDir === "asc" ? (
                        <ChevronUp className="w-3 h-3 ml-auto text-daintree-text/40" />
                      ) : (
                        <ChevronDown className="w-3 h-3 ml-auto text-daintree-text/40" />
                      ))}
                  </span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>View</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={view.density}
                onValueChange={(v) =>
                  setView((prev) => ({
                    ...prev,
                    density: isDensity(v) ? v : prev.density,
                  }))
                }
              >
                <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={view.showGenerated}
                onCheckedChange={(checked) =>
                  setView((prev) => ({ ...prev, showGenerated: !!checked }))
                }
              >
                Show generated files
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {files.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBulkAction}
              className="h-5 px-1.5 text-[10px] shrink-0"
              data-testid={bulkActionTestId}
            >
              <BulkActionIcon className="w-3 h-3 mr-1" />
              {hasSelection
                ? `${bulkActionVerb} selection (${selectedPaths.size})`
                : view.filterQuery
                  ? `${bulkActionVerb} shown (${files.length})`
                  : `${bulkActionVerb} all (${files.length})`}
            </Button>
          )}
        </div>
      </div>
      {files.length > 0 ? (
        <div
          className={cn(
            "px-2 py-1 flex flex-col",
            view.density === "compact" ? "gap-0" : "gap-0.5"
          )}
        >
          {files.map((file, i) => {
            const viewedKey = `${section}:${file.path}`;
            const rowIndex = indexOffset + i;
            return (
              <FileStageRow
                key={`${section}-${file.path}`}
                id={`review-hub-row-${rowIndex}`}
                rowIndex={rowIndex}
                isFocused={focusedIndex === rowIndex}
                file={file}
                section={section}
                isStaged={isStaged}
                isSelected={selectionSection === section && selectedPaths.has(file.path)}
                onToggle={onToggle}
                onRowClick={onRowClick}
                density={view.density}
                viewed={viewedFiles.has(viewedKey)}
                onViewedChange={(v) => onViewedChange(viewedKey, v)}
              />
            );
          })}
        </div>
      ) : view.filterQuery ? (
        <EmptyState
          variant="filtered-empty"
          scale="sidebar"
          title={`No ${emptyFilteredNoun} matching "${truncateFilterQuery(view.filterQuery)}"`}
          action={
            <button
              type="button"
              onClick={clearFilter}
              className="text-xs text-daintree-text/60 hover:text-daintree-text transition-colors underline underline-offset-2"
            >
              Clear filter
            </button>
          }
        />
      ) : !view.showGenerated && allFiles.some((f) => isGeneratedFile(f.path)) ? (
        <EmptyState
          variant="filtered-empty"
          scale="sidebar"
          title={emptyGeneratedTitle}
          action={
            <button
              type="button"
              onClick={() => setView((prev) => ({ ...prev, showGenerated: true }))}
              className="text-xs text-daintree-text/60 hover:text-daintree-text transition-colors underline underline-offset-2"
            >
              Show generated files
            </button>
          }
        />
      ) : (
        <EmptyState variant="user-cleared" scale="sidebar" title={emptyNothingTitle} />
      )}
    </div>
  );
}
