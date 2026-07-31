import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { IFuseOptions } from "fuse.js";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { DockLaunchMenuItems, type DockLaunchMenuComponents } from "./DockLaunchMenuItems";
import {
  activateDockLaunchItem,
  useDockLaunchModel,
  type DockLaunchAgent,
  type DockLaunchItem,
} from "./dockLaunchItems";
import type { RecipeContext } from "@/utils/recipeVariables";

const DROPDOWN_COMPONENTS: DockLaunchMenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
};

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
  // Mirror AgentButton.tsx's tooltip-suppression pattern: when the dropdown
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

  const model = useDockLaunchModel({ agents, pinnedCount, activeWorktreeId });

  const { query, results, selectedIndex, setQuery, setSelectedIndex, selectPrevious, selectNext } =
    useSearchablePalette<DockLaunchItem>({
      items: model.searchItems,
      fuseOptions: DOCK_LAUNCH_FUSE_OPTIONS,
      getItemId: (item) => item.key,
      maxResults: 30,
      // Enter can land in the same tick as the last keystroke here, and a
      // deferred pass would rank it against the previous query — launching a
      // row the user never saw.
      deferFiltering: false,
    });

  // Read synchronously from Radix's document-level Escape handler, which fires
  // before React state has re-rendered.
  const queryRef = useRef(query);
  queryRef.current = query;

  const isFiltering = query.trim().length > 0;

  // The content only mounts while open, so this fires exactly on open. Radix's
  // own mount autofocus lands on the first menu item synchronously; the rAF is
  // required to run after it, otherwise the search box never keeps focus.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        setTooltipOpen(false);
      } else {
        // Local state, not paletteId-backed — reset it ourselves so the next
        // open starts unfiltered on the Recently launched / Pinned bands.
        setQuery("");
      }
    },
    [setQuery]
  );

  const handleKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Let an IME candidate window own the keystroke.
      if (event.nativeEvent.isComposing) return;

      if (event.key === "Escape") {
        // Dismissal itself is blocked in onEscapeKeyDown (Radix listens on
        // document with capture, so it runs before this handler); here we just
        // clear the query for that first press.
        if (queryRef.current.length > 0) {
          event.stopPropagation();
          setQuery("");
        }
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        selectNext();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        selectPrevious();
        return;
      }
      if (event.key === "Home" && isFiltering) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(0);
        return;
      }
      if (event.key === "End" && isFiltering) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(Math.max(0, results.length - 1));
        return;
      }
      if (event.key === "Enter") {
        if (!isFiltering) return;
        event.preventDefault();
        event.stopPropagation();
        const selected = results[selectedIndex];
        if (!selected) return;
        setOpen(false);
        activateDockLaunchItem(selected, {
          cwd,
          activeWorktreeId,
          recipeContext,
          onLaunchAgent,
          settingsSource: "menu",
        });
        return;
      }

      if (event.key === "Tab") return;
      // Everything else is ordinary text editing. Stop it reaching the menu so
      // Radix's typeahead doesn't jump focus to an item on each character;
      // propagation only, so the input still receives the key natively.
      event.stopPropagation();
    },
    [
      activeWorktreeId,
      cwd,
      isFiltering,
      onLaunchAgent,
      recipeContext,
      results,
      selectedIndex,
      selectNext,
      selectPrevious,
      setQuery,
      setSelectedIndex,
    ]
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <Tooltip
        open={tooltipOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen && isRestoringFocusRef.current) return;
          setTooltipOpen(nextOpen);
        }}
      >
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
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
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Open launcher</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={4}
        className="min-w-[16rem]"
        onPointerDownOutside={() => {
          wasPointerCloseRef.current = true;
        }}
        onEscapeKeyDown={(e) => {
          // The dismissable layer listens on document with capture, so a
          // stopPropagation from the input would be too late. Block the close
          // here for the first Escape; the input clears the query.
          if (queryRef.current.length > 0) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          setTooltipOpen(false);
          isRestoringFocusRef.current = true;
          if (wasPointerCloseRef.current) {
            e.preventDefault();
            wasPointerCloseRef.current = false;
          }
        }}
      >
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <Search className="w-3.5 h-3.5 shrink-0 text-text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="searchbox"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDownCapture={handleKeyDownCapture}
            placeholder="Search agents, panels, and recipes"
            aria-label="Search agents, panels, and recipes"
            aria-controls={listboxId}
            aria-activedescendant={
              isFiltering && results[selectedIndex]
                ? `${listboxId}-${results[selectedIndex]!.key}`
                : undefined
            }
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent text-sm text-daintree-text placeholder:text-text-muted outline-none border-none"
          />
        </div>
        <DropdownMenuSeparator />
        <div id={listboxId}>
          <DockLaunchMenuItems
            components={DROPDOWN_COMPONENTS}
            agents={agents}
            pinnedCount={pinnedCount}
            activeWorktreeId={activeWorktreeId}
            cwd={cwd}
            recipeContext={recipeContext}
            onLaunchAgent={onLaunchAgent}
            model={model}
            search={{
              query,
              results,
              selectedIndex,
              getOptionId: (key) => `${listboxId}-${key}`,
              onHoverIndex: setSelectedIndex,
            }}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
