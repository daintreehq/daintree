import { PopoverContent } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { EmptyState } from "@/components/ui/EmptyState";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import type { BranchPickerRow } from "../branchPickerUtils";
import type { UseBranchPickerResult } from "../hooks/useBranchPicker";

interface BranchPickerPanelProps {
  controller: UseBranchPickerResult;
  /** The branch already committed to the field, marked with a check rather than a highlight. */
  selectedBranch: string | null;
  listId: string;
  optionIdPrefix: string;
  searchPlaceholder: string;
  searchAriaLabel: string;
  /** Copy for "there is nothing to pick", which differs per mode. */
  zeroDataTitle: string;
  /**
   * Base-branch mode marks the repo's checked-out branch; existing-branch mode
   * never does, because it only lists branches no worktree holds.
   */
  showCurrentBadge?: boolean;
}

/**
 * The one branch-picking surface. Both fields in the New Worktree dialog mount
 * this, so search behaviour, cursor semantics, row metadata, width and Escape
 * containment cannot drift apart again — which is exactly what happened while
 * each field carried its own copy of this markup (#11724).
 *
 * It owns `PopoverContent` itself, not just the contents, because the width and
 * `onEscapeKeyDown` contracts are part of what drifted.
 */
export function BranchPickerPanel({
  controller,
  selectedBranch,
  listId,
  optionIdPrefix,
  searchPlaceholder,
  searchAriaLabel,
  zeroDataTitle,
  showCurrentBadge = false,
}: BranchPickerPanelProps) {
  const {
    query,
    setQuery,
    activeIndex,
    setActiveIndex,
    inputRef,
    listRef,
    rows,
    selectableRows,
    totalCount,
    handleKeyDown,
    handleSelect,
  } = controller;

  const trimmedQuery = query.trim();
  const isTruncated = !trimmedQuery && selectableRows.length < totalCount;

  let optionIndex = 0;

  return (
    <PopoverContent
      // Matches the trigger instead of a hardcoded width, the way the sibling
      // NewBranchInput field already did.
      className="w-[var(--radix-popover-trigger-width)] p-0"
      align="start"
      // The popover portals out of the dialog's subtree; without this its own
      // Escape would also dismiss the dialog behind it.
      onEscapeKeyDown={(e) => e.stopPropagation()}
      onOpenAutoFocus={(e) => {
        // Cold mount: the lazy Radix chunk can land after the hook's rAF focus
        // attempt has already run, so claim focus here too.
        e.preventDefault();
        inputRef.current?.focus();
      }}
    >
      {/* Focus reads as the header rule brightening — a neutral `selection-outline`
          lift like the palette input's, not an accent box floating in the panel. */}
      <div className="flex items-center border-b border-daintree-border px-3 transition-colors focus-within:border-selection-outline">
        <Search className="mr-2 h-4 w-4 text-text-muted shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          className="flex h-10 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-text-placeholder disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-label={searchAriaLabel}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded
          aria-activedescendant={activeIndex >= 0 ? `${optionIdPrefix}${activeIndex}` : undefined}
        />
      </div>
      <ScrollShadow
        ref={listRef}
        id={listId}
        role="listbox"
        className="max-h-[300px]"
        scrollClassName="p-1"
      >
        {selectableRows.length === 0 ? (
          trimmedQuery ? (
            <EmptyState
              variant="filtered-empty"
              scale="popover"
              title={`No matches for "${trimmedQuery}"`}
              action={
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
                >
                  Clear search
                </button>
              }
            />
          ) : (
            <EmptyState variant="zero-data" scale="popover" title={zeroDataTitle} />
          )
        ) : (
          rows.map((row) => {
            if (row.kind === "section") {
              return (
                <div
                  key={`section-${row.label}`}
                  role="presentation"
                  className={cn(PALETTE_SECTION_LABEL_CLASS, "px-2 py-1.5")}
                >
                  {row.label}
                </div>
              );
            }
            const index = optionIndex++;
            return (
              <BranchPickerRowItem
                key={row.name}
                row={row}
                index={index}
                optionId={`${optionIdPrefix}${index}`}
                isCursor={index === activeIndex}
                isSelectedValue={row.name === selectedBranch}
                showCurrentBadge={showCurrentBadge}
                onActivate={() => setActiveIndex(index)}
                onSelect={() => handleSelect(row)}
              />
            );
          })
        )}
      </ScrollShadow>
      {isTruncated && (
        // Counted off the rows actually rendered rather than restating the cap,
        // so the footnote can't claim a number the list doesn't show. Search now
        // works from the first character, so "search to narrow" is sound advice.
        <div className="border-t border-daintree-border px-3 py-2 text-xs text-daintree-text/60">
          Showing {selectableRows.length} of {totalCount} branches — search to narrow
        </div>
      )}
    </PopoverContent>
  );
}

interface BranchPickerRowItemProps {
  row: BranchPickerRow & { kind: "option" };
  index: number;
  optionId: string;
  isCursor: boolean;
  isSelectedValue: boolean;
  showCurrentBadge: boolean;
  onActivate: () => void;
  onSelect: () => void;
}

function BranchPickerRowItem({
  row,
  index,
  optionId,
  isCursor,
  isSelectedValue,
  showCurrentBadge,
  onActivate,
  onSelect,
}: BranchPickerRowItemProps) {
  const lastCommit = row.committerDate ? formatTimeAgo(row.committerDate) : null;

  return (
    <div
      id={optionId}
      data-option-index={index}
      role="option"
      // The cursor, and only the cursor. PALETTE_ROW_CLASS keys its highlight off
      // this attribute, so the announcement and the highlight are one fact — and
      // the committed value below gets a check instead of a competing background.
      aria-selected={isCursor}
      aria-current={isSelectedValue ? "true" : undefined}
      // Pointer-move, not mouse-enter: it fires on movement within a row too, so
      // the cursor follows the pointer even when the list scrolls under a still
      // mouse. One state, so keyboard and pointer can never light different rows.
      onPointerMove={onActivate}
      onClick={onSelect}
      className={cn(
        PALETTE_ROW_CLASS,
        "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer"
      )}
    >
      {/* Name first and alone in its span: the dialog suite locates rows by the
          row's first span, and match ranges are indices into `name`. */}
      <span className="truncate font-mono">
        <HighlightedText text={row.name} indices={row.matchRanges} />
      </span>
      <span className="flex items-center gap-2 shrink-0 text-xs text-daintree-text/60">
        {showCurrentBadge && row.isCurrent && <span>current</span>}
        {row.isRemote && row.remoteName && <span>{row.remoteName}</span>}
        {lastCommit && <span>{lastCommit}</span>}
        {row.inUseWorktree && (
          <span
            className="text-status-warning"
            title={`In use by worktree: ${row.inUseWorktree.name}`}
          >
            in use
          </span>
        )}
        {isSelectedValue && (
          <>
            <Check className="h-4 w-4 text-daintree-text" aria-hidden="true" />
            <span className="sr-only">Currently selected</span>
          </>
        )}
      </span>
    </div>
  );
}
