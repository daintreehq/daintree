import { Fragment, useMemo, useEffect, useRef, useState, useCallback } from "react";
import type { JSX } from "react";
import {
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
import type { LucideIcon } from "lucide-react";
import { Moon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import {
  PALETTE_ROW_CLASS,
  PALETTE_ROW_FOCUS_CLASS,
  PALETTE_SECTION_LABEL_CLASS,
} from "@/components/ui/paletteRowStyles";
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
  formatFleetLiveness,
  getProjectRowStatus,
  getScratchRowStatus,
  ROW_DOT_CLASS,
  ROW_MARK_COLOR,
  runningShare,
  type ProjectRowTone,
  ROW_TONE_CLASS,
  type ProjectRowStatus,
} from "@/lib/projectRowStatus";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useModifierKeys } from "@/hooks/useModifierKeys";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
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
  ProjectSwitcherBrowseBand,
  ProjectSwitcherMode,
  ProjectSwitcherProjectRow,
  ProjectSwitcherRow,
  ProjectSwitcherScratchRow,
  SearchableProject,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import {
  PROJECT_SECTION_LABELS,
  PROJECT_SWITCHER_SCRATCH_BAND_KEY,
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
  onSelect: (row: ProjectSwitcherRow) => void;
  onClose: () => void;
  mode?: ProjectSwitcherMode;
  onAddProject?: () => void;
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onSleepProject?: (projectId: string) => void;
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
  children?: React.ReactNode;
  removeConfirmProject?: SearchableProject | null;
  onRemoveConfirmClose?: () => void;
  onConfirmRemove?: () => void;
  isRemovingProject?: boolean;
  /** Frozen snapshot of the project pending a Sleep confirm, or null. */
  sleepConfirmProject?: SearchableProject | null;
  onSleepConfirmClose?: () => void;
  onConfirmSleep?: () => void;
  isSleepingProject?: boolean;
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
  /** Opens the "delete every scratch" confirmation, from either the visible button or the section header's context menu. */
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
  /**
   * The clock this row renders against, passed rather than read (#11791).
   *
   * React Compiler auto-memoizes these rows, so a re-render of the palette root
   * does not re-run this component's body while its props are referentially
   * unchanged — an ambient `Date.now()` inside it would simply freeze. Ages and
   * the recency deadline both derive from this prop instead, so the tick that
   * changes it is what invalidates the row. `ScratchListItem` threads its clock
   * the same way, and `rowStatusClock.contract.test.ts` holds both ranked rows
   * to it — source-level, because vitest cannot see the freeze.
   */
  nowMs: number;
  onSelect: (row: ProjectSwitcherProjectRow) => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onSleepProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
}

/**
 * The row's leading mark: one 8px shape that weighs the row's running agents
 * against the ones asking for something (#11832).
 *
 * Two colours in one mark, as a pie: green for the runs still
 * going, the demand hue for the agents stopped on the user. A project that is
 * half waiting and half working is the state the switcher exists to surface,
 * and a single-hue dot could only ever report one half of it — which is the
 * original bug, one carrier for two facts.
 *
 * A pie rather than the open arc #11836 tried. That arc failed for a reason
 * worth recording: it is the app's `working` glyph everywhere else
 * (`terminalStateConfig`), it was the one place that glyph did not spin, and
 * hollowing the mark out spread the demand hue over a sub-pixel stroke that
 * reads grey. This keeps the solid disc — the hue has its full area back — and
 * puts the second fact in the one channel a disc has left.
 *
 * A true pie: the wedge is the counts' own proportion (see `runningShare`),
 * floored only so a single agent among fifty keeps a wedge rather than a
 * splinter. Nobody measures an 8px angle, but the mark does not need measuring
 * to be right — it needs to lean the way the row does, and a snapped angle
 * leaned a different way from the figures printed beside it.
 *
 * A row with nothing to report draws no mark, only the slot that reserves its
 * width (#11692). The slot is what keeps the tiles and names in one column: an
 * omitted mark would pull every quiet row left of the busy ones, and a list that
 * is mostly quiet would read as the ragged edge rather than the tidy one.
 */
function StatusDot({
  status,
  showResumeDot = false,
}: {
  status: ProjectRowStatus;
  showResumeDot?: boolean;
}) {
  // One slot, one decision. Written as a single choice rather than separate
  // conditions so the slot cannot hold two marks at once: the resume mark only
  // reaches here on a status that already agreed to yield, and an auto-parked
  // row is the case where both would otherwise have drawn (#11822).
  const dot = showResumeDot ? (
    <div
      className="workspace-mark w-2 h-2 rounded-full bg-text-secondary"
      data-testid="workspace-resume-dot"
      aria-hidden="true"
    />
  ) : status.markTone === null ? null : (
    <AgentMixDot tone={status.markTone} mix={status.agentMix} />
  );

  return (
    <div
      className="flex w-2 h-2 shrink-0 items-center justify-center"
      data-testid="workspace-status-slot"
    >
      {dot}
    </div>
  );
}

/**
 * The wedge covering `share` of the mark, swept clockwise from 12 o'clock.
 *
 * Drawn over a full-bleed circle rather than as a second slice meeting the
 * first: two adjacent paths each antialias against whatever is behind them, so
 * their shared boundary picks up the row underneath and reads as a dark line
 * ruled through the mark. Laid over an opaque disc the wedge's edge feathers
 * between the two hues instead, which is the boundary a pie chart actually has.
 *
 * An earlier version cut a transparent notch at each boundary to keep the split
 * legible when the two hues sit close together. At 8px that notch was the most
 * visible thing about the mark — it read as a seam rather than a division, and
 * it left a half-and-half mark looking like two leaves rather than one disc.
 */
function wedgePath(share: number): string {
  const angle = share * 2 * Math.PI;
  const x = (8 + 8 * Math.sin(angle)).toFixed(3);
  const y = (8 - 8 * Math.cos(angle)).toFixed(3);
  const largeArc = share > 0.5 ? 1 : 0;
  return `M 8 8 L 8 0 A 8 8 0 ${largeArc} 1 ${x} ${y} Z`;
}

/**
 * The mark itself: a solid disc when the row leans entirely one way, a two-tone
 * pie when it has both kinds of agent at once.
 *
 * Solid is the common case and stays a plain background class, so a row with
 * only waits or only runs draws exactly what it drew before this existed and
 * the ring tones keep their borders. The pie is reached only by a row that
 * genuinely has something to divide.
 *
 * The cost of dropping the notch is that two hues sitting close together — as
 * `review` and `working` do in palettes where both are greens — make a split
 * mark read as one disc. That is a legible mark stating one of its two facts;
 * the notch was an illegible mark stating both, and the row's line carries the
 * counts in words either way.
 *
 * `aria-hidden`, like every mark in this list: the row's own line states both
 * counts in words, and a mark that also announced itself would have a reader
 * hear the same fact twice.
 */
function AgentMixDot({ tone, mix }: { tone: ProjectRowTone; mix: ProjectRowStatus["agentMix"] }) {
  const share = mix ? runningShare(mix) : 0;

  if (share === 0 || share === 1) {
    return (
      <div
        className={cn("workspace-mark w-2 h-2 rounded-full", ROW_DOT_CLASS[tone])}
        data-testid="workspace-status-dot"
        aria-hidden="true"
      />
    );
  }

  // SVG rather than a `conic-gradient` on a rounded div. The gradient version
  // needed the div's `border-radius` to clip it into a circle, and at 8px that
  // clip's own antialiasing read as a thin dark rim around the whole mark. Two
  // filled shapes in one viewBox have no clip and no stroke, so nothing carves
  // the silhouette out of a square.
  //
  // The wedge does repaint the disc's rim along its own arc, and a repainted
  // antialiased edge composites heavier than a single pass. Measured on this
  // geometry it comes to about 1% more edge ink on the running side — two
  // orders below the artefacts this mark has actually been rejected for, and
  // cheaper than the alternatives, which each trade it for something worse:
  // adjacent slices let the row bleed through their shared edge, and a clip or
  // mask puts the silhouette back behind an antialiased cut-out.
  return (
    <svg
      viewBox="0 0 16 16"
      className="workspace-mark w-2 h-2"
      data-testid="workspace-status-dot"
      data-running-share={share}
      aria-hidden="true"
    >
      {/* The demand hue fills the disc; the running share is laid over it from
          12 o'clock, so the two meet on the wedge's own edge. */}
      <circle cx="8" cy="8" r="8" fill={ROW_MARK_COLOR[tone]} />
      <path d={wedgePath(share)} fill={ROW_MARK_COLOR.working} />
    </svg>
  );
}

/**
 * A row's second line: what is still running, then what it wants, then which
 * project it is.
 *
 * Running leads. It is the figure this surface gets opened for — "are my agents
 * still going, and how many" — and it used to be the one fact the row could not
 * state at all, because the sentence after it is chosen by a cascade that only
 * ever prints its loudest tier. Trailing it instead put it at a different
 * x-position on every row, behind a sentence whose length changes with the
 * state, which is the opposite of scannable.
 *
 * Two coloured tokens now, and deliberately: a run is green everywhere else in
 * this app, and greying it here to hold the row to one hue made the number read
 * as an afterthought rather than as the answer. The two never compete for a
 * meaning — green is always the work still moving, the demand tone is always
 * the work stopped on the user.
 *
 * Shared by all three row renderers so a fragment cannot appear on one kind of
 * workspace and not another — the two scratch paths drew a single toned element
 * before this, which left them structurally unable to carry a second one.
 */
function RowStatusLine({ status }: { status: ProjectRowStatus }) {
  // The dormant fallback is the row saying it has nothing to report, and
  // #11692 takes it at its word. Everything else earned its line.
  const sentence = status.isDormantFallback ? null : status.text;

  // The hue follows what this slot is actually reporting, because two different
  // facts arrive in it. A count of runs the user launched is green, the way a
  // run is green everywhere else in this app. "Assistant working" is
  // machine-initiated presence, and reads at settled weight (#11806) — green
  // there would both claim a run nobody started and paint the same fact a
  // different colour from the assistant-only row, where it lands in the demand
  // sentence instead. `withLiveness` only ever reaches the assistant phrase
  // with no agents running, so the count is the fact itself, not a proxy.
  const livenessTone =
    (status.agentMix?.running ?? 0) > 0 ? ROW_TONE_CLASS.working : ROW_TONE_CLASS.assistant;

  const parts = [
    status.livenessDetail !== undefined && (
      <span
        key="running"
        className={cn("shrink-0", livenessTone)}
        data-testid="workspace-running-count"
      >
        {status.livenessDetail}
      </span>
    ),
    sentence !== null && (
      <span key="demand" className={cn("shrink-0", ROW_TONE_CLASS[status.tone])}>
        {sentence}
      </span>
    ),
    status.ageDetail !== undefined && (
      // Muted, and never in the demand tone. The age is the one fragment here
      // that asks for nothing, and colouring it made the coloured run long
      // enough to outweigh the count leading the line.
      <span key="age" className="truncate text-daintree-text/50">
        {status.ageDetail}
      </span>
    ),
    status.pathHint !== undefined && (
      // `shrink` where the count takes `shrink-0`: the hint answers which
      // project this is, which the name above already mostly does, while the
      // count is the row's headline figure.
      <span key="path" className="truncate shrink text-daintree-text/50">
        {status.pathHint}
      </span>
    ),
  ].filter((part): part is JSX.Element => part !== false);

  if (parts.length === 0) return null;

  return (
    <div className="flex items-center gap-1 min-w-0 mt-0.5 text-[11px] leading-none">
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {/*
           * The separator is its own element rather than a prefix on the token
           * after it. Folded into a token it would inherit that token's hue,
           * and it would land inside the text a reader — or a test — matches
           * the token by.
           *
           * The visible dot is hidden from assistive tech and a comma stands in
           * for it, because the tokens are adjacent inline elements with no
           * whitespace between them: without this the row's accessible name
           * runs together as "2 agents running1 needs inputwaiting 10m".
           */}
          {index > 0 && (
            <>
              <span className="sr-only">, </span>
              <span className="shrink-0 text-daintree-text/40" aria-hidden="true">
                ·
              </span>
            </>
          )}
          {part}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Whether the row should mark that opening this workspace brings agents back
 * (#11801, extended to scratches in #11821).
 *
 * Gated on the status classifier's own answer because a live status always
 * outranks the promise: the coloured dot says what the workspace is doing now,
 * the grey one only says what it would come back with. So the mark lands on the
 * rows that have stopped — the dormant ones #11692 cleared, and the auto-parked
 * ones whose settled ring has less to say than the promise (#11822) — and never
 * displaces a mark that means more. Keyed off the count rather than which band
 * the row sorts into, so a pinned project keeps it too.
 *
 * An absent count means main has not resolved this workspace yet, which is not
 * the same as resolving it to zero — an unresolved row makes no claim rather
 * than a wrong one. Zero is an answer and also draws nothing: there is nothing
 * to come back to.
 *
 * The current workspace is excluded outright. Its count is real, but you are
 * already standing in it — those agents are on screen, not waiting to return.
 * Without this the row would read ", current, 3 agents will resume".
 *
 * Takes the two fields it reads rather than either view-model: projects and
 * scratches deliberately do not share a shape, and a union parameter would make
 * every project-only field type-reachable from the two scratch render paths.
 */
function showResumableAgentMark(
  status: ProjectRowStatus,
  workspace: { isActive: boolean; resumableAgentCount?: number }
): boolean {
  if (workspace.isActive) return false;
  if (status.allowsResumeMark !== true) return false;
  return workspace.resumableAgentCount !== undefined && workspace.resumableAgentCount > 0;
}

/**
 * The grey dot's meaning, said rather than shown (#11801). The dot itself is
 * `aria-hidden`, so without this the row would carry the fact in colour alone.
 * Part of the accessible name, not a live region, so a list render doesn't
 * announce every markable row.
 *
 * The count rather than the bare fact: the number is already here, and
 * "3 agents will resume" answers the question the dot only raises.
 *
 * Shared by all three row renderers — the two scratch paths draw the same
 * sentence the project rows do, so the phrasing cannot drift between them.
 */
function ResumableAgentsLabel({ count }: { count: number }) {
  return (
    <span className="sr-only">
      , {count} {count === 1 ? "agent" : "agents"} will resume
    </span>
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

/**
 * Whether a project row offers "Sleep" — shutting that one project down the way
 * quitting shuts them all down, then reopening it restored.
 *
 * Unlike the "Free memory" action it replaces, this DOES offer itself for the
 * project on screen: that window drops to the picker and the layout survives.
 * A missing project has nothing loaded to shut down, and an already-sleeping
 * one would no-op, so neither is offered it.
 *
 * Exported for its own test — the row's context menu is stubbed out in the
 * palette render suite, so the rule is only reachable in isolation.
 */
export function canSleepProject(project: { isMissing: boolean; status?: string }): boolean {
  return !project.isMissing && project.status !== "closed";
}

function ProjectListItem({
  project,
  isSelected,
  nowMs,
  onSelect,
  onStopProject,
  onCloseProject,
  onSleepProject,
  onLocateProject,
  onMoveOrRenameProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
}: ProjectListItemProps) {
  const showStop = project.processCount > 0 && !project.isMissing;
  const showSleep = canSleepProject(project);

  const notificationOverrides = useProjectSettingsStore(
    (state) => state.notificationOverridesByProjectId[project.id]
  );
  const isProjectNotificationsMuted = areProjectNotificationsMuted(notificationOverrides);

  const status = getProjectRowStatus(project, nowMs);
  const showResumeDot = showResumableAgentMark(status, project);

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
        "group w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-md)] text-left cursor-pointer",
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
      <StatusDot status={status} showResumeDot={showResumeDot} />

      <div
        className={cn(
          // Wash/shadow var fallbacks keep themes without the overrides byte-identical.
          "flex items-center justify-center rounded-[var(--radius-lg)] shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))] shrink-0",
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
              project.isMissing
                ? "text-daintree-text/50"
                : project.isActive || isSelected
                  ? "text-daintree-text"
                  : "text-daintree-text/85"
            )}
          >
            {project.name}
          </span>
          {/*
           * Said in the name, not just in `aria-current`. In browse the band
           * header carries it, but search drops the bands entirely — and even
           * in browse a reader arrowing straight onto the option may never hear
           * the group boundary, while `aria-current` itself goes unannounced
           * inside a listbox often enough that it can't be the only carrier.
           *
           * Directly after the name, before the bell: the name is what it
           * qualifies, and read after the muted-notifications label it would
           * attach itself to the wrong noun.
           */}
          {project.isActive && <span className="sr-only">, current</span>}
          {/* Same shape as `, current` above — see `ResumableAgentsLabel`. */}
          {showResumeDot && <ResumableAgentsLabel count={project.resumableAgentCount ?? 0} />}
          {isProjectNotificationsMuted && (
            <>
              {/*
               * The icon's label is concatenated straight onto whatever
               * precedes it, so without this the name runs together as
               * "Payments, currentNotifications muted…".
               */}
              <span className="sr-only">, </span>
              <BellOff
                className="w-3.5 h-3.5 text-daintree-text/40 shrink-0 ml-1"
                aria-label="Notifications muted for this project"
              />
            </>
          )}
        </div>

        {/*
         * The second line is earned, not standing. It says what the row is
         * doing, and "Opened 13h ago" is not that — repeated down twenty rows
         * it was most of the palette's height and none of its meaning (#11692).
         * A path hint is the exception: it disambiguates two projects with the
         * same folder name, so it belongs to identity rather than status and
         * survives on its own.
         */}
        <RowStatusLine status={status} />
      </div>
    </div>
  );

  const hasContextActions =
    onTogglePinProject ||
    onStopProject ||
    onCloseProject ||
    onSleepProject ||
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
          (onStopProject || onSleepProject || onCloseProject) && <ContextMenuSeparator />}
        {showStop && onStopProject && (
          <ContextMenuItem destructive onSelect={() => onStopProject(project.id)}>
            <Square className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Stop all agents
          </ContextMenuItem>
        )}
        {showSleep && onSleepProject && (
          <ContextMenuItem onSelect={() => onSleepProject(project.id)}>
            <Moon className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Sleep project
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
 * "Scratch" trails the name as plain muted text rather than a chip: origin has
 * to be unambiguous, but a pill here would be a second emphasis signal
 * competing with the selected row's own treatment.
 *
 * Action-free on purpose. Rename, save-as-project and delete are browse-mode
 * management — an inline rename editor would have to live inside the array the
 * arrow keys walk, and search is for reaching a scratch, not administering one.
 */
function ScratchListItem({
  scratch,
  isSelected,
  nowMs,
  onSelect,
}: {
  scratch: ProjectSwitcherScratchRow;
  isSelected: boolean;
  /** The clock this row renders against, passed rather than read — see `ProjectListItemProps`. */
  nowMs: number;
  onSelect: (row: ProjectSwitcherScratchRow) => void;
}) {
  const status = getScratchRowStatus(scratch, nowMs);
  const showResumeDot = showResumableAgentMark(status, scratch);

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
        "group w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-md)] text-left cursor-pointer",
        scratch.isActive
          ? "text-daintree-text hover:bg-overlay-subtle"
          : "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text"
      )}
      onClick={() => onSelect(scratch)}
    >
      <StatusDot status={status} showResumeDot={showResumeDot} />

      <CommandTile icon={FileText} tone="manage" />
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
          <span
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              scratch.isActive || isSelected ? "text-daintree-text" : "text-daintree-text/85"
            )}
          >
            {scratch.name}
          </span>
          <span className="text-[11px] leading-none text-daintree-text/50 shrink-0">· Scratch</span>
          {scratch.isActive && <span className="sr-only">, current</span>}
          {showResumeDot && <ResumableAgentsLabel count={scratch.resumableAgentCount ?? 0} />}
        </div>
        <RowStatusLine status={status} />
      </div>
    </div>
  );
}

interface ProjectSection {
  key: ProjectSectionKey;
  label: string;
  /** The band's VISIBLE rows — empty while collapsed. Always rows of `results`. */
  items: ProjectSwitcherProjectRow[];
  /** Projects the band holds whether or not they are on screen. */
  itemCount: number;
  collapsed: boolean;
  /**
   * Whether this band's header offers the fold control. False for bands read
   * off `results` rather than declared by a host: folding those would have to
   * drop rows the arrow keys can still address, so the affordance would be a
   * lie at best and #11071 at worst.
   */
  collapsible: boolean;
}

/**
 * The fold control every band header carries (#11943).
 *
 * Deliberately neutral: it takes `PALETTE_SECTION_LABEL_CLASS`'s own muted tone
 * from the header around it and never the accent, which this surface spends on
 * the selected row alone — seven chevrons competing with it would leave the
 * highlight as just one more coloured thing.
 *
 * `tabIndex={-1}` because section headers live inside the `role="listbox"`,
 * where a focusable child is invalid and unreachable anyway — arrow keys move
 * `aria-activedescendant` across rows and never land here, matching the Other
 * band's sort trigger. Folding is a pointer convenience on purpose: searching
 * deliberately ignores it, so no band can fold a project out of a keyboard
 * user's reach, and there is nothing here they cannot get to by typing.
 *
 * `tabIndex={-1}` keeps it out of the tab order but does NOT stop a pointer
 * press from focusing it, and the header outlives the fold — so without the
 * mousedown veto below, one click would leave focus on a chevron: typing would
 * stop reaching the search box, arrows would stop stepping rows, and Enter
 * would re-toggle the band instead of committing the highlighted project. The
 * sort trigger beside it solves the same problem by handing focus back after
 * its menu closes; refusing the focus outright is cheaper and never blinks.
 *
 * The label is its own leaf so `aria-labelledby` on the surrounding group names
 * the band and nothing else — the chevron is `aria-hidden`, but the id has to
 * sit on the text either way or a later sibling would join the computed name.
 */
function BandLabel({ label, labelId }: { label: string; labelId: string }) {
  return (
    <span id={labelId} className="truncate tracking-wider uppercase">
      {label}
    </span>
  );
}

function BandCollapseToggle({
  collapsed,
  label,
  labelId,
  controlsId,
  testId,
  onToggle,
}: {
  collapsed: boolean;
  label: string;
  labelId: string;
  controlsId: string;
  testId: string;
  onToggle: () => void;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      tabIndex={-1}
      data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      className="flex items-center gap-1.5 min-w-0 hover:text-daintree-text/60 transition-colors"
    >
      <Chevron className="w-3 h-3 shrink-0" aria-hidden="true" />
      <BandLabel label={label} labelId={labelId} />
    </button>
  );
}

/**
 * How much a folded band is holding. Only while folded: expanded, the rows are
 * the count, and printing it as well would be chrome naming what is already on
 * screen.
 */
function BandCollapsedCount({ count }: { count: number }) {
  return <span className="shrink-0 text-[10px] tabular-nums">{count}</span>;
}

/** Stable `aria-controls` target for a band's rows. */
function bandListId(key: ProjectSectionKey): string {
  return `project-section-list-${key}`;
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
 *   would name the band "Other projects Most used". The fold control added in
 *   #11943 is a sibling around that leaf for the same reason.
 * - The trigger is `tabIndex={-1}`. Section headers live inside the
 *   `role="listbox"`, where a focusable child is invalid and unreachable
 *   anyway (arrow keys move `aria-activedescendant` across rows, never here).
 *   Right-click reaches the same options, matching every other secondary
 *   action in this palette.
 *
 * The right-hand slot says one thing at a time: how the band is sorted while it
 * is open, and how much it is holding once it is folded — the sort order of
 * rows nobody can see is not the fact worth the space.
 *
 * No horizontal padding of its own. The `px-2` on the band wrapper is the one
 * inset that positions the row cards below, so a `px-3` here would float the
 * label 12px inside the edge those cards line up on (#11943).
 */
function OtherProjectsHeader({
  headerId,
  label,
  itemCount,
  collapsed,
  collapsible,
  onToggleCollapsed,
  onReturnFocus,
}: {
  headerId: string;
  label: string;
  itemCount: number;
  collapsed: boolean;
  collapsible: boolean;
  onToggleCollapsed: () => void;
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
            "flex items-center justify-between gap-2 px-2 py-1 normal-case tracking-normal"
          )}
        >
          {collapsible ? (
            <BandCollapseToggle
              collapsed={collapsed}
              label={label}
              labelId={headerId}
              controlsId={bandListId("other")}
              testId="band-collapse-toggle-other"
              onToggle={onToggleCollapsed}
            />
          ) : (
            <BandLabel label={label} labelId={headerId} />
          )}
          {collapsed && <BandCollapsedCount count={itemCount} />}
          {!collapsed && itemCount >= OTHER_PROJECTS_SORT_CONTROL_MIN_ROWS && (
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
  /**
   * Every browse band, including ones the user folded away — those contribute
   * no rows to `results`, so their headers have nowhere else to come from.
   * Absent (a surface driving the list by hand) falls back to reading the bands
   * off `results`, which is the same view whenever nothing is collapsed.
   */
  browseBands?: ProjectSwitcherBrowseBand[];
  selectedIndex: number;
  query: string;
  onSelect: (row: ProjectSwitcherRow) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Whether this surface offers "Add project…" — decides what the empty state can name. */
  canAddProject: boolean;
  /**
   * Whether the Scratch band below this list offers a create row. It decides
   * which action an empty list is allowed to name — the modal mounts without
   * the project commands but keeps Scratch, so pointing at the File menu there
   * sent the reader out of the app past a button two rows down.
   */
  canCreateScratch: boolean;
  /**
   * True when browse has scratches but no projects, which makes the Scratch
   * band the palette's first content. The instructional empty state stands down
   * for it — printed above real rows it contradicts them.
   */
  scratchesStandAlone: boolean;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onSleepProject?: (projectId: string) => void;
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
  browseBands,
  selectedIndex,
  query,
  onSelect,
  listRef,
  canAddProject,
  canCreateScratch,
  scratchesStandAlone,
  onStopProject,
  onCloseProject,
  onSleepProject,
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
  // a hundred-project list would all fire for the same reason. It has to be a
  // component that renders the rows, too — the clock is state, so a tick re-runs
  // THIS body and the changed `nowMs` is what invalidates each auto-memoized
  // row. A tick held at the palette root re-renders the root and stops there.
  const nowMs = useGlobalMinuteClock();

  // Bands are contiguous runs of `results`, never a re-filter of it. The hook
  // has already sorted by section, so walking the array once and cutting where
  // `section` changes reproduces the grouping without building a second,
  // narrower list — the thing that stranded the highlight and let Enter commit
  // an off-screen project (#11071). Every row in every band is still a row of
  // `results`, at the same index the arrow keys use.
  const sections = useMemo<ProjectSection[] | null>(() => {
    if (isSearching) return null;

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
        last.itemCount += 1;
      } else {
        bands.push({
          key: row.section,
          label: PROJECT_SECTION_LABELS[row.section],
          items: [row],
          itemCount: 1,
          collapsed: false,
          collapsible: false,
        });
      }
    }

    if (!browseBands || browseBands.length === 0) return bands.length > 0 ? bands : null;

    // A repeated key passes the order walk below — the second copy simply draws
    // no rows — but React keys, the `aria-labelledby` leaf id and the
    // `aria-controls` target are all derived from it, so the duplicate would
    // collide on all three.
    if (new Set(browseBands.map((band) => band.key)).size !== browseBands.length) return null;

    // The declared bands own the ORDER, the HEADERS and the counts; the runs
    // above own the rows, and they keep owning them — metadata never removes a
    // row. A band declared folded is expected to have contributed nothing to
    // `results` in the first place, so its items come out empty on their own.
    const byKey = new Map(bands.map((band) => [band.key, band]));
    const merged: ProjectSection[] = browseBands.map((band) => {
      const rendered = byKey.get(band.key);
      byKey.delete(band.key);
      return {
        key: band.key,
        label: band.label,
        items: rendered?.items ?? [],
        itemCount: band.itemCount,
        collapsed: band.collapsed,
        collapsible: true,
      };
    });

    // The one check that makes the bands a VIEW over `results` rather than a
    // claim about it: walked in order, they must reproduce `results` exactly.
    // Enumerating the ways two props can disagree misses some — a section key
    // appearing in two non-adjacent runs, a declared order that differs from
    // the row order, a stale count — and each of those either hides a row or
    // puts the DOM in an order the arrow keys don't follow, which is #11071
    // again. Any mismatch drops to the flat branch: a list with no headers
    // looks worse and is correct.
    let cursor = 0;
    for (const band of merged) {
      for (const row of band.items) {
        if (results[cursor] !== row) return null;
        cursor += 1;
      }
    }
    if (cursor !== results.length) return null;
    return merged;
  }, [results, isSearching, browseBands]);

  // `results` is already scoped by the hook to exactly the rows this mode
  // renders, so it doubles as the arrow-key domain. Never re-filter it here:
  // a second, narrower array is what stranded the highlight and let Enter
  // commit an off-screen project (#11071).
  const selectedRowId = results[selectedIndex]?.id;

  const setBandCollapsed = usePreferencesStore((state) => state.setProjectSwitcherBandCollapsed);

  const renderItem = (row: ProjectSwitcherRow) => {
    const isSelected = row.id === selectedRowId;
    return (
      <div key={`${row.kind}-${row.id}`} role="presentation">
        {row.kind === "scratch" ? (
          <ScratchListItem
            scratch={row}
            isSelected={isSelected}
            nowMs={nowMs}
            onSelect={onSelect}
          />
        ) : (
          <ProjectListItem
            project={row}
            isSelected={isSelected}
            nowMs={nowMs}
            onSelect={onSelect}
            onStopProject={onStopProject}
            onCloseProject={onCloseProject}
            onSleepProject={onSleepProject}
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
        {sections && sections.length > 0 ? (
          sections.map((section, sectionIdx) => {
            const headerId = `project-section-${section.key}`;
            const listId = bandListId(section.key);
            const toggle = () => setBandCollapsed(section.key, !section.collapsed);

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
                  /*
                   * One value on all four bands. The first/last overrides used
                   * to buy the run of bands some end padding, but the scroller
                   * carries that now — and while they were here a folded last
                   * band sat 8px below its own label and 4px above it, which is
                   * exactly the lopsided gap a collapsed band makes obvious.
                   */
                  className="px-1 py-1"
                >
                  {section.key === "other" ? (
                    <OtherProjectsHeader
                      headerId={headerId}
                      label={section.label}
                      itemCount={section.itemCount}
                      collapsed={section.collapsed}
                      collapsible={section.collapsible}
                      onToggleCollapsed={toggle}
                      onReturnFocus={onReturnFocus}
                    />
                  ) : (
                    <div
                      className={cn(
                        PALETTE_SECTION_LABEL_CLASS,
                        // `px-2` matches the row padding below rather than the
                        // wrapper's old inset: both now start from the bare band
                        // edge, so the label and the rows' status column share
                        // the palette's 12px rail (#11943).
                        "flex items-center justify-between gap-2 px-2 py-1"
                      )}
                    >
                      {section.collapsible ? (
                        <BandCollapseToggle
                          collapsed={section.collapsed}
                          label={section.label}
                          labelId={headerId}
                          controlsId={listId}
                          testId={`band-collapse-toggle-${section.key}`}
                          onToggle={toggle}
                        />
                      ) : (
                        <BandLabel label={section.label} labelId={headerId} />
                      )}
                      {section.collapsed && <BandCollapsedCount count={section.itemCount} />}
                    </div>
                  )}
                  {/*
                    Stays mounted while collapsed, holding no options. The
                    header's `aria-controls` has to resolve to something, and an
                    element that comes and goes would leave it dangling on every
                    fold.
                  */}
                  <div id={listId}>{section.items.map(renderItem)}</div>
                </div>
              </div>
            );
          })
        ) : results.length === 0 ? (
          scratchesStandAlone ? null : (
            <div className="px-1 py-1">
              <div
                className="px-2 py-8 text-center text-daintree-text/50 text-sm"
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
                ) : canCreateScratch ? (
                  // No project commands on this surface, but Scratch is still
                  // here — so the nearest action is the create row, not a menu.
                  "Create a scratch workspace to get started"
                ) : (
                  // Nothing on this surface can open anything, so the only honest
                  // instruction points outside it.
                  "Open a project from the File menu to get started"
                )}
              </div>
            </div>
          )
        ) : (
          <div className="px-1 py-1" role="presentation">
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
  /**
   * Spacing the editor inherits from whatever it stands in for. A rename editor
   * replaces a row in the run and takes nothing; the create editor replaces the
   * separated create action and takes its `mt-1`, so starting to type doesn't
   * shunt the list by 4px.
   */
  className?: string;
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
  className,
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
    <div
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-md)] border border-transparent",
        className
      )}
    >
      <StatusSlotSpacer />
      <CommandTile icon={FileText} tone="manage" />
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
   * section hides rather than unmounting so the inline name editor survives the
   * round trip — the fold itself is persisted now and no longer depends on
   * staying mounted (#11943).
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
 * That default is DERIVED, not stored, so it keeps tracking the scratch count
 * until the user overrules it — which is why the preference stores an explicit
 * `false` rather than dropping the key: an empty section someone deliberately
 * opened has to stay open, and "absent" here still means "collapsed while
 * empty". It also retires the effect that used to force the section open on the
 * first scratch; the derived default does that on its own now (#11943).
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
  const storedCollapsed = usePreferencesStore(
    (state) => state.projectSwitcherCollapsedBands[PROJECT_SWITCHER_SCRATCH_BAND_KEY]
  );
  const setBandCollapsed = usePreferencesStore((state) => state.setProjectSwitcherBandCollapsed);
  const collapsed = storedCollapsed ?? scratches.length === 0;
  const [editor, setEditor] = useState<ScratchEditorState>(null);
  // Radix restores focus to the context-menu trigger on close, but for a rename
  // that trigger has been swapped out for the editor — the restore would steal
  // focus from the input and blur-cancel the edit before it began.
  const suppressMenuFocusRestoreRef = useRef(false);
  // `now` is captured per-render so the countdown updates whenever the
  // surrounding component re-renders. Refresh is naturally driven by store
  // updates (loadScratches on palette open, scratch:updated push events) —
  // an interval here would be wasteful given the daily granularity.
  const now = Date.now();

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
    <div className="px-1 py-1" hidden={isSearching}>
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
            onClick={() => setBandCollapsed(PROJECT_SWITCHER_SCRATCH_BAND_KEY, !collapsed)}
            className={cn(
              PALETTE_SECTION_LABEL_CLASS,
              // `px-2` like the project bands' labels: the wrapper no longer
              // carries the inset, so the label draws its own and lands on the
              // same rail as the rows below it (#11943).
              "w-full flex items-center justify-between gap-2 px-2 py-1 hover:text-daintree-text/60 transition-colors",
              PALETTE_ROW_FOCUS_CLASS
            )}
            aria-expanded={!collapsed}
            aria-controls="scratch-section-list"
          >
            <span className="flex items-center gap-1.5">
              {collapsed ? (
                <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
              )}
              Scratch
            </span>
            {scratches.length > 0 && <BandCollapsedCount count={scratches.length} />}
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
        <div id="scratch-section-list">
          {scratches.length === 0 ? (
            <div className="px-2 py-1 text-xs text-daintree-text/40">
              Create a scratch workspace for a quick one-off task
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
                const showResumeDot = showResumableAgentMark(status, scratch);
                const hasContextActions = Boolean(onRequestDelete || onSaveAsProject || onRename);
                return (
                  <ContextMenu key={scratch.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onSelect?.(scratch)}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-md)] text-left transition-colors",
                          scratch.isActive
                            ? "text-daintree-text"
                            : "text-daintree-text/70 hover:text-daintree-text",
                          // Reserved like `PALETTE_ROW_CLASS` does, though this
                          // row never draws one: the ranked scratch rows carry a
                          // border, and without it here the same scratch shifted
                          // 1px sideways between browse and search.
                          "border border-transparent",
                          PALETTE_ROW_FOCUS_CLASS,
                          scratch.isActive
                            ? "bg-overlay-subtle hover:bg-overlay-medium"
                            : "hover:bg-overlay-subtle"
                        )}
                        role="option"
                        // No `aria-current` here, unlike the ranked rows above.
                        // This list has no roving cursor, so `aria-selected` is
                        // not spoken for — it has only ever meant "the scratch
                        // you're in", which is the same fact. Saying it twice
                        // would have a reader announce one state as two.
                        aria-selected={scratch.isActive}
                      >
                        <StatusDot status={status} showResumeDot={showResumeDot} />
                        <CommandTile icon={FileText} tone="manage" />
                        <div className="flex-1 min-w-0">
                          <div
                            className={cn(
                              "truncate text-sm font-semibold leading-tight",
                              scratch.isActive ? "text-daintree-text" : "text-daintree-text/85"
                            )}
                          >
                            {scratch.name}
                            {/*
                             * Inside the name element, not after it: this row
                             * has no `, current` span to follow (the section's
                             * `aria-selected` carries that), so the phrase
                             * attaches to the name the way it does on a
                             * project row.
                             */}
                            {showResumeDot && (
                              <ResumableAgentsLabel count={scratch.resumableAgentCount ?? 0} />
                            )}
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
                          <RowStatusLine status={status} />
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
                className="mt-1"
                onCommit={handleCreateCommit}
                onCancel={closeEditor}
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditor({ kind: "create" })}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1 mt-1 rounded-[var(--radius-md)] text-left transition-colors",
                  "border border-transparent text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text",
                  PALETTE_ROW_FOCUS_CLASS
                )}
                data-testid="scratch-create-button"
              >
                {/* Keeps the tile on the workspace column the scratches above use. */}
                <StatusSlotSpacer />
                <CommandTile icon={Plus} tone="create" />
                <span className="font-medium text-sm leading-tight">New scratch workspace…</span>
              </button>
            ))}
          {/*
           * The same action as the header context menu, which nothing in the
           * palette hinted was there (#11705). Deliberately lighter than the
           * create button above — no icon tile, smaller type — so a standing
           * destructive control doesn't out-weigh the benign one it sits under.
           */}
          {onDeleteAll && scratches.length > 0 && (
            <button
              type="button"
              onClick={onDeleteAll}
              className={cn(
                // A grid, not a flex run: the row is deliberately shorter than
                // the ones above it, so it has no 32px tile to push its label
                // out to their text column. The middle track stands in for the
                // tile and centres the smaller glyph inside it.
                "w-full grid grid-cols-[0.5rem_2rem_minmax(0,1fr)] items-center gap-x-2",
                "px-2 py-1.5 mt-1 rounded-[var(--radius-md)] border border-transparent text-left",
                "text-xs font-medium text-status-error transition-colors hover:bg-status-error/10",
                PALETTE_ROW_FOCUS_CLASS
              )}
              data-testid="scratch-delete-all-button"
            >
              <span aria-hidden="true" />
              <Trash2 className="h-3.5 w-3.5 justify-self-center" aria-hidden="true" />
              <span className="truncate">Delete all scratch workspaces</span>
            </button>
          )}
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
  hasSelection,
  isScratchSelected,
  onOpenPilot,
}: {
  /**
   * False when nothing is highlighted — an empty list, or every band folded
   * (#11943). Enter no-ops there, so naming it would be the footer promising an
   * action the keypress does not perform.
   */
  hasSelection: boolean;
  isScratchSelected: boolean;
  onOpenPilot: () => void;
}) {
  const modifiers = useModifierKeys();
  // Resolved, not hardcoded: the literal would be wrong on Windows/Linux and
  // wrong for anyone who rebound or removed the binding.
  const pilotShortcut = useEffectiveCombo("pilot.toggle");

  const hint = !hasSelection
    ? null
    : modifiers.meta && !isScratchSelected
      ? { keys: "⌘↵", label: "New window" }
      : { keys: "↵", label: "Switch" };

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
        <span className="shrink-0">
          <kbd className={KBD_CLASS}>{hint.keys}</kbd>
          <span className="ml-1.5">{hint.label}</span>
        </span>
      ) : (
        // Holds the rail's left slot so "All agents" stays put rather than
        // sliding across as the last band folds.
        <span className="shrink-0" />
      )}
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
        {hasSelection && !isScratchSelected && (
          <span className="text-daintree-text/50 shrink-0 @max-[520px]/switcher-footer:hidden">
            Right-click for more
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The plain commands under the divider — Project Settings, Add Project, Clone,
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
 * The 32x32 icon tile every non-workspace row wears.
 *
 * Two treatments, and the split is semantic rather than decorative: `manage`
 * acts on something that already exists, `create` brings something new in and
 * wears the dashed outline that has always marked an add affordance here. Both
 * ride the audited overlay ladder rather than a raw tint/muted alpha, so they
 * hold their separation from the row underneath in every theme.
 */
function CommandTile({ icon: Icon, tone }: { icon: LucideIcon; tone: "manage" | "create" }) {
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-daintree-text/50",
        tone === "create"
          ? "border border-dashed border-border-strong bg-overlay-soft"
          : "bg-overlay-medium"
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </div>
  );
}

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

/**
 * The empty stand-in for `StatusDot` on a row that has no status to report.
 *
 * Every row in this palette puts its tile on one column, and on a workspace row
 * that column is reached across an 8px status mark. A create/command row has no
 * mark, so without this its tile climbed 16px left and the palette grew a
 * second icon column for its actions (#11947).
 */
function StatusSlotSpacer() {
  return <div className="w-2 h-2 shrink-0" aria-hidden="true" />;
}

const PROJECT_ACTION_ROW_CLASS = cn(
  "palette-command-row w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
  // Horizontal only. The rows above reserve a full border for their selected
  // state, and matching it here keeps the two families' content boxes on the
  // same pixel — but nothing ever draws a border on a command row, so the
  // vertical halves were 2px of pure height, pushing the block off the 48px
  // its tile and `py-2` add up to.
  "border-x border-transparent",
  "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text",
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
  onSleepProject?: (projectId: string) => void;
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
  fleetLiveness,
}: ProjectPaletteInnerProps) {
  const projectSwitcherShortcut = useEffectiveCombo("project.switcherPalette");
  const fleetSummary = fleetLiveness ? formatFleetLiveness(fleetLiveness) : null;

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
  const hasProjectPresentation =
    (browseBands?.length ?? 0) > 0 || results.some((row) => row.kind === "project");
  const scratchesStandAlone =
    !isRankedSearch && !hasProjectPresentation && (scratchResults?.length ?? 0) > 0;

  useWaitAgeTick(results.length > 0 || (scratchResults?.length ?? 0) > 0);

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
          aria-expanded={true}
          aria-haspopup="listbox"
          aria-label="Search workspaces"
          aria-controls="project-list"
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
        scrollClassName="space-y-0"
        ariaLabel="Workspaces"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
      >
        <ProjectListContent
          results={results}
          browseBands={browseBands}
          selectedIndex={selectedIndex}
          query={query}
          onSelect={onSelect}
          listRef={listRef}
          canAddProject={Boolean(onAddProject)}
          canCreateScratch={Boolean(onCreateScratch)}
          scratchesStandAlone={scratchesStandAlone}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          onSleepProject={onSleepProject}
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
            {/* Nothing above it to separate from once Scratch is the first content. */}
            <AppPaletteDialog.Divider hidden={isRankedSearch || scratchesStandAlone} />
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
          <div>
            {onOpenProjectSettings && (
              <ProjectCommandRow
                icon={Settings2}
                tone="manage"
                label="Project settings…"
                onClick={onOpenProjectSettings}
              />
            )}
            {onAddProject && (
              <ProjectCommandRow
                icon={Plus}
                tone="create"
                label="Add project…"
                onClick={onAddProject}
                testId="project-add-button"
              />
            )}
            {onCloneRepo && (
              <ProjectCommandRow
                icon={Download}
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
          hasSelection={activeResult !== undefined}
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
          fleetLiveness={innerProps.fleetLiveness}
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
  sleepConfirmProject,
  onSleepConfirmClose,
  onConfirmSleep,
  isSleepingProject = false,
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
  fleetLiveness,
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
        fleetLiveness={fleetLiveness}
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
      {sleepConfirmProject && onSleepConfirmClose && onConfirmSleep && (
        <ConfirmDialog
          isOpen={true}
          onClose={isSleepingProject ? undefined : onSleepConfirmClose}
          title={`Sleep '${sleepConfirmProject.name}'?`}
          zIndex="nested"
          confirmLabel="Sleep project"
          cancelLabel="Cancel"
          onConfirm={onConfirmSleep}
          isConfirmLoading={isSleepingProject}
          variant="default"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{sleepConfirmProject.name}</div>
              <div className="text-xs text-daintree-text/50 font-mono mt-1">
                {sleepConfirmProject.path}
              </div>
            </div>
            {(sleepConfirmProject.processCount > 0 ||
              sleepConfirmProject.activeAgentCount > 0 ||
              sleepConfirmProject.waitingAgentCount > 0) && (
              <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                <div className="font-medium">Running processes will be stopped</div>
                <div className="mt-1 text-status-warning/80">
                  {sleepConfirmProject.processCount > 0 && (
                    <div>• {sleepConfirmProject.processCount} running process(es)</div>
                  )}
                  {sleepConfirmProject.activeAgentCount > 0 && (
                    <div>• {sleepConfirmProject.activeAgentCount} active agent(s)</div>
                  )}
                  {sleepConfirmProject.waitingAgentCount > 0 && (
                    <div>• {sleepConfirmProject.waitingAgentCount} waiting agent(s)</div>
                  )}
                </div>
              </div>
            )}
            {sleepConfirmProject.isActive && (
              <div className="text-xs text-daintree-text/60">
                This window returns to the project picker
              </div>
            )}
            <div className="text-xs text-daintree-text/60">
              The layout, terminal scrollback, and agent sessions come back when you reopen the
              project.
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
            // The list below scrolls, so the role has to drop from `alertdialog`
            // to `dialog` — a reader would otherwise flatten every name into a
            // single utterance on open.
            hasPreview={true}
            // Only consulted when the element that opened this has disconnected,
            // which the context menu's item does as soon as the run empties the
            // list (the visible button added in #11705 survives a cancel, and
            // keeps focus itself). Without a named successor that case walks to
            // app chrome behind a still-`aria-modal` palette, so name the search
            // box, which outlives the delete.
            restoreFocusTo={paletteInputRef}
          >
            <div className="space-y-3">
              <div className="text-sm text-daintree-text/70">
                {deleteAllScratchesConfirm.length === 1
                  ? "Its terminals will be closed and its folder deleted from disk."
                  : "Their terminals will be closed and their folders deleted from disk."}
              </div>
              {/*
               * Named, not just counted: the action is one click from "New
               * scratch workspace" now, so the dialog is what stands between a
               * misclick and folders leaving disk. Every target is rendered —
               * only the viewport is capped — because a "+N more" tail would
               * reintroduce the count-only problem for the hidden ones. Keyed by
               * id so two scratches sharing a name stay separate rows.
               */}
              <div className="max-h-40 overflow-y-auto" data-testid="scratch-delete-all-preview">
                <ul
                  className="space-y-0.5 text-xs text-daintree-text/70"
                  aria-label="Scratch workspaces to delete"
                >
                  {/*
                   * Wrapped rather than truncated: this list is what the user
                   * consents against, and two long names sharing a prefix would
                   * clip to the same string. Chromium keeps the overflowing
                   * container keyboard-reachable on its own, and skips it when
                   * the names happen to fit.
                   */}
                  {deleteAllScratchesConfirm.map((target) => (
                    <li key={target.id} className="break-words">
                      {target.name}
                    </li>
                  ))}
                </ul>
              </div>
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
