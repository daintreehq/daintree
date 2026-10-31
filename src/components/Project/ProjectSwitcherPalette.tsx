import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { isPointerClaimed } from "@/lib/pointerClaim";
import { FolderOpen, FolderPlus, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FolderDown } from "@/components/icons";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { describeKeyCap } from "@/lib/kbdShortcut";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";
import { KbdChord } from "@/components/ui/Kbd";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { formatFleetLiveness } from "@/lib/projectRowStatus";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useModifierKeys } from "@/hooks/useModifierKeys";
import { useOverlayClaim } from "@/hooks";
import type {
  ProjectSwitcherBrowseBand,
  ProjectSwitcherMode,
  ProjectSwitcherRow,
  ProjectSwitchSelectSource,
  SearchableProject,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import { usePilotStore } from "@/store/pilotStore";
import { pluralize } from "@/lib/pluralize";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { keyBelongsToField } from "@/hooks/useListboxCursor";
import { HostNameText } from "@/components/Hosts/HostNameText";
import { CommandTile, StatusSlotSpacer } from "./paletteTiles";
import {
  OTHER_HOSTS_LIST_ID,
  OtherHostsSection,
  useCurrentHostName,
  activateOtherHostOption,
  otherHostOptionCloses,
  otherHostOptionId,
  useOtherHostProjectOptions,
  type OtherHostOption,
} from "@/components/Hosts/OtherHostsSection";
import { isNewWindowClick } from "@/components/Hosts/hostSwitching";
import {
  getOtherHostEnterHint,
  getProjectSwitcherEnterHint,
  modEnterOpensWindow,
} from "./ProjectSwitcherRows";
import { ProjectListContent } from "./ProjectSwitcherBands";
import { ScratchSection } from "./ProjectSwitcherScratchSection";
import {
  ProjectSwitcherConfirmDialogs,
  type ProjectSwitcherConfirmState,
} from "./ProjectSwitcherConfirmDialogs";

export {
  canSleepProject,
  getNewWindowMenuLabel,
  getOtherHostEnterHint,
  getProjectSwitcherEnterHint,
} from "./ProjectSwitcherRows";
export { formatScratchCleanupCountdown } from "./ProjectSwitcherScratchSection";

export interface ProjectSwitcherPaletteProps extends ProjectSwitcherConfirmState {
  isOpen: boolean;
  query: string;
  /**
   * Mixed once a query is active — narrow on `kind` before reading anything a
   * scratch row doesn't carry.
   */
  results: ProjectSwitcherRow[];
  /**
   * Browse's bands, headers included for ones the user folded away — those hold
   * no rows in `results`, so nothing else can report that they exist (#11943).
   */
  browseBands?: ProjectSwitcherBrowseBand[];
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  /** Commits any row. Project-only callbacks below stay typed to projects. */
  onSelect: (row: ProjectSwitcherRow, source?: ProjectSwitchSelectSource) => void;
  onClose: () => void;
  mode?: ProjectSwitcherMode;
  onAddProject?: () => void;
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onSleepProject?: (projectId: string) => void;
  onRestartProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  /** Pointer-enter callback used to schedule a hover prefetch of the project's hydrate payload. */
  onHoverProject?: (projectId: string, pointerType: string) => void;
  /** Pointer-leave callback used to cancel a pending hover prefetch. */
  onHoverProjectEnd?: (pointerType: string) => void;
  /**
   * Moves the palette's one cursor to the row under the pointer, so the row the
   * pointer lights is the row Enter commits. Fired on `pointermove`, never
   * `pointerenter`: rows scrolling under a resting pointer must not steal it.
   */
  onHoverRow?: (rowId: string) => void;
  onOpenProjectSettings?: () => void;
  /**
   * What is executing across every workspace, for the header's one-line answer
   * to "is it safe to look away?" (#11832).
   *
   * Deliberately not derived from `results`, which is filtered and reordered for
   * presentation — a search for one project would otherwise report the fleet as
   * quiet. Optional because it is a summary: a caller without the totals shows
   * no line, which is the same thing an idle fleet shows.
   */
  fleetLiveness?: { runningAgentCount: number; workingAssistantCount: number };
  dropdownAlign?: "start" | "center" | "end";
  /**
   * Fired when the dropdown's Popover restores focus to its trigger on close.
   * Lets the trigger (e.g. ProjectSwitcher) suppress a Radix Tooltip from
   * reopening on the refocused trigger after a project switch. Dropdown-only.
   */
  onDropdownCloseAutoFocus?: () => void;
  /** Dropdown only: whether this close must not return focus to the trigger. */
  consumeCloseAutoFocusSuppression?: () => boolean;
  children?: React.ReactNode;
  /** Scratch (one-off agent workspace) results — rendered in their own collapsible section. */
  /**
   * True while `results` is the ranked list carrying the scratches, so the
   * pinned section below can stand down. Trails the query by a commit; defaults
   * to the live query for callers that don't track it.
   */
  rankedSearch?: boolean;
  scratchResults?: SearchableScratch[];
  /** Callback to create and switch to a new scratch. A blank name takes the default. */
  onCreateScratch?: (name?: string) => void;
  /** Callback to switch to an existing scratch. */
  onSelectScratch?: (scratch: SearchableScratch) => void;
  /** Opens the single-scratch delete confirmation from the row's context menu. */
  onRequestDeleteScratch?: (scratchId: string) => void;
  /** Opens the "delete every scratch" confirmation, from either the visible button or the section header's context menu. */
  onRequestDeleteAllScratches?: () => void;
  /** Callback to rename a scratch in place. */
  onRenameScratch?: (scratchId: string, name: string) => void;
  /** Callback to save a scratch as a regular project (copy + register). */
  onSaveAsProject?: (scratchId: string) => void;
}

/** Matches the resolution of the wait ages on screen — they change by the minute. */
const WAIT_AGE_TICK_MS = 60_000;

/**
 * Re-renders once a minute so wait ages advance while the palette sits open.
 *
 * Ages are derived from a timestamp at render time, and the stats service
 * suppresses broadcasts whose payload hasn't changed — so without a tick, an
 * agent that has been waiting eleven minutes keeps reading "just now" for as
 * long as nothing else happens.
 *
 * Lives at the palette level rather than inside the project list: the pinned
 * scratch section is a sibling of that list, so a tick held there re-rendered
 * everything except the rows it now also has to keep current (#11518).
 */
function useWaitAgeTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((value) => value + 1), WAIT_AGE_TICK_MS);
    return () => clearInterval(id);
  }, [active]);
}

/**
 * Every hint here is project-only, so a highlighted scratch row drops them
 * rather than naming affordances it doesn't have: ⌘↵ falls back to a plain
 * switch, and a search-mode scratch row carries no context menu.
 */
function ProjectSwitcherFooter({
  selectedRow,
  hostOption,
  canOpenWindow,
  onOpenPilot,
}: {
  /** The other-hosts row under the cursor; it takes the hint over `selectedRow`. */
  hostOption?: OtherHostOption;
  /**
   * Undefined when nothing is highlighted — an empty list, or every band folded
   * (#11943). Enter no-ops there, so naming it would be the footer promising an
   * action the keypress does not perform.
   */
  selectedRow: ProjectSwitcherRow | undefined;
  /** Whether ⌘↵ has a new-window handler to go to at all. */
  canOpenWindow: boolean;
  onOpenPilot: () => void;
}) {
  const modifiers = useModifierKeys();
  // Resolved, not hardcoded: the literal would be wrong on Windows/Linux and
  // wrong for anyone who rebound or removed the binding.
  const pilotShortcut = useEffectiveCombo("pilot.toggle");

  const hasSelection = selectedRow !== undefined;
  const isScratchSelected = selectedRow?.kind === "scratch";
  const hint: ReturnType<typeof getOtherHostEnterHint> = hostOption
    ? getOtherHostEnterHint(hostOption, modifiers.meta)
    : getProjectSwitcherEnterHint(selectedRow, modifiers.meta, canOpenWindow);

  return (
    // Container-queried rather than fixed: the same footer serves the anchored
    // dropdown and the wider command-tier modal. "Right-click for more" names
    // no key and is the lowest-priority rail, so it is the one that drops on
    // the narrower tier, leaving the Enter action and "All agents" (the only
    // affordance with no other entry point). Tailwind needs each variant
    // written out, so it is a literal.
    //
    // There is no ⌘⌫ Remove rail. It was cut while the anchored tier was 352px
    // and the rail overflowed; #11736 widened that tier back to 484px, so the
    // room objection is gone and restoring it is a live option — just not one a
    // width fix should decide. Remove stays reachable from the row's context
    // menu and from ⌘⌫ itself, and both open the same confirmation.
    <div className="@container/switcher-footer w-full flex items-center justify-between gap-3">
      {hint ? (
        <span className="flex min-w-0 items-center">
          <span className="sr-only">{describeKeyCap(hint.keys, isMac())}</span>
          <kbd aria-hidden="true" className={cn(KBD_CLASS, "shrink-0")}>
            {hint.keys}
          </kbd>
          {hint.host ? (
            <span className="ml-1.5 flex min-w-0">
              <span className="shrink-0 whitespace-pre">{`${hint.label} `}</span>
              <HostNameText name={hint.host} />
            </span>
          ) : (
            <span className="ml-1.5 whitespace-nowrap">{hint.label}</span>
          )}
        </span>
      ) : (
        // Holds the rail's left slot so "All agents" stays put rather than
        // sliding across as the last band folds.
        <span className="shrink-0" />
      )}
      <div className="flex shrink-0 items-center gap-3">
        {/*
          The switcher answers "which project", so the fleet-wide view belongs
          beside it rather than inside its list: adding a row would put a
          non-workspace entry into a listbox whose every other row is a
          workspace, and into the arrow-key domain that selects one.
        */}
        <button
          type="button"
          onClick={onOpenPilot}
          className="inline-flex items-center shrink-0 text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary"
          data-testid="project-switcher-open-pilot"
          {...(pilotShortcut ? { "aria-keyshortcuts": pilotShortcut } : {})}
        >
          {pilotShortcut && <KbdChord shortcut={pilotShortcut} />}
          <span className={pilotShortcut ? "ml-1.5" : undefined}>All agents</span>
        </button>
        {hasSelection && !isScratchSelected && (
          <span className="text-text-secondary shrink-0 @max-[520px]/switcher-footer:hidden">
            Right-click for more
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The plain commands under the divider — Project Settings, Open Project, Clone,
 * Create Folder. Full-bleed on purpose: they never take the roving cursor, so
 * they must not wear the ranked rows' card shape, which is what marks the
 * arrow-key domain (`PALETTE_ROW_CLASS`). Losing the inset means `px-3` is now
 * the row's own edge, landing its content on the header's and footer's column
 * instead of an inset nothing else in the palette shares.
 *
 * The focus ring is inset for the same reason. The palette clips to
 * `overflow-hidden`, so a ring drawn outside a full-width row loses its left
 * and right sides at the dialog edge; `-outline-offset-2` keeps all four.
 * `palette-command-row` is not styling — like `palette-row` next to it, it is
 * the handle the `forced-colors: active` block in `index.css` needs, where a
 * global `outline-offset: 2px !important` would otherwise push the ring back
 * out past that same edge.
 */
/**
 * A palette-level command: the actions under the divider, which act on the
 * project list rather than on a workspace in it.
 *
 * Full-bleed rather than a card, because the cards above it are the arrow-key
 * domain and these rows are reached by Tab. That distinction is carried by the
 * focus ring, not by the shape — the shape only says which half of the palette
 * a row belongs to.
 */
function ProjectCommandRow({
  icon,
  tone,
  label,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  tone: "manage" | "create";
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={PROJECT_ACTION_ROW_CLASS}
      data-testid={testId}
    >
      <StatusSlotSpacer />
      <CommandTile icon={icon} tone={tone} />
      <span className="font-medium text-sm leading-tight">{label}</span>
    </button>
  );
}

const PROJECT_ACTION_ROW_CLASS = cn(
  "palette-command-row w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
  // Horizontal only. The rows above reserve a full border for their selected
  // state, and matching it here keeps the two families' content boxes on the
  // same pixel — but nothing ever draws a border on a command row, so the
  // vertical halves were 2px of pure height, pushing the block off the 48px
  // its tile and `py-2` add up to.
  "border-x border-transparent",
  "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary",
  PALETTE_ROW_FOCUS_CLASS
);

interface ProjectPaletteInnerProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  results: ProjectSwitcherRow[];
  browseBands?: ProjectSwitcherBrowseBand[];
  selectedIndex: number;
  mode?: ProjectSwitcherMode;
  onQueryChange: (query: string) => void;
  onSelect: (row: ProjectSwitcherRow, source?: ProjectSwitchSelectSource) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onClose: () => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onAddProject?: () => void;
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
  onOpenProjectSettings?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onSleepProject?: (projectId: string) => void;
  onRestartProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
  /**
   * Moves the palette's one cursor to the row under the pointer, so the row the
   * pointer lights is the row Enter commits. Fired on `pointermove`, never
   * `pointerenter`: rows scrolling under a resting pointer must not steal it.
   */
  onHoverRow?: (rowId: string) => void;
  /**
   * True while `results` is the ranked list carrying the scratches, so the
   * pinned section below can stand down. Trails the query by a commit; defaults
   * to the live query for callers that don't track it.
   */
  rankedSearch?: boolean;
  scratchResults?: SearchableScratch[];
  onCreateScratch?: (name?: string) => void;
  onSelectScratch?: (scratch: SearchableScratch) => void;
  onRequestDeleteScratch?: (scratchId: string) => void;
  onRequestDeleteAllScratches?: () => void;
  onRenameScratch?: (scratchId: string, name: string) => void;
  onSaveAsProject?: (scratchId: string) => void;
  fleetLiveness?: { runningAgentCount: number; workingAssistantCount: number };
}

function ProjectPaletteInner({
  inputRef,
  listRef,
  query,
  results,
  browseBands,
  selectedIndex,
  mode,
  onQueryChange,
  onSelect,
  onSelectNewWindow,
  onClose,
  onSelectPrevious,
  onSelectNext,
  onAddProject,
  onCloneRepo,
  onCreateFolder,
  onOpenProjectSettings,
  onStopProject,
  onCloseProject,
  onSleepProject,
  onRestartProject,
  onLocateProject,
  onMoveOrRenameProject,
  onTogglePinProject,
  onCopyPath,
  onHoverProject,
  onHoverProjectEnd,
  onHoverRow,
  rankedSearch,
  scratchResults,
  onCreateScratch,
  onSelectScratch,
  onRequestDeleteScratch,
  onRequestDeleteAllScratches,
  onRenameScratch,
  onSaveAsProject,
  fleetLiveness,
}: ProjectPaletteInnerProps) {
  const projectSwitcherShortcut = useEffectiveCombo("project.switcherPalette");
  const fleetSummary = fleetLiveness ? formatFleetLiveness(fleetLiveness) : null;

  // Other hosts' rows are the tail of the arrow-key order: ArrowDown off the
  // last result enters them, and moving past either end wraps back into
  // `results`, the same wrap the hook applies inside them. The hook owns the
  // selection within `results`; this cursor exists only while it sits in the
  // band, and only for the query it was set under. It holds a row's key, never
  // its position: hosts connect and drop while the palette is open, and a
  // position would hand Enter whichever row slid into it (#13290).
  const {
    groups: hostGroups,
    options: hostOptions,
    remoteNames,
  } = useOtherHostProjectOptions(query);
  const [hostCursorState, setHostCursorState] = useState<{
    query: string;
    key: string;
    /** Placed for an empty result list rather than moved to; local results take it back. */
    auto?: boolean;
  } | null>(null);
  const claimedHostIndex =
    hostCursorState !== null &&
    hostCursorState.query === query &&
    !(hostCursorState.auto && results.length > 0)
      ? hostOptions.findIndex((option) => option.key === hostCursorState.key)
      : -1;
  // Nothing here matched: the first project another host offers is what Enter
  // opens, the way the first result is when there are results. A search that
  // named only a host lands on that host's own row instead.
  const firstHostProject = hostOptions.findIndex(
    (option) => option.kind === "project" || option.kind === "worktree"
  );
  const defaultHostIndex =
    results.length > 0
      ? -1
      : firstHostProject >= 0
        ? firstHostProject
        : (rankedSearch ?? query.trim().length > 0) && hostOptions.length > 0
          ? 0
          : -1;
  const hostIndex = claimedHostIndex >= 0 ? claimedHostIndex : defaultHostIndex;
  const hostCursor = hostIndex >= 0 ? hostIndex : null;
  const activeHostOption: OtherHostOption | undefined =
    hostCursor === null ? undefined : hostOptions[hostCursor];
  // The automatic pick is held by key like a chosen one, so a host answering
  // later, with rows drawn above it, can't move what Enter opens.
  const defaultHostKey =
    claimedHostIndex < 0 && defaultHostIndex >= 0 ? hostOptions[defaultHostIndex]!.key : null;
  // A claim belongs to the query it was made under; left in place it would
  // come back when the query is cleared, pointing Enter at a row nobody chose.
  useEffect(() => {
    setHostCursorState((prev) => (prev !== null && prev.query !== query ? null : prev));
  }, [query]);
  useEffect(() => {
    if (defaultHostKey !== null) setHostCursorState({ query, key: defaultHostKey, auto: true });
  }, [defaultHostKey, query]);
  const setHostCursor = (index: number | null) => {
    const option = index === null ? undefined : hostOptions[index];
    setHostCursorState(option ? { query, key: option.key } : null);
  };
  const resultsCursor = hostCursor === null ? selectedIndex : -1;

  // The hook only steps relative to its own selection (its updater composes
  // batched steps), so returning from the band is a walk the short way round.
  const moveResultsSelectionTo = (target: number) => {
    const count = results.length;
    const from = selectedIndex >= 0 && selectedIndex < count ? selectedIndex : 0;
    const forward = (target - from + count) % count;
    const backward = (from - target + count) % count;
    if (forward <= backward) for (let i = 0; i < forward; i += 1) onSelectNext();
    else for (let i = 0; i < backward; i += 1) onSelectPrevious();
  };

  const activeHostOptionId = activeHostOption ? otherHostOptionId(activeHostOption) : null;
  // Rows a host adds above the cursor push it down without changing its id, and
  // so do a listing host's header and a path line a query earns; the band's
  // shape is a reason to bring the cursor back into view too.
  const hostRowsShape = hostGroups
    .map((group) =>
      [
        group.hostId,
        ...group.options.map((option) =>
          option.kind === "project" && option.showPath ? `${option.key}+path` : option.key
        ),
      ].join(" ")
    )
    .join("\n");
  useEffect(() => {
    if (activeHostOptionId === null) return;
    document.getElementById(activeHostOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeHostOptionId, hostRowsShape]);

  /**
   * Puts the cursor on a position in the whole arrow-key order: `results`,
   * then the other hosts' rows.
   */
  const moveCursorTo = (position: number) => {
    if (position >= results.length) {
      setHostCursor(position - results.length);
      return;
    }
    setHostCursor(null);
    if (onHoverRow) onHoverRow(results[position]!.id);
    else moveResultsSelectionTo(position);
  };

  useEffect(() => {
    if (hostCursor !== null) return;
    if (listRef.current && selectedIndex >= 0 && selectedIndex < results.length) {
      const selectedItem = listRef.current.querySelector(
        `#project-option-${results[selectedIndex]!.id}`
      );
      // A row under the pointer was just claimed by it; revealing it would
      // scroll a half-visible row out from under the pointer.
      if (selectedItem && !isPointerClaimed(selectedItem)) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [listRef, selectedIndex, results, hostCursor]);

  /** Rows that fit in the scroller, less one so a page keeps a row of context. */
  const pageStep = () => {
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>("[tabindex]") ?? list;
    const row = list?.querySelector<HTMLElement>('[role="option"]');
    if (!scroller || !row || row.offsetHeight === 0) return 5;
    return Math.max(1, Math.floor(scroller.clientHeight / row.offsetHeight) - 1);
  };

  /**
   * Opens a row's context menu from the keyboard, anchored under its name. The
   * menu returns focus to the search box when it closes (see `ProjectListItem`).
   */
  const openRowMenu = (rowId: string) => {
    const row = document.getElementById(`project-option-${rowId}`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 48,
        clientY: rect.bottom,
      })
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // An IME spends Enter, the arrows and Escape on its candidate window, so
    // none of them may reach the list while a composition is open — Enter would
    // switch projects on the keypress meant to commit a character.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
      // Kept from the dialog's document backstop too, which would otherwise
      // read a composing Escape as "close".
      if (e.key === "Escape") e.stopPropagation();
      return;
    }
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        if (hostCursor !== null) {
          if (hostCursor > 0) setHostCursor(hostCursor - 1);
          else if (results.length > 0) {
            setHostCursor(null);
            moveResultsSelectionTo(results.length - 1);
          } else setHostCursor(hostOptions.length - 1);
        } else if (hostOptions.length > 0 && (results.length === 0 || selectedIndex <= 0)) {
          setHostCursor(hostOptions.length - 1);
        } else {
          onSelectPrevious();
        }
        break;
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        if (hostCursor !== null) {
          if (hostCursor < hostOptions.length - 1) setHostCursor(hostCursor + 1);
          else if (results.length > 0) {
            setHostCursor(null);
            moveResultsSelectionTo(0);
          } else setHostCursor(0);
        } else if (
          hostOptions.length > 0 &&
          (results.length === 0 || selectedIndex >= results.length - 1)
        ) {
          setHostCursor(0);
        } else {
          onSelectNext();
        }
        break;
      // First and last, as in every other palette, counting the other hosts'
      // rows as the tail of the list. Shift+Home selects the query instead, and
      // an empty list leaves the keys to the caret.
      case "Home":
      case "End": {
        const total = results.length + hostOptions.length;
        if (keyBelongsToField(e) || total === 0) break;
        e.preventDefault();
        e.stopPropagation();
        moveCursorTo(e.key === "Home" ? 0 : total - 1);
        break;
      }
      // A page of rows rather than native scrolling, which would walk the
      // highlighted row off screen and leave Enter committing something the
      // user can no longer see.
      case "PageUp":
      case "PageDown": {
        const total = results.length + hostOptions.length;
        if (total === 0) break;
        e.preventDefault();
        e.stopPropagation();
        const step = pageStep();
        const from =
          hostCursor !== null
            ? results.length + hostCursor
            : selectedIndex >= 0
              ? selectedIndex
              : 0;
        moveCursorTo(
          e.key === "PageDown" ? Math.min(total - 1, from + step) : Math.max(0, from - step)
        );
        break;
      }
      // The keyboard's right-click. Without it pin, sleep, copy path and move
      // were pointer-only: the rows never take focus, so there is nothing for
      // the platform's own context-menu key to land on.
      case "F10":
      case "ContextMenu": {
        if (e.key === "F10" && !e.shiftKey) break;
        const target = hostCursor === null ? results[selectedIndex] : undefined;
        if (target?.kind !== "project") break;
        e.preventDefault();
        e.stopPropagation();
        openRowMenu(target.id);
        break;
      }
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        if (activeHostOption) {
          // Same modifier as a click on the row: a new window on ⌘/Ctrl.
          if (otherHostOptionCloses(activeHostOption)) onClose();
          activateOtherHostOption(activeHostOption, isNewWindowClick(e));
        } else if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
          const selected = results[selectedIndex]!;
          // Anything ⌘↵ can't open a window for falls through to the plain
          // switch rather than swallowing the keypress.
          if (
            (e.metaKey || e.ctrlKey) &&
            onSelectNewWindow &&
            modEnterOpensWindow(selected, true)
          ) {
            onSelectNewWindow(selected);
          } else {
            onSelect(selected, "keyboard");
          }
        }
        break;
      case "Escape":
        // Anchored mode leaves Escape entirely to the shell, which spends the
        // first press clearing the query. Closing here would beat that: this
        // runs on bubble, after Radix's capture-phase dismissal has already
        // been vetoed, so the palette would shut on a press meant to filter.
        if (mode === "dropdown") break;
        e.preventDefault();
        e.stopPropagation();
        // The dialog spends its first press the same way the shell does.
        if (query !== "") onQueryChange("");
        else onClose();
        break;
      case "Backspace": {
        // Projects only. Both paths confirm now, but the chord means "close
        // the project" — pointing it at a scratch row would overload one key
        // with a reversible close and an irreversible delete.
        const target = hostCursor === null ? results[selectedIndex] : undefined;
        if ((e.metaKey || e.ctrlKey) && onCloseProject && target?.kind === "project") {
          e.preventDefault();
          e.stopPropagation();
          onCloseProject(target.id);
        }
        break;
      }
    }
  };

  const activeResult = hostCursor === null ? results[selectedIndex] : undefined;
  const activeDescendant =
    activeHostOptionId !== null
      ? activeHostOptionId
      : activeResult
        ? `project-option-${activeResult.id}`
        : undefined;
  // The RANKED list owns the scratches, and it trails the box by a commit.
  // Hiding the pinned section on the live query instead would blank them for
  // that frame — and for a user whose only workspaces are scratches, that frame
  // reads as "no matches".
  const isRankedSearch = rankedSearch ?? query.trim().length > 0;
  const hasProjectPresentation =
    (browseBands?.length ?? 0) > 0 || results.some((row) => row.kind === "project");
  const hasProjectCommands = Boolean(
    onOpenProjectSettings || onAddProject || onCloneRepo || onCreateFolder
  );
  const scratchesStandAlone =
    !isRankedSearch && !hasProjectPresentation && (scratchResults?.length ?? 0) > 0;

  useWaitAgeTick(results.length > 0 || (scratchResults?.length ?? 0) > 0);

  // "N results" once a search settles, the way `SearchablePalette` says it:
  // Doherty-gated so a fast typist hears one count, read when the timer fires
  // so it is the list that settled. Zero stands down — the empty state below
  // announces its own "No workspaces match …", and two owners would say it twice.
  const currentHostName = useCurrentHostName();
  const remoteNamesKey = [...remoteNames].sort().join("\n");
  const sharedNameHost = useMemo(
    () =>
      remoteNamesKey === ""
        ? null
        : { hostName: currentHostName, names: new Set(remoteNamesKey.split("\n")) },
    [remoteNamesKey, currentHostName]
  );
  const hostProjectCount = hostOptions.filter(
    (option) => option.kind === "project" || option.kind === "worktree"
  ).length;
  // While searching, a host row the query named is a match like any other and
  // counts — except a Retry already under way, which holds its row but does
  // nothing.
  const hostMatchCount = isRankedSearch
    ? hostOptions.filter((option) => !(option.kind === "retry" && option.busy)).length
    : hostProjectCount;
  const resultCount = results.length + hostMatchCount;
  // The band answers the search when it draws anything for it — a host still
  // listing included, which says more than "nothing matched" would.
  const bandAnswersSearch = isRankedSearch ? hostGroups.length > 0 : hostProjectCount > 0;
  const resultCountRef = useRef(resultCount);
  useEffect(() => {
    resultCountRef.current = resultCount;
  });
  useEffect(() => {
    if (!isRankedSearch || query.trim() === "") return;
    const timer = window.setTimeout(() => {
      const count = resultCountRef.current;
      if (count > 0) useAnnouncerStore.getState().announce(pluralize(count, "result"), "polite");
    }, UI_DOHERTY_THRESHOLD);
    return () => window.clearTimeout(timer);
  }, [query, isRankedSearch]);

  return (
    <>
      <AppPaletteDialog.Header
        label="Switch project"
        shortcut={projectSwitcherShortcut}
        // Absent, not zeroed, when the fleet is idle: "is anything running?" is
        // answered by the line being there at all, and a standing "0 running"
        // would make the reader parse a number to learn nothing.
        trailing={
          fleetSummary ? (
            <span data-testid="fleet-liveness-summary">{fleetSummary}</span>
          ) : undefined
        }
      >
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search workspaces…"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={true}
          aria-haspopup="listbox"
          aria-label="Search workspaces"
          aria-controls={
            // Groups, not options: a band holding only a host still giving its
            // first list has no options, but it is still this popup's content.
            hostGroups.length > 0 ? `project-list ${OTHER_HOSTS_LIST_ID}` : "project-list"
          }
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        /*
         * The shell's 144px floor is a stability device for typing: it seats
         * three rows so a narrowing result list doesn't resize the palette on
         * every keystroke. Browse never narrows, and there the floor only
         * propped the body open past its content — a fully folded list left its
         * last band a hundred-odd pixels above the rule below it, which is the
         * one gap in the palette the band padding couldn't answer for.
         */
        className={cn(
          // The shell transitions `height`, but the property that actually
          // changes between these two states is `min-height` — left off the
          // list, clearing the query dropped the floor in one frame.
          "p-0 transition-[height,min-height]",
          !isRankedSearch && "min-h-0"
        )}
        /*
         * No padding of its own — the bands carry all of it. Both halves matter.
         *
         * Horizontally, the band dividers are children of this scroller while
         * the header and footer rules are not, so any inset here drew the
         * palette's internal rules 4px shorter than its chrome rules. They are
         * the same hairline doing the same job and have to be the same width.
         *
         * Vertically, this padding stacked on top of the first and last band's
         * own, leaving the first band 4px lower than every band after it — the
         * one rule-to-label gap in the palette that didn't match the rest.
         *
         * `space-y-0` for the same reason: the inherited 4px landed on one side
         * of each divider only, so every rule sat off centre between the two
         * bands it separates.
         */
        /*
         * The shell's 60vh assumes a header, a body and a footer. This palette
         * also stands up to four 48px command rows under the body, and at 60vh
         * the ⌘⌥P modal ran past the bottom of a 1000px window, clipping
         * "Create new folder…" and the footer with the Enter hint. The cap
         * leaves room for that block below the modal's 15vh offset.
         */
        maxHeight={hasProjectCommands ? "max-h-[min(60vh,calc(85vh-20rem))]" : undefined}
        scrollClassName="space-y-0"
        ariaLabel="Workspaces"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
        // A press on row whitespace must not park focus on the region, where
        // typing stops filtering. The scratch rows and their controls are
        // tabbable, so the shell leaves presses on them alone.
        keepPointerFocusOnInput
      >
        <ProjectListContent
          results={results}
          browseBands={browseBands}
          selectedIndex={resultsCursor}
          query={query}
          onSelect={onSelect}
          listRef={listRef}
          canAddProject={Boolean(onAddProject)}
          canCreateScratch={Boolean(onCreateScratch)}
          scratchesStandAlone={scratchesStandAlone}
          hasOtherHostResults={bandAnswersSearch}
          sharedNameHost={sharedNameHost}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          onSleepProject={onSleepProject}
          onRestartProject={onRestartProject}
          onLocateProject={onLocateProject}
          onMoveOrRenameProject={onMoveOrRenameProject}
          onTogglePinProject={onTogglePinProject}
          onCopyPath={onCopyPath}
          onSelectNewWindow={onSelectNewWindow}
          onHoverProject={onHoverProject}
          onHoverProjectEnd={onHoverProjectEnd}
          // A local row under the pointer takes the cursor back from the
          // other-hosts band, or the highlight and Enter would stay remote.
          onHoverRow={
            onHoverRow
              ? (rowId) => {
                  setHostCursor(null);
                  onHoverRow(rowId);
                }
              : undefined
          }
          onReturnFocus={() => inputRef.current?.focus()}
        />
        {(onCreateScratch || (scratchResults && scratchResults.length > 0)) && (
          <>
            {/* Nothing above it to separate from once Scratch is the first content. */}
            <AppPaletteDialog.Divider hidden={isRankedSearch || scratchesStandAlone} />
            <ScratchSection
              scratches={scratchResults ?? []}
              isSearching={isRankedSearch}
              isOnlyAction={
                !isRankedSearch &&
                !hasProjectPresentation &&
                (scratchResults?.length ?? 0) === 0 &&
                !onAddProject
              }
              onCreate={onCreateScratch}
              onSelect={onSelectScratch}
              onRequestDelete={onRequestDeleteScratch}
              onDeleteAll={onRequestDeleteAllScratches}
              onRename={onRenameScratch}
              onSaveAsProject={onSaveAsProject}
              onReturnFocus={() => inputRef.current?.focus()}
            />
          </>
        )}
        {hostGroups.length > 0 && (
          // The band's own top edge, drawn like Scratch's: hidden when nothing
          // sits above it, where it would double the search field's divider.
          <AppPaletteDialog.Divider
            hidden={
              results.length === 0 &&
              isRankedSearch &&
              // Nothing local matched and the band answers, so no empty state
              // is drawn above it either.
              bandAnswersSearch
            }
          />
        )}
        <OtherHostsSection
          groups={hostGroups}
          query={query}
          activeKey={activeHostOption?.key ?? null}
          onChosen={onClose}
          // Also turns an automatic pick under the pointer into a chosen one.
          onHoverKey={(key) =>
            setHostCursorState((prev) =>
              prev !== null && prev.key === key && prev.query === query && !prev.auto
                ? prev
                : { query, key }
            )
          }
        />
      </AppPaletteDialog.Body>

      {hasProjectCommands && (
        <>
          <AppPaletteDialog.Divider />
          <div>
            {onOpenProjectSettings && (
              <ProjectCommandRow
                icon={Settings}
                tone="manage"
                label="Project settings…"
                onClick={onOpenProjectSettings}
              />
            )}
            {onAddProject && (
              <ProjectCommandRow
                icon={FolderOpen}
                tone="create"
                label="Open project…"
                onClick={onAddProject}
                testId="project-add-button"
              />
            )}
            {onCloneRepo && (
              <ProjectCommandRow
                icon={FolderDown}
                tone="create"
                label="Clone repository…"
                onClick={onCloneRepo}
                testId="project-clone-button"
              />
            )}
            {onCreateFolder && (
              <ProjectCommandRow
                icon={FolderPlus}
                tone="create"
                label="Create new folder…"
                onClick={onCreateFolder}
              />
            )}
          </div>
        </>
      )}

      <AppPaletteDialog.Footer>
        <ProjectSwitcherFooter
          selectedRow={activeResult}
          hostOption={activeHostOption}
          canOpenWindow={onSelectNewWindow !== undefined}
          onOpenPilot={() => {
            onClose();
            usePilotStore.getState().open();
          }}
        />
      </AppPaletteDialog.Footer>
    </>
  );
}

/**
 * The palette's search box, lifted out of the two content hosts so the dialogs
 * rendered beside them can name it as a focus successor. Only the mounted host
 * attaches, so one ref serves both.
 */
interface PaletteInputRefProp {
  paletteInputRef: React.RefObject<HTMLInputElement | null>;
}

function ModalContent({
  isOpen,
  onClose,
  mode,
  paletteInputRef: inputRef,
  ...innerProps
}: Omit<ProjectSwitcherPaletteProps, "children" | "dropdownAlign"> & PaletteInputRefProp) {
  useOverlayClaim("project-switcher", isOpen);
  const listRef = useRef<HTMLDivElement>(null);

  return (
    <AppPaletteDialog
      isOpen={isOpen}
      onClose={(reason) => {
        // The input spends Escape on a query itself, but once Tab has moved
        // focus to the results or a command row the shell's backstop is what
        // hears it — and it would close on the press meant to clear.
        if (reason === "escape" && innerProps.query !== "") {
          innerProps.onQueryChange("");
          inputRef.current?.focus();
          return;
        }
        onClose();
      }}
      ariaLabel="Project switcher"
      // The modal form is the global ⌘P surface, so it takes the command box.
      // Its dropdown twin below is anchored: same content, same material, a
      // box scaled to how the user reached it.
      tier="command"
    >
      <ProjectPaletteInner
        inputRef={inputRef}
        listRef={listRef}
        query={innerProps.query}
        results={innerProps.results}
        browseBands={innerProps.browseBands}
        selectedIndex={innerProps.selectedIndex}
        mode={mode}
        onQueryChange={innerProps.onQueryChange}
        onSelect={innerProps.onSelect}
        onClose={onClose}
        onSelectPrevious={innerProps.onSelectPrevious}
        onSelectNext={innerProps.onSelectNext}
        onAddProject={innerProps.onAddProject}
        onCloneRepo={innerProps.onCloneRepo}
        onCreateFolder={innerProps.onCreateFolder}
        onOpenProjectSettings={innerProps.onOpenProjectSettings}
        onStopProject={innerProps.onStopProject}
        onCloseProject={innerProps.onCloseProject}
        onSleepProject={innerProps.onSleepProject}
        onRestartProject={innerProps.onRestartProject}
        onLocateProject={innerProps.onLocateProject}
        onMoveOrRenameProject={innerProps.onMoveOrRenameProject}
        onTogglePinProject={innerProps.onTogglePinProject}
        onCopyPath={innerProps.onCopyPath}
        onSelectNewWindow={innerProps.onSelectNewWindow}
        onHoverProject={innerProps.onHoverProject}
        onHoverProjectEnd={innerProps.onHoverProjectEnd}
        onHoverRow={innerProps.onHoverRow}
        rankedSearch={innerProps.rankedSearch}
        scratchResults={innerProps.scratchResults}
        onCreateScratch={innerProps.onCreateScratch}
        onSelectScratch={innerProps.onSelectScratch}
        onRequestDeleteScratch={innerProps.onRequestDeleteScratch}
        onRequestDeleteAllScratches={innerProps.onRequestDeleteAllScratches}
        onRenameScratch={innerProps.onRenameScratch}
        onSaveAsProject={innerProps.onSaveAsProject}
        fleetLiveness={innerProps.fleetLiveness}
      />
    </AppPaletteDialog>
  );
}

function DropdownContent({
  isOpen,
  onClose,
  dropdownAlign = "start",
  children,
  mode,
  onDropdownCloseAutoFocus,
  consumeCloseAutoFocusSuppression,
  paletteInputRef: inputRef,
  onQueryChange,
  ...innerProps
}: ProjectSwitcherPaletteProps & PaletteInputRefProp) {
  const listRef = useRef<HTMLDivElement>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose]
  );

  const handleClearQuery = useCallback(() => onQueryChange(""), [onQueryChange]);

  return (
    <AppPalettePopover
      isOpen={isOpen}
      onOpenChange={handleOpenChange}
      // Non-modal on purpose: Tab leaves the palette by native traversal, and
      // the controls the switcher renders after its results region stay
      // reachable. The modal form is the ⌘P dialog, not this.
      modal={false}
      // A confirm dialog opened from one of the rows stacks above the switcher;
      // leaving it open behind the dialog it spawned reads as two live surfaces.
      dismissOnForeignOverlay
    >
      <AppPalettePopover.Trigger asChild>{children}</AppPalettePopover.Trigger>
      <AppPalettePopover.Content
        ariaLabel="Project switcher"
        // Anchored: reached by clicking the title bar, showing the projects
        // already to hand. The ⌘P modal above renders the same content on the
        // command tier — same material, a box scaled to the way in.
        tier="anchored"
        inputRef={inputRef}
        onClearQuery={handleClearQuery}
        onCloseAutoFocus={onDropdownCloseAutoFocus}
        consumeCloseAutoFocusSuppression={consumeCloseAutoFocusSuppression}
        // Keeps the trigger's focus ring on a pointer dismissal, which is what
        // this palette has always done. The shell's default (suppress) is the
        // better behaviour and worth adopting — but as its own change, not
        // folded silently into an extraction.
        restoreFocusOnPointerDismiss
        // Padding only — width comes from the shell's tier above, which is what
        // splits this box from its ⌘P twin.
        className="p-0"
        data-testid="project-switcher-palette"
        align={dropdownAlign}
        onEscapeKeyDown={(event) => {
          // Radix dismisses on a document-capture listener, which beats the
          // scratch-name input's own handler. While that input owns focus,
          // Escape means "cancel the edit", not "clear the query or close the
          // switcher" — so veto before the shell's staged Escape runs.
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.hasAttribute("data-scratch-name-input")) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          // A row's context menu portals outside this content, so its clicks
          // read as "outside" and would dismiss the switcher underneath it.
          // Global by role rather than scoped to this palette's own subtree
          // (the #8216 data-attribute + portal-re-provided-Context pattern is
          // the upgrade path if an unrelated menu ever holds it open).
          //
          // `Element`, not `HTMLElement`: menu items carry Lucide glyphs, and a
          // click landing on the SVG would otherwise miss the guard entirely.
          const target = event.target;
          if (target instanceof Element && target.closest('[role="menu"]')) {
            event.preventDefault();
          }
        }}
      >
        <ProjectPaletteInner
          inputRef={inputRef}
          listRef={listRef}
          query={innerProps.query}
          results={innerProps.results}
          browseBands={innerProps.browseBands}
          selectedIndex={innerProps.selectedIndex}
          mode={mode}
          onQueryChange={onQueryChange}
          onSelect={innerProps.onSelect}
          onClose={onClose}
          onSelectPrevious={innerProps.onSelectPrevious}
          onSelectNext={innerProps.onSelectNext}
          onAddProject={innerProps.onAddProject}
          onCloneRepo={innerProps.onCloneRepo}
          onCreateFolder={innerProps.onCreateFolder}
          onOpenProjectSettings={innerProps.onOpenProjectSettings}
          onStopProject={innerProps.onStopProject}
          onCloseProject={innerProps.onCloseProject}
          onSleepProject={innerProps.onSleepProject}
          onRestartProject={innerProps.onRestartProject}
          onLocateProject={innerProps.onLocateProject}
          onMoveOrRenameProject={innerProps.onMoveOrRenameProject}
          onTogglePinProject={innerProps.onTogglePinProject}
          onCopyPath={innerProps.onCopyPath}
          onSelectNewWindow={innerProps.onSelectNewWindow}
          onHoverProject={innerProps.onHoverProject}
          onHoverProjectEnd={innerProps.onHoverProjectEnd}
          onHoverRow={innerProps.onHoverRow}
          rankedSearch={innerProps.rankedSearch}
          scratchResults={innerProps.scratchResults}
          onCreateScratch={innerProps.onCreateScratch}
          onSelectScratch={innerProps.onSelectScratch}
          onRequestDeleteScratch={innerProps.onRequestDeleteScratch}
          onRequestDeleteAllScratches={innerProps.onRequestDeleteAllScratches}
          onRenameScratch={innerProps.onRenameScratch}
          onSaveAsProject={innerProps.onSaveAsProject}
          fleetLiveness={innerProps.fleetLiveness}
        />
      </AppPalettePopover.Content>
    </AppPalettePopover>
  );
}

export function ProjectSwitcherPalette({
  isOpen,
  query,
  results,
  browseBands,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onClose,
  mode = "modal",
  onAddProject,
  onCloneRepo,
  onCreateFolder,
  onStopProject,
  onCloseProject,
  onSleepProject,
  onRestartProject,
  onLocateProject,
  onMoveOrRenameProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
  onHoverRow,
  onOpenProjectSettings,
  onDropdownCloseAutoFocus,
  dropdownAlign,
  children,
  rankedSearch,
  scratchResults,
  onCreateScratch,
  onSelectScratch,
  onRequestDeleteScratch,
  onRequestDeleteAllScratches,
  onRenameScratch,
  onSaveAsProject,
  fleetLiveness,
  ...confirmState
}: ProjectSwitcherPaletteProps) {
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const content =
    mode === "dropdown" ? (
      <DropdownContent
        paletteInputRef={paletteInputRef}
        isOpen={isOpen}
        query={query}
        results={results}
        browseBands={browseBands}
        selectedIndex={selectedIndex}
        onQueryChange={onQueryChange}
        onSelectPrevious={onSelectPrevious}
        onSelectNext={onSelectNext}
        onSelect={onSelect}
        onClose={onClose}
        mode={mode}
        onAddProject={onAddProject}
        onCloneRepo={onCloneRepo}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onSleepProject={onSleepProject}
        onRestartProject={onRestartProject}
        onLocateProject={onLocateProject}
        onMoveOrRenameProject={onMoveOrRenameProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectNewWindow={onSelectNewWindow}
        onHoverProject={onHoverProject}
        onHoverProjectEnd={onHoverProjectEnd}
        onHoverRow={onHoverRow}
        onOpenProjectSettings={onOpenProjectSettings}
        onDropdownCloseAutoFocus={onDropdownCloseAutoFocus}
        dropdownAlign={dropdownAlign}
        rankedSearch={rankedSearch}
        scratchResults={scratchResults}
        onCreateScratch={onCreateScratch}
        onSelectScratch={onSelectScratch}
        onRequestDeleteScratch={onRequestDeleteScratch}
        onRequestDeleteAllScratches={onRequestDeleteAllScratches}
        onRenameScratch={onRenameScratch}
        onSaveAsProject={onSaveAsProject}
        fleetLiveness={fleetLiveness}
      >
        {children}
      </DropdownContent>
    ) : (
      <ModalContent
        paletteInputRef={paletteInputRef}
        isOpen={isOpen}
        query={query}
        results={results}
        browseBands={browseBands}
        selectedIndex={selectedIndex}
        onQueryChange={onQueryChange}
        onSelectPrevious={onSelectPrevious}
        onSelectNext={onSelectNext}
        onSelect={onSelect}
        onClose={onClose}
        mode={mode}
        onAddProject={onAddProject}
        onCloneRepo={onCloneRepo}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onSleepProject={onSleepProject}
        onRestartProject={onRestartProject}
        onLocateProject={onLocateProject}
        onMoveOrRenameProject={onMoveOrRenameProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectNewWindow={onSelectNewWindow}
        onHoverProject={onHoverProject}
        onHoverProjectEnd={onHoverProjectEnd}
        onHoverRow={onHoverRow}
        onOpenProjectSettings={onOpenProjectSettings}
        rankedSearch={rankedSearch}
        scratchResults={scratchResults}
        onCreateScratch={onCreateScratch}
        onSelectScratch={onSelectScratch}
        onRequestDeleteScratch={onRequestDeleteScratch}
        onRequestDeleteAllScratches={onRequestDeleteAllScratches}
        onRenameScratch={onRenameScratch}
        onSaveAsProject={onSaveAsProject}
        fleetLiveness={fleetLiveness}
      />
    );

  return (
    <>
      {content}
      <ProjectSwitcherConfirmDialogs {...confirmState} paletteInputRef={paletteInputRef} />
    </>
  );
}
