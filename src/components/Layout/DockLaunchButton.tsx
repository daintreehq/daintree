import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Fuse, { type IFuseOptions } from "fuse.js";
import { Pin, PinOff, Plus, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { BrandMark, Workflow } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { cn } from "@/lib/utils";
import { isAgentBlocked, isAgentLaunchable } from "@shared/utils/agentAvailability";
import { isAgentButtonOnToolbar } from "@shared/utils/agentPinned";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import {
  getLauncherPanelButtonIdForKind,
  isPanelButtonOnToolbar,
  type LauncherPanelButtonId,
} from "@shared/types/toolbar";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { dispatchToolbarVisibility } from "@/lib/toolbarVisibilityDispatch";
import { normalizeKeyForBinding } from "@/services/keybindingUtils";
import { TOOLBAR_PIN_LABEL, TOOLBAR_UNPIN_LABEL } from "./toolbarMenuStrings";
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

/**
 * Swallows the second half of a pointer-then-click pair on one row, and a held
 * Alt+P. Keyed per target below, not one timestamp for the whole launcher, so
 * two different rows toggled in quick succession both land.
 */
const PIN_ACTION_GUARD_MS = 50;

/**
 * A row that can be pinned to the toolbar, resolved to the id the write path
 * actually takes. Agents and panels keep separate stores behind the one
 * affordance — `null` means the row has no toolbar representation at all
 * (recipes, the create-recipe cue, plugin panel kinds, non-built-in agents).
 */
type DockLaunchPinTarget =
  | { category: "agent"; key: string; id: BuiltInAgentId; name: string; onToolbar: boolean }
  | { category: "panel"; key: string; id: LauncherPanelButtonId; name: string; onToolbar: boolean };

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
  const inputRef = useRef<HTMLInputElement>(null);
  // Armed on the way out of a launch, spent by the shell's close-autofocus.
  // See activateRow.
  const suppressCloseAutoFocusRef = useRef(false);
  const listboxId = useId();
  const getOptionId = useCallback((rowKey: string) => `${listboxId}-${rowKey}`, [listboxId]);

  const model = useDockLaunchModel({
    agents,
    pinnedCount,
    activeWorktreeId,
    surface: "dock",
  });

  // Subscribed here rather than threaded down from ContentDock: the launcher
  // already owns its own model's store reads, and #11691 swaps this component
  // into the toolbar — where there is no ContentDock to compute props for it.
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);
  const agentAvailability = useCliAvailabilityStore((s) => s.availability);
  const pinnedButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.pinnedButtons));
  const leftButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.leftButtons));
  const rightButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.rightButtons));
  const setPanelButtonOnToolbar = useToolbarPreferencesStore((s) => s.setPanelButtonOnToolbar);
  const positionAgentButton = useToolbarPreferencesStore((s) => s.positionAgentButton);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);

  const resolvePinTarget = useCallback(
    (row: DockLaunchRow): DockLaunchPinTarget | null => {
      const { item } = row;
      if (!item) return null;

      if (item.category === "agent") {
        // Only built-in agents have a toolbar button id to write. A plugin or
        // user-defined agent is launchable here but can never reach the toolbar.
        if (!isBuiltInAgentId(item.agent.id)) return null;
        const id = item.agent.id;
        return {
          category: "agent",
          key: item.key,
          id,
          name: item.name,
          // The array-aware resolver, not `isAgentToolbarVisible`: an installed
          // agent with no position renders no button, and a pin icon that
          // claimed otherwise would be describing a button that isn't there.
          onToolbar: isAgentButtonOnToolbar(
            agentSettings?.agents?.[id],
            item.agent.availability,
            leftButtons.includes(id) || rightButtons.includes(id)
          ),
        };
      }

      if (item.category === "panel") {
        // Through the kind→button map, never `isLauncherPanelButtonId(kindId)`:
        // the dev preview kind is `dev-preview` and its button is `dev-server`,
        // so the direct test drops that row and nothing tells you it did.
        const id = getLauncherPanelButtonIdForKind(item.kindId);
        if (!id) return null;
        return {
          category: "panel",
          key: item.key,
          id,
          name: item.name,
          onToolbar: isPanelButtonOnToolbar(id, pinnedButtons, leftButtons, rightButtons),
        };
      }

      return null;
    },
    [agentSettings, leftButtons, pinnedButtons, rightButtons]
  );

  // Keyed on the item key rather than the row key, deliberately: the recency
  // band repeats agents that also appear under Pinned/Other, and those two rows
  // are one logical target that must not be toggled twice.
  const lastPinActionAt = useRef(new Map<string, number>());
  const togglePin = useCallback(
    (target: DockLaunchPinTarget) => {
      const now = Date.now();
      if (now - (lastPinActionAt.current.get(target.key) ?? -Infinity) < PIN_ACTION_GUARD_MS)
        return;
      lastPinActionAt.current.set(target.key, now);

      if (target.category === "agent") {
        // Through the shared dispatcher, not `setAgentPinned` directly: it is
        // what also gives a newly-pinned agent a toolbar position, and it is
        // what Settings → Toolbar calls. `onToolbar` is passed explicitly
        // because the dispatcher's own fallback derives the flip from
        // `isAgentToolbarVisible` — the predicate this row deliberately isn't
        // using, which would make the first click a no-op for an installed,
        // unpositioned agent.
        dispatchToolbarVisibility(
          target.id,
          "left",
          {
            agentSettings,
            agentAvailability,
            setAgentPinned,
            toggleButtonVisibility,
            positionAgentButton,
          },
          !target.onToolbar
        );
        return;
      }
      setPanelButtonOnToolbar(target.id, !target.onToolbar);
    },
    [
      agentAvailability,
      agentSettings,
      positionAgentButton,
      setAgentPinned,
      setPanelButtonOnToolbar,
      toggleButtonVisibility,
    ]
  );

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

  const clearQuery = useCallback(() => setQuery(""), [setQuery]);

  // The hook reconciles `selectedIndex` in an effect, so the render right after
  // the results change still holds the old index — which browsing can now leave
  // well past the end of a narrowed list, where the old menu always left it at
  // 0. Fall back to the top row (not the last) so this frame agrees with where
  // that effect settles; unhandled, it highlights nothing and Enter no-ops.
  const activeIndex =
    selectedIndex >= 0 && selectedIndex < results.length
      ? selectedIndex
      : results.length > 0
        ? 0
        : -1;
  const selectedRow = activeIndex >= 0 ? results[activeIndex] : undefined;
  const activeDescendant = selectedRow ? getOptionId(selectedRow.rowKey) : undefined;
  const selectedPinTarget = selectedRow ? resolvePinTarget(selectedRow) : null;

  const suppressTooltipDuringFocusRestore = useCallback(() => {
    setTooltipOpen(false);
    isRestoringFocusRef.current = true;
  }, []);

  // Read-and-disarm in one step, so a close the shell suppressed for its own
  // reasons still spends the flag rather than leaving it to fire on the next
  // Escape.
  const consumeCloseAutoFocusSuppression = useCallback(() => {
    const suppress = suppressCloseAutoFocusRef.current;
    suppressCloseAutoFocusRef.current = false;
    return suppress;
  }, []);

  // Re-anchor the selection each time the launcher opens. Closing only clears
  // the query, so the hook's follow-anchor still points wherever browsing
  // ended, while the reopened popover mounts its scroller at the top and the
  // active row keeps its id — so the scroll effect below never re-runs and
  // Enter launches a row that was never on screen.
  //
  // In an effect rather than the open handler: the Recently launched band is
  // rebuilt from MRU that can change while the launcher is closed without
  // re-rendering it, so the handler's closure would anchor a row the opening
  // render is about to displace. Gated on the transition because
  // `setSelectedIndex` takes a new identity every render (the hook's results
  // memo keys on an inline `getItemId`), and resetting on each of those would
  // undo the deliberate follow-the-selection behaviour while typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) setSelectedIndex(0);
    wasOpenRef.current = open;
  }, [open, setSelectedIndex]);

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
  const closeLauncher = useCallback(
    (suppressCloseAutoFocus = false) => {
      // Assigned on every close, never merely armed on the ones that launch.
      // Reopening inside the content's exit animation cancels Radix's unmount
      // outright, so that close never reaches close-autofocus and its answer is
      // left unspent — and the next Escape would spend it, losing the focus
      // return the launcher owes a dismissal that launched nothing.
      suppressCloseAutoFocusRef.current = suppressCloseAutoFocus;
      // Local state, not paletteId-backed — reset it ourselves so the next open
      // starts unfiltered on the Recently launched / Pinned bands.
      clearQuery();
      setOpen(false);
    },
    [clearQuery]
  );

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
      const { item } = row;
      // Everything closes through `closeLauncher`, so Radix cannot tell a
      // launch from an Escape and restores focus to the trigger either way —
      // landing a beat after the new panel took it, once the content's exit
      // animation ends (#11664). Cancel that return, but only for rows that
      // genuinely launch: the two branches below navigate instead, into
      // dialogs that manage their own focus, and their dispatch can fail — the
      // WAI-ARIA return is what keeps the keyboard somewhere useful if it does.
      //
      // Decided on intent, not outcome: every launch below is fire-and-forget,
      // so whether a panel actually appears is not knowable here. A launch that
      // fails outright (the hard panel limit, a recipe that spawns nothing)
      // therefore drops focus to the body rather than the trigger — the
      // accepted cost of not stealing focus on the overwhelmingly common path.
      const launches =
        item !== undefined &&
        // Mirrors the redirect in activateDockLaunchItem: an agent that isn't
        // launchable opens its settings subtab rather than a panel.
        (item.category !== "agent" || isAgentLaunchable(item.agent.availability));

      closeLauncher(launches);
      if (!item) {
        activateCreateRecipeCue(activeWorktreeId, "menu");
        return;
      }
      activateDockLaunchItem(item, {
        cwd,
        activeWorktreeId,
        recipeContext,
        onLaunchAgent,
        source: "menu",
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
        // No rows at all: swallow the key rather than letting it escape to
        // whatever is behind the launcher.
        event.preventDefault();
        event.stopPropagation();
        if (selectedRow) activateRow(selectedRow);
        return;
      }

      if (event.key === "Tab") return;

      // Alt+P pins the selected row. It has to be modified: this is a type-ahead
      // search box, so a bare "P" is the second letter of "python". Exactly Alt
      // — Cmd+P, Cmd+Shift+P and Cmd+Alt+P are all taken in
      // `defaultKeybindings.ts`, and requiring Alt alone leaves every one of
      // them reaching its own binding. `normalizeKeyForBinding` because macOS
      // reports Option+P as "π"; the AltGraph test because Windows/Linux AltGr
      // synthesizes ctrl+alt and must keep producing international characters.
      const isPinShortcut =
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.nativeEvent.getModifierState?.("AltGraph") &&
        normalizeKeyForBinding(event.nativeEvent).toLowerCase() === "p";
      if (isPinShortcut && selectedPinTarget) {
        event.preventDefault();
        event.stopPropagation();
        // Held keys repeat; a pin that flips on every repeat lands wherever the
        // user happened to let go.
        if (!event.repeat) togglePin(selectedPinTarget);
        return;
      }

      // Leave shortcuts alone — swallowing modified keys here would break app
      // keybindings while the launcher is open. Plain typing is still stopped
      // so a letter can't reach the dock's own key handling behind the popover;
      // propagation only, so the input still receives the key natively.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.stopPropagation();
    },
    [
      activateRow,
      results.length,
      selectedPinTarget,
      selectedRow,
      selectNext,
      selectPrevious,
      setSelectedIndex,
      togglePin,
    ]
  );

  return (
    <AppPalettePopover
      isOpen={open}
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
          <AppPalettePopover.Trigger asChild>
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
          </AppPalettePopover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="top">Open launcher</TooltipContent>
      </Tooltip>
      <AppPalettePopover.Content
        ariaLabel="Launch"
        tier="anchored"
        inputRef={inputRef}
        onClearQuery={clearQuery}
        onCloseAutoFocus={suppressTooltipDuringFocusRestore}
        consumeCloseAutoFocusSuppression={consumeCloseAutoFocusSuppression}
        side="top"
        align="start"
        sideOffset={4}
        // Width comes from the shell's anchored tier, so the launcher can't
        // drift away from the other menus it sits next to in the same keyboard
        // reflex — and doesn't wear a command palette's box for a list of
        // agents and panels.
        className="p-0"
        // Catch-all behind the input's own handler, for the frame before the
        // shell's refocus lands and for focus legitimately sitting on the
        // results region. Bubble phase, so the input and body still get first
        // refusal.
        onKeyDown={handleNavigationKeyDown}
      >
        <AppPaletteDialog.Header label="Launch">
          <AppPaletteDialog.Input
            inputRef={inputRef}
            value={query}
            // Deliberately NOT resetting the selection here: the palette hook's
            // own effect reconciles it, and calling its setter with the
            // pre-query results would stamp the old list's first row as the item
            // to follow — after which the effect chases that row into the new
            // results instead of settling on the top match. `activeIndex` above
            // covers the frame before it lands.
            onChange={(e) => setQuery(e.target.value)}
            onKeyDownCapture={handleNavigationKeyDown}
            placeholder="Search agents, panels, and recipes"
            role="combobox"
            // The listbox only exists when something matched, so claiming it
            // is expanded — or pointing aria-controls at an unrendered id —
            // would leave the combobox describing a popup that isn't there.
            aria-expanded={results.length > 0}
            aria-haspopup="listbox"
            aria-label="Search agents, panels, and recipes"
            aria-controls={results.length > 0 ? listboxId : undefined}
            aria-activedescendant={activeDescendant}
            autoComplete="off"
            spellCheck={false}
          />
        </AppPaletteDialog.Header>

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
                  isSelected={index === activeIndex}
                  showBandLabel={row.band !== results[index - 1]?.band}
                  optionId={getOptionId(row.rowKey)}
                  pinTarget={resolvePinTarget(row)}
                  onHover={setSelectedIndex}
                  onActivate={activateRow}
                  onTogglePin={togglePin}
                />
              ))}
            </div>
          )}
        </AppPaletteDialog.Body>
      </AppPalettePopover.Content>
    </AppPalettePopover>
  );
}

interface DockLaunchOptionProps {
  row: DockLaunchRow;
  index: number;
  isSelected: boolean;
  showBandLabel: boolean;
  optionId: string;
  /** Null for rows with no toolbar button to pin — the slot is still reserved. */
  pinTarget: DockLaunchPinTarget | null;
  onHover: (index: number) => void;
  onActivate: (row: DockLaunchRow) => void;
  onTogglePin: (target: DockLaunchPinTarget) => void;
}

function DockLaunchOption({
  row,
  index,
  isSelected,
  showBandLabel,
  optionId,
  pinTarget,
  onHover,
  onActivate,
  onTogglePin,
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
  const displayName = item ? item.name : "Create a recipe";
  // Where the row lands, or which recipe wins — rendered as the trailing label
  // and reused as the option's accessible name below.
  const qualifier = !item
    ? undefined
    : item.category === "panel"
      ? item.location === "dock"
        ? "Dock"
        : "Grid"
      : item.category === "recipe"
        ? item.isShadowed
          ? `${item.scopeLabel} · Overridden by Team`
          : item.scopeLabel
        : "Agent";

  return (
    <>
      {showBandLabel && (
        <div
          // Decorative inside the listbox — the band is conveyed by the row's
          // own trailing label, and an extra child would break option counting.
          aria-hidden="true"
          data-testid="dock-launcher-band"
          className={cn(PALETTE_SECTION_LABEL_CLASS, "px-2 pt-2 pb-1 first:pt-0")}
        >
          {DOCK_LAUNCH_BAND_LABELS[row.band]}
        </div>
      )}
      {/* A div, not a button: the pin control is a real button and one cannot
          nest inside another. Same split as ActionPaletteItem, which is where
          this palette family already solved a secondary action on an option. */}
      <div
        id={optionId}
        role="option"
        aria-selected={isSelected}
        // Stated, not computed from content: the pin button is a child, so a
        // content-derived name would end every pinnable row with "Pin to
        // toolbar: X". The destination stays in the name because it is the part
        // that says where activating lands you.
        aria-label={qualifier ? `${displayName}, ${qualifier}` : displayName}
        // Keeps DOM focus on the search box when a row is clicked or hovered,
        // so typing never lands anywhere else. preventDefault only — stopping
        // propagation here would hide the pointerdown from Radix's
        // DismissableLayer, which needs to see it to classify the next outside
        // click as a dismissal.
        onPointerDown={(event) => event.preventDefault()}
        onPointerEnter={() => onHover(index)}
        className={cn(
          PALETTE_ROW_CLASS,
          "group relative w-full flex items-center px-2 py-1.5 rounded-[var(--radius-md)] text-left text-sm",
          "hover:bg-overlay-subtle",
          isDimmed && "opacity-70"
        )}
      >
        <button
          type="button"
          tabIndex={-1}
          // Stays on the inner button rather than the row: it explains what
          // activating does, and the row now has a second control that does
          // something else entirely.
          title={title}
          onClick={() => onActivate(row)}
          className="flex-1 min-w-0 flex items-center bg-transparent border-0 p-0 text-left"
        >
          <DockLaunchOptionIcon row={row} />
          <span className="truncate">{displayName}</span>
          {qualifier && (
            <span className="ml-auto pl-2 text-[11px] text-text-muted shrink-0">{qualifier}</span>
          )}
        </button>

        {/* The slot is reserved on every row, not just pinnable ones. Opacity
            hides the control without releasing its box, so a recipe and an agent
            end their trailing labels on the same edge. */}
        <span className="ml-1 w-5 shrink-0">
          {pinTarget && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`${pinTarget.onToolbar ? TOOLBAR_UNPIN_LABEL : TOOLBAR_PIN_LABEL}: ${pinTarget.name}`}
              aria-pressed={pinTarget.onToolbar}
              aria-keyshortcuts="Alt+P"
              title={`${pinTarget.onToolbar ? TOOLBAR_UNPIN_LABEL : TOOLBAR_PIN_LABEL} (Alt+P)`}
              // preventDefault keeps focus on the search box; stopPropagation is
              // deliberately absent here and present on the click below, so the
              // pin never reaches `onActivate` while Radix still sees the
              // pointer sequence it needs.
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePin(pinTarget);
              }}
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] bg-transparent border-0",
                "transition-[opacity,color,background-color] hover:bg-overlay-soft hover:text-daintree-text",
                // Pinned rows read as state markers and stay visible; unpinned
                // ones are controls that only appear once the row is under the
                // pointer or the selection.
                pinTarget.onToolbar
                  ? "text-daintree-text/70 opacity-100"
                  : "text-daintree-text/40 opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100"
              )}
            >
              {pinTarget.onToolbar ? (
                <PinOff className="h-3 w-3" aria-hidden />
              ) : (
                <Pin className="h-3 w-3" aria-hidden />
              )}
            </button>
          )}
        </span>
      </div>
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
