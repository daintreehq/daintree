import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import type { FileBrowserSortKey } from "@shared/types/panel";
import type { FileBrowserSortOrder, HiddenRowCounts } from "./fileBrowserTree";

const SORT_OPTIONS: ReadonlyArray<{ value: FileBrowserSortKey; label: string }> = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Modified" },
  { value: "size", label: "Size" },
  { value: "type", label: "Type" },
];

function toSortKey(value: string, fallback: FileBrowserSortKey): FileBrowserSortKey {
  // Narrowed by lookup rather than asserted: the option list is already the
  // authority on which keys exist, so reading the key back off the matched
  // option proves the type instead of claiming it.
  return SORT_OPTIONS.find((option) => option.value === value)?.value ?? fallback;
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
  /**
   * The manual re-read. A fallback rather than a primary: the browser already
   * ticks off the worktree watcher, or a 2s poll where no watcher covers the
   * root, so this exists for the cases that slip through — notably writes into
   * a gitignored folder, which `git status` never reports (#11334).
   */
  onRefresh: () => void;
  isRefreshing: boolean;
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
 * Deliberately NOT badged with a count, unlike `FileSection`'s otherwise
 * identical trigger. A number inside a fixed-width icon button reads fine at
 * "3" and falls apart at "25", where it squeezes the glyph beside it; and a
 * trigger sized to its content drags the whole button cluster sideways every
 * time a folder is expanded. The count belongs where there is room for words
 * and a recovery — see `FileBrowserHiddenStrip`, which appears under the tree
 * only while rows are actually being hidden.
 */
export function FileBrowserViewOptions({
  sort,
  onSortChange,
  hideDotfiles,
  onHideDotfilesChange,
  hiddenCounts,
  onRefresh,
  isRefreshing,
  "data-testid": testId,
}: FileBrowserViewOptionsProps) {
  // Just the name. What the filters are doing is announced by the strip under
  // the tree, which is a live region, so repeating it here would say it twice
  // to a screen reader and wrap the tooltip onto two lines for everyone else.
  // It also kept a permanent "1 hidden by Settings" on the control in every git
  // repo, since `.git` is always on the junk list.
  const label = "File tree options";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              // Same footprint as its neighbours in the row. The armed chip
              // `toolbar-icon-button` paints on `data-state="open"` is the only
              // state this control needs to carry; what the filters are actually
              // doing is said in words under the tree, not crammed in here.
              className="toolbar-icon-button shrink-0 rounded-lg p-1.5 text-text-secondary"
              aria-label={label}
              data-testid={testId}
            >
              <SlidersHorizontal className={TOOLBAR_ICON_CLASS} aria-hidden="true" />
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
        <DropdownMenuSeparator />
        {/* An action, not a view setting, so it sits under its own rule at the
            bottom rather than among the things above it.

            Demoted from a dedicated header button on purpose. The tree already
            refreshes itself — the worktree watcher ticks it, and a 2s poll
            covers roots no watcher owns — so a permanently visible Refresh
            claimed a slot in a sub-300px header for something the user rarely
            has to reach for. Still exactly one Refresh in every layout: this
            menu is rendered by the tree header, or by the viewer's toolbar
            while the tree is collapsed away, never both (#11496, #11938). */}
        <DropdownMenuItem onSelect={onRefresh} data-testid="file-browser-refresh">
          <SpinningIcon
            icon={RefreshCw}
            active={isRefreshing}
            className={TOOLBAR_ICON_CLASS}
            aria-hidden="true"
          />
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
