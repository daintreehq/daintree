import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { Plus, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { BrandMark, Workflow } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { cn } from "@/lib/utils";
import { isAgentBlocked, isAgentLaunchable } from "@shared/utils/agentAvailability";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import {
  activateCreateRecipeCue,
  activateDockLaunchItem,
  useDockLaunchModel,
  DOCK_LAUNCH_BAND_LABELS,
  type DockLaunchAgent,
  type DockLaunchItem,
  type DockLaunchRow,
} from "./dockLaunchItems";
import type { RecipeContext } from "@/utils/recipeVariables";

// Same weighting as the ⌘⇧P panel palette so a name match outranks an alias or
// destination match across all three categories.
const DOCK_LAUNCH_FUSE_OPTIONS: IFuseOptions<DockLaunchItem> = {
  keys: [
    { name: "name", weight: 2 },
    { name: "searchAliases", weight: 1.5 },
    { name: "description", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

/** Ranked results are capped; the browse list always renders in full. */
const SEARCH_RESULT_CAP = 30;

interface DockLaunchButtonProps {
  agents: ReadonlyArray<DockLaunchAgent>;
  pinnedCount?: number;
  onLaunchAgent: (agentId: string) => void;
  activeWorktreeId: string | null;
  cwd: string;
  recipeContext?: RecipeContext;
}

export function DockLaunchButton({
  agents,
  pinnedCount,
  onLaunchAgent,
  activeWorktreeId,
  cwd,
  recipeContext,
}: DockLaunchButtonProps) {
  const [open, setOpen] = useState(false);
  // Mirror AgentButton.tsx's tooltip-suppression pattern: when the launcher
  // closes, Radix restores focus to the trigger and the tooltip would re-fire
  // on top of newly-launched panels. Hold suppression open until the next
  // genuine pointer hover (cleared via onPointerEnter).
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);
  // Set in onPointerDownOutside, read in onCloseAutoFocus. Lets us
  // preventDefault() the focus restoration only for pointer dismissals so the
  // launch pill doesn't keep its accent focus-visible ring; keyboard close
  // (Escape/Enter) still gets default focus return for WAI-ARIA.
  const wasPointerCloseRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const getOptionId = useCallback((rowKey: string) => `${listboxId}-${rowKey}`, [listboxId]);

  const model = useDockLaunchModel({
    agents,
    pinnedCount,
    activeWorktreeId,
    surface: "dock",
  });

  const fuse = useMemo(
    () => new Fuse(model.searchItems, DOCK_LAUNCH_FUSE_OPTIONS),
    [model.searchItems]
  );

  // One flat row list drives selection in both modes: browsing renders the
  // grouped bands, searching renders the ranked matches, and either way
  // `selectedIndex` indexes the same array. Fuse runs over the de-duplicated
  // `searchItems` so a recently-launched agent can't rank twice.
  const filterRows = useCallback(
    (rows: DockLaunchRow[], nextQuery: string): DockLaunchRow[] => {
      const trimmed = nextQuery.trim();
      if (!trimmed) return rows;
      return fuse
        .search(trimmed)
        .slice(0, SEARCH_RESULT_CAP)
        .map(({ item }) => ({ rowKey: item.key, band: "results" as const, item }));
    },
    [fuse]
  );

  const { query, results, selectedIndex, setQuery, setSelectedIndex, selectPrevious, selectNext } =
    useSearchablePalette<DockLaunchRow>({
      items: model.browseRows,
      filterFn: filterRows,
      getItemId: (row) => row.rowKey,
      // `filterRows` caps ranked search itself and the browse list must render
      // every row, so the hook's own cap must never truncate either one.
      maxResults: Number.MAX_SAFE_INTEGER,
      // Enter can land in the same tick as the last keystroke here, and a
      // deferred pass would rank it against the previous query — launching a
      // row the user never saw.
      deferFiltering: false,
    });

  // Read synchronously from Radix's document-level Escape handler, which fires
  // before React state has re-rendered. Written only from `updateQuery` (never
  // during render) so an abandoned concurrent render can't leave the ref
  // describing a query the user never committed.
  const queryRef = useRef(query);

  const updateQuery = useCallback(
    (next: string) => {
      queryRef.current = next;
      setQuery(next);
    },
    [setQuery]
  );

  const selectedRow = results[selectedIndex];
  const activeDescendant = selectedRow ? getOptionId(selectedRow.rowKey) : undefined;

  const focusInput = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Second focus attempt behind `onOpenAutoFocus`. `PopoverContent` renders
  // nothing until its lazily imported Radix chunk resolves, so on a cold click
  // this frame can fire before the input exists; on a warm one it runs after
  // the mount handler already focused it and is a harmless no-op. Neither
  // covers both orders alone.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(focusInput);
    return () => cancelAnimationFrame(frame);
  }, [open, focusInput]);

  // Keep the active option in view as the selection moves. `getElementById`
  // rather than a `#id` query: both `useId()` and the item keys contain colons,
  // which are illegal in a CSS id selector.
  useEffect(() => {
    if (!activeDescendant) return;
    document.getElementById(activeDescendant)?.scrollIntoView({ block: "nearest" });
  }, [activeDescendant]);

  // Single close path. Radix only calls onOpenChange for closes it initiates, so
  // the Enter-to-launch path (which sets `open` directly) would otherwise skip
  // the query reset and reopen still filtered.
  const closeLauncher = useCallback(() => {
    // Local state, not paletteId-backed — reset it ourselves so the next open
    // starts unfiltered on the Recently launched / Pinned bands.
    updateQuery("");
    setOpen(false);
  }, [updateQuery]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setOpen(true);
        setTooltipOpen(false);
      } else {
        closeLauncher();
      }
    },
    [closeLauncher]
  );

  const activateRow = useCallback(
    (row: DockLaunchRow) => {
      closeLauncher();
      if (!row.item) {
        activateCreateRecipeCue(activeWorktreeId, "menu");
        return;
      }
      activateDockLaunchItem(row.item, {
        cwd,
        activeWorktreeId,
        recipeContext,
        onLaunchAgent,
        settingsSource: "menu",
      });
    },
    [activeWorktreeId, closeLauncher, cwd, onLaunchAgent, recipeContext]
  );

  // Shared by the input and the results region, so navigation keeps working
  // after Tab moves focus onto the scroll container.
  const handleNavigationKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Let an IME candidate window own the keystroke. Chromium can emit
      // keyCode 229 before `isComposing` flips true, so both are checked —
      // the same pair guarded across the other palettes and terminal input.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

      // Escape is handled on the content's `onEscapeKeyDown`: Radix dismisses
      // from a document-level capture listener that runs before this one, so
      // clearing here would be too late to also veto the close.
      if (event.key === "Escape") return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "ArrowDown") selectNext();
        else selectPrevious();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(Math.max(0, results.length - 1));
        return;
      }
      if (event.key === "Enter") {
        // No row (or an out-of-range index): swallow the key rather than
        // letting it escape to whatever is behind the launcher.
        event.preventDefault();
        event.stopPropagation();
        const row = results[selectedIndex];
        if (row) activateRow(row);
        return;
      }

      if (event.key === "Tab") return;
      // Leave shortcuts alone — swallowing modified keys here would break app
      // keybindings while the launcher is open. Plain typing is still stopped
      // so a letter can't reach the dock's own key handling behind the popover;
      // propagation only, so the input still receives the key natively.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.stopPropagation();
    },
    [activateRow, results, selectedIndex, selectNext, selectPrevious, setSelectedIndex]
  );

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      // The DropdownMenu this replaced was modal, and the launcher relies on
      // that: focus stays trapped so Tab cycles input → results instead of
      // escaping to the dock behind it, and the first outside click is spent
      // dismissing rather than also activating what it landed on.
      modal={true}
    >
      <Tooltip
        open={tooltipOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen && isRestoringFocusRef.current) return;
          setTooltipOpen(nextOpen);
        }}
      >
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="pill"
              size="sm"
              className="px-2"
              aria-label="Open launcher"
              onPointerEnter={() => {
                isRestoringFocusRef.current = false;
              }}
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Open launcher</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={4}
        className="w-[22rem] p-0"
        onOpenAutoFocus={(event) => {
          // Radix would otherwise focus the content wrapper; the search box is
          // what the user is about to type into.
          event.preventDefault();
          focusInput();
        }}
        onPointerDownOutside={() => {
          wasPointerCloseRef.current = true;
        }}
        onEscapeKeyDown={(event) => {
          // The dismissable layer listens on document with capture, so a
          // stopPropagation from the input would be too late. Spend the first
          // Escape clearing the query and block the close here — whitespace
          // alone doesn't filter, so it must not cost the user a press.
          if (queryRef.current.trim().length > 0) {
            event.preventDefault();
            updateQuery("");
          }
        }}
        onCloseAutoFocus={(event) => {
          setTooltipOpen(false);
          isRestoringFocusRef.current = true;
          if (wasPointerCloseRef.current) {
            event.preventDefault();
            wasPointerCloseRef.current = false;
          }
        }}
      >
        <div
          data-testid="dock-launcher-search-row"
          // The header padding around the input is a click target that isn't
          // the input, and Radix's focus scope wrapper is tabIndex={-1}, so
          // clicking it parks focus on the content: Escape then dead-ends (the
          // content vetoes the close while only the input clears the query).
          // The input's own mousedown is left untouched so caret placement and
          // drag-select still work.
          onMouseDown={(event) => {
            if (event.target === inputRef.current) return;
            event.preventDefault();
            focusInput();
          }}
        >
          <AppPaletteDialog.Header label="Launch">
            <AppPaletteDialog.Input
              inputRef={inputRef}
              value={query}
              onChange={(e) => updateQuery(e.target.value)}
              onKeyDownCapture={handleNavigationKeyDown}
              placeholder="Search agents, panels, and recipes"
              role="combobox"
              aria-expanded={true}
              aria-haspopup="listbox"
              aria-label="Search agents, panels, and recipes"
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant}
              autoComplete="off"
              spellCheck={false}
              // The focus indicator is deliberately neutral: the selected row
              // owns this region's single accent anchor, and the input holds
              // focus the whole time the launcher is open, so an accent ring
              // here would be a permanently competing signal.
              className="focus:border-daintree-border focus:ring-daintree-border/30"
            />
          </AppPaletteDialog.Header>
        </div>

        <AppPaletteDialog.Body
          ariaLabel="Launcher results"
          activeDescendant={activeDescendant}
          onNavigationKeyDown={handleNavigationKeyDown}
        >
          {results.length === 0 ? (
            <AppPaletteDialog.Empty query={query} emptyMessage="Nothing to launch" />
          ) : (
            <div id={listboxId} role="listbox" aria-label="Launcher results">
              {results.map((row, index) => (
                <DockLaunchOption
                  key={row.rowKey}
                  row={row}
                  index={index}
                  isSelected={index === selectedIndex}
                  showBandLabel={row.band !== results[index - 1]?.band}
                  optionId={getOptionId(row.rowKey)}
                  onHover={setSelectedIndex}
                  onActivate={activateRow}
                />
              ))}
            </div>
          )}
        </AppPaletteDialog.Body>

        <AppPaletteDialog.Footer />
      </PopoverContent>
    </Popover>
  );
}

interface DockLaunchOptionProps {
  row: DockLaunchRow;
  index: number;
  isSelected: boolean;
  showBandLabel: boolean;
  optionId: string;
  onHover: (index: number) => void;
  onActivate: (row: DockLaunchRow) => void;
}

function DockLaunchOption({
  row,
  index,
  isSelected,
  showBandLabel,
  optionId,
  onHover,
  onActivate,
}: DockLaunchOptionProps) {
  const { item } = row;
  // A filtered row must carry the same warnings as its unfiltered twin: a
  // blocked agent that silently opens Settings, or a shadowed recipe that
  // resolves to a different winner, is worse when the row looks ordinary.
  const unavailableAgent =
    item?.category === "agent" && !isAgentLaunchable(item.agent.availability) ? item : null;
  const isDimmed = unavailableAgent !== null || (item?.category === "recipe" && item.isShadowed);
  const title = unavailableAgent
    ? isAgentBlocked(unavailableAgent.agent.availability)
      ? `${unavailableAgent.name} is blocked by endpoint security. Click to configure.`
      : `${unavailableAgent.name} needs setup. Click to configure.`
    : undefined;

  return (
    <>
      {showBandLabel && (
        <div
          // Decorative inside the listbox — the band is conveyed by the row's
          // own trailing label, and an extra child would break option counting.
          aria-hidden="true"
          data-testid="dock-launcher-band"
          className="px-2 pt-2 pb-1 text-[11px] text-text-muted select-none first:pt-0"
        >
          {DOCK_LAUNCH_BAND_LABELS[row.band]}
        </div>
      )}
      <button
        type="button"
        id={optionId}
        role="option"
        aria-selected={isSelected}
        tabIndex={-1}
        title={title}
        // Keeps DOM focus on the search box when a row is clicked or hovered,
        // so typing never lands anywhere else.
        onPointerDown={(event) => event.preventDefault()}
        onPointerEnter={() => onHover(index)}
        onClick={() => onActivate(row)}
        className={cn(
          "relative w-full flex items-center px-2 py-1.5 rounded-[var(--radius-md)] text-left text-sm transition-colors",
          isDimmed && "opacity-70",
          isSelected
            ? "bg-overlay-raised before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[2px] before:bg-daintree-accent before:content-['']"
            : "hover:bg-overlay-subtle"
        )}
      >
        <DockLaunchOptionIcon row={row} />
        <span className="truncate">{item ? item.name : "Create a recipe"}</span>
        {item && (
          <span className="ml-auto pl-2 text-[11px] text-text-muted shrink-0">
            {item.category === "panel"
              ? item.location === "dock"
                ? "Dock"
                : "Grid"
              : item.category === "recipe"
                ? item.isShadowed
                  ? `${item.scopeLabel} · Overridden by Team`
                  : item.scopeLabel
                : "Agent"}
          </span>
        )}
      </button>
    </>
  );
}

function DockLaunchOptionIcon({ row }: { row: DockLaunchRow }) {
  const { item } = row;
  if (!item || item.category === "recipe") {
    return <Workflow className="w-3.5 h-3.5 mr-2 shrink-0" />;
  }
  if (item.category === "panel") {
    return <PanelKindIcon iconId={item.iconId} color={item.color} size={14} className="mr-2" />;
  }
  return item.agent.icon ? (
    <BrandMark brandColor={item.agent.brandColor} className="w-3.5 h-3.5 mr-2">
      <item.agent.icon className="w-3.5 h-3.5" brandColor={item.agent.brandColor} />
    </BrandMark>
  ) : (
    <SquareTerminal className="w-3.5 h-3.5 mr-2 shrink-0" />
  );
}
