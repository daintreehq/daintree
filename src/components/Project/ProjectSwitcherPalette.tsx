import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { isPointerClaimed } from "@/lib/pointerClaim";
import { FolderOpen, FolderPlus, Settings } from "lucide-react";
import { FolderDown } from "@/components/icons";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { describeKeyCap } from "@/lib/kbdShortcut";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { usePreferencesStore } from "@/store/preferencesStore";
import { PROJECT_SWITCHER_SCRATCH_BAND_KEY } from "@/hooks/useProjectSwitcherPalette";
import { pluralize } from "@/lib/pluralize";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { keyBelongsToField } from "@/hooks/useListboxCursor";
import { HostNameText } from "@/components/Hosts/HostNameText";
import {
  OTHER_HOSTS_BAND_OPTION_ID,
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
import {
  bandOptionId,
  deriveBrowseSections,
  isBandHeaderStop,
  ProjectListContent,
} from "./ProjectSwitcherBands";
import {
  isScratchBandCollapsed,
  SCRATCH_CREATE_OPTION_ID,
  SCRATCH_LIST_ID,
  ScratchSection,
  scratchOptionId,
} from "./ProjectSwitcherScratchSection";
import {
  liftScratches,
  scratchLiftPlace,
  type ScratchLiftPlace,
} from "@/hooks/projectSwitcher/scratchLift";
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
  /** See `UseProjectSwitcherPaletteReturn.cycleRequest`. */
  cycleRequest?: number;
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
  hintOverride,
  inBrowse = false,
  canOpenWindow,
  onOpenPilot,
}: {
  /**
   * Browse, where the list has bands: the footer teaches the band keys, which
   * nothing else on screen would. A search has no bands, so it keeps the
   * right-click hint instead.
   */
  inBrowse?: boolean;
  /** The other-hosts row under the cursor; it takes the hint over `selectedRow`. */
  hostOption?: OtherHostOption;
  /** What Enter does on a stop that is not a workspace: a band header, the create row. */
  hintOverride?: { keys: string; label: string };
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
  const hint: ReturnType<typeof getOtherHostEnterHint> = hintOverride
    ? hintOverride
    : hostOption
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
        {inBrowse && (
          <span
            className="hidden shrink-0 items-center @min-[400px]/switcher-footer:inline-flex"
            data-testid="project-switcher-band-keys-hint"
          >
            <span className="sr-only">
              {isMac() ? "Option" : "Alt"} plus up or down arrow to jump between sections
            </span>
            <kbd aria-hidden="true" className={KBD_CLASS}>
              {isMac() ? "⌥↑↓" : "Alt ↑↓"}
            </kbd>
            <span aria-hidden="true" className="ml-1.5">
              Sections
            </span>
          </span>
        )}
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
        {!inBrowse && hasSelection && !isScratchSelected && (
          <span className="text-text-secondary shrink-0 @max-[520px]/switcher-footer:hidden">
            Right-click for more
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The palette-level commands — Open project, Clone, Create folder, Project
 * settings — as one compact bar under the list rather than a stack of 48px
 * rows. They act on the project list, not on a workspace in it, so they never
 * take the roving cursor; they are reached by Tab, and the bar gives the list
 * back the ~100px the stack used to hold in every window.
 *
 * Ghost buttons on the shared Button primitive, so their hover, focus ring and
 * press are the app's own. Settings is the gear alone: it is the house glyph
 * for project settings, and a fourth label would not fit the anchored tier.
 */
function ProjectCommandBar({
  onOpenProjectSettings,
  onAddProject,
  onCloneRepo,
  onCreateFolder,
}: {
  onOpenProjectSettings?: () => void;
  onAddProject?: () => void;
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2 py-1.5" data-testid="project-command-bar">
      {onAddProject && (
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          onClick={onAddProject}
          data-testid="project-add-button"
        >
          <FolderOpen aria-hidden="true" />
          Open project…
        </Button>
      )}
      {onCloneRepo && (
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          onClick={onCloneRepo}
          data-testid="project-clone-button"
        >
          <FolderDown aria-hidden="true" />
          Clone repository…
        </Button>
      )}
      {onCreateFolder && (
        <Button variant="ghost" size="sm" className="px-2" onClick={onCreateFolder}>
          <FolderPlus aria-hidden="true" />
          New folder…
        </Button>
      )}
      {onOpenProjectSettings && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Project settings…"
              onClick={onOpenProjectSettings}
              data-testid="project-settings-button"
            >
              <Settings aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Project settings…</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * One stop of the palette's single cursor. Every row the palette draws that
 * Enter can act on is one of these, in the order the DOM draws them: the
 * project rows and folded band headers, then the scratches (or Scratch's
 * folded header), then the other hosts' rows. The arrow keys walk exactly this
 * list, so nothing on screen is out of the keyboard's reach and nothing the
 * keyboard reaches is off screen (#11071).
 *
 * `section` is the band a stop belongs to, which is what ⌥↑/⌥↓ jump between.
 */
type CursorStop =
  | { key: string; kind: "row"; row: ProjectSwitcherRow; section: string }
  | { key: string; kind: "band"; bandKey: string; section: string }
  | { key: string; kind: "scratch"; scratch: SearchableScratch; section: string }
  | { key: string; kind: "scratch-create"; section: string }
  | { key: string; kind: "host"; option: OtherHostOption; section: string };

/** The Other hosts band's key in the persisted fold map, like Scratch's. */
const OTHER_HOSTS_BAND_KEY = "other-hosts";

/** Where the cursor sits when it is not on a project row: a stop key, held for one query. */
interface CursorClaim {
  query: string;
  key: string;
  /** Placed for an empty result list rather than moved to; local results take it back. */
  auto?: boolean;
}

/** A claim the next render resolves to the first stop of a band just unfolded. */
const FIRST_OF_PREFIX = "first-of:";

interface ProjectPaletteInnerProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  results: ProjectSwitcherRow[];
  browseBands?: ProjectSwitcherBrowseBand[];
  selectedIndex: number;
  cycleRequest?: number;
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
  cycleRequest = 0,
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

  const {
    groups: hostGroups,
    options: hostOptions,
    remoteNames,
  } = useOtherHostProjectOptions(query);

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
  const scratchCount = scratchResults?.length ?? 0;
  const scratchesStandAlone = !isRankedSearch && !hasProjectPresentation && scratchCount > 0;
  const showScratchSection = Boolean(onCreateScratch || scratchCount > 0);
  const scratchIsOnlyAction =
    !isRankedSearch && !hasProjectPresentation && scratchCount === 0 && !onAddProject;
  const storedScratchCollapsed = usePreferencesStore(
    (state) => state.projectSwitcherCollapsedBands[PROJECT_SWITCHER_SCRATCH_BAND_KEY]
  );
  const setBandCollapsed = usePreferencesStore((state) => state.setProjectSwitcherBandCollapsed);
  const scratchCollapsed = isScratchBandCollapsed(
    storedScratchCollapsed,
    scratchCount,
    scratchIsOnlyAction
  );
  const scratchInBrowse = showScratchSection && !isRankedSearch;
  const [scratchCreating, setScratchCreating] = useState(false);
  const collapsedBands = usePreferencesStore((state) => state.projectSwitcherCollapsedBands);
  const hostsCollapsed = !isRankedSearch && collapsedBands[OTHER_HOSTS_BAND_KEY] === true;

  // Scratches doing work are drawn in the band their work puts them in. Where
  // each one goes is decided the first time the palette sees it and held for
  // the open session, so a scratch that starts running doesn't jump under the
  // pointer. The palette's content unmounts on close, which is what resets it.
  //
  // A lift is held as soon as it is seen. "Stays in Scratch" is held only once
  // the palette has been open long enough for the stats push that follows an
  // open to land — held on the first frame, a scratch whose agents had not
  // reported yet would be pinned below the catalogue for the whole session.
  const [liftHeld, setLiftHeld] = useState<Record<string, ScratchLiftPlace | null>>({});
  const [liftSettled, setLiftSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLiftSettled(true), UI_DOHERTY_THRESHOLD);
    return () => window.clearTimeout(timer);
  }, []);
  const liftFor = (scratch: SearchableScratch) =>
    scratch.id in liftHeld ? liftHeld[scratch.id]! : scratchLiftPlace(scratch);
  const unheldKey = (scratchResults ?? [])
    .filter((scratch) => !(scratch.id in liftHeld))
    .map((scratch) => {
      const place = scratchLiftPlace(scratch);
      return `${scratch.id}=${place ? `${place.band}:${place.tier}` : ""}`;
    })
    .filter((entry) => liftSettled || !entry.endsWith("="))
    .join(" ");
  useEffect(() => {
    if (unheldKey === "") return;
    setLiftHeld((prev) => {
      const next = { ...prev };
      for (const entry of unheldKey.split(" ")) {
        const [id, place] = entry.split("=") as [string, string];
        if (id in next) continue;
        const [band, tier] = place.split(":");
        next[id] = band ? { band: band as ScratchLiftPlace["band"], tier: Number(tier) } : null;
      }
      return next;
    });
  }, [unheldKey]);
  const lifted = !isRankedSearch
    ? liftScratches(results, browseBands ?? [], scratchResults ?? [], liftFor, collapsedBands)
    : null;
  const viewResults = lifted ? lifted.results : results;
  const viewBands = lifted && lifted.bands.length > 0 ? lifted.bands : browseBands;
  const pinnedScratches = lifted
    ? (scratchResults ?? []).filter((scratch) => !lifted.liftedIds.has(scratch.id))
    : (scratchResults ?? []);
  const liftedScratchCount = lifted ? lifted.liftedIds.size : 0;

  // Every stop, in drawn order, read off the same band layout the list renders
  // (`deriveBrowseSections`), so the two cannot disagree about what is on
  // screen — not even for the commit a search trails its query by (#11071).
  const sections = deriveBrowseSections(viewResults, viewBands, isRankedSearch);
  const stops: CursorStop[] = [];
  const rowStop = (row: ProjectSwitcherRow, section: string): CursorStop => ({
    key: `row:${row.id}`,
    kind: "row",
    row,
    section,
  });
  if (sections) {
    for (const section of sections) {
      if (isBandHeaderStop(section)) {
        stops.push({
          key: `band:${section.key}`,
          kind: "band",
          bandKey: section.key,
          section: section.key,
        });
      }
      for (const row of section.items) stops.push(rowStop(row, section.key));
    }
  } else {
    for (const row of viewResults) stops.push(rowStop(row, "results"));
  }
  if (scratchInBrowse) {
    if (scratchCollapsed) {
      stops.push({
        key: `band:${PROJECT_SWITCHER_SCRATCH_BAND_KEY}`,
        kind: "band",
        bandKey: PROJECT_SWITCHER_SCRATCH_BAND_KEY,
        section: PROJECT_SWITCHER_SCRATCH_BAND_KEY,
      });
    } else {
      for (const scratch of pinnedScratches) {
        stops.push({
          key: `scratch:${scratch.id}`,
          kind: "scratch",
          scratch,
          section: PROJECT_SWITCHER_SCRATCH_BAND_KEY,
        });
      }
      // Not while its name field is open: the row it addresses is gone, and an
      // active descendant must name something on screen.
      if (onCreateScratch && !scratchCreating) {
        stops.push({
          key: "scratch-create",
          kind: "scratch-create",
          section: PROJECT_SWITCHER_SCRATCH_BAND_KEY,
        });
      }
    }
  }
  if (hostsCollapsed && hostGroups.length > 0) {
    stops.push({
      key: `band:${OTHER_HOSTS_BAND_KEY}`,
      kind: "band",
      bandKey: OTHER_HOSTS_BAND_KEY,
      section: OTHER_HOSTS_BAND_KEY,
    });
  } else {
    for (const group of hostGroups) {
      for (const option of group.options) {
        stops.push({
          key: `host:${option.key}`,
          kind: "host",
          option,
          section: `host:${group.hostId}`,
        });
      }
    }
  }

  // The hook owns the selection among `results`; anything else the cursor sits
  // on is a claim held here, by key rather than position — hosts connect and
  // drop while the palette is open, and a position would hand Enter whichever
  // row slid into it (#13290). A claim belongs to the query it was made under.
  const [claim, setClaim] = useState<CursorClaim | null>(null);
  // An unfolded band's first row; an empty band (a group whose members are
  // all above) has none, so its own header, which keeps the cursor in place.
  const firstStopOf = (section: string) => {
    // Other hosts is one band over several host sections.
    const inBand = (stop: CursorStop) =>
      section === OTHER_HOSTS_BAND_KEY ? stop.kind === "host" : stop.section === section;
    const row = stops.findIndex((stop) => inBand(stop) && stop.kind !== "band");
    if (row >= 0) return row;
    return stops.findIndex((stop) => stop.section === section);
  };
  const claimLive = claim !== null && claim.query === query && !(claim.auto && results.length > 0);
  const claimedIndex =
    claim === null || !claimLive
      ? -1
      : claim.key.startsWith(FIRST_OF_PREFIX)
        ? firstStopOf(claim.key.slice(FIRST_OF_PREFIX.length))
        : stops.findIndex((stop) => stop.key === claim.key);
  // Nothing local matched: the first project another host offers is what Enter
  // opens, the way the first result is when there are results. A search that
  // named only a host lands on that host's own row instead.
  const firstHostProject = stops.findIndex(
    (stop) =>
      stop.kind === "host" && (stop.option.kind === "project" || stop.option.kind === "worktree")
  );
  const firstHost = stops.findIndex((stop) => stop.kind === "host");
  // A list with nothing local to land on: a scratch first, then another host.
  // A list whose every band is folded keeps no default — that is a choice the
  // user made, and Enter on a header they didn't pick would undo it.
  const firstScratch = stops.findIndex(
    (stop) => stop.kind === "scratch" || stop.kind === "scratch-create"
  );
  const defaultIndex =
    viewResults.length > 0 || stops.some((stop) => stop.kind === "band")
      ? -1
      : firstScratch >= 0
        ? firstScratch
        : firstHostProject >= 0
          ? firstHostProject
          : isRankedSearch && firstHost >= 0
            ? firstHost
            : -1;
  const hookRow = results[selectedIndex];
  const hookIndex = hookRow
    ? stops.findIndex((stop) => stop.kind === "row" && stop.row.id === hookRow.id)
    : -1;
  const cursorIndex =
    claimedIndex >= 0 ? claimedIndex : defaultIndex >= 0 ? defaultIndex : hookIndex;
  const cursor: CursorStop | undefined = cursorIndex >= 0 ? stops[cursorIndex] : undefined;

  // Opening lands on the first workspace that isn't where you are — the hook
  // picks among projects, so when a lifted scratch comes before its pick (a
  // waiting scratch above everything else), the cursor starts there instead.
  // Once per open, and only in browse.
  const [initialPicked, setInitialPicked] = useState(false);
  const firstElsewhere = stops.findIndex((stop) =>
    stop.kind === "row"
      ? !stop.row.isActive && !(stop.row.kind === "project" && stop.row.isMissing)
      : stop.kind === "scratch"
        ? !stop.scratch.isActive
        : stop.kind === "host"
          ? stop.option.kind === "project" || stop.option.kind === "worktree"
          : false
  );
  const elsewhereStop = firstElsewhere >= 0 ? stops[firstElsewhere] : undefined;
  const hookOwnsElsewhere = elsewhereStop?.kind === "row" && results.includes(elsewhereStop.row);
  const initialKey =
    !initialPicked &&
    claim === null &&
    query === "" &&
    !isRankedSearch &&
    elsewhereStop !== undefined &&
    !hookOwnsElsewhere &&
    (hookIndex < 0 || firstElsewhere < hookIndex)
      ? elsewhereStop.key
      : null;
  // Done once it has picked, once the lift has settled, or as soon as the user
  // moves the cursor themselves — a late pick must never take it back.
  useEffect(() => {
    if (initialKey !== null) {
      setClaim({ query: "", key: initialKey });
      setInitialPicked(true);
    } else if (liftSettled) {
      setInitialPicked(true);
    }
  }, [initialKey, liftSettled]);

  // An unfold's "first row" is resolved once and then held by key, so a row
  // that arrives above it afterwards can't take Enter from the one landed on.
  const resolvedFirstKey =
    claim !== null && claim.key.startsWith(FIRST_OF_PREFIX) && claimedIndex >= 0
      ? stops[claimedIndex]!.key
      : null;
  useEffect(() => {
    if (resolvedFirstKey === null) return;
    setClaim((prev) =>
      prev !== null && prev.key.startsWith(FIRST_OF_PREFIX)
        ? { query: prev.query, key: resolvedFirstKey }
        : prev
    );
  }, [resolvedFirstKey]);

  // The palette's shortcut pressed again steps the cursor one stop, the way ↓
  // does — whatever kind of stop it is on and whatever kind comes next.
  const [cycleSeen, setCycleSeen] = useState(cycleRequest);
  const cyclePending = cycleRequest !== cycleSeen;
  const cycleNextKey =
    cyclePending && stops.length > 0
      ? stops[cursorIndex < 0 ? 0 : (cursorIndex + 1) % stops.length]!.key
      : null;
  useEffect(() => {
    if (!cyclePending) return;
    if (cycleNextKey !== null) setClaim({ query, key: cycleNextKey });
    setCycleSeen(cycleRequest);
  }, [cyclePending, cycleNextKey, cycleRequest, query]);

  // The automatic pick is held by key like a chosen one, so a host answering
  // later, with rows drawn above it, can't move what Enter opens.
  const defaultKey = claimedIndex < 0 && defaultIndex >= 0 ? stops[defaultIndex]!.key : null;
  useEffect(() => {
    setClaim((prev) => (prev !== null && prev.query !== query ? null : prev));
  }, [query]);
  useEffect(() => {
    if (defaultKey !== null) setClaim({ query, key: defaultKey, auto: true });
  }, [defaultKey, query]);

  // The hook only steps relative to its own selection (its updater composes
  // batched steps), so a surface without `onHoverRow` walks the short way round.
  const moveResultsSelectionTo = (target: number) => {
    const count = results.length;
    if (count === 0) return;
    const from = selectedIndex >= 0 && selectedIndex < count ? selectedIndex : 0;
    const forward = (target - from + count) % count;
    const backward = (from - target + count) % count;
    if (forward <= backward) for (let i = 0; i < forward; i += 1) onSelectNext();
    else for (let i = 0; i < backward; i += 1) onSelectPrevious();
  };

  const moveTo = (stop: CursorStop | undefined) => {
    if (!stop) return;
    setInitialPicked(true);
    // The hook selects among its own rows; anything else — a header, a
    // scratch, a host, a scratch drawn in a project band — is a claim here.
    if (stop.kind !== "row" || !results.includes(stop.row)) {
      setClaim({ query, key: stop.key });
      return;
    }
    setClaim(null);
    if (onHoverRow) onHoverRow(stop.row.id);
    else moveResultsSelectionTo(results.indexOf(stop.row));
  };

  /** The first stop of the band after (or before) the cursor's, wrapping. */
  const jumpBand = (direction: 1 | -1) => {
    const count = stops.length;
    if (count === 0) return;
    if (cursorIndex < 0) {
      moveTo(stops[0]);
      return;
    }
    const section = (index: number) => stops[index]!.section;
    if (direction === 1) {
      let next = cursorIndex + 1;
      while (next < count && section(next) === section(cursorIndex)) next += 1;
      moveTo(stops[next < count ? next : 0]);
      return;
    }
    let start = cursorIndex;
    while (start > 0 && section(start - 1) === section(cursorIndex)) start -= 1;
    if (start < cursorIndex) {
      moveTo(stops[start]);
      return;
    }
    let previous = start > 0 ? start - 1 : count - 1;
    while (previous > 0 && section(previous - 1) === section(previous)) previous -= 1;
    moveTo(stops[previous]);
  };

  // Bands only exist with an empty query, which is also when ←/→ have no caret
  // to move — so the horizontal arrows fold and unfold exactly where folding
  // means something, and never take a key away from text editing.
  const canFold = !isRankedSearch && query === "";
  const foldableSection = (stop: CursorStop | undefined): string | null => {
    if (!stop) return null;
    if (stop.kind === "scratch" || stop.kind === "scratch-create") {
      return PROJECT_SWITCHER_SCRATCH_BAND_KEY;
    }
    if (stop.kind === "host") return OTHER_HOSTS_BAND_KEY;
    if (stop.kind === "band" && !isFoldedBand(stop.bandKey)) return stop.bandKey;
    if (stop.kind === "row" && viewBands?.some((band) => band.key === stop.section)) {
      return stop.section;
    }
    return null;
  };
  const isFoldedBand = (bandKey: string) =>
    bandKey === PROJECT_SWITCHER_SCRATCH_BAND_KEY
      ? scratchCollapsed
      : bandKey === OTHER_HOSTS_BAND_KEY
        ? hostsCollapsed
        : (viewBands?.find((band) => band.key === bandKey)?.collapsed ?? false);
  const fold = (bandKey: string) => {
    setBandCollapsed(bandKey, true);
    setClaim({ query, key: `band:${bandKey}` });
  };
  // A pointer fold goes through here too, so folding the band the cursor is in
  // leaves the cursor on its header rather than dropping it back to the top.
  const toggleBand = (bandKey: string, collapsed: boolean) => {
    if (!collapsed) {
      setBandCollapsed(bandKey, false);
      if (cursor?.kind === "band" && cursor.bandKey === bandKey) unfold(bandKey);
      return;
    }
    if (
      cursor?.section === bandKey ||
      (cursor?.kind === "host" && bandKey === OTHER_HOSTS_BAND_KEY)
    ) {
      fold(bandKey);
    } else {
      setBandCollapsed(bandKey, true);
    }
  };
  const unfold = (bandKey: string) => {
    setBandCollapsed(bandKey, false);
    setClaim({ query, key: `${FIRST_OF_PREFIX}${bandKey}` });
  };

  const activeHostOption = cursor?.kind === "host" ? cursor.option : undefined;
  const activeDescendant: string | undefined = !cursor
    ? undefined
    : cursor.kind === "row"
      ? `project-option-${cursor.row.id}`
      : cursor.kind === "band"
        ? cursor.bandKey === OTHER_HOSTS_BAND_KEY
          ? OTHER_HOSTS_BAND_OPTION_ID
          : bandOptionId(cursor.bandKey)
        : cursor.kind === "scratch"
          ? scratchOptionId(cursor.scratch.id)
          : cursor.kind === "scratch-create"
            ? SCRATCH_CREATE_OPTION_ID
            : otherHostOptionId(cursor.option);
  const resultsCursor = cursor?.kind === "row" ? viewResults.indexOf(cursor.row) : -1;
  const [createRequest, setCreateRequest] = useState(0);

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
    if (activeDescendant === undefined) return;
    const element = document.getElementById(activeDescendant);
    // A row under the pointer was just claimed by it; revealing it would
    // scroll a half-visible row out from under the pointer.
    if (element && !isPointerClaimed(element)) element.scrollIntoView?.({ block: "nearest" });
  }, [activeDescendant, hostRowsShape, results]);

  /** Rows that fit in the scroller, less one so a page keeps a row of context. */
  const pageStep = () => {
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>("[tabindex]") ?? list;
    // A row, not a band header: a folded first band would measure 24px and
    // turn a page into half again as many rows as fit.
    const row = list?.querySelector<HTMLElement>('[role="option"]:not([data-band-header])');
    if (!scroller || !row || row.offsetHeight === 0) return 5;
    return Math.max(1, Math.floor(scroller.clientHeight / row.offsetHeight) - 1);
  };

  /**
   * Opens a row's context menu from the keyboard, anchored under its name. The
   * menu returns focus to the search box when it closes (see `ProjectListItem`).
   */
  const openMenuOn = (elementId: string) => {
    const row = document.getElementById(elementId);
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
    const count = stops.length;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown": {
        if (count === 0) break;
        e.preventDefault();
        e.stopPropagation();
        const direction = e.key === "ArrowDown" ? 1 : -1;
        // ⌥↑/⌥↓ (Alt off macOS) move a band at a time — the quick-pick
        // convention for jumping separators, and the difference between three
        // presses and thirty in a long list.
        if (e.altKey) {
          jumpBand(direction);
          break;
        }
        const next =
          cursorIndex < 0
            ? direction === 1
              ? 0
              : count - 1
            : (cursorIndex + direction + count) % count;
        moveTo(stops[next]);
        break;
      }
      case "ArrowLeft": {
        if (!canFold || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) break;
        const section = foldableSection(cursor);
        if (section === null) break;
        e.preventDefault();
        e.stopPropagation();
        fold(section);
        break;
      }
      case "ArrowRight": {
        if (!canFold || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) break;
        if (cursor?.kind !== "band" || !isFoldedBand(cursor.bandKey)) break;
        e.preventDefault();
        e.stopPropagation();
        unfold(cursor.bandKey);
        break;
      }
      // First and last, as in every other palette, across every stop. Shift+Home
      // selects the query instead, and an empty list leaves the keys to the caret.
      case "Home":
      case "End": {
        if (keyBelongsToField(e) || count === 0) break;
        e.preventDefault();
        e.stopPropagation();
        moveTo(stops[e.key === "Home" ? 0 : count - 1]);
        break;
      }
      // A page of rows rather than native scrolling, which would walk the
      // highlighted row off screen and leave Enter committing something the
      // user can no longer see.
      case "PageUp":
      case "PageDown": {
        if (count === 0) break;
        e.preventDefault();
        e.stopPropagation();
        const step = pageStep();
        const from = cursorIndex >= 0 ? cursorIndex : 0;
        moveTo(
          stops[e.key === "PageDown" ? Math.min(count - 1, from + step) : Math.max(0, from - step)]
        );
        break;
      }
      // The keyboard's right-click. Without it pin, sleep, copy path and move
      // were pointer-only: the rows never take focus, so there is nothing for
      // the platform's own context-menu key to land on.
      case "F10":
      case "ContextMenu": {
        if (e.key === "F10" && !e.shiftKey) break;
        const target =
          cursor?.kind === "row" && (cursor.row.kind === "project" || cursor.row.section)
            ? `project-option-${cursor.row.id}`
            : cursor?.kind === "scratch"
              ? scratchOptionId(cursor.scratch.id)
              : cursor?.kind === "band"
                ? bandOptionId(cursor.bandKey)
                : null;
        if (target === null) break;
        e.preventDefault();
        e.stopPropagation();
        openMenuOn(target);
        break;
      }
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        if (!cursor) break;
        if (cursor.kind === "host") {
          // Same modifier as a click on the row: a new window on ⌘/Ctrl.
          if (otherHostOptionCloses(cursor.option)) onClose();
          activateOtherHostOption(cursor.option, isNewWindowClick(e));
        } else if (cursor.kind === "band") {
          // A folded header unfolds; an open empty one is only there to fold.
          if (isFoldedBand(cursor.bandKey)) unfold(cursor.bandKey);
          else fold(cursor.bandKey);
        } else if (cursor.kind === "scratch-create") {
          setCreateRequest((count) => count + 1);
        } else if (cursor.kind === "scratch") {
          onSelectScratch?.(cursor.scratch);
        } else {
          const selected = cursor.row;
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
        if (
          (e.metaKey || e.ctrlKey) &&
          onCloseProject &&
          cursor?.kind === "row" &&
          cursor.row.kind === "project"
        ) {
          e.preventDefault();
          e.stopPropagation();
          onCloseProject(cursor.row.id);
        }
        break;
      }
    }
  };

  const footerRow: ProjectSwitcherRow | undefined =
    cursor?.kind === "row"
      ? cursor.row
      : cursor?.kind === "scratch"
        ? { kind: "scratch", ...cursor.scratch }
        : undefined;

  useWaitAgeTick(results.length > 0 || scratchCount > 0);

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
      const settled = resultCountRef.current;
      if (settled > 0)
        useAnnouncerStore.getState().announce(pluralize(settled, "result"), "polite");
    }, UI_DOHERTY_THRESHOLD);
    return () => window.clearTimeout(timer);
  }, [query, isRankedSearch]);

  // Groups, not options: a band holding only a host still giving its first
  // list has no options, but it is still this popup's content.
  const controls = [
    "project-list",
    ...(scratchInBrowse ? [SCRATCH_LIST_ID] : []),
    ...(hostGroups.length > 0 ? [OTHER_HOSTS_LIST_ID] : []),
  ].join(" ");

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
          aria-controls={controls}
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
         * No padding of its own — the bands carry all of it. Horizontally, the
         * domain rules are children of this scroller while the header and
         * footer rules are not, so any inset here drew them shorter than the
         * chrome's. Vertically, it would stack on the first and last band's own.
         */
        maxHeight={
          // Anchored, the palette hangs from the title bar with most of the
          // window below it, so it sizes from the room Radix measures there
          // less its own chrome. The modal sits 15vh down and keeps the shell's
          // cap; it carries no commands.
          mode === "dropdown"
            ? "max-h-[min(72vh,calc(var(--radix-popover-content-available-height,85vh)-10rem))]"
            : hasProjectCommands
              ? "max-h-[min(60vh,calc(85vh-12rem))]"
              : undefined
        }
        scrollClassName="space-y-0"
        // The short fade: at the full 32px a live row sliding under the edge
        // read as disabled rather than as more list.
        compactFade
        ariaLabel="Workspaces"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
        // A press on row whitespace must not park focus on the region, where
        // typing stops filtering. The scratch rows and their controls are
        // tabbable, so the shell leaves presses on them alone.
        keepPointerFocusOnInput
      >
        <ProjectListContent
          results={viewResults}
          browseBands={viewBands}
          isRankedSearch={isRankedSearch}
          onToggleBand={toggleBand}
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
          // A local row under the pointer takes the cursor back from wherever
          // a claim had put it, or the highlight and Enter would stay there.
          // Through the cursor, so a scratch drawn in a project band — a row
          // the hook doesn't select among — is claimed rather than handed to it.
          onHoverRow={
            onHoverRow
              ? (rowId) => {
                  const stop = stops.find(
                    (candidate) => candidate.kind === "row" && candidate.row.id === rowId
                  );
                  if (stop) {
                    moveTo(stop);
                    return;
                  }
                  setClaim(null);
                  onHoverRow(rowId);
                }
              : undefined
          }
          onSaveScratchAsProject={onSaveAsProject}
          onRequestDeleteScratch={onRequestDeleteScratch}
          onRequestDeleteAllScratches={onRequestDeleteAllScratches}
          onRenameScratch={onRenameScratch}
          cursorBandKey={cursor?.kind === "band" ? cursor.bandKey : null}
          onHoverBand={(bandKey) => setClaim({ query, key: `band:${bandKey}` })}
          onReturnFocus={() => inputRef.current?.focus()}
        />
        {showScratchSection && (
          <>
            {/* Nothing above it to separate from once Scratch is the first content. */}
            <AppPaletteDialog.Divider
              hidden={isRankedSearch || (scratchesStandAlone && viewResults.length === 0)}
            />
            <ScratchSection
              scratches={pinnedScratches}
              collapsed={scratchCollapsed}
              onCreatingChange={setScratchCreating}
              liftedCount={liftedScratchCount}
              cursorOnCreate={cursor?.kind === "scratch-create"}
              onHoverCreate={() => setClaim({ query, key: "scratch-create" })}
              createRequest={createRequest}
              onToggleCollapsed={(collapsed) =>
                toggleBand(PROJECT_SWITCHER_SCRATCH_BAND_KEY, collapsed)
              }
              isSearching={isRankedSearch}
              isOnlyAction={scratchIsOnlyAction}
              onCreate={onCreateScratch}
              onSelect={onSelectScratch}
              onRequestDelete={onRequestDeleteScratch}
              onDeleteAll={onRequestDeleteAllScratches}
              onRename={onRenameScratch}
              onSaveAsProject={onSaveAsProject}
              onReturnFocus={() => inputRef.current?.focus()}
              cursorScratchId={cursor?.kind === "scratch" ? cursor.scratch.id : null}
              cursorOnBand={
                cursor?.kind === "band" && cursor.bandKey === PROJECT_SWITCHER_SCRATCH_BAND_KEY
              }
              onHoverScratch={(scratchId) => setClaim({ query, key: `scratch:${scratchId}` })}
              onHoverBand={() =>
                setClaim({ query, key: `band:${PROJECT_SWITCHER_SCRATCH_BAND_KEY}` })
              }
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
          collapsed={hostsCollapsed}
          // A search shows every match, so the band offers no fold there.
          onToggleCollapsed={
            isRankedSearch ? undefined : () => toggleBand(OTHER_HOSTS_BAND_KEY, !hostsCollapsed)
          }
          cursorOnBand={cursor?.kind === "band" && cursor.bandKey === OTHER_HOSTS_BAND_KEY}
          onHoverBand={() => setClaim({ query, key: `band:${OTHER_HOSTS_BAND_KEY}` })}
          activeKey={activeHostOption?.key ?? null}
          onChosen={onClose}
          // Also turns an automatic pick under the pointer into a chosen one.
          onHoverKey={(key) =>
            setClaim((prev) =>
              prev !== null && prev.key === `host:${key}` && prev.query === query && !prev.auto
                ? prev
                : { query, key: `host:${key}` }
            )
          }
        />
      </AppPaletteDialog.Body>

      {hasProjectCommands && (
        <>
          <AppPaletteDialog.Divider />
          <ProjectCommandBar
            onOpenProjectSettings={onOpenProjectSettings}
            onAddProject={onAddProject}
            onCloneRepo={onCloneRepo}
            onCreateFolder={onCreateFolder}
          />
        </>
      )}

      <AppPaletteDialog.Footer>
        <ProjectSwitcherFooter
          selectedRow={footerRow}
          hostOption={activeHostOption}
          inBrowse={!isRankedSearch && query === "" && stops.length > 1}
          hintOverride={
            cursor?.kind === "band"
              ? { keys: "↵", label: isFoldedBand(cursor.bandKey) ? "to expand" : "to collapse" }
              : cursor?.kind === "scratch-create"
                ? { keys: "↵", label: "to create" }
                : undefined
          }
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
        cycleRequest={innerProps.cycleRequest}
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
          cycleRequest={innerProps.cycleRequest}
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
  cycleRequest,
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
  consumeCloseAutoFocusSuppression,
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
        cycleRequest={cycleRequest}
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
        // Taken out of the rest spread on purpose: left in it, it rode into the
        // confirm dialogs and never reached the dropdown that consumes it.
        consumeCloseAutoFocusSuppression={consumeCloseAutoFocusSuppression}
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
        cycleRequest={cycleRequest}
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
