import { Fragment } from "react";
import type { JSX } from "react";
import {
  AppWindow,
  BellOff,
  CircleStop,
  Copy,
  FileText,
  FolderInput,
  FolderOpen,
  Pin,
  PinOff,
  RotateCw,
  X,
} from "lucide-react";
import { AlarmClockOff, Moon } from "@/components/icons";
import { actionService } from "@/services/ActionService";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { formatChordText } from "@/lib/kbdShortcut";
import { PALETTE_ROW_CLASS, ROW_MENU_TARGET_CLASS } from "@/components/ui/paletteRowStyles";
import {
  HighlightedText,
  substringMatchIndices,
  wordMatchIndices,
} from "@/components/ui/HighlightedText";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  getProjectRowStatus,
  getScratchRowStatus,
  ROW_DOT_CLASS,
  ROW_MARK_COLOR,
  runningShare,
  type ProjectRowTone,
  ROW_TONE_CLASS,
  type ProjectRowStatus,
} from "@/lib/projectRowStatus";
import type {
  ProjectSwitcherProjectRow,
  ProjectSwitcherRow,
  ProjectSwitcherScratchRow,
  ProjectSwitchSelectSource,
  SearchableProject,
} from "@/hooks/useProjectSwitcherPalette";
import { ProjectFilingMenuItems } from "./ProjectGroupMenus";
import {
  useProjectSettingsStore,
  areProjectNotificationsMuted,
} from "@/store/projectSettingsStore";
import { pluralize } from "@/lib/pluralize";
import { OpenOnHostSubmenu } from "@/components/Hosts/OpenOnHostSubmenu";
import { CommandTile, ProjectTile } from "./paletteTiles";
import { PaletteCurrentLabel as CurrentLabel } from "@/components/ui/PaletteCurrentLabel";
import { type OtherHostOption } from "@/components/Hosts/OtherHostsSection";
import { isNewWindowClick } from "@/components/Hosts/hostSwitching";

export interface ProjectListItemProps {
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
  /** False only under the "Current project" band header, which already says it. */
  showCurrentLabel: boolean;
  /** Set when another host lists a project of the same name: which host this one is on. */
  hostName?: string;
  /**
   * Say which group the project is filed under. Only where no band header
   * already says it — the ranked search list, which drops the bands.
   */
  showGroupLabel?: boolean;
  /** Drawn under band headers (browse) rather than in the flat ranked list. */
  inBands?: boolean;
  /** The live query, so the name can show what it matched — the family's match emphasis. */
  highlightQuery?: string;
  onSelect: (row: ProjectSwitcherProjectRow, source?: ProjectSwitchSelectSource) => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onSleepProject?: (projectId: string) => void;
  onRestartProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onMoveOrRenameProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
  /**
   * Moves the palette's one cursor to the row under the pointer, so the row the
   * pointer lights is the row Enter commits. Fired on `pointermove`, never
   * `pointerenter`: rows scrolling under a resting pointer must not steal it.
   */
  onHoverRow?: (rowId: string) => void;
  /**
   * Hands focus back to the search box when the row's menu closes. The row
   * itself is never focusable, so the menu's own restore would land on
   * `document.body` and strand a keyboard user who opened it with Shift+F10.
   */
  onReturnFocus?: () => void;
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
export function StatusDot({
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
 * The cost of dropping the notch is that two hues sitting close together make a
 * split mark read as one disc. Every built-in keeps `review` and `working` apart
 * for that reason (#15866); a custom palette that doesn't gets a legible mark
 * stating one of its two facts, where the notch was an illegible mark stating
 * both, and the row's line carries the counts in words either way.
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
export function RowStatusLine({ status }: { status: ProjectRowStatus }) {
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
      <span key="age" className="truncate text-text-secondary">
        {status.ageDetail}
      </span>
    ),
    status.pathHint !== undefined && (
      // `shrink` where the count takes `shrink-0`: the hint answers which
      // project this is, which the name above already mostly does, while the
      // count is the row's headline figure.
      <span key="path" className="truncate shrink text-text-secondary">
        {status.pathHint}
      </span>
    ),
  ].filter((part): part is JSX.Element => part !== false);

  if (parts.length === 0) return null;

  return (
    // `leading-tight`, not `leading-none`: the age and the count truncate, and
    // `overflow: hidden` on a line box with no leading cuts every descender —
    // "1h ago" rendered as "1h aqo".
    <div className="flex items-center gap-1 min-w-0 mt-px text-2xs leading-tight">
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
           * runs together as "2 agents running1 waitingfor 10m".
           */}
          {index > 0 && (
            <>
              <span className="sr-only">, </span>
              <span className="shrink-0 text-text-muted" aria-hidden="true">
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
export function showResumableAgentMark(
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
export function ResumableAgentsLabel({ count }: { count: number }) {
  return <span className="sr-only">, {pluralize(count, "agent")} will resume</span>;
}

/**
 * Where a row is filed, said after its name wherever no band header says it:
 * its group in search, and "Archived" anywhere outside the Archived band. Muted
 * and plain like the host label beside it — it is provenance, not status.
 */
function ProjectFilingLabel({
  projectName,
  groupName: rawGroupName,
  isArchived,
}: {
  projectName: string;
  groupName?: string;
  isArchived: boolean;
}) {
  // "Daintree · Daintree" says nothing the name didn't: a project filed under a
  // group of its own name is already in the obvious place.
  const groupName =
    rawGroupName && rawGroupName.toLocaleLowerCase() !== projectName.toLocaleLowerCase()
      ? rawGroupName
      : undefined;
  if (!groupName && !isArchived) return null;
  const spoken = [groupName ? `in ${groupName}` : undefined, isArchived ? "archived" : undefined]
    .filter(Boolean)
    .join(", ");
  // Two spans, and only the group name truncates: when space runs out it is
  // "Archived" that must survive, since that is the fact a row outside the
  // Archived band exists to say.
  return (
    <span className="ml-1.5 flex min-w-0 items-baseline text-xs text-text-secondary">
      <span className="sr-only">, {spoken}</span>
      {groupName && (
        <span aria-hidden="true" className="min-w-0 truncate">
          · {groupName}
        </span>
      )}
      {isArchived && (
        <span aria-hidden="true" className={cn("shrink-0", groupName && "ml-1")}>
          {/* A real space for copy and text extraction; the margin draws it. */}
          {groupName && " "}· Archived
        </span>
      )}
    </span>
  );
}

export { CurrentLabel };

/**
 * What a row's name shows it matched: the query as one run, or — for a query of
 * several words, which search matches word by word — each word where it lands.
 */
function queryMatchIndices(name: string, query: string | undefined) {
  if (!query) return undefined;
  const whole = substringMatchIndices(name, query);
  if (whole || !/\s/.test(query.trim())) return whole;
  return wordMatchIndices(name, query);
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

/** Mirrors `sleepProject`: it confirms when work would stop or the project is on screen. */
function sleepConfirms(
  project: Pick<
    SearchableProject,
    "isActive" | "processCount" | "activeAgentCount" | "waitingAgentCount"
  >
): boolean {
  return (
    project.isActive ||
    project.processCount > 0 ||
    project.activeAgentCount > 0 ||
    project.waitingAgentCount > 0
  );
}

/**
 * Whether the row reads as open in another window (#12597): picking it goes to
 * that window, and the row says so before Enter does. Never on the current row,
 * whose place is here, nor on a missing one, whose Enter goes to Locate. One
 * another window only keeps cached opens here, so it isn't marked (#13291).
 */
function isOpenElsewhere(project: SearchableProject): boolean {
  return (
    project.openInOtherWindow !== undefined &&
    project.openInOtherWindow !== "cached" &&
    !project.isActive &&
    !project.isMissing
  );
}

/**
 * Whether asking for a new window takes the project's one live view out of the
 * window keeping it in the background, here or elsewhere, rather than going to
 * where it already is (#13274).
 */
function movesCachedView(
  project: Pick<
    SearchableProject,
    "openInOtherWindow" | "isCachedInThisWindow" | "isOpenInThisWindow"
  >
): boolean {
  if (project.isCachedInThisWindow) return true;
  // One this window is already bringing in front stays here, whatever another
  // window still caches.
  return project.openInOtherWindow === "cached" && !project.isOpenInThisWindow;
}

/**
 * The row's new-window menu item, or null where it has none (#12597).
 *
 * A project has one live view across the app, so asking for a new window for
 * one another window shows or is activating brings that window forward — the
 * item says so. One this window shows or is activating has no second window to
 * go to: the request would just switch here, which the row itself already does.
 * A view kept cached, in this window or another, moves to the new window.
 *
 * Exported for its own test, like `canSleepProject`.
 */
export function getNewWindowMenuLabel(
  project: Pick<
    SearchableProject,
    "isActive" | "isMissing" | "openInOtherWindow" | "isOpenInThisWindow" | "isCachedInThisWindow"
  >
): string | null {
  if (project.isActive || project.isMissing) return null;
  if (movesCachedView(project)) return "Open in new window";
  if (project.isOpenInThisWindow) return null;
  return project.openInOtherWindow !== undefined ? "Go to window" : "Open in new window";
}

/**
 * Whether ⌘↵ on `row` takes the new-window path rather than a plain switch.
 * The keypress and the footer's hint both read it, so the hint can't name an
 * action the keypress doesn't take. A scratch has no second window to open.
 */
export function modEnterOpensWindow(
  row: ProjectSwitcherRow,
  canOpenWindow: boolean
): row is ProjectSwitcherProjectRow {
  return canOpenWindow && row.kind === "project" && !row.isActive && !row.isMissing;
}

/**
 * The footer's Enter hint for the highlighted row (#12597). A row another
 * window shows or is activating goes there on either key, so both say where it
 * goes rather than "Switch" or "New window". A row this window shows or is
 * activating switches here on either key too. A row only kept cached moves to a
 * new window on ⌘↵ (#13274). Null with nothing highlighted: Enter no-ops there.
 *
 * Exported for its own test.
 */
export function getProjectSwitcherEnterHint(
  row: ProjectSwitcherRow | undefined,
  modifierHeld: boolean,
  canOpenWindow: boolean,
  mac: boolean = isMac()
): { keys: string; label: string } | null {
  if (!row) return null;
  // A missing project's Enter opens the relocation dialog, not a switch.
  if (row.kind === "project" && row.isMissing) return { keys: "↵", label: "to locate" };
  // Enter on the workspace you're in is a "never mind": the palette closes and
  // nothing switches, so the hint says that rather than promising a switch.
  if (row.isActive) return { keys: "↵", label: "to close" };
  const opensWindow = modifierHeld && modEnterOpensWindow(row, canOpenWindow);
  // The keydown takes Meta or Control, so the modifier is whichever this
  // platform calls primary — a literal ⌘ tells Windows and Linux to press a key
  // they don't have. The Enter glyph stays the footer family's ↵.
  const modEnter = `${formatChordText("Cmd", mac)}${mac ? "" : "+"}↵`;
  if (opensWindow && row.kind === "project" && movesCachedView(row)) {
    return { keys: modEnter, label: "to open in new window" };
  }
  // A row this window is already bringing in front switches here, whatever
  // another window still caches.
  if (row.kind === "project" && isOpenElsewhere(row) && !row.isOpenInThisWindow) {
    return { keys: opensWindow ? modEnter : "↵", label: "to go to window" };
  }
  if (opensWindow && !row.isOpenInThisWindow) {
    return { keys: modEnter, label: "to open in new window" };
  }
  return { keys: "↵", label: "to switch" };
}

/**
 * The footer's Enter hint for a row of the other-hosts band: Enter opens the
 * project on its host (connecting first when it isn't), ⌘↵ in a new window;
 * a host listing nothing is switched to; Retry asks the host again — and says
 * nothing while that answer is on its way, since Enter then does nothing.
 * Exported for its own test.
 */
export function getOtherHostEnterHint(
  option: OtherHostOption,
  modifierHeld: boolean,
  mac: boolean = isMac()
): { keys: string; label: string; host?: string } | null {
  if (option.kind === "retry") return option.busy ? null : { keys: "↵", label: "to retry" };
  if (modifierHeld) {
    return {
      keys: `${formatChordText("Cmd", mac)}${mac ? "" : "+"}↵`,
      label: "to open in new window",
    };
  }
  if (option.kind === "connect") return { keys: "↵", label: "to connect" };
  if (option.kind === "host") return { keys: "↵", label: "to switch" };
  // The host apart from the words, so the footer can clip a long name the way
  // the band does — keeping the part that tells two machines apart.
  return { keys: "↵", label: "to open on", host: option.hostName };
}

export function ProjectListItem({
  project,
  isSelected,
  nowMs,
  showCurrentLabel,
  hostName,
  showGroupLabel = false,
  inBands = false,
  highlightQuery,
  onSelect,
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
  onReturnFocus,
}: ProjectListItemProps) {
  const showStop = project.processCount > 0 && !project.isMissing;
  const showSleep = canSleepProject(project);

  const notificationOverrides = useProjectSettingsStore(
    (state) => state.notificationOverridesByProjectId[project.id]
  );
  const isProjectNotificationsMuted = areProjectNotificationsMuted(notificationOverrides);

  const status = getProjectRowStatus(project, nowMs);
  const showResumeDot = showResumableAgentMark(status, project);
  const showOpenElsewhere = isOpenElsewhere(project);
  const newWindowLabel = getNewWindowMenuLabel(project);

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
        ROW_MENU_TARGET_CLASS,
        "group w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-sm)] text-left cursor-pointer",
        project.isActive
          ? "text-text-primary"
          : project.isMissing
            ? // A missing project stays dimmed while selected: the row's own
              // brightness is what says the folder is gone, and restoring it
              // under the highlight would erase that.
              "text-text-secondary aria-selected:text-text-secondary"
            : "text-text-secondary"
      )}
      // The current project is selectable too: picking where you already are is
      // a "never mind", and the handler closes the palette rather than sitting
      // there doing nothing. Cmd-click (Ctrl-click off macOS) is ⌘↵ by pointer,
      // through the same gate, so the rows ⌘↵ won't open elsewhere stay a plain
      // pick. Ctrl-click on macOS is the context menu and never arrives here.
      onClick={(e) => {
        if (onSelectNewWindow && isNewWindowClick(e) && modEnterOpensWindow(project, true)) {
          onSelectNewWindow(project);
          return;
        }
        onSelect(project, "pointer");
      }}
      // The pointer moves the palette's one cursor, so the lit row is always the
      // one Enter switches to; the prefetch below is a separate concern.
      onPointerMove={onHoverRow && !isSelected ? () => onHoverRow(project.id) : undefined}
      // A right-click without a pointer move first still makes this the row
      // Enter acts on, or the menu's row and the lit row would be two rows.
      onContextMenu={onHoverRow && !isSelected ? () => onHoverRow(project.id) : undefined}
      onPointerEnter={onHoverProject ? (e) => onHoverProject(project.id, e.pointerType) : undefined}
      onPointerLeave={onHoverProjectEnd ? (e) => onHoverProjectEnd(e.pointerType) : undefined}
    >
      <StatusDot status={status} showResumeDot={showResumeDot} />

      <ProjectTile emoji={project.emoji} color={project.color} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center min-w-0">
          <span
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              project.isMissing ? "text-text-secondary" : "text-text-primary"
            )}
          >
            <HighlightedText
              text={project.name}
              indices={queryMatchIndices(project.name, highlightQuery)}
            />
          </span>
          {hostName && (
            <span className="ml-1.5 shrink-0 text-xs text-text-secondary">
              <span className="sr-only">, on </span>
              <span aria-hidden="true">· </span>
              {hostName}
            </span>
          )}
          <ProjectFilingLabel
            projectName={project.name}
            groupName={showGroupLabel ? project.groupName : undefined}
            // Under the Archived header the band already says it. Anywhere else
            // — the ranked list, which has no headers, or Running, where a live
            // agent lifted it — the row has to.
            isArchived={project.isArchived === true && (!inBands || project.section !== "archived")}
          />
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
          {showOpenElsewhere && (
            <>
              {/*
               * Quiet, like the bell beside it: the glyph VS Code puts on a
               * workspace open in another window. The footer names the action
               * once the row is highlighted, so the row only has to say where
               * the project lives.
               */}
              <span className="sr-only">, </span>
              <AppWindow
                className="w-3.5 h-3.5 text-text-secondary shrink-0 ml-1"
                aria-label="Open in another window"
                data-testid="project-open-elsewhere-marker"
              />
            </>
          )}
          {project.neverAutoSleep && (
            <>
              <span className="sr-only">, </span>
              <AlarmClockOff
                className="w-3.5 h-3.5 text-text-secondary shrink-0 ml-1"
                aria-label="Never sleeps automatically"
                data-testid="project-never-auto-sleep-marker"
              />
            </>
          )}
          {isProjectNotificationsMuted && (
            <>
              {/*
               * The icon's label is concatenated straight onto whatever
               * precedes it, so without this the name runs together as
               * "Payments, currentNotifications muted…".
               */}
              <span className="sr-only">, </span>
              <BellOff
                className="w-3.5 h-3.5 text-text-secondary shrink-0 ml-1"
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
      {/* Not under the "Current project" band header: it already names this
          row, and a label beside it would say it twice. */}
      {project.isActive && showCurrentLabel && <CurrentLabel />}
    </div>
  );

  const hasContextActions =
    onTogglePinProject ||
    onStopProject ||
    onCloseProject ||
    onSleepProject ||
    onRestartProject ||
    onCopyPath ||
    onSelectNewWindow ||
    onMoveOrRenameProject ||
    onLocateProject;
  if (!hasContextActions) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={() => {
          // Only a stranded focus is taken back: an item that opened a dialog
          // (Remove, Sleep, Move) has already handed focus to it.
          if (!onReturnFocus) return;
          requestAnimationFrame(() => {
            const active = document.activeElement;
            if (active === null || active === document.body) onReturnFocus();
          });
        }}
      >
        {onSelectNewWindow && newWindowLabel !== null && (
          <ContextMenuItem onSelect={() => onSelectNewWindow(project)}>
            <AppWindow className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            {newWindowLabel}
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
        {/*
          Filing rides on the pin's prop: a surface that lets the user pin is
          one that lets them organise, and the preview/read-only surfaces that
          omit it omit both.
        */}
        {onTogglePinProject && (
          <ProjectFilingMenuItems
            projectId={project.id}
            groupId={project.groupId}
            isArchived={project.isArchived}
          />
        )}
        {onCopyPath && (
          <ContextMenuItem onSelect={() => onCopyPath(project.path)}>
            <Copy className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
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
          (onStopProject || onSleepProject || onRestartProject || onCloseProject) && (
            <ContextMenuSeparator />
          )}
        {showStop && onStopProject && (
          <ContextMenuItem destructive onSelect={() => onStopProject(project.id)}>
            <CircleStop className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Stop project…
          </ContextMenuItem>
        )}
        {showSleep && onSleepProject && (
          <ContextMenuCheckboxItem
            checked={project.neverAutoSleep ?? false}
            onCheckedChange={(checked) =>
              void actionService.dispatch(
                "project.toggleNeverAutoSleep",
                { projectId: project.id, enabled: checked },
                { source: "user" }
              )
            }
          >
            Never sleep automatically
          </ContextMenuCheckboxItem>
        )}
        {showSleep && onSleepProject && (
          <ContextMenuItem onSelect={() => onSleepProject(project.id)}>
            <Moon className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            {/* The ellipsis only where Sleep confirms first: something would be
                stopped, or it is the project on screen. */}
            {sleepConfirms(project) ? "Sleep project…" : "Sleep project"}
          </ContextMenuItem>
        )}
        {showSleep && onRestartProject && project.isActive && (
          <ContextMenuItem onSelect={() => onRestartProject(project.id)}>
            <RotateCw className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Restart project…
          </ContextMenuItem>
        )}
        {onCloseProject && project.isActive && (
          <ContextMenuItem destructive onSelect={() => onCloseProject(project.id)}>
            <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Close project…
          </ContextMenuItem>
        )}
        {onCloseProject && !project.isActive && (
          <ContextMenuItem destructive onSelect={() => onCloseProject(project.id)}>
            <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Remove project…
          </ContextMenuItem>
        )}
        {project.isMissing && onLocateProject && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onLocateProject(project.id)}>
              <FolderOpen className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Locate moved project…
            </ContextMenuItem>
          </>
        )}
        {!project.isMissing && <OpenOnHostSubmenu projectId={project.id} />}
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
export function ScratchListItem({
  scratch,
  isSelected,
  nowMs,
  showCurrentLabel,
  highlightQuery,
  onSelect,
  onHoverRow,
  menuTarget = false,
  ...triggerProps
}: Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  /** Drawn as a context-menu trigger: marks itself while its menu is open. */
  menuTarget?: boolean;
  scratch: ProjectSwitcherScratchRow;
  isSelected: boolean;
  /** See `ProjectListItemProps`. */
  highlightQuery?: string;
  /** The clock this row renders against, passed rather than read — see `ProjectListItemProps`. */
  nowMs: number;
  /** See `ProjectListItemProps`. */
  showCurrentLabel: boolean;
  onSelect: (row: ProjectSwitcherScratchRow) => void;
  onHoverRow?: (rowId: string) => void;
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
      // A context-menu trigger hands its own handlers and `data-state` in here;
      // they go on first so the row's own handlers below win.
      {...triggerProps}
      className={cn(
        PALETTE_ROW_CLASS,
        menuTarget && ROW_MENU_TARGET_CLASS,
        "group w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-sm)] text-left cursor-pointer",
        scratch.isActive ? "text-text-primary" : "text-text-secondary"
      )}
      onPointerMove={onHoverRow && !isSelected ? () => onHoverRow(scratch.id) : undefined}
      onContextMenu={(event) => {
        if (onHoverRow && !isSelected) onHoverRow(scratch.id);
        triggerProps.onContextMenu?.(event);
      }}
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
          <span className={cn("truncate text-sm font-semibold leading-tight", "text-text-primary")}>
            <HighlightedText
              text={scratch.name}
              indices={queryMatchIndices(scratch.name, highlightQuery)}
            />
          </span>
          <span className="text-2xs leading-tight text-text-secondary shrink-0">· Scratch</span>
          {scratch.isActive && <span className="sr-only">, current</span>}
          {showResumeDot && <ResumableAgentsLabel count={scratch.resumableAgentCount ?? 0} />}
        </div>
        <RowStatusLine status={status} />
      </div>
      {scratch.isActive && showCurrentLabel && <CurrentLabel />}
    </div>
  );
}
