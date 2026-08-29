import { SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FileBrowserSortKey } from "@shared/types/panel";
import type { FileBrowserSortOrder, HiddenRowCounts } from "./fileBrowserTree";

const SORT_OPTIONS: ReadonlyArray<{ value: FileBrowserSortKey; label: string }> = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Modified" },
  { value: "size", label: "Size" },
  { value: "type", label: "Type" },
];

function toSortKey(value: string, fallback: FileBrowserSortKey): FileBrowserSortKey {
  return SORT_OPTIONS.some((option) => option.value === value)
    ? (value as FileBrowserSortKey)
    : fallback;
}

/**
 * The sentence the badge, the tooltip and the accessible name all read from, so
 * the number a user sees and the number a screen reader hears can never drift.
 * Empty string when nothing is hidden — the caller renders no badge then.
 */
export function hiddenSummary(counts: HiddenRowCounts): string {
  const parts: string[] = [];
  if (counts.dotfiles > 0) {
    parts.push(`${counts.dotfiles} dotfile${counts.dotfiles === 1 ? "" : "s"} hidden`);
  }
  if (counts.alwaysHidden > 0) {
    // Named by where the recovery lives, not by what matched: "always hidden"
    // is the setting's internal name and means nothing from here, whereas
    // Settings is somewhere the user can actually go.
    parts.push(`${counts.alwaysHidden} hidden by Settings`);
  }
  return parts.join(", ");
}

export interface FileBrowserViewOptionsProps {
  sort: FileBrowserSortOrder;
  onSortChange: (next: FileBrowserSortOrder) => void;
  /** True while the dotfile filter is removing rows. */
  hideDotfiles: boolean;
  onHideDotfilesChange: (hide: boolean) => void;
  /** What the two filters are removing from the branches currently on screen. */
  hiddenCounts: HiddenRowCounts;
  "data-testid"?: string;
}

/**
 * Everything that changes what the tree SHOWS, in one menu (#11938 follow-up).
 *
 * Both settings govern the tree — `flattenTree` sorts every level and drops
 * filtered entries — so they belong to whichever column is currently rendering
 * the tree's chrome, together. Previously they were split by column: the
 * dotfile filter held a dedicated button in the tree header while sort lived in
 * the viewer's toolbar behind a `!filePath` gate, which meant collapsing the
 * viewer or opening any file removed the only control for a setting that was
 * still reordering the rows on screen.
 *
 * Rendered by the tree header, and by the viewer's toolbar only while the tree
 * column is collapsed away — the same conditional ownership Refresh already
 * uses, so there is exactly one of these in every layout.
 *
 * The badge counts hidden ROWS, not non-default settings, which is where this
 * departs from `FileSection`'s otherwise identical trigger. The reasoning is
 * that a badge should carry what the surface cannot otherwise say: a non-default
 * sort is self-evident from the list itself, but a hidden row leaves nothing
 * behind, and that silence is the documented failure mode where a user believes
 * files were deleted. Neutral fill and a number, never an accent or a dot — a
 * dot reads as "something new", and what matters here is how many.
 */
export function FileBrowserViewOptions({
  sort,
  onSortChange,
  hideDotfiles,
  onHideDotfilesChange,
  hiddenCounts,
  "data-testid": testId,
}: FileBrowserViewOptionsProps) {
  const totalHidden = hiddenCounts.dotfiles + hiddenCounts.alwaysHidden;
  const summary = hiddenSummary(hiddenCounts);
  const label = summary === "" ? "View options" : `View options — ${summary}`;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              // Fixed width rather than intrinsic: the badge appears and
              // disappears as rows are filtered, and a trigger that resizes
              // would drag the whole button cluster sideways each time.
              className={cn(
                "toolbar-icon-button inline-flex w-8 shrink-0 items-center justify-center gap-1 rounded p-1",
                totalHidden > 0 ? "text-text-primary" : "text-text-secondary"
              )}
              aria-label={label}
              data-testid={testId}
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              {totalHidden > 0 && (
                <span aria-hidden="true" className="text-3xs font-medium leading-none tabular-nums">
                  {totalHidden}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        {/* Key and direction are two labelled radio groups rather than one
            group that reverses when its active item is re-picked: the compact
            version hides the direction behind a gesture nothing announces —
            the checked item stays checked, so a screen reader reports no
            change — and leaves no way to set a direction outright. Each group
            carries its own `aria-label` because Radix renders these as
            `role="group"` and the visible label above is a sibling, not an
            association. */}
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Sort by"
          value={sort.key}
          onValueChange={(value) => {
            onSortChange({ ...sort, key: toSortKey(value, sort.key) });
          }}
        >
          {SORT_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Order</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Order"
          value={sort.direction}
          onValueChange={(value) => {
            onSortChange({ ...sort, direction: value === "desc" ? "desc" : "asc" });
          }}
        >
          <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* A static label carrying the positive sense, per the toggle-label
            rule: the checkbox state says whether they are shown, so the words
            never have to change. The trailing count is the reason this row
            beats the old dedicated button — it says what the filter is
            actually doing right now, which a lit icon never did. */}
        <DropdownMenuCheckboxItem
          checked={!hideDotfiles}
          onCheckedChange={(checked) => {
            onHideDotfilesChange(!checked);
          }}
          data-testid="file-browser-show-dotfiles"
        >
          <span className="flex flex-1 items-center gap-2">
            Show dotfiles
            {hiddenCounts.dotfiles > 0 && (
              <span className="ml-auto text-3xs tabular-nums text-text-secondary">
                {hiddenCounts.dotfiles}
              </span>
            )}
          </span>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
