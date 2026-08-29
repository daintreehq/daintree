import { useRef, useState } from "react";
import { ChevronsDownUp, RefreshCw, SlidersHorizontal } from "lucide-react";
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
  /**
   * Collapses every expanded branch. Standard in comparable trees (VS Code,
   * JetBrains, Xcode) and previously absent here entirely — the only way back
   * from a deep tree was collapsing each branch by hand.
   */
  onCollapseAll: () => void;
  /** False when nothing is expanded, so the item cannot promise a no-op. */
  canCollapseAll: boolean;
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
  onCollapseAll,
  canCollapseAll,
  "data-testid": testId,
}: FileBrowserViewOptionsProps) {
  // Just the name. What the filters are doing is announced by the strip under
  // the tree, which is a live region, so repeating it here would say it twice
  // to a screen reader and wrap the tooltip onto two lines for everyone else.
  // It also kept a permanent "1 hidden by Settings" on the control in every git
  // repo, since `.git` is always on the junk list.
  const label = "File tree options";

  // Radix opens tooltips on FOCUS as well as hover, and hands focus back to the
  // trigger when the menu closes — so selecting an item left this trigger's
  // tooltip hanging open under a pointer that was never on it.
  //
  // Suppressed LOCALLY rather than through `dismissAllTooltips()`. The global
  // call is for surfaces that can strand a tooltip anywhere (dialogs); this menu
  // knows exactly which tooltip is about to reopen, and closing every registered
  // tooltip in the app to fix one of them is the blanket wiring #11034 rejected.
  // Same shape as `AgentButton`: a controlled tooltip plus a restoring flag.
  //
  // Armed inside `onCloseAutoFocus`, immediately before Radix moves focus,
  // rather than when the close begins — Radix defers restoration past the menu's
  // 120ms exit animation, so a window armed at close-time is racing a stall it
  // does not need to race.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);
  // Set in onPointerDownOutside, read in onCloseAutoFocus: dismissing by
  // clicking AWAY should leave no focus ring, and the clicked target takes
  // focus itself. Deliberately NOT set for clicks on items — Radix has already
  // unmounted the item by then, so preventing restoration there does not mean
  // "focus without a ring", it means focus falls to document.body and the
  // keyboard user is stranded.
  const wasPointerCloseRef = useRef(false);
  // Set when a POINTER actually activated a menu item, as opposed to the
  // keyboard doing it. Radix implements Enter/Space selection by calling
  // `.click()` on the item, and a synthetic click carries `detail === 0` where
  // a real one carries 1 or more — so the pair of "landed on an item" and
  // "detail > 0" separates the two without guessing. Clicks that land on
  // padding, a label or a separator match neither and leave this alone, which
  // matters because those do not close the menu and would otherwise strand the
  // flag onto whatever gesture does.
  const wasPointerSelectRef = useRef(false);
  // Whether a pointer has been pressed inside the menu during this opening.
  // `detail` alone is not quite enough: Radix has a pointer-up fallback that
  // calls `.click()` when the press did not start on the item being released
  // over, and that synthetic click carries `detail === 0` like a keyboard one.
  // Pressing inside the content is something the keyboard cannot do, so it
  // separates that case without claiming any real keyboard path.
  const pointerInsideRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <DropdownMenu
      onOpenChange={(next) => {
        if (!next) return;
        wasPointerCloseRef.current = false;
        wasPointerSelectRef.current = false;
        pointerInsideRef.current = false;
      }}
    >
      <Tooltip
        open={tooltipOpen}
        onOpenChange={(next) => {
          // A focus-driven open during restoration is exactly what this exists
          // to swallow; a genuine hover still opens it, because pointerenter
          // clears the flag first.
          if (next && isRestoringFocusRef.current) return;
          setTooltipOpen(next);
        }}
      >
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              // Same footprint as its neighbours in the row. The armed chip
              // `toolbar-icon-button` paints on `data-state="open"` is the only
              // state this control needs to carry; what the filters are actually
              // doing is said in words under the tree, not crammed in here.
              className="toolbar-icon-button shrink-0 rounded-lg p-1.5 text-text-secondary"
              aria-label={label}
              data-testid={testId}
              onPointerEnter={() => {
                isRestoringFocusRef.current = false;
              }}
            >
              <SlidersHorizontal className={TOOLBAR_ICON_CLASS} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="min-w-[200px]"
        onPointerDown={() => {
          pointerInsideRef.current = true;
        }}
        onPointerDownOutside={() => {
          wasPointerCloseRef.current = true;
        }}
        onClick={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          const item = target?.closest(
            '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]'
          );
          // Must have landed on an item either way — a press on padding or a
          // label closes nothing, so claiming it would strand the flag onto
          // whatever gesture does close the menu.
          const onItem = item !== null && item !== undefined;
          wasPointerSelectRef.current = onItem && (event.detail > 0 || pointerInsideRef.current);
        }}
        onCloseAutoFocus={(event) => {
          // Always, whichever way it closed: focus is about to land on the
          // trigger and would drag the tooltip open with it.
          setTooltipOpen(false);
          isRestoringFocusRef.current = true;

          // Clicked away: the clicked target owns focus, so there is nothing to
          // restore and no ring to leave behind.
          if (wasPointerCloseRef.current) {
            event.preventDefault();
            wasPointerCloseRef.current = false;
            wasPointerSelectRef.current = false;
            pointerInsideRef.current = false;
            return;
          }

          // Clicked an item: focus still has to come back here, or it falls to
          // document.body and a keyboard user is stranded. But Radix's own
          // restoration is a bare `.focus()`, and Chromium paints
          // `:focus-visible` on a programmatic focus — so a mouse user who never
          // asked for a focus ring gets the accent one anyway. Take the
          // restoration over and ask for the focus WITHOUT the visible state.
          if (wasPointerSelectRef.current) {
            event.preventDefault();
            wasPointerSelectRef.current = false;
            pointerInsideRef.current = false;
            triggerRef.current?.focus({ preventScroll: true, focusVisible: false });
            return;
          }

          // Keyboard close: Radix restores focus and the ring comes with it,
          // which is exactly right for someone driving from the keyboard.
        }}
      >
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
        {/* `inset` plus an absolutely-placed glyph at left-2 is exactly the
            geometry the radio and checkbox items above use for their check
            indicators, so this row's label lands on the same left edge as
            theirs instead of sitting a few pixels out with its icon jammed
            against the text. */}
        <DropdownMenuItem
          inset
          disabled={!canCollapseAll}
          onSelect={onCollapseAll}
          data-testid="file-browser-collapse-all"
        >
          <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
            <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          Collapse all
        </DropdownMenuItem>
        <DropdownMenuItem inset onSelect={onRefresh} data-testid="file-browser-refresh">
          <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
            <SpinningIcon
              icon={RefreshCw}
              active={isRefreshing}
              className="h-3.5 w-3.5"
              aria-hidden="true"
            />
          </span>
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
