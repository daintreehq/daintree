import { Search, ExternalLink, Plus, ArrowUpDown, RefreshCw } from "lucide-react";
import { ListChecks } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";

/**
 * The virtualized row height, in px, and the only definition of it. This used
 * to be 68 against markup that measured about 58 — Virtuoso laid rows out on
 * the constant while the fill and hit area drew to the shorter box, leaving a
 * 10px strip between rows that belonged to no row at all. `GitHubListItem`
 * now sets its own height from this constant, so the two cannot drift.
 */
export const RESOURCE_ITEM_HEIGHT_PX = 64;
export const COMMIT_ITEM_HEIGHT_PX = 64;
export const MAX_SKELETON_ITEMS = 6;

/**
 * The state mark's placement in a forge row. Height was not the only thing the
 * two files each held their own copy of: the mark's offset and the trailing
 * rail drifted apart across three unrelated PRs to `GitHubListItem`, because
 * nothing linked them. Anything the loading row has to mirror lives here now.
 */
export const RESOURCE_ROW_STATE_MARK = "shrink-0 mt-1";

/** The trailing rail's shared slot frame, so rows share a right edge. */
export const RAIL_SLOT = "shrink-0 flex items-center justify-center";

export interface ResourceRailSlot {
  id: "count" | "assignee" | "ci" | "menu";
  /** The box the slot holds open. Empty when its width is its own content. */
  box: string;
  /** The bone the skeleton draws, absent for a slot it cannot reserve. */
  bone?: string;
}

/**
 * The trailing rail, in render order, per resource type — every slot the row
 * can draw, whether or not the skeleton reserves it.
 *
 * The rail is strictly type-partitioned: `GitHubListItem` empties `assignees`
 * for a PR and gates the check glyph on the item being one, so neither type
 * ever draws the other's slots.
 *
 * `count` carries no bone. It has no fixed width and needs a second assignee
 * to appear at all, so reserving it would cost every title the space of a
 * count most rows never show. It stays in the list because its position is the
 * invariant that keeps avatars in one column — variable width to the LEFT of
 * the fixed identity slot — and because a rail child registered nowhere is
 * exactly how this drifted before.
 */
export const RESOURCE_RAIL_SLOTS: Record<"issue" | "pr", readonly ResourceRailSlot[]> = {
  issue: [
    { id: "count", box: "" },
    { id: "assignee", box: "w-4", bone: "w-4 h-4 rounded-full" },
    { id: "menu", box: "w-6 h-6 -me-1", bone: "w-6 h-6 rounded" },
  ],
  pr: [
    { id: "ci", box: "w-4 h-3.5", bone: "w-3.5 h-3.5 rounded-full" },
    { id: "menu", box: "w-6 h-6 -me-1", bone: "w-6 h-6 rounded" },
  ],
};

/** Each slot's box by id, for the row that draws one slot at a time. */
export const RESOURCE_RAIL_SLOT_BOX = {
  assignee: "w-4",
  ci: "w-4 h-3.5",
  menu: "w-6 h-6 -me-1",
} as const;

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
 * The geometry of `IssueSelector`'s option row, shared with its skeleton. The
 * transparent border comes from `PALETTE_ROW_CLASS` on the loaded row; the
 * skeleton takes it from here rather than the whole interactive class.
 */
export const FORGE_OPTION_ROW =
  "flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] border border-transparent";

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
      className="relative w-[450px] flex flex-col h-[500px]"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading GitHub results"
    >
      <span className="sr-only">Loading GitHub results</span>

      {/* Header — matches GitHubResourceList */}
      <div className="p-3 border-b border-[var(--border-divider)] space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2.5 h-8 rounded-[var(--radius-md)] flex-1 min-w-0",
              "bg-overlay-soft border border-[var(--border-overlay)]"
            )}
          >
            <Search
              className="w-3.5 h-3.5 shrink-0 text-text-secondary pointer-events-none"
              aria-hidden="true"
            />
            <span className="flex-1 min-w-0 text-sm text-text-secondary select-none">
              Search {type === "issue" ? "issues" : "pull requests"}…
            </span>
          </div>
          {/* Every icon slot, or the search field jumps narrower the moment
              real content replaces this. */}
          <div className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0 text-text-secondary">
            <RefreshCw className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0 text-text-secondary">
            <ArrowUpDown className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] shrink-0 text-text-secondary">
            <ListChecks className="w-3.5 h-3.5" />
          </div>
        </div>

        <div
          className="flex p-0.5 bg-overlay-soft border border-[var(--border-divider)] rounded-[var(--radius-md)]"
          aria-hidden="true"
        >
          {stateTabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "flex-1 px-3 py-1 text-xs font-medium rounded text-center",
                tab.id === "open" ? "bg-overlay-medium text-text-primary" : "text-text-secondary"
              )}
            >
              {tab.label}
            </div>
          ))}
        </div>
      </div>

      {/* List skeleton rows */}
      <div className="relative overflow-hidden flex-1 min-h-0">
        <GitHubResourceRowsSkeleton count={renderCount} immediate={showImmediate} type={type} />
        {/* Same fade the loaded list uses, so a skeleton row cut by the panel
            edge dissolves instead of being guillotined. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-[var(--scroll-shadow-color)] to-transparent"
        />
      </div>

      {/* Footer — matches GitHubResourceList */}
      <div className="px-2 py-1.5 border-t border-[var(--border-divider)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5 px-3 h-7 text-xs text-text-secondary">
          <ExternalLink className="h-3.5 w-3.5" />
          View on GitHub
        </div>
        <div className="flex items-center gap-1.5 px-3 h-7 text-xs text-text-secondary">
          <Plus className="h-3.5 w-3.5" />
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
            className={cn("w-4 h-4 bg-muted", RESOURCE_ROW_STATE_MARK, RESOURCE_STATE_BONE[type])}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 h-6">
              <div className="h-4 bg-muted rounded flex-1" />
              {/* Every rail slot the loaded row reserves, from the one list
                  that names them. One short and the title bar jumps the
                  moment data lands — which is the bug this row shipped for
                  three releases. */}
              <div data-rail className="flex items-center gap-1.5 shrink-0">
                {RESOURCE_RAIL_SLOTS[type]
                  .filter((slot) => slot.bone)
                  .map((slot) => (
                    <span
                      key={slot.id}
                      data-rail-slot={slot.id}
                      className={cn(RAIL_SLOT, slot.box)}
                    >
                      <span className={cn("bg-muted", slot.bone)} />
                    </span>
                  ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-1 h-4">
              <div className="h-3 bg-muted rounded w-12" />
              <div className="h-3 bg-muted rounded w-16" />
              <div className="h-3 bg-muted rounded w-10" />
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
          <div className="w-3 h-3 rounded-full bg-muted shrink-0" />
          {/* An empty bone has no line box, so without the loaded row's own
              20px one to sit in, every row would come up short. */}
          <div className="h-5 flex items-center flex-1 min-w-0">
            <div
              className={cn(
                "h-4 bg-muted rounded",
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

  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading commits">
      <span className="sr-only">Loading commits</span>
      <div aria-hidden="true" className="divide-y divide-[var(--border-divider)]">
        {Array.from({ length: renderCount }).map((_, i) => (
          <div
            key={i}
            className={`px-3 py-2.5 ${pulseClass} box-border`}
            style={{ height: `${COMMIT_ITEM_HEIGHT_PX}px` }}
          >
            <div className="flex items-start gap-2 h-full">
              <div className="w-4 h-4 rounded-full bg-muted mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="h-5 bg-muted rounded w-3/4" />
                <div className="mt-0.5 flex items-center gap-1.5">
                  <div className="h-4 bg-muted rounded w-16" />
                  <div className="h-4 bg-muted rounded w-20" />
                  <div className="h-4 bg-muted rounded w-12" />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
