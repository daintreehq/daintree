import { Search, ExternalLink, Plus, ArrowUpDown, RefreshCw, X } from "lucide-react";
import { ListChecks } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { FORGE_DROPDOWN_PANEL_SIZE } from "@/components/Layout/forgeStatsDropdownContract";
import { useGitHubFilterStore } from "../stores/githubFilterStore";

/**
 * The virtualized row height, in px, and the only definition of it. This used
 * to be 68 against markup that measured about 58 — Virtuoso laid rows out on
 * the constant while the fill and hit area drew to the shorter box, leaving a
 * 10px strip between rows that belonged to no row at all. `GitHubListItem`
 * now sets its own height from this constant, so the two cannot drift.
 */
export const RESOURCE_ITEM_HEIGHT_PX = 64;
/** A collapsed commit row in the host's list (`LocalCommitsDropdown`), which this stands in for. */
export const COMMIT_ITEM_HEIGHT_PX = 58;
export const MAX_SKELETON_ITEMS = 6;

/**
 * The state mark's placement in a forge row. Height was not the only thing the
 * two files each held their own copy of: the mark's offset and the trailing
 * rail drifted apart across three unrelated PRs to `GitHubListItem`, because
 * nothing linked them. Anything the loading row has to mirror lives here now.
 */
export const RESOURCE_ROW_STATE_MARK = "shrink-0 mt-1";

/** The trailing rail itself, so neither side can respace it on its own. */
export const RESOURCE_RAIL = "flex items-center gap-1.5 shrink-0";

/** The trailing rail's shared slot frame, so rows share a right edge. */
export const RAIL_SLOT = "shrink-0 flex items-center justify-center";

/**
 * Every slot the trailing rail can hold, and the only definition of each.
 *
 * `box` is the width the slot holds open; `bone` is what the loading row draws
 * inside it. A slot whose width is whatever it happens to contain carries an
 * empty `box` and no `bone` — there is no fixed width there to reserve.
 */
export const RESOURCE_RAIL_SLOT = {
  count: { box: "", bone: null },
  assignee: { box: "w-4", bone: "w-4 h-4 rounded-full" },
  ci: { box: "w-4 h-3.5", bone: "w-3.5 h-3.5 rounded-full" },
  // `rounded-lg` is what a bare `rounded` already renders here — the design
  // contract overrides `--radius` — named so the step is legible, and so the
  // class stays visible to `component-contract/no-raw-radius`, which does not
  // resolve identifiers and so cannot see into this table.
  menu: { box: "w-6 h-6 -me-1", bone: "w-6 h-6 rounded-lg" },
} as const satisfies Record<string, { box: string; bone: string | null }>;

export type ResourceRailSlotId = keyof typeof RESOURCE_RAIL_SLOT;

/**
 * The rail in render order, per resource type — every slot the row can draw,
 * whether or not the loading row reserves it.
 *
 * The rail is strictly type-partitioned: `GitHubListItem` empties `assignees`
 * for a PR and gates the check glyph on the item being one, so neither type
 * ever draws the other's slots.
 *
 * `count` is listed but never reserved. It has no fixed width and needs a
 * second assignee to appear at all, so holding a box open for it would cost
 * every title the space of a count most rows never show. It stays in the order
 * because its position is the invariant that keeps avatars in one column —
 * variable width to the LEFT of the fixed identity slot, which is itself
 * immediately before the always-present menu — and because a rail child
 * registered nowhere is exactly how this drifted in the first place.
 */
export const RESOURCE_RAIL_ORDER = {
  issue: ["count", "assignee", "menu"],
  pr: ["ci", "menu"],
} as const satisfies Record<"issue" | "pr", readonly ResourceRailSlotId[]>;

/**
 * An issue's state mark is a circle (`CircleDot`/`CheckCircle2`); a PR's never
 * is (`getPrStateGlyph` returns four non-round glyphs). Loading cannot know
 * which state, but it can stop claiming the wrong shape.
 */
export const RESOURCE_STATE_BONE = {
  issue: "rounded-full",
  pr: "rounded-sm",
} as const;

/**
 * The panel's chrome, shared with `GitHubResourceList` for the same reason as
 * the row constants above: the loading panel's header and footer had drifted
 * from the ones that replace them, so the swap moved the footer's labels and
 * re-laid its actions. The header frame holds the search row and the filter.
 */
export const RESOURCE_PANEL_HEADER =
  "p-3 border-b border-[var(--border-divider)] space-y-2 shrink-0";

/** The dropdown's 32px, text-sm search field, taking the search row's spare width. */
export const RESOURCE_SEARCH_FIELD = "h-8 text-sm flex-1";

/**
 * Three columns, so the freshness line the loaded footer can show in the middle
 * never pushes either action off its edge.
 */
export const RESOURCE_PANEL_FOOTER =
  "px-2 h-10 border-t border-[var(--border-divider)] grid grid-cols-[1fr_auto_1fr] items-center shrink-0";

/**
 * The list body's scrollbar gutter, held open whether or not the rows overflow.
 * The app draws classic scrollbars wherever the platform does, and a body that
 * gained one only once the rows arrived moved the whole rail left by its width.
 */
export const RESOURCE_LIST_GUTTER = "[scrollbar-gutter:stable]";

/**
 * Every stand-in for a control that is a `button` in the loaded panel. Both
 * contrast modes put a border on native buttons (`prefers-contrast.css`,
 * `forced-colors.css`), so a plain box here came up 2-4px short of the segment
 * or action that replaced it, and the rows below moved by the difference.
 */
const CONTROL_STAND_IN =
  "contrast-more:border-2 forced-colors:border forced-colors:border-[ButtonText]";

/** A header icon slot: the `IconButton` at its default 32px size. */
const HEADER_ICON_SLOT = cn(
  "flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0 text-text-secondary",
  CONTROL_STAND_IN
);

/**
 * A footer action at rest: the ghost `sm` `Button` the loaded footer draws,
 * weight included. The labels were regular weight here, so they thickened and
 * widened the moment the list landed.
 */
const FOOTER_ACTION = cn(
  "inline-flex items-center justify-center whitespace-nowrap h-7 px-3 gap-1.5 text-xs font-medium rounded-[var(--radius-md)] text-text-secondary [&_svg]:size-3.5 [&_svg]:shrink-0",
  CONTROL_STAND_IN
);

/**
 * The geometry of `IssueSelector`'s option row, shared with its skeleton. The
 * transparent border comes from `PALETTE_ROW_CLASS` on the loaded row; the
 * skeleton takes it from here rather than the whole interactive class.
 */
export const FORGE_OPTION_ROW =
  "flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] border border-transparent";

/**
 * The 20px line box `text-sm` gives the loaded option's text. A bone has no
 * line box of its own, so the loading row has to stand one up or every row
 * comes up 4px short of the option it stands in for.
 */
export const FORGE_OPTION_LINE = "h-5 flex items-center flex-1 min-w-0";

function normalizeCount(count?: number | null): number {
  if (count == null || !Number.isFinite(count)) return MAX_SKELETON_ITEMS;
  return Math.min(Math.max(1, Math.floor(count)), MAX_SKELETON_ITEMS);
}

interface SkeletonProps {
  count?: number | null;
  immediate?: boolean;
}

interface ResourceListSkeletonProps extends SkeletonProps {
  type?: "issue" | "pr";
}

/** Required, not defaulted: the rows cannot pick a rail without knowing. */
interface ResourceRowsSkeletonProps extends SkeletonProps {
  type: "issue" | "pr";
}

export function GitHubResourceListSkeleton({
  count,
  immediate,
  type = "issue",
}: ResourceListSkeletonProps) {
  const renderCount = normalizeCount(count);
  const showImmediate = useSkeletonGate(Boolean(immediate));
  // The loaded header draws the filter, sort and query the panel was last left
  // on, so this does too. Drawing the defaults moved the filter's thumb and
  // changed the field's text whenever the panel reopened somewhere else.
  const filterState = useGitHubFilterStore((s) => (type === "issue" ? s.issueFilter : s.prFilter));
  const sortOrder = useGitHubFilterStore((s) =>
    type === "issue" ? s.issueSortOrder : s.prSortOrder
  );
  const searchQuery = useGitHubFilterStore((s) =>
    type === "issue" ? s.issueSearchQuery : s.prSearchQuery
  );

  const stateTabs =
    type === "pr"
      ? [
          { id: "open", label: "Open" },
          { id: "merged", label: "Merged" },
          { id: "closed", label: "Closed" },
        ]
      : [
          { id: "open", label: "Open" },
          { id: "closed", label: "Closed" },
        ];

  return (
    <div
      className={cn("relative flex flex-col", FORGE_DROPDOWN_PANEL_SIZE)}
      role="status"
      aria-live="polite"
      aria-label="Loading GitHub results"
    >
      <span className="sr-only">Loading GitHub results</span>

      {/* Header — matches GitHubResourceList */}
      <div className={RESOURCE_PANEL_HEADER}>
        <div className="flex items-center gap-2">
          {/* The shared field's own classes, not a copy of its look: the live
              header renders SearchField, so drawing the same CSS here keeps the
              swap from loading to loaded seamless. */}
          <div
            data-search-field=""
            className={cn("search-field cursor-default", RESOURCE_SEARCH_FIELD)}
            data-size="compact"
          >
            <Search className="search-field-icon" aria-hidden="true" />
            {searchQuery ? (
              <>
                {/* Clipped, not ellipsized: the loaded input clips a long query. */}
                <span className="flex-1 min-w-0 overflow-hidden whitespace-pre select-none">
                  {searchQuery}
                </span>
                {/* The clear button the loaded field shows whenever it holds text. */}
                <span className={cn("search-field-clear", CONTROL_STAND_IN)}>
                  <X className="h-3 w-3" aria-hidden="true" />
                </span>
              </>
            ) : (
              <span className="flex-1 min-w-0 truncate text-text-secondary select-none">
                Search {type === "issue" ? "issues" : "pull requests"}…
              </span>
            )}
          </div>
          {/* Every icon slot, or the search field jumps narrower the moment
              real content replaces this. */}
          <div data-header-slot="refresh" className={HEADER_ICON_SLOT}>
            <RefreshCw className="w-3.5 h-3.5" />
          </div>
          {/* Lifted under a non-default sort, as the loaded trigger is. */}
          <div
            data-header-slot="sort"
            className={cn(
              HEADER_ICON_SLOT,
              sortOrder !== "created" && "bg-overlay-soft text-text-primary"
            )}
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
          </div>
          {/* Dimmed: the loaded trigger is disabled until rows arrive, so it
              would otherwise dim and come back the moment the list mounted. */}
          <div data-header-slot="select" className={cn(HEADER_ICON_SLOT, "opacity-50")}>
            <ListChecks className="w-3.5 h-3.5" />
          </div>
        </div>

        {/* Drawn as the shared segmented control at rest (inset track, bordered
            neutral thumb), so the filter does not change shape when the list loads. */}
        <div
          className="flex w-full p-0.5 bg-surface-inset rounded-[var(--radius-md)]"
          aria-hidden="true"
        >
          {stateTabs.map((tab) => (
            <div
              key={tab.id}
              data-segment={tab.id}
              data-checked={tab.id === filterState ? "" : undefined}
              className={cn(
                "relative flex-1 min-w-0 px-2.5 py-1 text-xs font-medium rounded-[var(--radius-sm)] text-center",
                CONTROL_STAND_IN,
                tab.id === filterState ? "text-text-primary" : "text-text-secondary"
              )}
            >
              {/* The thumb as the live control draws it: its own layer under the
                  label, so its border adds nothing to the segment's height. The
                  live thumb spans the segment's whole border box, so it reaches
                  out over the border the contrast modes add. Not the primitive's
                  thumb slot, which only `SegmentedRadioGroup` may draw, so the
                  two contrast treatments that slot gets from the host styles
                  are restated here: a hairline outline under increased contrast
                  and a 2px ButtonText border under forced colours. */}
              {tab.id === filterState && (
                <span
                  data-skeleton-thumb=""
                  className={cn(
                    "absolute inset-0 rounded-[var(--radius-sm)] bg-overlay-medium border border-text-secondary shadow-[var(--theme-shadow-ambient)]",
                    "contrast-more:-inset-0.5 contrast-more:outline contrast-more:outline-1 contrast-more:-outline-offset-1 contrast-more:outline-border-strong",
                    "forced-colors:-inset-px forced-colors:border-2 forced-colors:border-[ButtonText]"
                  )}
                />
              )}
              <span className="relative block truncate">{tab.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* List skeleton rows */}
      <div className={cn("relative overflow-hidden flex-1 min-h-0", RESOURCE_LIST_GUTTER)}>
        <GitHubResourceRowsSkeleton count={renderCount} immediate={showImmediate} type={type} />
        {/* Same fade the loaded list uses, so a skeleton row cut by the panel
            edge dissolves instead of being guillotined. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-[var(--scroll-shadow-color)] to-transparent"
        />
      </div>

      {/* Footer — matches GitHubResourceList */}
      <div data-panel-footer="" className={RESOURCE_PANEL_FOOTER}>
        <div className={cn(FOOTER_ACTION, "justify-self-start")}>
          <ExternalLink />
          View on GitHub
        </div>
        <span aria-hidden="true" />
        <div className={cn(FOOTER_ACTION, "justify-self-end")}>
          <Plus />
          {type === "issue" ? "New issue" : "New pull request"}
        </div>
      </div>
    </div>
  );
}

export function GitHubResourceRowsSkeleton({ count, immediate, type }: ResourceRowsSkeletonProps) {
  const renderCount = normalizeCount(count);
  const pulseClass = immediate ? "animate-pulse-immediate" : "animate-pulse-delayed";

  return (
    <div aria-hidden="true">
      {Array.from({ length: renderCount }).map((_, i) => (
        <div
          key={i}
          className={`${pulseClass} box-border px-3 py-2.5 flex items-start gap-2.5`}
          style={{ height: `${RESOURCE_ITEM_HEIGHT_PX}px` }}
        >
          <div
            data-state-mark
            data-skeleton-bone=""
            className={cn(
              "w-4 h-4 bg-tint/[0.1]",
              RESOURCE_ROW_STATE_MARK,
              RESOURCE_STATE_BONE[type]
            )}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 h-6">
              <div
                data-skeleton-bone=""
                className="h-4 bg-tint/[0.1] rounded-[var(--radius-xs)] flex-1"
              />
              {/* Every rail slot the loaded row reserves, from the one order
                  that names them. One short and the title bar jumps the
                  moment data lands — which is the bug this row shipped for
                  three releases. */}
              <div data-rail className={RESOURCE_RAIL}>
                {RESOURCE_RAIL_ORDER[type].map((id) => {
                  const slot = RESOURCE_RAIL_SLOT[id];
                  if (!slot.bone) return null;
                  return (
                    <span key={id} data-rail-slot={id} className={cn(RAIL_SLOT, slot.box)}>
                      <span data-skeleton-bone="" className={cn("bg-tint/[0.1]", slot.bone)} />
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-1 h-4">
              <div
                data-skeleton-bone=""
                className="h-3 bg-tint/[0.1] rounded-[var(--radius-xs)] w-12"
              />
              <div
                data-skeleton-bone=""
                className="h-3 bg-tint/[0.1] rounded-[var(--radius-xs)] w-16"
              />
              <div
                data-skeleton-bone=""
                className="h-3 bg-tint/[0.1] rounded-[var(--radius-xs)] w-10"
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Three widths, so a short stack of bars reads as titles and not as a grid. */
const OPTION_BONE_WIDTHS = ["w-3/5", "w-4/5", "w-2/3"];

/**
 * `IssueSelector`'s loading state. It used to borrow the resource skeleton
 * above — a 64px two-line row for a single-line option a third that height, so
 * the popover collapsed as the issues arrived.
 */
export function ForgeOptionRowsSkeleton({ count, immediate }: SkeletonProps) {
  const renderCount = normalizeCount(count);
  const pulseClass = immediate ? "animate-pulse-immediate" : "animate-pulse-delayed";

  return (
    <div aria-hidden="true">
      {Array.from({ length: renderCount }).map((_, i) => (
        <div key={i} className={cn(FORGE_OPTION_ROW, pulseClass)}>
          <div data-skeleton-bone="" className="w-3 h-3 rounded-full bg-tint/[0.1] shrink-0" />
          <div data-option-line className={FORGE_OPTION_LINE}>
            <div
              data-skeleton-bone=""
              className={cn(
                "h-4 bg-tint/[0.1] rounded-[var(--radius-xs)]",
                OPTION_BONE_WIDTHS[i % OPTION_BONE_WIDTHS.length]
              )}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CommitListSkeleton({ count, immediate }: SkeletonProps) {
  const renderCount = normalizeCount(count);
  const showImmediate = useSkeletonGate(Boolean(immediate));
  const pulseClass = showImmediate ? "animate-pulse-immediate" : "animate-pulse-delayed";

  // The whole panel, not just rows: the list's code loads behind this on a
  // first open, and a bare stack of rows made the panel change height and move
  // its rows the moment the real header and footer arrived.
  return (
    <div
      className={cn("relative flex flex-col", FORGE_DROPDOWN_PANEL_SIZE)}
      role="status"
      aria-live="polite"
      aria-label="Loading commits"
    >
      <span className="sr-only">Loading commits</span>
      <div className="p-3 border-b border-[var(--border-divider)] shrink-0" aria-hidden="true">
        <div className="search-field h-8 text-sm cursor-default" data-size="compact">
          <Search className="search-field-icon" aria-hidden="true" />
          <span className="flex-1 min-w-0 truncate text-text-secondary select-none">
            Search commits…
          </span>
        </div>
      </div>
      <div aria-hidden="true" className="flex-1 min-h-0 overflow-hidden">
        {Array.from({ length: renderCount }).map((_, i) => (
          <div
            key={i}
            className={`px-3 py-2.5 ${pulseClass} box-border`}
            style={{ height: `${COMMIT_ITEM_HEIGHT_PX}px` }}
          >
            {/* The same bones as the commits list it stands in for (the host's
                LocalCommitsDropdown skeleton), so the swap is one shape. */}
            <div className="flex items-start gap-2 h-full">
              <div
                data-skeleton-bone=""
                className="w-4 h-4 rounded-full bg-tint/[0.1] mt-0.5 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div
                  data-skeleton-bone=""
                  className="h-5 bg-tint/[0.1] rounded-[var(--radius-xs)] w-3/4"
                />
                <div className="mt-0.5 flex items-center gap-1.5">
                  <div
                    data-skeleton-bone=""
                    className="h-4 bg-tint/[0.1] rounded-[var(--radius-xs)] w-20"
                  />
                  <div
                    data-skeleton-bone=""
                    className="h-4 bg-tint/[0.1] rounded-[var(--radius-xs)] w-12"
                  />
                  <div
                    data-skeleton-bone=""
                    className="ml-auto h-4 bg-tint/[0.1] rounded-[var(--radius-xs)] w-14"
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="px-3 h-10 border-t border-[var(--border-divider)] flex items-center justify-end shrink-0"
      >
        <div className="flex items-center gap-1.5 px-3 h-7 text-xs text-text-secondary">
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </div>
      </div>
    </div>
  );
}
