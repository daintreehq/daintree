import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import {
  ArchiveX,
  BellOff,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Download,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Square,
  Trash2,
  X,
  AppWindow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { KbdChord } from "@/components/ui/Kbd";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowDownAZ, ChartNoAxesColumn, Clock } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  getProjectRowStatus,
  getScratchRowStatus,
  ROW_DOT_CLASS,
  ROW_TONE_CLASS,
  type ProjectRowStatus,
} from "@/lib/projectRowStatus";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useModifierKeys } from "@/hooks/useModifierKeys";
import { useScratchDeletionProgress } from "@/hooks/useScratchDeletionProgress";
import { useOverlayClaim } from "@/hooks";
// Leaf import, not the `@/hooks` barrel: several palette suites mock that barrel
// and would throw on an export they don't list.
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { defaultScratchName } from "@shared/utils/scratchName";
import type {
  DeleteAllScratchesSnapshot,
  DeleteScratchTarget,
  ProjectSectionKey,
  ProjectSwitcherMode,
  ProjectSwitcherProjectRow,
  ProjectSwitcherRow,
  ProjectSwitcherScratchRow,
  SearchableProject,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import {
  PROJECT_SECTION_LABELS,
  OTHER_PROJECTS_SORT_CONTROL_MIN_ROWS,
} from "@/hooks/useProjectSwitcherPalette";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  isOtherProjectsSortMode,
  OTHER_PROJECTS_SORT_MODES,
  type OtherProjectsSortMode,
} from "@/lib/projectSort";
import { usePilotStore } from "@/store/pilotStore";
import {
  useProjectSettingsStore,
  areProjectNotificationsMuted,
} from "@/store/projectSettingsStore";
import {
  SCRATCH_CLEANUP_TTL_MS,
  SCRATCH_CLEANUP_COUNTDOWN_VISIBLE_DAYS,
} from "@shared/config/scratchCleanup";

export interface ProjectSwitcherPaletteProps {
  isOpen: boolean;
  query: string;
  /**
   * Mixed once a query is active — narrow on `kind` before reading anything a
   * scratch row doesn't carry.
   */
  results: ProjectSwitcherRow[];
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  /** Commits any row. Project-only callbacks below stay typed to projects. */
  onSelect: (row: ProjectSwitcherRow) => void;
  onClose: () => void;
  mode?: ProjectSwitcherMode;
  onAddProject?: () => void;
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onFreeMemoryProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  /** Pointer-enter callback used to schedule a hover prefetch of the project's hydrate payload. */
  onHoverProject?: (projectId: string, pointerType: string) => void;
  /** Pointer-leave callback used to cancel a pending hover prefetch. */
  onHoverProjectEnd?: (pointerType: string) => void;
  onOpenProjectSettings?: () => void;
  dropdownAlign?: "start" | "center" | "end";
  /**
   * Fired when the dropdown's Popover restores focus to its trigger on close.
   * Lets the trigger (e.g. ProjectSwitcher) suppress a Radix Tooltip from
   * reopening on the refocused trigger after a project switch. Dropdown-only.
   */
  onDropdownCloseAutoFocus?: () => void;
  children?: React.ReactNode;
  removeConfirmProject?: SearchableProject | null;
  onRemoveConfirmClose?: () => void;
  onConfirmRemove?: () => void;
  isRemovingProject?: boolean;
  /** Frozen snapshot of the project pending a "Free memory" confirm, or null. */
  freeMemoryConfirmProject?: SearchableProject | null;
  onFreeMemoryConfirmClose?: () => void;
  onConfirmFreeMemory?: () => void;
  isFreeingMemory?: boolean;
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
  /**
   * Target of a pending single-scratch delete confirmation, frozen when it
   * opened. Surfaced as a top-level ConfirmDialog above the palette.
   */
  deleteScratchConfirm?: DeleteScratchTarget | null;
  onDismissDeleteScratchConfirm?: () => void;
  onConfirmDeleteScratch?: () => void;
  isDeletingScratch?: boolean;
  /** Opens the "delete every scratch" confirmation from the section header's context menu. */
  onRequestDeleteAllScratches?: () => void;
  /**
   * Targets of a pending bulk-delete confirmation, frozen when it opened.
   * Surfaced as a top-level ConfirmDialog above the palette.
   */
  deleteAllScratchesConfirm?: DeleteAllScratchesSnapshot | null;
  onDismissDeleteAllScratchesConfirm?: () => void;
  onConfirmDeleteAllScratches?: () => void;
  isDeletingAllScratches?: boolean;
  /** Callback to rename a scratch in place. */
  onRenameScratch?: (scratchId: string, name: string) => void;
  /** Callback to save a scratch as a regular project (copy + register). */
  onSaveAsProject?: (scratchId: string) => void;
  /**
   * "Delete original?" follow-up after a successful Save-as-Project copy.
   * Surfaced as a top-level ConfirmDialog above the palette.
   */
  saveAsProjectConfirm?: {
    scratch: SearchableScratch;
    project: { name: string; path: string };
  } | null;
  onDismissSaveAsProjectConfirm?: () => void;
  onConfirmDeleteOriginalScratch?: () => void;
  isDeletingOriginalScratch?: boolean;
}

interface ProjectListItemProps {
  project: ProjectSwitcherProjectRow;
  isSelected: boolean;
  onSelect: (row: ProjectSwitcherProjectRow) => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onFreeMemoryProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
}

/**
 * The dot repeats the status line's tone rather than encoding anything on its
 * own — status must never be colour-only, and the sentence beside it already
 * carries the meaning for anyone who can't separate these hues.
 *
 * A row with nothing to report draws no dot, only the slot that reserves its
 * width (#11692). The slot is what keeps the tiles and names in one column: an
 * omitted dot would pull every quiet row 14px left of the busy ones, and a list
 * that is mostly quiet would read as the ragged edge rather than the tidy one.
 */
function StatusDot({ status }: { status: ProjectRowStatus }) {
  return (
    <div className="w-1.5 shrink-0">
      {!status.isDormantFallback && (
        <div
          className={cn("w-1.5 h-1.5 rounded-full", ROW_DOT_CLASS[status.tone])}
          data-testid="workspace-status-dot"
        />
      )}
    </div>
  );
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

function ProjectListItem({
  project,
  isSelected,
  onSelect,
  onStopProject,
  onCloseProject,
  onFreeMemoryProject,
  onLocateProject,
  onMoveOrRenameProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
}: ProjectListItemProps) {
  const showStop = project.processCount > 0 && !project.isMissing;
  // "Free memory" reclaims a backgrounded project's resident RAM. Only
  // meaningful for non-active, non-missing projects that still hold resources
  // (the active project owns the live renderer; a missing one has nothing
  // loaded; an already-closed one was reclaimed, so the action would no-op).
  const showFreeMemory = !project.isActive && !project.isMissing && project.status !== "closed";

  const notificationOverrides = useProjectSettingsStore(
    (state) => state.notificationOverridesByProjectId[project.id]
  );
  const isProjectNotificationsMuted = areProjectNotificationsMuted(notificationOverrides);

  const status = getProjectRowStatus(project);

  const row = (
    <div
      id={`project-option-${project.id}`}
      role="option"
      aria-selected={isSelected}
      // Where you are, on its own channel from where Enter goes. `aria-selected`
      // is spoken for — it is the one authority on the Enter target
      // (`PALETTE_ROW_CLASS`) — so the current project rides `aria-current`
      // instead, the same way every other surface in the app marks its active
      // row. Support for the bare attribute inside a listbox is uneven enough
      // that the accessible name says it too (see below).
      aria-current={project.isActive ? "true" : undefined}
      className={cn(
        PALETTE_ROW_CLASS,
        "group w-full flex items-center gap-2 px-3 py-1 rounded-[var(--radius-md)] text-left cursor-pointer",
        project.isActive
          ? // Hover still has to answer: the band wash used to sit under this
            // row permanently, which both marked it and made it look hovered
            // already, so pointing at it said nothing back.
            "text-daintree-text hover:bg-overlay-subtle"
          : project.isMissing
            ? // A missing project stays dimmed while selected: the row's own
              // brightness is what says the folder is gone, and restoring it
              // under the highlight would erase that.
              "text-daintree-text/50 hover:bg-overlay-subtle aria-selected:text-daintree-text/50"
            : "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text"
      )}
      // The current project is selectable too: picking where you already are is
      // a "never mind", and the handler closes the palette rather than sitting
      // there doing nothing.
      onClick={() => onSelect(project)}
      onPointerEnter={onHoverProject ? (e) => onHoverProject(project.id, e.pointerType) : undefined}
      onPointerLeave={onHoverProjectEnd ? (e) => onHoverProjectEnd(e.pointerType) : undefined}
    >
      <StatusDot status={status} />

      <div
        className={cn(
          // Wash/shadow var fallbacks keep themes without the overrides byte-identical.
          "flex items-center justify-center rounded-[var(--radius-lg)] shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))] shrink-0 transition duration-150",
          "h-8 w-8 text-base"
        )}
        style={{
          background: project.color
            ? `var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), ${getProjectGradient(project.color)}`
            : "var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), var(--color-daintree-sidebar)",
        }}
      >
        <span className="leading-none select-none filter drop-shadow-sm">{project.emoji}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center min-w-0">
          <span
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              project.isActive || isSelected ? "text-daintree-text" : "text-daintree-text/85"
            )}
          >
            {project.name}
          </span>
          {isProjectNotificationsMuted && (
            <BellOff
              className="w-3.5 h-3.5 text-daintree-text/40 shrink-0 ml-1"
              aria-label="Notifications muted for this project"
            />
          )}
          {/*
           * The band header above says which row this is, but a screen reader
           * arrowing straight onto the option may never hear the group boundary
           * — and `aria-current` itself goes unannounced inside a listbox often
           * enough that it can't be the only carrier. In the name it is always
           * read, and one extra word on one row is a cheap way to be sure.
           */}
          {project.isActive && <span className="sr-only">, current</span>}
        </div>

        {/*
         * The second line is earned, not standing. It says what the row is
         * doing, and "Opened 13h ago" is not that — repeated down twenty rows
         * it was most of the palette's height and none of its meaning (#11692).
         * A path hint is the exception: it disambiguates two projects with the
         * same folder name, so it belongs to identity rather than status and
         * survives on its own.
         */}
        {(!status.isDormantFallback || status.pathHint) && (
          <div className="flex items-center gap-1 min-w-0 mt-0.5">
            {!status.isDormantFallback && (
              <span
                className={cn("truncate text-[11px] leading-none", ROW_TONE_CLASS[status.tone])}
              >
                {status.text}
              </span>
            )}
            {status.pathHint && (
              <span className="truncate text-[11px] leading-none text-daintree-text/50 shrink">
                {status.isDormantFallback ? status.pathHint : `· ${status.pathHint}`}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const hasContextActions =
    onTogglePinProject ||
    onStopProject ||
    onCloseProject ||
    onFreeMemoryProject ||
    onCopyPath ||
    onSelectNewWindow ||
    onMoveOrRenameProject ||
    onLocateProject;
  if (!hasContextActions) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {onSelectNewWindow && !project.isActive && !project.isMissing && (
          <ContextMenuItem onSelect={() => onSelectNewWindow(project)}>
            <AppWindow className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Open in new window
          </ContextMenuItem>
        )}
        {onTogglePinProject && (
          <ContextMenuItem onSelect={() => onTogglePinProject(project.id)}>
            {project.isPinned ? (
              <>
                <PinOff className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Unpin project
              </>
            ) : (
              <>
                <Pin className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Pin project
              </>
            )}
          </ContextMenuItem>
        )}
        {onCopyPath && (
          <ContextMenuItem onSelect={() => onCopyPath(project.path)}>
            <Clipboard className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Copy path
          </ContextMenuItem>
        )}
        {onMoveOrRenameProject && !project.isMissing && (
          <ContextMenuItem onSelect={() => onMoveOrRenameProject(project.id)}>
            <FolderInput className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Move or rename project…
          </ContextMenuItem>
        )}
        {(onTogglePinProject || onCopyPath) &&
          (onStopProject || onFreeMemoryProject || onCloseProject) && <ContextMenuSeparator />}
        {showStop && onStopProject && (
          <ContextMenuItem destructive onSelect={() => onStopProject(project.id)}>
            <Square className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Stop all agents
          </ContextMenuItem>
        )}
        {showFreeMemory && onFreeMemoryProject && (
          <ContextMenuItem onSelect={() => onFreeMemoryProject(project.id)}>
            <ArchiveX className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Free memory
          </ContextMenuItem>
        )}
        {onCloseProject && project.isActive && (
          <ContextMenuItem destructive onSelect={() => onCloseProject(project.id)}>
            <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Close project
          </ContextMenuItem>
        )}
        {onCloseProject && !project.isActive && (
          <ContextMenuItem destructive onSelect={() => onCloseProject(project.id)}>
            <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Remove project
          </ContextMenuItem>
        )}
        {project.isMissing && onLocateProject && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onLocateProject(project.id)}>
              <FolderOpen className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Locate moved project
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A scratch as a row of the ranked search list (#11466).
 *
 * Deliberately NOT the button `ScratchSection` draws. That one is its own
 * focusable stop in a nested listbox; this one belongs to the palette's roving
 * selection, so it carries the shared `project-option-` id the scroll query and
 * `aria-activedescendant` resolve against, and stays out of the tab order.
 *
 * "Scratch" rides the secondary line rather than a chip: origin has to be
 * unambiguous, but it is not the row's headline, and a pill here would be a
 * second emphasis signal competing with the selected row's own treatment.
 *
 * Action-free on purpose. Rename, save-as-project and delete are browse-mode
 * management — an inline rename editor would have to live inside the array the
 * arrow keys walk, and search is for reaching a scratch, not administering one.
 */
function ScratchListItem({
  scratch,
  isSelected,
  onSelect,
}: {
  scratch: ProjectSwitcherScratchRow;
  isSelected: boolean;
  onSelect: (row: ProjectSwitcherScratchRow) => void;
}) {
  const status = getScratchRowStatus(scratch);

  return (
    <div
      id={`project-option-${scratch.id}`}
      role="option"
      aria-selected={isSelected}
      // Same split the project rows draw: `aria-selected` is the Enter target,
      // `aria-current` is the workspace you are in. A ranked scratch has no
      // band header to place it, so the accessible name carries the word too.
      aria-current={scratch.isActive ? "true" : undefined}
      className={cn(
        PALETTE_ROW_CLASS,
        "group w-full flex items-center gap-2 px-3 py-1 rounded-[var(--radius-md)] text-left cursor-pointer",
        scratch.isActive
          ? "text-daintree-text hover:bg-overlay-subtle"
          : "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text"
      )}
      onClick={() => onSelect(scratch)}
    >
      <StatusDot status={status} />

      <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-tint/[0.04] text-muted-foreground shrink-0">
        <FileText className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        {/*
         * Origin rides the name, not the status line. In the ranked list a
         * scratch sits among projects with no section header to place it, so
         * "Scratch" has to be on the row somewhere — and it answers what the
         * row *is*, which belongs beside the name. Parked on the status line it
         * also held that line open on a scratch with nothing to report, which
         * is the second line #11692 is trying to give back.
         */}
        <div className="flex items-baseline gap-1 min-w-0">
          <span className="truncate text-sm font-semibold leading-tight">{scratch.name}</span>
          <span className="text-[11px] leading-none text-daintree-text/50 shrink-0">· Scratch</span>
          {scratch.isActive && <span className="sr-only">, current</span>}
        </div>
        {!status.isDormantFallback && (
          <div
            className={cn("truncate text-[11px] leading-none mt-0.5", ROW_TONE_CLASS[status.tone])}
          >
            {status.text}
          </div>
        )}
      </div>
    </div>
  );
}

interface ProjectSection {
  key: ProjectSectionKey;
  label: string;
  items: ProjectSwitcherProjectRow[];
}

// Keyed by mode rather than a list, so the lookup below is total: a new mode in
// the union is a compile error here until it gets a label and an icon. The menu
// takes its order from `OTHER_PROJECTS_SORT_MODES`.
const OTHER_PROJECTS_SORT_OPTIONS: Record<
  OtherProjectsSortMode,
  { label: string; Icon: typeof Clock }
> = {
  mostUsed: { label: "Most used", Icon: ChartNoAxesColumn },
  recent: { label: "Recent", Icon: Clock },
  alphabetical: { label: "A to Z", Icon: ArrowDownAZ },
};

/**
 * The Other band's header, which doubles as its sort control (#11455). The
 * band is the residual catch-all, so its order is the one thing a reader can't
 * infer from the rows — the control's first job is naming that order, changing
 * it second. More so since the rows stopped printing their opened times
 * (#11692): there is now nothing else on screen hinting at how they are sorted.
 *
 * Two structural constraints shape the markup:
 *
 * - The `id` stays on a leaf element holding ONLY the label text. It is the
 *   `aria-labelledby` target for the surrounding `role="group"`, and that name
 *   is computed from the element's whole subtree — nesting the mode inside it
 *   would name the band "Other projects Most used".
 * - The trigger is `tabIndex={-1}`. Section headers live inside the
 *   `role="listbox"`, where a focusable child is invalid and unreachable
 *   anyway (arrow keys move `aria-activedescendant` across rows, never here).
 *   Right-click reaches the same options, matching every other secondary
 *   action in this palette.
 */
function OtherProjectsHeader({
  headerId,
  label,
  itemCount,
  onReturnFocus,
}: {
  headerId: string;
  label: string;
  itemCount: number;
  onReturnFocus?: () => void;
}) {
  const sortMode = usePreferencesStore((state) => state.projectSwitcherOtherSortMode);
  const setSortMode = usePreferencesStore((state) => state.setProjectSwitcherOtherSortMode);

  const active = OTHER_PROJECTS_SORT_OPTIONS[sortMode];
  const ActiveIcon = active.Icon;

  const handleValueChange = (value: string) => {
    if (isOtherProjectsSortMode(value)) setSortMode(value);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="presentation"
          className={cn(
            PALETTE_SECTION_LABEL_CLASS,
            "flex items-center justify-between px-3 py-1 normal-case tracking-normal"
          )}
        >
          <div id={headerId} className="tracking-wider uppercase">
            {label}
          </div>
          {itemCount >= OTHER_PROJECTS_SORT_CONTROL_MIN_ROWS && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  data-testid="other-projects-sort-trigger"
                  aria-label={`Sort other projects, currently ${active.label}`}
                  className="flex shrink-0 items-center gap-1 text-daintree-text/40 hover:text-daintree-text/60 transition-colors"
                >
                  <ActiveIcon className="w-3 h-3" aria-hidden="true" />
                  {active.label}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  // Radix would restore focus to the trigger, which then eats
                  // ArrowDown and Enter to reopen itself — leaving the palette
                  // unable to walk or commit a row until focus moved by hand.
                  // The search box owns those keys, so send focus back there.
                  //
                  // Deferred a frame: focusing inside Radix's own focus-restore
                  // window loses the race with its teardown (same reason
                  // `ContentPanel`'s rename input defers).
                  event.preventDefault();
                  requestAnimationFrame(() => onReturnFocus?.());
                }}
              >
                <DropdownMenuRadioGroup value={sortMode} onValueChange={handleValueChange}>
                  {OTHER_PROJECTS_SORT_MODES.map((value) => {
                    const { label: optionLabel, Icon } = OTHER_PROJECTS_SORT_OPTIONS[value];
                    return (
                      <DropdownMenuRadioItem key={value} value={value}>
                        <Icon className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                        {optionLabel}
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </ContextMenuTrigger>
      {/*
       * Right-click keeps the options reachable below the row threshold, where
       * the visible trigger hides itself — the preference still applies there.
       */}
      <ContextMenuContent>
        <ContextMenuRadioGroup value={sortMode} onValueChange={handleValueChange}>
          {OTHER_PROJECTS_SORT_MODES.map((value) => {
            const { label: optionLabel, Icon } = OTHER_PROJECTS_SORT_OPTIONS[value];
            return (
              <ContextMenuRadioItem key={value} value={value}>
                <Icon className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                {optionLabel}
              </ContextMenuRadioItem>
            );
          })}
        </ContextMenuRadioGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface ProjectListContentProps {
  results: ProjectSwitcherRow[];
  selectedIndex: number;
  query: string;
  onSelect: (row: ProjectSwitcherRow) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Whether this surface offers "Add Project…" — decides what the empty state can name. */
  canAddProject: boolean;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onFreeMemoryProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
  /** Hands focus back to the search box after the sort menu closes. */
  onReturnFocus?: () => void;
}

function ProjectListContent({
  results,
  selectedIndex,
  query,
  onSelect,
  listRef,
  canAddProject,
  onStopProject,
  onCloseProject,
  onFreeMemoryProject,
  onLocateProject,
  onMoveOrRenameProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
  onReturnFocus,
}: ProjectListContentProps) {
  const isSearching = query.trim().length > 0;

  // Mounted here, once for the whole list, rather than per row: sixty timers in
  // a hundred-project list would all fire for the same reason.

  // Bands are contiguous runs of `results`, never a re-filter of it. The hook
  // has already sorted by section, so walking the array once and cutting where
  // `section` changes reproduces the grouping without building a second,
  // narrower list — the thing that stranded the highlight and let Enter commit
  // an off-screen project (#11071). Every row in every band is still a row of
  // `results`, at the same index the arrow keys use.
  const sections = useMemo<ProjectSection[] | null>(() => {
    if (isSearching || results.length === 0) return null;

    const bands: ProjectSection[] = [];
    for (const row of results) {
      // Browse is projects only — scratches ride the pinned section below. A
      // non-project row here would mean that changed, so drop the whole band
      // layout rather than skipping the row: the flat branch still renders
      // everything, where dropping one would strand the highlight on a row that
      // isn't on screen (#11071).
      if (row.kind !== "project") return null;
      const last = bands.at(-1);
      if (last && last.key === row.section) {
        last.items.push(row);
      } else {
        bands.push({
          key: row.section,
          label: PROJECT_SECTION_LABELS[row.section],
          items: [row],
        });
      }
    }
    return bands;
  }, [results, isSearching]);

  // `results` is already scoped by the hook to exactly the rows this mode
  // renders, so it doubles as the arrow-key domain. Never re-filter it here:
  // a second, narrower array is what stranded the highlight and let Enter
  // commit an off-screen project (#11071).
  const selectedRowId = results[selectedIndex]?.id;

  const renderItem = (row: ProjectSwitcherRow) => {
    const isSelected = row.id === selectedRowId;
    return (
      <div key={`${row.kind}-${row.id}`} role="presentation">
        {row.kind === "scratch" ? (
          <ScratchListItem scratch={row} isSelected={isSelected} onSelect={onSelect} />
        ) : (
          <ProjectListItem
            project={row}
            isSelected={isSelected}
            onSelect={onSelect}
            onStopProject={onStopProject}
            onCloseProject={onCloseProject}
            onFreeMemoryProject={onFreeMemoryProject}
            onLocateProject={onLocateProject}
            onMoveOrRenameProject={onMoveOrRenameProject}
            onTogglePinProject={onTogglePinProject}
            onCopyPath={onCopyPath}
            onSelectNewWindow={onSelectNewWindow}
            onHoverProject={onHoverProject}
            onHoverProjectEnd={onHoverProjectEnd}
          />
        )}
      </div>
    );
  };

  return (
    <>
      <div ref={listRef} id="project-list" role="listbox" aria-label="Workspaces">
        {results.length === 0 ? (
          <div className="p-2">
            <div
              className="px-3 py-8 text-center text-daintree-text/50 text-sm"
              data-testid="project-empty-state"
            >
              {query.trim() ? (
                // "Workspaces", not "projects": scratches are ranked into this
                // same list now, so naming only half of what was searched would
                // read as a scratch still being findable somewhere else.
                <div>{`No workspaces match "${query}"`}</div>
              ) : canAddProject ? (
                // Names the button sitting directly below this list.
                "Add a project to get started"
              ) : (
                // The modal mounts without the add/clone callbacks, so naming
                // them here would point at an action this surface can't run.
                "Open a project from the File menu to get started"
              )}
            </div>
          </div>
        ) : sections ? (
          sections.map((section, sectionIdx) => {
            const isLast = sectionIdx === sections.length - 1;
            const headerId = `project-section-${section.key}`;

            // Bands wrap options, so they can't be bare `div`s inside the
            // listbox: each is a `group` named by its own visible header. Every
            // band carries one now that `current` is labelled (#11692), which
            // is also what keeps this legal — an unnamed `group` is an ARIA
            // violation, so a band without a header would have to flatten away.
            return (
              <div key={section.key} role="presentation">
                {sectionIdx > 0 && <AppPaletteDialog.Divider />}
                <div
                  role="group"
                  aria-labelledby={headerId}
                  className={cn("px-2 py-1.5", sectionIdx === 0 && "pt-2", isLast && "pb-2")}
                >
                  {section.key === "other" ? (
                    <OtherProjectsHeader
                      headerId={headerId}
                      label={section.label}
                      itemCount={section.items.length}
                      onReturnFocus={onReturnFocus}
                    />
                  ) : (
                    <div id={headerId} className={cn(PALETTE_SECTION_LABEL_CLASS, "px-3 py-1")}>
                      {section.label}
                    </div>
                  )}
                  {section.items.map(renderItem)}
                </div>
              </div>
            );
          })
        ) : (
          <div className="p-2" role="presentation">
            {results.map((project) => renderItem(project))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Returns the cleanup-countdown microcopy when a scratch is within the
 * visibility window, otherwise null. Strings are hardcoded English (sentence
 * case, no period) per the project microcopy convention. The TTL constant is
 * imported from `shared/config/scratchCleanup` so the user-visible countdown
 * never drifts from the actual deletion threshold in `ScratchCleanupService`.
 */
export function formatScratchCleanupCountdown(lastOpened: number, now: number): string | null {
  if (!lastOpened) return null;
  const expiresAt = lastOpened + SCRATCH_CLEANUP_TTL_MS;
  const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
  if (daysLeft > SCRATCH_CLEANUP_COUNTDOWN_VISIBLE_DAYS) return null;
  if (daysLeft <= 0) return "Auto-cleanup today";
  if (daysLeft === 1) return "Auto-cleanup tomorrow";
  return `Auto-cleanup in ${daysLeft} days`;
}

interface ScratchNameEditorProps {
  initialValue: string;
  ariaLabel: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  testId: string;
}

/**
 * Inline name field for creating or renaming a scratch. Lives inside
 * `AppPaletteDialog`, whose document-level Escape backstop would otherwise close
 * the whole switcher — so Escape is both consumed here and claimed on the escape
 * stack. Enter is stopped for the same reason: the palette's own Enter handler
 * lives on the search input, but the backstop listens on document.
 */
function ScratchNameEditor({
  initialValue,
  ariaLabel,
  onCommit,
  onCancel,
  testId,
}: ScratchNameEditorProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Committing on blur would fire on Escape's focus restore too, resurrecting the
  // cancelled edit; explicit Enter is the only commit path.
  const committedRef = useRef(false);

  useEscapeStack(true, () => {
    if (committedRef.current) return;
    onCancel();
  });

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = useCallback(() => {
    committedRef.current = true;
    onCommit(value);
  }, [onCommit, value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    },
    [commit, onCancel]
  );

  return (
    <div className="w-full flex items-center gap-3 px-3 py-2 mt-1 rounded-[var(--radius-md)]">
      <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-tint/[0.04] text-muted-foreground shrink-0">
        <FileText className="h-4 w-4" />
      </div>
      <input
        ref={inputRef}
        data-scratch-name-input=""
        data-testid={testId}
        type="text"
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        className="flex-1 min-w-0 bg-overlay-soft border border-[var(--border-overlay)] rounded-[var(--radius-md)] px-2 py-1 text-sm text-daintree-text outline-hidden focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
      />
    </div>
  );
}

type ScratchEditorState =
  { kind: "create" } | { kind: "rename"; scratchId: string; name: string } | null;

interface ScratchSectionProps {
  scratches: SearchableScratch[];
  /**
   * True once a query is active, where the ranked list owns the scratches. The
   * section hides rather than unmounting: remounting would reset `collapsed`,
   * so a section the user deliberately collapsed would spring back open the
   * moment they cleared the box.
   */
  isSearching: boolean;
  onCreate?: (name?: string) => void;
  onSelect?: (scratch: SearchableScratch) => void;
  onRequestDelete?: (scratchId: string) => void;
  onDeleteAll?: () => void;
  onRename?: (scratchId: string, name: string) => void;
  onSaveAsProject?: (scratchId: string) => void;
}

/**
 * Collapsible "Scratch" section, rendered in browse only — searching ranks
 * scratches into the main list instead (#11466). Defaults to collapsed when
 * there are no scratches yet — discoverable but quiet. Once the user has
 * scratches, defaults to expanded.
 *
 * Sort order is purely by `lastOpened` desc (the hook already does this).
 * Scratches deliberately do NOT participate in the project frecency ranking.
 */
function ScratchSection({
  scratches,
  isSearching,
  onCreate,
  onSelect,
  onRequestDelete,
  onDeleteAll,
  onRename,
  onSaveAsProject,
}: ScratchSectionProps) {
  const [collapsed, setCollapsed] = useState<boolean>(scratches.length === 0);
  const [editor, setEditor] = useState<ScratchEditorState>(null);
  // Radix restores focus to the context-menu trigger on close, but for a rename
  // that trigger has been swapped out for the editor — the restore would steal
  // focus from the input and blur-cancel the edit before it began.
  const suppressMenuFocusRestoreRef = useRef(false);
  const previousScratchCountRef = useRef(scratches.length);
  // `now` is captured per-render so the countdown updates whenever the
  // surrounding component re-renders. Refresh is naturally driven by store
  // updates (loadScratches on palette open, scratch:updated push events) —
  // an interval here would be wasteful given the daily granularity.
  const now = Date.now();

  // If a scratch was just created from the empty state, expand the section
  // so the new entry is visible.
  useEffect(() => {
    const previousScratchCount = previousScratchCountRef.current;
    previousScratchCountRef.current = scratches.length;

    if (previousScratchCount === 0 && scratches.length > 0) {
      setCollapsed(false);
    }
  }, [scratches.length]);

  // A rename target can vanish under the editor via a scratch:removed push.
  useEffect(() => {
    if (editor?.kind !== "rename") return;
    if (!scratches.some((s) => s.id === editor.scratchId)) {
      setEditor(null);
    }
  }, [editor, scratches]);

  // Searching hides this section, and a hidden editor is worse than a closed
  // one: it still holds its claim on the escape stack, so Escape would cancel
  // an edit nobody can see instead of closing the palette.
  useEffect(() => {
    if (isSearching) setEditor(null);
  }, [isSearching]);

  const closeEditor = useCallback(() => setEditor(null), []);

  const handleCreateCommit = useCallback(
    (name: string) => {
      setEditor(null);
      onCreate?.(name);
    },
    [onCreate]
  );

  const handleRenameCommit = useCallback(
    (scratchId: string, previousName: string, name: string) => {
      setEditor(null);
      const trimmed = name.trim();
      if (!trimmed || trimmed === previousName) return;
      onRename?.(scratchId, trimmed);
    },
    [onRename]
  );

  const isCreating = editor?.kind === "create";

  return (
    <div className="px-2 py-1.5" hidden={isSearching}>
      {/*
       * The trigger stays mounted at zero scratches — only the menu content is
       * conditional. Swapping the button in and out of a ContextMenu as the last
       * scratch is deleted would remount the node Radix is restoring focus to.
       * A `contextmenu` gesture (and Shift+F10) never dispatches `click`, so the
       * collapse toggle below is safe to leave as-is.
       */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className={cn(
              PALETTE_SECTION_LABEL_CLASS,
              "w-full flex items-center justify-between px-3 py-1 hover:text-daintree-text/60 transition-colors"
            )}
            aria-expanded={!collapsed}
            aria-controls="scratch-section-list"
          >
            <span className="flex items-center gap-1.5">
              {collapsed ? (
                <ChevronRight className="w-3 h-3" aria-hidden="true" />
              ) : (
                <ChevronDown className="w-3 h-3" aria-hidden="true" />
              )}
              Scratch
            </span>
            {scratches.length > 0 && (
              <span className="text-[10px] tabular-nums">{scratches.length}</span>
            )}
          </button>
        </ContextMenuTrigger>
        {onDeleteAll && scratches.length > 0 && (
          <ContextMenuContent>
            <ContextMenuItem destructive onSelect={onDeleteAll}>
              <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Delete all scratch workspaces
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
      {!collapsed && (
        <div id="scratch-section-list" className="mt-1">
          {scratches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-daintree-text/40">
              No scratch workspaces yet. Create one for a quick one-off task.
            </div>
          ) : (
            <div role="listbox" aria-label="Scratch workspaces">
              {scratches.map((scratch) => {
                const isRenaming = editor?.kind === "rename" && editor.scratchId === scratch.id;
                if (isRenaming) {
                  // Both the seed and the no-op comparison use the name frozen when
                  // editing began. Against the live name, an untouched editor would
                  // resubmit the old name and undo a rename that landed by push.
                  const originalName = editor.name;
                  return (
                    <ScratchNameEditor
                      key={scratch.id}
                      initialValue={originalName}
                      ariaLabel="Scratch name"
                      testId="scratch-rename-input"
                      onCommit={(name) => handleRenameCommit(scratch.id, originalName, name)}
                      onCancel={closeEditor}
                    />
                  );
                }

                const countdown = formatScratchCleanupCountdown(scratch.lastOpened, now);
                const status = getScratchRowStatus(scratch, now);
                const hasContextActions = Boolean(onRequestDelete || onSaveAsProject || onRename);
                return (
                  <ContextMenu key={scratch.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onSelect?.(scratch)}
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-1 rounded-[var(--radius-md)] text-left transition-colors",
                          scratch.isActive ? "bg-overlay-subtle" : "hover:bg-overlay-subtle"
                        )}
                        role="option"
                        // This list has no roving cursor of its own, so
                        // `aria-selected` here has only ever meant "the scratch
                        // you're in" and stays. `aria-current` names that
                        // directly, matching how the ranked rows above say it.
                        aria-selected={scratch.isActive}
                        aria-current={scratch.isActive ? "true" : undefined}
                      >
                        <StatusDot status={status} />
                        <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-tint/[0.04] text-muted-foreground shrink-0">
                          <FileText className="h-4 w-4" aria-hidden="true" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate leading-tight">
                            {scratch.name}
                          </div>
                          {/*
                           * No origin hint here — the section header already
                           * says "Scratch", so repeating it on every row would
                           * be chrome naming what the reader just read.
                           *
                           * The status line is conditional for the same reason
                           * it is on a project row (#11692); the cleanup
                           * countdown below is not, because a scratch about to
                           * be deleted is exactly the row that has something to
                           * report even when nothing is running.
                           */}
                          {!status.isDormantFallback && (
                            <div
                              className={cn(
                                "text-[11px] leading-none truncate mt-0.5",
                                ROW_TONE_CLASS[status.tone]
                              )}
                            >
                              {status.text}
                            </div>
                          )}
                          {countdown && (
                            <div
                              className="text-[11px] leading-none text-daintree-text/40 mt-0.5 truncate"
                              data-testid="scratch-cleanup-countdown"
                            >
                              {countdown}
                            </div>
                          )}
                        </div>
                      </button>
                    </ContextMenuTrigger>
                    {hasContextActions && (
                      <ContextMenuContent
                        onCloseAutoFocus={(e) => {
                          if (!suppressMenuFocusRestoreRef.current) return;
                          suppressMenuFocusRestoreRef.current = false;
                          e.preventDefault();
                        }}
                      >
                        {onRename && (
                          <ContextMenuItem
                            onSelect={() => {
                              suppressMenuFocusRestoreRef.current = true;
                              setEditor({
                                kind: "rename",
                                scratchId: scratch.id,
                                name: scratch.name,
                              });
                            }}
                          >
                            <Pencil className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                            Rename scratch
                          </ContextMenuItem>
                        )}
                        {onSaveAsProject && (
                          <ContextMenuItem onSelect={() => onSaveAsProject(scratch.id)}>
                            <FolderUp className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                            Save as project…
                          </ContextMenuItem>
                        )}
                        {(onSaveAsProject || onRename) && onRequestDelete && (
                          <ContextMenuSeparator />
                        )}
                        {onRequestDelete && (
                          <ContextMenuItem destructive onSelect={() => onRequestDelete(scratch.id)}>
                            <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                            Delete scratch…
                          </ContextMenuItem>
                        )}
                      </ContextMenuContent>
                    )}
                  </ContextMenu>
                );
              })}
            </div>
          )}
          {onCreate &&
            (isCreating ? (
              <ScratchNameEditor
                initialValue={defaultScratchName(new Date())}
                ariaLabel="Name for the new scratch workspace"
                testId="scratch-create-input"
                onCommit={handleCreateCommit}
                onCancel={closeEditor}
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditor({ kind: "create" })}
                className="w-full flex items-center gap-3 px-3 py-2 mt-1 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
                data-testid="scratch-create-button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  New scratch workspace
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Every hint here is project-only, so a highlighted scratch row drops them
 * rather than naming affordances it doesn't have: ⌘↵ falls back to a plain
 * switch, and a search-mode scratch row carries no context menu.
 */
function ProjectSwitcherFooter({
  isScratchSelected,
  onOpenPilot,
}: {
  isScratchSelected: boolean;
  onOpenPilot: () => void;
}) {
  const modifiers = useModifierKeys();
  // Resolved, not hardcoded: the literal would be wrong on Windows/Linux and
  // wrong for anyone who rebound or removed the binding.
  const pilotShortcut = useEffectiveCombo("pilot.toggle");

  const hint =
    modifiers.meta && !isScratchSelected
      ? { keys: "⌘↵", label: "New window" }
      : { keys: "↵", label: "Switch" };

  return (
    // Container-queried rather than fixed: the same footer serves the anchored
    // dropdown and the wider command-tier modal, and the passive "Right-click
    // for more" does not fit the anchored box — so it drops there and the Enter
    // action and "All agents" (the only affordance with no other entry point)
    // survive. Tailwind needs each variant written out, so it is a literal.
    //
    // There is deliberately no ⌘⌫ Remove rail. It fit the old single 484px
    // surface, but the anchored footer is 326px: at its widest — ⌘ held, so the
    // Enter rail reads "⌘↵ New window" — the two rails measure 251px, and a
    // Remove rail takes that to 343px, which overflows rather than degrading.
    // A container query cannot drop it only in the ⌘-held state, and ⌘ held is
    // exactly when it would be worth reading. The chord itself still works; the
    // context menu is what names it.
    <div className="@container/switcher-footer w-full flex items-center justify-between gap-3">
      <span className="shrink-0">
        <kbd className={KBD_CLASS}>{hint.keys}</kbd>
        <span className="ml-1.5">{hint.label}</span>
      </span>
      <div className="flex items-center gap-3 min-w-0">
        {/*
          The switcher answers "which project", so the fleet-wide view belongs
          beside it rather than inside its list: adding a row would put a
          non-workspace entry into a listbox whose every other row is a
          workspace, and into the arrow-key domain that selects one.
        */}
        <button
          type="button"
          onClick={onOpenPilot}
          className="inline-flex items-center shrink-0 text-daintree-text/50 transition-colors duration-150 ease-out hover:text-daintree-text"
          data-testid="project-switcher-open-pilot"
          {...(pilotShortcut ? { "aria-keyshortcuts": pilotShortcut } : {})}
        >
          {pilotShortcut && <KbdChord shortcut={pilotShortcut} />}
          <span className={pilotShortcut ? "ml-1.5" : undefined}>All agents</span>
        </button>
        {!isScratchSelected && (
          <span className="text-daintree-text/50 shrink-0 @max-[520px]/switcher-footer:hidden">
            Right-click for more
          </span>
        )}
      </div>
    </div>
  );
}

interface ProjectPaletteInnerProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  results: ProjectSwitcherRow[];
  selectedIndex: number;
  mode?: ProjectSwitcherMode;
  onQueryChange: (query: string) => void;
  onSelect: (row: ProjectSwitcherRow) => void;
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
  onFreeMemoryProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
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
}

function ProjectPaletteInner({
  inputRef,
  listRef,
  query,
  results,
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
  onFreeMemoryProject,
  onLocateProject,
  onMoveOrRenameProject,
  onTogglePinProject,
  onCopyPath,
  onHoverProject,
  onHoverProjectEnd,
  rankedSearch,
  scratchResults,
  onCreateScratch,
  onSelectScratch,
  onRequestDeleteScratch,
  onRequestDeleteAllScratches,
  onRenameScratch,
  onSaveAsProject,
}: ProjectPaletteInnerProps) {
  const projectSwitcherShortcut = useEffectiveCombo("project.switcherPalette");

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && selectedIndex < results.length) {
      const selectedItem = listRef.current.querySelector(
        `#project-option-${results[selectedIndex]!.id}`
      );
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [listRef, selectedIndex, results]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          onSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
            const selected = results[selectedIndex]!;
            // A scratch has no second window to open, so ⌘↵ falls through to
            // the plain switch rather than swallowing the keypress.
            if (
              (e.metaKey || e.ctrlKey) &&
              onSelectNewWindow &&
              selected.kind === "project" &&
              !selected.isActive &&
              !selected.isMissing
            ) {
              onSelectNewWindow(selected);
            } else {
              onSelect(selected);
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
          onClose();
          break;
        case "Backspace": {
          // Projects only. Both paths confirm now, but the chord means "close
          // the project" — pointing it at a scratch row would overload one key
          // with a reversible close and an irreversible delete.
          const target = results[selectedIndex];
          if ((e.metaKey || e.ctrlKey) && onCloseProject && target?.kind === "project") {
            e.preventDefault();
            e.stopPropagation();
            onCloseProject(target.id);
          }
          break;
        }
      }
    },
    [
      results,
      selectedIndex,
      mode,
      onSelectPrevious,
      onSelectNext,
      onSelect,
      onSelectNewWindow,
      onClose,
      onCloseProject,
    ]
  );

  const activeResult = results[selectedIndex];
  const activeDescendant = activeResult ? `project-option-${activeResult.id}` : undefined;
  // The RANKED list owns the scratches, and it trails the box by a commit.
  // Hiding the pinned section on the live query instead would blank them for
  // that frame — and for a user whose only workspaces are scratches, that frame
  // reads as "no matches".
  const isRankedSearch = rankedSearch ?? query.trim().length > 0;

  useWaitAgeTick(results.length > 0 || (scratchResults?.length ?? 0) > 0);

  return (
    <>
      <AppPaletteDialog.Header label="Switch project" shortcut={projectSwitcherShortcut}>
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search workspaces…"
          role="combobox"
          aria-expanded={true}
          aria-haspopup="listbox"
          aria-label="Search workspaces"
          aria-controls="project-list"
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        className="p-0"
        ariaLabel="Workspaces"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
      >
        <ProjectListContent
          results={results}
          selectedIndex={selectedIndex}
          query={query}
          onSelect={onSelect}
          listRef={listRef}
          canAddProject={Boolean(onAddProject)}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          onFreeMemoryProject={onFreeMemoryProject}
          onLocateProject={onLocateProject}
          onMoveOrRenameProject={onMoveOrRenameProject}
          onTogglePinProject={onTogglePinProject}
          onCopyPath={onCopyPath}
          onSelectNewWindow={onSelectNewWindow}
          onHoverProject={onHoverProject}
          onHoverProjectEnd={onHoverProjectEnd}
          onReturnFocus={() => inputRef.current?.focus()}
        />
        {(onCreateScratch || (scratchResults && scratchResults.length > 0)) && (
          <>
            <AppPaletteDialog.Divider hidden={isRankedSearch} />
            <ScratchSection
              scratches={scratchResults ?? []}
              isSearching={isRankedSearch}
              onCreate={onCreateScratch}
              onSelect={onSelectScratch}
              onRequestDelete={onRequestDeleteScratch}
              onDeleteAll={onRequestDeleteAllScratches}
              onRename={onRenameScratch}
              onSaveAsProject={onSaveAsProject}
            />
          </>
        )}
      </AppPaletteDialog.Body>

      {(onOpenProjectSettings || onAddProject || onCloneRepo || onCreateFolder) && (
        <>
          <AppPaletteDialog.Divider />
          <div className="px-2 pt-1 pb-2">
            {onOpenProjectSettings && (
              <button
                type="button"
                onClick={() => onOpenProjectSettings()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-tint/[0.04] text-muted-foreground">
                  <Settings2 className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">Project Settings…</span>
              </button>
            )}
            {onAddProject && (
              <button
                type="button"
                onClick={() => onAddProject()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
                data-testid="project-add-button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">Add Project…</span>
              </button>
            )}
            {onCloneRepo && (
              <button
                type="button"
                onClick={() => onCloneRepo()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
                data-testid="project-clone-button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Download className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">Clone Repository…</span>
              </button>
            )}
            {onCreateFolder && (
              <button
                type="button"
                onClick={() => onCreateFolder()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <FolderPlus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  Create New Folder…
                </span>
              </button>
            )}
          </div>
        </>
      )}

      <AppPaletteDialog.Footer>
        <ProjectSwitcherFooter
          isScratchSelected={activeResult?.kind === "scratch"}
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
      onClose={onClose}
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
        onFreeMemoryProject={innerProps.onFreeMemoryProject}
        onLocateProject={innerProps.onLocateProject}
        onMoveOrRenameProject={innerProps.onMoveOrRenameProject}
        onTogglePinProject={innerProps.onTogglePinProject}
        onCopyPath={innerProps.onCopyPath}
        onSelectNewWindow={innerProps.onSelectNewWindow}
        onHoverProject={innerProps.onHoverProject}
        onHoverProjectEnd={innerProps.onHoverProjectEnd}
        rankedSearch={innerProps.rankedSearch}
        scratchResults={innerProps.scratchResults}
        onCreateScratch={innerProps.onCreateScratch}
        onSelectScratch={innerProps.onSelectScratch}
        onRequestDeleteScratch={innerProps.onRequestDeleteScratch}
        onRequestDeleteAllScratches={innerProps.onRequestDeleteAllScratches}
        onRenameScratch={innerProps.onRenameScratch}
        onSaveAsProject={innerProps.onSaveAsProject}
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
        sideOffset={8}
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
          onFreeMemoryProject={innerProps.onFreeMemoryProject}
          onLocateProject={innerProps.onLocateProject}
          onMoveOrRenameProject={innerProps.onMoveOrRenameProject}
          onTogglePinProject={innerProps.onTogglePinProject}
          onCopyPath={innerProps.onCopyPath}
          onSelectNewWindow={innerProps.onSelectNewWindow}
          onHoverProject={innerProps.onHoverProject}
          onHoverProjectEnd={innerProps.onHoverProjectEnd}
          rankedSearch={innerProps.rankedSearch}
          scratchResults={innerProps.scratchResults}
          onCreateScratch={innerProps.onCreateScratch}
          onSelectScratch={innerProps.onSelectScratch}
          onRequestDeleteScratch={innerProps.onRequestDeleteScratch}
          onRequestDeleteAllScratches={innerProps.onRequestDeleteAllScratches}
          onRenameScratch={innerProps.onRenameScratch}
          onSaveAsProject={innerProps.onSaveAsProject}
        />
      </AppPalettePopover.Content>
    </AppPalettePopover>
  );
}

/**
 * Single-scratch delete confirmation (#11522).
 *
 * Its own component so the progress clocks mount and unmount with the dialog —
 * the palette body would otherwise carry timers outliving every confirm it ever
 * opened.
 */
function DeleteScratchConfirmDialog({
  target,
  onDismiss,
  onConfirm,
  isDeleting,
  restoreFocusTo,
}: {
  target: DeleteScratchTarget;
  onDismiss: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
  restoreFocusTo: React.RefObject<HTMLElement | null>;
}) {
  const progress = useScratchDeletionProgress(isDeleting);

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={isDeleting ? undefined : onDismiss}
      title={`Delete '${target.name}'?`}
      zIndex="nested"
      confirmLabel="Delete scratch"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      // Split on purpose: the button locks the instant it is pressed, but its
      // spinner waits out the Doherty gate, so a scratch that deletes in 80ms
      // never flashes one. Gating the lock too would leave a window where a
      // second press still went through.
      confirmDisabled={isDeleting}
      isConfirmLoading={isDeleting && progress.isVisible}
      variant="destructive"
      // The row that opened this is gone by the time it closes, so the default
      // restore walks to the first tabbable node under #root — app chrome behind
      // a palette that is still `aria-modal`. Hand focus back to the search box
      // instead, which survives the delete and keeps it inside the palette.
      restoreFocusTo={restoreFocusTo}
    >
      <div className="space-y-3">
        <div className="text-sm text-daintree-text/70">
          Its terminals will be closed and its folder deleted from disk.
        </div>
        <div className="text-xs text-daintree-text/50 font-mono break-all">{target.path}</div>
        {/*
         * Raw `isDeleting` decides whether the live region exists; the Doherty
         * gate only decides whether it has anything to say, so a scratch that
         * deletes inside the gate never flashes it (lesson #10083). The region
         * stays mounted for the whole run so the long-wait line is an update to
         * one announcer rather than a second one.
         */}
        {isDeleting && (
          <div
            role="status"
            className="min-h-4 text-xs text-daintree-text/60"
            data-testid="delete-scratch-progress"
          >
            {progress.isVisible && (
              <>
                {/*
                 * Names the operation, not a step. Main tears the terminals down
                 * FIRST and only reaches the folder if that confirms — so a line
                 * claiming both would be asserting file deletion during a
                 * teardown that may yet fail and delete nothing. The steps are
                 * named in the consequence copy above, where they are a statement
                 * of intent rather than a claim about what is happening now.
                 */}
                Deleting scratch…
                {progress.isStillWorking && (
                  <span className="block text-daintree-text/40">Still working…</span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

export function ProjectSwitcherPalette({
  isOpen,
  query,
  results,
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
  onFreeMemoryProject,
  onLocateProject,
  onMoveOrRenameProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
  onOpenProjectSettings,
  onDropdownCloseAutoFocus,
  dropdownAlign,
  children,
  removeConfirmProject,
  onRemoveConfirmClose,
  onConfirmRemove,
  isRemovingProject = false,
  freeMemoryConfirmProject,
  onFreeMemoryConfirmClose,
  onConfirmFreeMemory,
  isFreeingMemory = false,
  rankedSearch,
  scratchResults,
  onCreateScratch,
  onSelectScratch,
  onRequestDeleteScratch,
  deleteScratchConfirm,
  onDismissDeleteScratchConfirm,
  onConfirmDeleteScratch,
  isDeletingScratch = false,
  onRequestDeleteAllScratches,
  deleteAllScratchesConfirm,
  onDismissDeleteAllScratchesConfirm,
  onConfirmDeleteAllScratches,
  isDeletingAllScratches = false,
  onRenameScratch,
  onSaveAsProject,
  saveAsProjectConfirm,
  onDismissSaveAsProjectConfirm,
  onConfirmDeleteOriginalScratch,
  isDeletingOriginalScratch = false,
}: ProjectSwitcherPaletteProps) {
  const paletteInputRef = useRef<HTMLInputElement>(null);

  const hasRunningProcesses = removeConfirmProject
    ? removeConfirmProject.processCount > 0 ||
      removeConfirmProject.activeAgentCount > 0 ||
      removeConfirmProject.waitingAgentCount > 0
    : false;

  const content =
    mode === "dropdown" ? (
      <DropdownContent
        paletteInputRef={paletteInputRef}
        isOpen={isOpen}
        query={query}
        results={results}
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
        onFreeMemoryProject={onFreeMemoryProject}
        onLocateProject={onLocateProject}
        onMoveOrRenameProject={onMoveOrRenameProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectNewWindow={onSelectNewWindow}
        onHoverProject={onHoverProject}
        onHoverProjectEnd={onHoverProjectEnd}
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
      >
        {children}
      </DropdownContent>
    ) : (
      <ModalContent
        paletteInputRef={paletteInputRef}
        isOpen={isOpen}
        query={query}
        results={results}
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
        onFreeMemoryProject={onFreeMemoryProject}
        onLocateProject={onLocateProject}
        onMoveOrRenameProject={onMoveOrRenameProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectNewWindow={onSelectNewWindow}
        onHoverProject={onHoverProject}
        onHoverProjectEnd={onHoverProjectEnd}
        onOpenProjectSettings={onOpenProjectSettings}
        rankedSearch={rankedSearch}
        scratchResults={scratchResults}
        onCreateScratch={onCreateScratch}
        onSelectScratch={onSelectScratch}
        onRequestDeleteScratch={onRequestDeleteScratch}
        onRequestDeleteAllScratches={onRequestDeleteAllScratches}
        onRenameScratch={onRenameScratch}
        onSaveAsProject={onSaveAsProject}
      />
    );

  return (
    <>
      {content}
      {removeConfirmProject && onRemoveConfirmClose && onConfirmRemove && (
        <ConfirmDialog
          isOpen={true}
          onClose={isRemovingProject ? undefined : onRemoveConfirmClose}
          title={removeConfirmProject.isActive ? "Close project?" : "Remove project from list?"}
          zIndex="nested"
          confirmLabel={removeConfirmProject.isActive ? "Close project" : "Remove project"}
          cancelLabel="Cancel"
          onConfirm={onConfirmRemove}
          isConfirmLoading={isRemovingProject}
          variant="destructive"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{removeConfirmProject.name}</div>
              <div className="text-xs text-daintree-text/50 font-mono mt-1">
                {removeConfirmProject.path}
              </div>
            </div>
            {removeConfirmProject.isActive
              ? hasRunningProcesses && (
                  <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                    <div className="font-medium">
                      Warning: All running processes will be terminated
                    </div>
                    <div className="mt-1 text-status-warning/80">
                      {removeConfirmProject.processCount > 0 && (
                        <div>• {removeConfirmProject.processCount} running process(es)</div>
                      )}
                      {removeConfirmProject.activeAgentCount > 0 && (
                        <div>• {removeConfirmProject.activeAgentCount} active agent(s)</div>
                      )}
                      {removeConfirmProject.waitingAgentCount > 0 && (
                        <div>• {removeConfirmProject.waitingAgentCount} waiting agent(s)</div>
                      )}
                    </div>
                  </div>
                )
              : hasRunningProcesses && (
                  <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                    <div className="font-medium">Warning: Active sessions detected</div>
                    <div className="mt-1 text-status-warning/80">
                      {removeConfirmProject.processCount > 0 && (
                        <div>• {removeConfirmProject.processCount} running process(es)</div>
                      )}
                      {removeConfirmProject.activeAgentCount > 0 && (
                        <div>• {removeConfirmProject.activeAgentCount} active agent(s)</div>
                      )}
                      {removeConfirmProject.waitingAgentCount > 0 && (
                        <div>• {removeConfirmProject.waitingAgentCount} waiting agent(s)</div>
                      )}
                    </div>
                  </div>
                )}
            <div className="text-xs text-daintree-text/60">
              {removeConfirmProject.isActive
                ? "The project will remain in your list and can be reopened at any time."
                : "This project will be removed from your list. You can add it back later, but any running terminals or processes will need to be restarted."}
            </div>
          </div>
        </ConfirmDialog>
      )}
      {freeMemoryConfirmProject && onFreeMemoryConfirmClose && onConfirmFreeMemory && (
        <ConfirmDialog
          isOpen={true}
          onClose={isFreeingMemory ? undefined : onFreeMemoryConfirmClose}
          title={`Free memory for '${freeMemoryConfirmProject.name}'?`}
          zIndex="nested"
          confirmLabel="Free memory"
          cancelLabel="Cancel"
          onConfirm={onConfirmFreeMemory}
          isConfirmLoading={isFreeingMemory}
          variant="default"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{freeMemoryConfirmProject.name}</div>
              <div className="text-xs text-daintree-text/50 font-mono mt-1">
                {freeMemoryConfirmProject.path}
              </div>
            </div>
            {(freeMemoryConfirmProject.processCount > 0 ||
              freeMemoryConfirmProject.activeAgentCount > 0 ||
              freeMemoryConfirmProject.waitingAgentCount > 0) && (
              <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                <div className="font-medium">Running processes will be stopped</div>
                <div className="mt-1 text-status-warning/80">
                  {freeMemoryConfirmProject.processCount > 0 && (
                    <div>• {freeMemoryConfirmProject.processCount} running process(es)</div>
                  )}
                  {freeMemoryConfirmProject.activeAgentCount > 0 && (
                    <div>• {freeMemoryConfirmProject.activeAgentCount} active agent(s)</div>
                  )}
                  {freeMemoryConfirmProject.waitingAgentCount > 0 && (
                    <div>• {freeMemoryConfirmProject.waitingAgentCount} waiting agent(s)</div>
                  )}
                </div>
              </div>
            )}
            <div className="text-xs text-daintree-text/60">
              Sessions are preserved and restored when you reopen the project.
            </div>
          </div>
        </ConfirmDialog>
      )}
      {deleteScratchConfirm && onDismissDeleteScratchConfirm && onConfirmDeleteScratch && (
        <DeleteScratchConfirmDialog
          target={deleteScratchConfirm}
          restoreFocusTo={paletteInputRef}
          onDismiss={onDismissDeleteScratchConfirm}
          onConfirm={onConfirmDeleteScratch}
          isDeleting={isDeletingScratch}
        />
      )}
      {deleteAllScratchesConfirm &&
        onDismissDeleteAllScratchesConfirm &&
        onConfirmDeleteAllScratches && (
          <ConfirmDialog
            isOpen={true}
            onClose={isDeletingAllScratches ? undefined : onDismissDeleteAllScratchesConfirm}
            // Counted off the frozen snapshot, never the live list: the rows
            // disappear as the run lands, and the dialog must keep naming the
            // number the user actually agreed to.
            title={
              deleteAllScratchesConfirm.length === 1
                ? "Delete 1 scratch workspace?"
                : `Delete ${deleteAllScratchesConfirm.length} scratch workspaces?`
            }
            zIndex="nested"
            confirmLabel="Delete scratch workspaces"
            cancelLabel="Cancel"
            onConfirm={onConfirmDeleteAllScratches}
            isConfirmLoading={isDeletingAllScratches}
            variant="destructive"
          >
            <div className="text-sm text-daintree-text/70">
              {deleteAllScratchesConfirm.length === 1
                ? "Its terminals will be closed and its folder deleted from disk."
                : "Their terminals will be closed and their folders deleted from disk."}
            </div>
          </ConfirmDialog>
        )}
      {saveAsProjectConfirm && onDismissSaveAsProjectConfirm && onConfirmDeleteOriginalScratch && (
        <ConfirmDialog
          isOpen={true}
          onClose={isDeletingOriginalScratch ? undefined : onDismissSaveAsProjectConfirm}
          title={`Delete '${saveAsProjectConfirm.scratch.name}'?`}
          zIndex="nested"
          confirmLabel="Delete scratch"
          cancelLabel="Keep scratch"
          onConfirm={onConfirmDeleteOriginalScratch}
          isConfirmLoading={isDeletingOriginalScratch}
          variant="destructive"
        >
          <div className="space-y-3">
            <div className="text-sm">
              Saved as <span className="font-medium">{saveAsProjectConfirm.project.name}</span>. The
              original scratch folder is no longer needed.
            </div>
            <div className="text-xs text-daintree-text/50 font-mono break-all">
              {saveAsProjectConfirm.scratch.path}
            </div>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
