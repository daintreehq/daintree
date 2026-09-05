import type React from "react";
import { useCallback, useEffect, useMemo } from "react";
import type { Dispatch, Ref, RefObject, SetStateAction } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { GitStatus, StagingFileEntry } from "@shared/types";
import { ChevronDown, ChevronUp, Minus, Plus, Search, SlidersHorizontal } from "lucide-react";
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
  REVIEW_HUB_STICKY_BAND,
  type SectionViewState,
  applySortChange,
  countNonDefaultView,
  isDensity,
  matchesFilter,
  resolveBulkScope,
  sumChurn,
  truncateFilterQuery,
} from "./reviewHubUtils";

interface FileSectionProps {
  /** Drives every staged/unstaged copy, testid, and toggle-verb choice below. */
  isStaged: boolean;
  files: StagingFileEntry[];
  /**
   * The section's TRUE population, before the filter query and the
   * generated-file toggle narrow it. The header counts this rather than
   * `files`, so a narrowed section can never report its visible subset as the
   * group total.
   */
  allFiles: StagingFileEntry[];
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
  /**
   * The shared file-row menu's items for one row (#11757). Built once by the
   * hub and passed down rather than resolved per row, so a large changeset
   * doesn't mint a store subscription per file. `triggerRef` is the row's own
   * node, which `Open diff` hands focus back to.
   */
  renderRowMenu: (
    file: StagingFileEntry,
    section: FileStageRowSection,
    triggerRef: RefObject<HTMLElement | null>
  ) => React.ReactNode;
  /**
   * Whether this section's rows window. Decided by the hub across BOTH
   * sections, not per section — they share one scroll container and one
   * keyboard cursor, so windowing one and not the other would leave the cursor
   * crossing a boundary between two different reveal mechanisms.
   */
  virtualized?: boolean;
  /**
   * The hub's scroll container. Virtuoso windows against it rather than owning
   * a scroller of its own, which is what keeps the section headers, the
   * conflict banner and the two sections in one continuous scroll the way they
   * render today.
   */
  scrollParent?: HTMLElement | null;
  /** Reveal handle for the hub's keyboard cursor. Unused on the static path. */
  listRef?: RefObject<VirtuosoHandle | null>;
  /**
   * The slice Virtuoso currently has MOUNTED, in this section's local index
   * space. `null` means "every row is mounted" — the static path, and the state
   * the hub must assume before the first `rangeChanged`.
   */
  onRenderedRangeChange?: (range: { start: number; end: number } | null) => void;
}

/**
 * Rows kept mounted above and below the viewport.
 *
 * Sized in pixels rather than rows because the two densities are 24px and 32px:
 * ~200px is six compact rows or four comfortable ones either side, which is
 * enough that stepping the keyboard cursor past the fold finds a mounted row
 * and the reveal only has to scroll, never to mount-then-find.
 */
const VIRTUALIZED_OVERSCAN_PX = 200;

/** Per-row inputs, passed through Virtuoso's `context` rather than closed over per row. */
interface SectionRowContext {
  section: FileStageRowSection;
  isStaged: boolean;
  indexOffset: number;
  focusedIndex: number;
  selectionSection: FileStageRowSection | null;
  selectedPaths: Set<string>;
  density: SectionViewState["density"];
  virtualized: boolean;
  viewedFiles: ReadonlySet<string>;
  onToggle: (filePath: string) => void;
  onRowClick: (
    section: FileStageRowSection,
    filePath: string,
    status: GitStatus,
    e: React.MouseEvent
  ) => void;
  onViewedChange: (viewedKey: string, viewed: boolean) => void;
  renderRowMenu: (
    file: StagingFileEntry,
    section: FileStageRowSection,
    triggerRef: RefObject<HTMLElement | null>
  ) => React.ReactNode;
}

/**
 * Keyed by section and path, never by index: an index key makes Virtuoso reuse
 * a row's DOM for a different file the moment a filter, a sort or a stage
 * changes the list's length, and the height it cached with it.
 */
function computeSectionRowKey(_index: number, file: StagingFileEntry, ctx: SectionRowContext) {
  return `${ctx.section}-${file.path}`;
}

/**
 * The one row renderer, shared by the static and windowed paths so the markup
 * cannot drift between them. `index` is section-local; `rowIndex` is the flat
 * staged+unstaged coordinate the hub's cursor and `aria-activedescendant` use.
 */
function renderSectionRow(index: number, file: StagingFileEntry, ctx: SectionRowContext) {
  const rowIndex = ctx.indexOffset + index;
  const viewedKey = `${ctx.section}:${file.path}`;
  return (
    <FileStageRow
      id={`review-hub-row-${rowIndex}`}
      rowIndex={rowIndex}
      isFocused={ctx.focusedIndex === rowIndex}
      file={file}
      section={ctx.section}
      isStaged={ctx.isStaged}
      isSelected={ctx.selectionSection === ctx.section && ctx.selectedPaths.has(file.path)}
      onToggle={ctx.onToggle}
      onRowClick={ctx.onRowClick}
      density={ctx.density}
      virtualized={ctx.virtualized}
      viewed={ctx.viewedFiles.has(viewedKey)}
      onViewedChange={(v) => ctx.onViewedChange(viewedKey, v)}
      renderRowMenu={ctx.renderRowMenu}
    />
  );
}

/**
 * The windowed path's per-row wrapper.
 *
 * The static path spaces rows with a flex `gap`, which a virtualizer cannot
 * reproduce — it stacks absolutely positioned items and measures each one, so a
 * gap between them is height it never sees. The same space is applied as
 * bottom padding INSIDE the measured item instead, which keeps the two paths
 * pixel-identical and the height cache honest.
 */
function renderVirtualizedRow(index: number, file: StagingFileEntry, ctx: SectionRowContext) {
  return (
    <div className={ctx.density === "compact" ? undefined : "pb-0.5"}>
      {renderSectionRow(index, file, ctx)}
    </div>
  );
}

export function FileSection({
  isStaged,
  files,
  allFiles,
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
  renderRowMenu,
  virtualized = false,
  scrollParent = null,
  listRef,
  onRenderedRangeChange,
}: FileSectionProps) {
  const section: FileStageRowSection = isStaged ? "staged" : "unstaged";
  const title = isStaged ? "Staged" : "Changes";
  const countTestId = isStaged ? "staged-section-count-chip" : "changes-section-count-chip";
  const bulkActionTestId = isStaged
    ? "review-hub-unstage-section-button"
    : "review-hub-stage-section-button";
  const bulkActionVerb = isStaged ? "Unstage" : "Stage";
  // The rows spell this operation `+` / `-`; the header spelled it with
  // check-box glyphs, which read as the section's state rather than as the
  // action about to run. One vocabulary per operation.
  const BulkActionIcon = isStaged ? Minus : Plus;
  const emptyNothingTitle = isStaged ? "Nothing staged" : "All changes staged";
  const emptyGeneratedTitle = isStaged
    ? "Only generated files staged"
    : "Only generated files changed";
  const emptyFilteredNoun = isStaged ? "staged files" : "changed files";
  const filterLabel = isStaged ? "Filter staged files" : "Filter changed files";

  // Counts and churn come from the unnarrowed population. `files` is what is
  // currently on screen; the difference between the two is disclosed, never
  // silently absorbed into the headline number.
  const totalCount = allFiles.length;
  const shownCount = files.length;
  const isNarrowed = shownCount !== totalCount;
  const churn = sumChurn(allFiles);

  const bulkScope = resolveBulkScope(view, hasSelection);
  const bulkCount = bulkScope === "selection" ? selectedPaths.size : shownCount;
  const bulkLabel =
    bulkScope === "selection"
      ? `${bulkActionVerb} selection (${bulkCount})`
      : bulkScope === "shown"
        ? `${bulkActionVerb} shown (${bulkCount})`
        : `${bulkActionVerb} all (${bulkCount})`;

  const nonDefaultViewCount = countNonDefaultView(view);

  // Generated files that the query WOULD have matched, were they not hidden.
  // Without this the filter branch below claims nothing matches, which is a
  // false diagnosis and offers a recovery ("Clear filter") that cannot work.
  const hiddenGeneratedMatches =
    !view.showGenerated && view.filterQuery
      ? allFiles.filter((f) => isGeneratedFile(f.path) && matchesFilter(f.path, view.filterQuery))
          .length
      : 0;

  // Static drop table, ordered by ascending importance — the last entry hides
  // first as the header narrows. Title, count, the shown/total disclosure and
  // the bulk action are never in it. An active query keeps its field on screen
  // at any width; a user cannot clear what they cannot see.
  const churnDropClass = "@max-[560px]/file-section:hidden";
  const filterDropClass = view.filterQuery ? "" : "@max-[460px]/file-section:hidden";

  // Windowing needs the scroll container it windows against, and that element
  // only exists after the hub's first commit — so a section can be over the
  // threshold for one render and still have nowhere to window. Rendering the
  // static list for that render is correct, not a fallback: it is what the
  // list looked like a frame earlier.
  const windowed = virtualized && scrollParent !== null;

  const rowContext: SectionRowContext = useMemo(
    () => ({
      section,
      isStaged,
      indexOffset,
      focusedIndex,
      selectionSection,
      selectedPaths,
      density: view.density,
      virtualized: windowed,
      viewedFiles,
      onToggle,
      onRowClick,
      onViewedChange,
      renderRowMenu,
    }),
    [
      section,
      isStaged,
      indexOffset,
      focusedIndex,
      selectionSection,
      selectedPaths,
      view.density,
      windowed,
      viewedFiles,
      onToggle,
      onRowClick,
      onViewedChange,
      renderRowMenu,
    ]
  );

  // Reported during render rather than from an effect: the hub gates
  // `aria-activedescendant` on this range, and an effect would leave it
  // pointing at an id that is not in the document for a commit. `null` is the
  // static path's honest answer — every row is mounted — and it is also what
  // the windowed path must report before Virtuoso's first `rangeChanged`,
  // which is why the transition out of windowing clears it here.
  const reportRange = onRenderedRangeChange;
  useEffect(() => {
    if (!windowed || files.length === 0) reportRange?.(null);
  }, [windowed, files.length, reportRange]);

  // A plain callback, not a `useEffectEvent`: Virtuoso takes this as a prop,
  // and an effect event cannot be passed down. Identity is stable as long as
  // the hub's own handler is, which is what keeps Virtuoso from resubscribing
  // on every scroll frame.
  const handleRangeChanged = useCallback(
    ({ startIndex, endIndex }: { startIndex: number; endIndex: number }) => {
      reportRange?.({ start: startIndex, end: endIndex });
    },
    [reportRange]
  );

  return (
    <div
      ref={sectionRef}
      data-testid={`review-hub-file-section-${section}`}
      className={cn(isStaged && "border-b border-divider")}
    >
      {/* Sticky so identity, count and the scoped bulk action stay reachable
          while a long changeset scrolls. */}
      <div className={cn("@container/file-section", REVIEW_HUB_STICKY_BAND)}>
        <div className="flex items-center justify-between px-4 py-2 bg-overlay-subtle gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wider text-text-secondary shrink-0 flex items-center">
            {title}
            <span
              data-testid={countTestId}
              className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-3xs font-medium normal-case tracking-normal inline-flex items-center gap-1"
            >
              <span>
                {totalCount} file{totalCount !== 1 ? "s" : ""}
              </span>
              {(churn.ins > 0 || churn.del > 0) && (
                <span className={cn("inline-flex items-center gap-1", churnDropClass)}>
                  <span aria-hidden="true" className="text-daintree-text/30">
                    ·
                  </span>
                  {churn.ins > 0 && (
                    <span className="text-status-success/80">{`+${churn.ins}`}</span>
                  )}
                  {churn.del > 0 && <span className="text-status-error/80">{`-${churn.del}`}</span>}
                </span>
              )}
            </span>
            {/* The disclosure that the count above is not what is on screen.
                Independent of the bulk label on purpose: that label loses its
                "shown" wording the moment rows are selected, which used to
                leave a filtered section with no filter signal at all. */}
            {isNarrowed && (
              <span
                role="status"
                data-testid={`${section}-section-shown-chip`}
                aria-label={`${shownCount} of ${totalCount} files shown`}
                className="ml-1 tabular-nums rounded px-1 py-0.5 text-3xs font-medium normal-case tracking-normal text-text-secondary bg-overlay-medium"
              >
                {shownCount} shown
              </span>
            )}
          </span>
          <div className="flex items-center gap-1.5 min-w-0">
            <div
              className={cn(
                "flex items-center gap-1 h-5 pl-1.5 pr-1.5 rounded min-w-0",
                "bg-tint/[0.04] border border-border-strong",
                "hover:bg-tint/[0.06] transition-colors",
                "focus-within:border-accent-primary",
                // The strip IS the field, so it owns the forced-colors focus
                // boundary. Without this the inner input painted its own
                // rectangle inside the wrapper and the pair read as two
                // separate controls.
                "forced-colors:focus-within:outline forced-colors:focus-within:outline-2",
                "forced-colors:focus-within:outline-[Highlight]",
                filterDropClass
              )}
            >
              <Search
                aria-hidden="true"
                className="w-3 h-3 shrink-0 text-daintree-text/40 forced-colors:text-[CanvasText]"
              />
              <input
                ref={inputRef}
                type="text"
                aria-label={filterLabel}
                placeholder="Filter…"
                defaultValue={view.filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                className={cn(
                  "w-[104px] min-w-0 bg-transparent text-2xs",
                  "text-text-primary placeholder:text-text-placeholder",
                  // The transparent-outline utility below is what forced
                  // colors would normally turn into a visible box. That is
                  // right for a standalone control and wrong inside a strip
                  // whose wrapper already draws the boundary, so its width is
                  // zeroed there and the wrapper paints the focus ring.
                  "outline-hidden forced-colors:outline-0"
                )}
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    // Fixed width, not min-width: the count appears and
                    // disappears as settings change, and an intrinsically-sized
                    // trigger drags the filter field with it every time.
                    "toolbar-icon-button inline-flex w-8 shrink-0 items-center justify-center gap-1 rounded p-1",
                    nonDefaultViewCount > 0 && "text-text-primary"
                  )}
                  data-testid={`${section}-section-view-trigger`}
                  aria-label={
                    nonDefaultViewCount > 0
                      ? `View options (${nonDefaultViewCount} changed from default)`
                      : "View options"
                  }
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  {/* A count, not a dot: a dot reads as "something new", and
                      what matters here is how many settings are non-default.
                      Same ruling as WorktreeFilterPopover. Neutral, never accent. */}
                  {nonDefaultViewCount > 0 && (
                    <span
                      aria-hidden="true"
                      className="text-3xs font-medium leading-none tabular-nums"
                    >
                      {nonDefaultViewCount}
                    </span>
                  )}
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
            {shownCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBulkAction}
                // min-w holds the trailing rail still. The label legitimately
                // changes width as its scope changes, and without a floor every
                // such change dragged the filter field and the view trigger
                // sideways with it. Sized for the longest label the component
                // can produce — "Unstage selection (NNN)" — because a floor that
                // merely narrows the travel still leaves the rail moving.
                // justify-start so the glyph keeps the same x in both stacked
                // sections; the ghost button has no chrome at rest, so the
                // reserved trailing space is invisible.
                className="h-5 px-1.5 text-3xs shrink-0 min-w-[9rem] justify-start"
                data-testid={bulkActionTestId}
              >
                <BulkActionIcon className="w-3 h-3 mr-1" />
                {bulkLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
      {files.length > 0 ? (
        windowed ? (
          <div className="px-2 py-1">
            <Virtuoso<StagingFileEntry, SectionRowContext>
              ref={listRef}
              data={files}
              context={rowContext}
              customScrollParent={scrollParent ?? undefined}
              computeItemKey={computeSectionRowKey}
              itemContent={renderVirtualizedRow}
              // Keeps a screenful of rows mounted either side of the viewport so
              // an arrow key that steps just past the fold lands on a row that
              // already exists, rather than on one the reveal has to conjure.
              increaseViewportBy={VIRTUALIZED_OVERSCAN_PX}
              rangeChanged={handleRangeChanged}
              skipAnimationFrameInResizeObserver
            />
          </div>
        ) : (
          <div
            className={cn(
              "px-2 py-1 flex flex-col",
              view.density === "compact" ? "gap-0" : "gap-0.5"
            )}
          >
            {files.map((file, i) => (
              <FileStageRow
                key={`${section}-${file.path}`}
                id={`review-hub-row-${indexOffset + i}`}
                rowIndex={indexOffset + i}
                isFocused={focusedIndex === indexOffset + i}
                file={file}
                section={section}
                isStaged={isStaged}
                isSelected={selectionSection === section && selectedPaths.has(file.path)}
                onToggle={onToggle}
                onRowClick={onRowClick}
                density={view.density}
                viewed={viewedFiles.has(`${section}:${file.path}`)}
                onViewedChange={(v) => onViewedChange(`${section}:${file.path}`, v)}
                renderRowMenu={renderRowMenu}
              />
            ))}
          </div>
        )
      ) : hiddenGeneratedMatches > 0 ? (
        /* The query DOES match — those matches are just hidden as generated.
           Reaching the plain filter branch here would name the wrong cause and
           offer "Clear filter", which cannot bring them back. */
        <EmptyState
          variant="filtered-empty"
          scale="sidebar"
          title={`${hiddenGeneratedMatches} matching generated file${
            hiddenGeneratedMatches !== 1 ? "s" : ""
          } hidden`}
          action={
            <button
              type="button"
              onClick={() => setView((prev) => ({ ...prev, showGenerated: true }))}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors underline underline-offset-2"
            >
              Show generated files
            </button>
          }
        />
      ) : view.filterQuery ? (
        <EmptyState
          variant="filtered-empty"
          scale="sidebar"
          title={`No ${emptyFilteredNoun} matching "${truncateFilterQuery(view.filterQuery)}"`}
          action={
            <button
              type="button"
              onClick={clearFilter}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors underline underline-offset-2"
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
              className="text-xs text-text-secondary hover:text-text-primary transition-colors underline underline-offset-2"
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
