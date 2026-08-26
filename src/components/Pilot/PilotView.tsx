import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, KeyboardEventHandler } from "react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { actionService } from "@/services/ActionService";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { agoPhrase, formatWaitAge } from "@/lib/projectRowStatus";
import { isDemandBand } from "@/lib/fleetAttention";
import {
  buildPilotGroups,
  buildPilotWorktreeGroups,
  countPilotBands,
  filterPilotBands,
  filterPilotGroups,
  hasWorktreeAxis,
  summarizePilotGroups,
  PILOT_BAND_FILTER_LABEL,
  type PilotBandFilter,
  type PilotDisplayGroup,
  type PilotGroupCore,
  type PilotProjectGroup,
  type PilotRow,
  type PilotWorkspaceMeta,
  type PilotWorktreeGroup,
} from "./pilotRows";
import { BAND_GLYPH, BAND_GLYPH_TONE, PilotRunState } from "./PilotRunState";
import { PilotFilterBar } from "./PilotFilterBar";
import { PilotParkEditor, type PilotGateCandidate, type PilotParkTarget } from "./PilotParkEditor";
import { isMac } from "@/lib/platform";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import {
  usePaletteTreeNavigation,
  type NavigablePaletteTreeRow,
  type PaletteTreeGroupInput,
} from "@/hooks/usePaletteTreeNavigation";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { CircleHelp, FileText, FolderGit2 } from "@/components/icons";
// Direction glyphs, not app concepts, so they come straight from Lucide the way
// every other chevron in the app does rather than through the icon aliases.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
// Leaf import, not the `@/hooks` barrel: palette suites routinely mock that
// barrel and throw on an export they don't list.
import { useOverlayClaim } from "@/hooks/useOverlayState";
const LIST_ID = "pilot-agent-list";

/** Ages are minute-grained, so a 30s tick keeps them honest without churn. */
const AGE_TICK_MS = 30_000;
/** The loading rule's ">5s says something" threshold. */
const LOADING_HINT_MS = 5_000;

/**
 * Id of a group's container, on whichever axis the list is cut.
 *
 * Keyed on the GROUP id rather than a workspace id: on the worktree axis a
 * group is a worktree, and the encoded path it carries is what keeps two
 * checkouts from ever sharing a container.
 */
function groupDomId(groupId: string): string {
  return `pilot-option-group-${groupId}`;
}

function runDomId(runId: string): string {
  return `pilot-option-run-${runId}`;
}

/**
 * A snapshot of where things were, by id.
 *
 * Ids rather than rows, so a held order cannot also freeze a glyph or an age:
 * position is the only thing worth holding still under a pointer.
 */
interface PilotOrder {
  groups: string[];
  rows: Map<string, string[]>;
}

function capturePilotOrder(groups: readonly PilotGroupCore[]): PilotOrder {
  return {
    groups: groups.map((group) => group.groupId),
    rows: new Map(groups.map((group) => [group.groupId, group.rows.map((r) => r.run.runId)])),
  };
}

/**
 * The live fleet, re-sorted back into a captured order.
 *
 * Anything the capture never saw compares equal to its fellow newcomers and,
 * `Array.sort` being stable, keeps its live relative rank at the tail — for as
 * long as the hold lasts. Nothing is written back into the snapshot, so
 * releasing puts every newcomer straight at its real position rather than
 * leaving it stranded at the end of the list for the rest of the opening.
 */
function applyPilotOrder<T extends PilotGroupCore>(groups: readonly T[], order: PilotOrder): T[] {
  const groupIndex = new Map(order.groups.map((id, i) => [id, i]));
  const rankOf = (index: Map<string, number>, id: string) =>
    index.get(id) ?? Number.MAX_SAFE_INTEGER;

  const ordered = [...groups].sort(
    (a, b) => rankOf(groupIndex, a.groupId) - rankOf(groupIndex, b.groupId)
  );

  return ordered.map((group) => {
    const rowOrder = order.rows.get(group.groupId);
    if (!rowOrder) return group;
    const rowIndex = new Map(rowOrder.map((id, i) => [id, i]));
    // `Object.assign` rather than a spread, for the reason `narrowGroup` gives:
    // spreading a generic widens it past the return type.
    return Object.assign({}, group, {
      rows: [...group.rows].sort(
        (a, b) => rankOf(rowIndex, a.run.runId) - rankOf(rowIndex, b.run.runId)
      ),
    });
  });
}

/** Layout only; the selected treatment comes from the shared row class. */
const ROW_BASE = cn(
  PALETTE_ROW_CLASS,
  "flex w-full cursor-pointer items-center rounded-[var(--radius-md)] text-left"
);

/**
 * One phrasing of the demand, so the header and the footer can't disagree.
 *
 * The subject rides the sentence — a bare "1 needs you" makes the reader supply
 * the noun, which is the same correction the switcher's status line already
 * carries.
 */
function demandPhrase(count: number): string {
  return count === 1 ? "Agent needs you" : `${count} agents need you`;
}

function agentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}

/** Work handed back, plural-aware. The footer's sentence when nothing is asking. */
function reviewPhrase(count: number): string {
  return count === 1 ? "Ready for review" : `${count} agents ready for review`;
}

/** The resting tone. Selected is the shared row class's to own, off the attribute. */
const ROW_TONE = "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text";

/**
 * 16px, down from the switcher's 32px.
 *
 * At half the size the tile stops being an avatar competing with the rows and
 * becomes a coloured bullet in front of a section label, which is what a
 * project heading actually is here. The colour still identifies the project;
 * it just no longer outweighs the agents it organises.
 */
const TILE_BASE =
  "flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[9px]";

/**
 * The workspace's identity tile, at the switcher's colour and a heading's size.
 *
 * Only a project carries an emoji and a colour. A scratch is an app-managed
 * folder with neither, so the switcher gives it a neutral tile and a glyph —
 * rendering the project tile for one produced an empty coloured square. An
 * unknown workspace is a genuine anomaly (removed while its agents kept
 * running) and is allowed to look like one.
 */
function WorkspaceTile({ group }: { group: PilotProjectGroup }) {
  if (group.kind !== "project") {
    const Glyph = group.kind === "scratch" ? FileText : CircleHelp;
    return (
      <div className={cn(TILE_BASE, "bg-tint/[0.04] text-muted-foreground")}>
        <Glyph className="h-2.5 w-2.5" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div
      className={cn(
        TILE_BASE,
        "shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))]"
      )}
      style={{
        background: group.color
          ? `var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), ${getProjectGradient(group.color)}`
          : "var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), var(--color-daintree-sidebar)",
      }}
    >
      <span className="leading-none select-none filter drop-shadow-sm">{group.emoji}</span>
    </div>
  );
}

/**
 * A project, as a heading — never a row, and never a control.
 *
 * Deliberately outside the selection domain. The arrow keys walk agents,
 * because agents are what this surface is for; stopping on a project on the way
 * past made the common case (compare what is working against what is waiting)
 * cost an extra keystroke per project.
 *
 * It used to carry a disclosure, which is gone (#11669). A durable collapse set
 * meant a project shut last week could hide an agent that blocked today, on the
 * one surface that exists to show every agent — and a `<button>` inside a
 * `role="group"` inside a `role="listbox"` was never structurally right either.
 * The header's whole job now is to file the rows underneath it.
 */
/**
 * The group's demand, at a glance: glyph and hue come from the worst row
 * beneath (which is always a demand band whenever the count is non-zero, since
 * demands outrank everything else), so five headers answer "which one is on
 * fire" without reading a single row. Hidden with the rest of the header — the
 * group's aria-label carries the same fact in words.
 *
 * Shared by both axes so a worktree's chip cannot come to mean something
 * different from a project's.
 */
function GroupDemandChip({ group }: { group: PilotGroupCore }) {
  if (group.demandCount === 0) return null;
  const chipBand = isDemandBand(group.topBand) ? group.topBand : "needs-you";
  const ChipGlyph = BAND_GLYPH[chipBand];
  return (
    <span
      aria-hidden="true"
      data-testid="pilot-group-demand"
      className={cn(
        "flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums",
        BAND_GLYPH_TONE[chipBand]
      )}
    >
      <ChipGlyph className="h-2.5 w-2.5" />
      {group.demandCount}
    </span>
  );
}

function GroupHeader({
  group,
  onDrill,
  className,
}: {
  group: PilotProjectGroup;
  /**
   * Present only where regrouping this project by worktree would say something
   * new, so the affordance never promises a list identical to the one already
   * on screen.
   *
   * A click handler on the heading itself, not a button inside it. The rows
   * live in a `role="listbox"` whose children are options, and a focusable
   * control in there is both invalid and unreachable by the keyboard this
   * surface is driven with — the ruling that removed the old disclosure
   * (#11669). The keyboard form of this gesture is the chord the footer
   * advertises instead, which lands on the selected RUN, where the arrow keys
   * already are.
   */
  onDrill?: () => void;
  className?: string;
}) {
  return (
    <div
      data-testid="pilot-group-header"
      {...(onDrill !== undefined
        ? {
            "data-drillable": "true",
            onClick: onDrill,
            title: `Show ${group.name} by worktree`,
          }
        : {})}
      className={cn(
        "flex w-full items-center gap-2 py-1 pr-3 pl-3 select-none",
        onDrill !== undefined &&
          "cursor-pointer rounded-[var(--radius-md)] transition-colors hover:bg-overlay-subtle",
        className
      )}
    >
      <WorkspaceTile group={group} />

      {/*
        The shared section-label treatment every other palette gives this
        element — 10px, tracked, uppercase, muted. A project is structure, and
        structure has to weigh less than the content it organises; the 14px
        semibold name plus a second coloured line outweighed the very rows it
        was meant to be filing.

        The enclosing `role="group"` already carries the name as the label for
        every option inside it, so this is hidden rather than announced a second
        time on the way past.
      */}
      <div aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={cn(PALETTE_SECTION_LABEL_CLASS, "truncate")}>{group.name}</span>
        {/*
          Which workspace you are already in decides whether opening a run is
          instant or swaps the whole view, so it is worth a word. Muted and
          textual — membership is never an accent signal.
        */}
        {group.isCurrent && (
          <span className="shrink-0 text-[10px] leading-none text-daintree-text/30">Current</span>
        )}
      </div>

      <GroupDemandChip group={group} />

      {/*
        The only thing on the heading saying it can be opened. Muted to the
        point of being scenery until the row is hovered, because a project that
        cannot be drilled must not look like one that can — and structure is
        not allowed to outweigh the rows it files.
      */}
      {onDrill !== undefined && (
        <ChevronRight
          aria-hidden="true"
          data-testid="pilot-group-drill"
          className="h-3 w-3 shrink-0 text-daintree-text/25"
        />
      )}
    </div>
  );
}

/**
 * A worktree, as a heading — the same structure a project is, on the other axis.
 *
 * Not navigable either, and for the same reason: the arrow keys walk agents,
 * because agents are what this surface is for. Twenty to thirty worktrees in
 * one project is the case this exists for, so the header is one compact line —
 * a glyph, a name, and the demand chip. Nothing about the worktree's git state
 * is on it, because the fleet snapshot is global and git state is not: branch,
 * dirty count and divergence live in the per-project-view worktree store, which
 * exists for the one project a renderer owns. The question this answers is
 * which unit of work owns these agents, not whether that branch is safe to push.
 */
function WorktreeGroupHeader({ group }: { group: PilotWorktreeGroup }) {
  return (
    <div
      data-testid="pilot-worktree-header"
      className="flex w-full items-center gap-2 py-1 pr-3 pl-3 select-none"
    >
      <div className={cn(TILE_BASE, "bg-tint/[0.04] text-muted-foreground")}>
        <FolderGit2 className="h-2.5 w-2.5" aria-hidden="true" />
      </div>

      {/* Hidden for the reason the project heading's name is: the enclosing
          `role="group"` already carries it as the label for every option
          inside, so announcing it here would say it twice. */}
      <div aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={cn(PALETTE_SECTION_LABEL_CLASS, "truncate")}>{group.name}</span>
      </div>

      <GroupDemandChip group={group} />
    </div>
  );
}

function RunRow({
  row,
  isSelected,
  domId,
  onActivate,
  onPointerMove,
}: {
  row: PilotRow;
  isSelected: boolean;
  domId: string;
  onActivate: () => void;
  /**
   * `onPointerMove`, never `onMouseEnter`.
   *
   * `SearchablePalette` documents the reason and this surface is exactly the
   * case it describes: keyboard scrolling under a stationary cursor drags rows
   * past the pointer, and `mouseenter` would read that as the user choosing
   * each one on the way. Movement is what says a pointer is being aimed.
   */
  onPointerMove: () => void;
}) {
  /**
   * The agent's brand, unless the title already is it.
   *
   * The brand is on the row as an icon only, and search matches on it precisely
   * because "codex" is a plausible thing to type — so two identically-titled
   * runs on different agents were one string to a screen reader. An untitled
   * run falls back to its agent's name for the title, though, and "Claude,
   * Claude" is a separator promising a second fact and then not delivering one.
   */
  const agentLabel =
    row.chrome.label.toLowerCase() === row.title.toLowerCase() ? null : row.chrome.label;

  /**
   * Spelled out rather than left to the name-from-content computation.
   *
   * The row's own spans are inline, so a computed name concatenates them with
   * no separators at all: "Fix auth2m". Naming the parts here is what turns the
   * row back into a sentence, and it lets the age be announced as an age
   * ("2m ago") instead of a bare token a screen reader reads as "two em".
   *
   * The state is here and nowhere else on the row now. The worktree is neither:
   * it is a scratch project's UUID as often as it is a branch, and dropping it
   * from the drawn row without dropping it from the name would have left the
   * noise exactly where it is least escapable.
   */
  const accessibleName = [
    row.title,
    agentLabel,
    row.statusLabel,
    row.parkNote,
    row.quietFor !== null ? `quiet for ${row.quietFor}` : null,
    row.age !== null ? agoPhrase(row.age) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <div
      id={domId}
      role="option"
      aria-selected={isSelected}
      aria-label={accessibleName}
      data-testid="pilot-row"
      onClick={onActivate}
      onPointerMove={onPointerMove}
      // One line, ~32px. Two-line rows made 8 agents into 16 lines of identical
      // shape with nothing to scan down; columns are what give it a grain.
      className={cn(ROW_BASE, ROW_TONE, "gap-2 py-1 pr-3 pl-3")}
    >
      {/*
        State leads the row, so every agent's mark sits in one vertical line
        down the left edge and the fleet's working-vs-waiting split reads in a
        single glance without tracking across each row.
      */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <PilotRunState band={row.band} agentState={row.run.agentState} />
      </span>

      {/*
        The panel's own brand mark. Same component, chrome and preset colour the
        panel header and dock render, so one agent looks like itself everywhere
        — a generic glyph here would make the row the only surface that cannot
        tell Claude from Codex.
      */}
      <span className="flex size-4 shrink-0 items-center justify-center">
        <TerminalIcon
          chrome={row.chrome}
          className="h-4 w-4"
          brandColor={row.presetColor ?? row.chrome.color}
        />
      </span>

      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm leading-tight",
          isSelected ? "text-daintree-text" : "text-daintree-text/85"
        )}
      >
        {row.title}
      </span>

      {/*
        The park's note — the one line of intent that justifies the row still
        being listed. Capped so it shares the row with the title instead of
        starving it; the row's accessible name above carries it in full.
      */}
      {row.parkNote !== null && (
        <span
          aria-hidden="true"
          className="max-w-[45%] min-w-0 shrink truncate text-xs leading-tight text-daintree-text/45"
        >
          {row.parkNote}
        </span>
      )}

      {/*
        The stall cue: a working glyph beside ten minutes of silence is the
        one combination the age column cannot express — "Working · 47m" and
        "working but wedged" render identically without it. Amber because it
        is a live fact that may need a hand, worded because the hue alone
        must never carry it (the accessible name says "quiet for 12m").
      */}
      {row.quietFor !== null && (
        <span
          aria-hidden="true"
          className="shrink-0 text-[11px] leading-none text-state-waiting/80"
        >
          quiet {row.quietFor}
        </span>
      )}

      {/*
        The scan column, now a single fact wide.

        `aria-hidden` — the row's own label above says this in order and with
        separators, so announcing it here would read the age twice. Right-
        aligned, tabular, and given a floor width so "just now" and "2h 15m"
        start at the same x: without that the ages sit at eight different
        offsets and "how long has this been stuck" goes back to being eight
        separate reads instead of one scan.

        The status word and the worktree used to sit to its left. The glyph in
        the chevron column already says the state, and the worktree was as often
        a scratch project's UUID as a branch name — both were charging the
        truncating title for width to say nothing it needed.
      */}
      {row.age !== null && (
        <span
          aria-hidden="true"
          className="min-w-[3.5rem] shrink-0 text-right text-[11px] leading-none tabular-nums text-daintree-text/50"
        >
          {row.age}
        </span>
      )}
    </div>
  );
}

/**
 * `actionLabel` is null when nothing is listed, and the hint goes with it — a
 * footer offering "↵ Open" over a loading or empty list is chrome promising a
 * key that visibly does nothing.
 *
 * What Enter does to the highlighted row is the whole of the left edge. Arrow
 * keys moving a selection is a convention every list already teaches, so the
 * footer no longer spends a slot restating it.
 *
 * `onShowDemand` turns the demand sentence into the control it was already
 * implying. "2 agents need you" stated a fact the surface gave no way to act
 * on; as a button it isolates exactly the two agents it counted. Present only
 * when there is a demand to isolate, so the footer never grows a control that
 * would filter to nothing.
 */
function PilotFooter({
  actionLabel,
  parkLabel,
  drillLabel,
  summary,
  demandCount,
  onShowDemand,
}: {
  actionLabel: string | null;
  /** The park verb for the highlighted row, or null while no row is selected. */
  parkLabel: string | null;
  /**
   * The drill verb, present only while the highlighted run's project has more
   * than one worktree to break out. This is where the gesture's keyboard form
   * is taught: the heading carries the mouse form and cannot carry a key.
   */
  drillLabel: string | null;
  summary: string;
  demandCount: number;
  onShowDemand: () => void;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {actionLabel !== null && (
          <span>
            <kbd className={KBD_CLASS}>↵</kbd>
            <span className="ml-1.5">{actionLabel}</span>
          </span>
        )}
        {parkLabel !== null && (
          <span data-testid="pilot-park-hint">
            <kbd className={KBD_CLASS}>{isMac() ? "⌥↵" : "Alt+↵"}</kbd>
            <span className="ml-1.5">{parkLabel}</span>
          </span>
        )}
        {drillLabel !== null && (
          <span data-testid="pilot-drill-hint">
            <kbd className={KBD_CLASS}>{isMac() ? "⌘↵" : "Ctrl+↵"}</kbd>
            <span className="ml-1.5">{drillLabel}</span>
          </span>
        )}
      </div>
      {summary &&
        (demandCount > 0 ? (
          <button
            type="button"
            onClick={onShowDemand}
            data-testid="pilot-demand-action"
            // No `aria-label`. An action-phrased one ("Show 2 agents that need
            // you") would not contain the visible sentence, which is a
            // label-in-name failure for anyone driving the app by voice — and
            // its singular came out as "Show 1 agent that need you". The
            // button role already says it is actionable; the sentence says
            // what it is about.
            className={cn(
              "truncate rounded-[var(--radius-sm)] px-1.5 py-0.5 text-daintree-text/70 transition-colors",
              "hover:bg-overlay-subtle hover:text-daintree-text",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent"
            )}
          >
            {summary}
          </button>
        ) : (
          <span data-testid="pilot-summary" className="truncate text-daintree-text/50">
            {summary}
          </span>
        ))}
    </div>
  );
}

/**
 * The run `parkTargetId` names, resolved against the live fleet.
 *
 * A plain function rather than a `useMemo` in the component: the compiler could
 * not preserve the manual memo here and skipped optimizing `PilotView` whole,
 * so one hand-written cache was costing the entire component its automatic
 * ones. Called bare, the compiler caches the result itself.
 */
function findParkTarget(
  liveGroups: PilotProjectGroup[],
  parkTargetId: string | null
): PilotParkTarget | null {
  if (parkTargetId === null) return null;
  for (const group of liveGroups) {
    const row = group.rows.find((r) => r.run.runId === parkTargetId);
    if (row) return { row, group, existingPark: row.run.park };
  }
  return null;
}

/**
 * Whether this group is a project whose rows, as currently narrowed, span more
 * than one worktree.
 *
 * A type predicate so the drill target is proven to be a project group at the
 * one place that reads its workspace id. Computed from the DISPLAYED rows, so a
 * query that narrows a project down to a single worktree also withdraws the
 * affordance rather than offering a regrouping that would change nothing.
 */
function canDrill(group: PilotDisplayGroup): group is PilotProjectGroup {
  return group.axis === "workspace" && hasWorktreeAxis(group.rows.map((row) => row.run));
}

export function PilotView() {
  const isOpen = usePilotStore((s) => s.isOpen);
  const close = usePilotStore((s) => s.close);
  const scope = usePilotStore((s) => s.scope);
  const showFleet = usePilotStore((s) => s.showFleet);
  const openProject = usePilotStore((s) => s.openProject);
  const snapshot = useFleetSnapshotStore((s) => s.snapshot);
  const projects = useProjectStore((s) => s.projects);
  const scratches = useScratchStore((s) => s.scratches);
  const pilotShortcut = useEffectiveCombo("pilot.toggle");
  const scopedShortcut = useEffectiveCombo("pilot.openProject");

  useOverlayClaim("pilot", isOpen);

  const [query, setQuery] = useState("");
  /**
   * The state segment, held locally beside the query rather than in
   * `pilotStore`.
   *
   * Both are narrowing state for one opening of the dialog and both reset when
   * it closes. A filter that persisted would reopen the surface already hiding
   * agents, with the reason two openings in the past.
   */
  const [bandFilter, setBandFilter] = useState<PilotBandFilter>("all");
  /**
   * True while real focus sits on a filter segment.
   *
   * The footer advertises the LIST's keys, and on a segment those keys mean
   * something else entirely — Enter reselects the filter, the arrows move
   * between segments. Leaving "↵ Open" up while focus is there is the same
   * false promise the footer already drops over an empty list.
   */
  const [isFilterFocused, setIsFilterFocused] = useState(false);
  /** So a control that removes itself can hand focus back somewhere useful. */
  const searchRef = useRef<HTMLInputElement>(null);

  // The clock is state, not a bare tick counter, and it is a real dependency of
  // the row build below. A `setTick(n => n + 1)` that nothing reads is a no-op
  // under the React Compiler — it memoizes the derived rows on their declared
  // inputs, so a counter absent from those inputs never recomputes an age.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Names come from these two lists, and neither is guaranteed to be populated
  // when Pilot opens: the boot load of scratches is fire-and-forget and its
  // documented self-heal is "the switcher reloads them whenever it opens"
  // (#11518). Pilot is reachable by keybinding without ever opening the
  // switcher, so it refreshes them itself. Both loaders dedupe in flight.
  useEffect(() => {
    safeFireAndForget(
      Promise.allSettled([
        useProjectStore.getState().loadProjects(),
        useScratchStore.getState().loadScratches(),
      ]).then((results) => {
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
          throw new AggregateError(
            failed.map((r) => r.reason),
            "Workspace name hydrate failed"
          );
        }
      }),
      { context: "PilotView workspace name hydrate" }
    );
  }, []);

  const workspaces = useMemo(() => {
    const map = new Map<string, PilotWorkspaceMeta>();
    for (const project of projects) {
      map.set(project.id, {
        kind: "project",
        name: project.name,
        // Required on both workspace types, unlike the fields around it, so it
        // is assigned rather than spread in on a check.
        lastOpened: project.lastOpened,
        ...(project.emoji ? { emoji: project.emoji } : {}),
        ...(project.color ? { color: project.color } : {}),
        ...(project.lastCompletionSeenAt !== undefined
          ? { lastCompletionSeenAt: project.lastCompletionSeenAt }
          : {}),
      });
    }
    for (const scratch of scratches) {
      map.set(scratch.id, {
        kind: "scratch",
        name: scratch.name,
        lastOpened: scratch.lastOpened,
        ...(scratch.lastCompletionSeenAt !== undefined
          ? { lastCompletionSeenAt: scratch.lastCompletionSeenAt }
          : {}),
      });
    }
    return map;
  }, [projects, scratches]);

  const liveGroups = useMemo(() => {
    if (!snapshot) return [];
    // Agent names now come from the chrome descriptor each row derives, which
    // is the same resolution the panel header uses — a second lookup here
    // would be a second chance to disagree with it.
    return buildPilotGroups(snapshot.runs, {
      workspaces,
      currentWorkspaceId: getViewWorkspaceId(),
      nowMs,
    });
  }, [snapshot, workspaces, nowMs]);

  /**
   * The project the scope names, found among the groups actually built.
   *
   * Null while unscoped, and null too when the scoped project has drained: its
   * agents can all exit while the surface is open, and there is no group left
   * to regroup. That renders the scoped empty state rather than silently
   * dropping back to the fleet — a surface that navigates itself somewhere the
   * user did not ask for is harder to follow than one that says it is empty and
   * leaves the way back on screen.
   */
  const scopedProject = useMemo(
    () =>
      scope.kind === "project"
        ? (liveGroups.find((group) => group.workspaceId === scope.workspaceId) ?? null)
        : null,
    [scope, liveGroups]
  );

  /**
   * The population, cut on whichever axis the scope names.
   *
   * Everything downstream — the pointer hold, the query, the counts, the band
   * filter, the footer, the empty states — runs on this and never on the fleet
   * behind it, which is what makes a scoped opening's numbers describe the
   * scoped population rather than the whole fleet.
   */
  const displayGroups = useMemo<PilotDisplayGroup[]>(() => {
    if (scope.kind === "fleet") return liveGroups;
    return scopedProject === null ? [] : buildPilotWorktreeGroups(scopedProject);
  }, [scope.kind, liveGroups, scopedProject]);

  /** The scoped project's name, for the breadcrumb and the copy around it. */
  const scopedName =
    scope.kind === "project"
      ? (scopedProject?.name ?? workspaces.get(scope.workspaceId)?.name ?? "Unknown workspace")
      : null;

  /**
   * Position, held only while the pointer is genuinely working the list.
   *
   * Row order is derived from live agent state and the ranking IS the answer
   * this surface exists to give, so it has to stay true: an agent that blocks
   * while you are looking at the list has to rise to where the ranking says it
   * belongs, not sit below every idle agent until you close and reopen. Group
   * order is workspace recency, which no amount of agent state can move — but a
   * switch elsewhere can, which is why the hold has to cover whole groups too.
   *
   * The misclick this used to guard against is real but pointer-only. Selection
   * is keyed by `rowId` (#11071), so a re-rank cannot make Enter commit a row
   * the user did not choose — only a mouse aimed at a row that moves out from
   * under it can go wrong. So the order is held from the first pointer movement
   * over the list, and released the moment the pointer leaves or the keyboard
   * takes over. Ids only: the rows themselves keep updating in place, so a
   * glyph or an age still moves the instant it changes.
   *
   * Held in state rather than a ref so every mutation is a declared input of
   * the memo below. A ref read during render is invisible to memoization and
   * would serve a stale order for a frame.
   */
  const [pointerOrder, setPointerOrder] = useState<PilotOrder | null>(null);

  const orderedGroups = useMemo(
    () => (pointerOrder === null ? displayGroups : applyPilotOrder(displayGroups, pointerOrder)),
    [displayGroups, pointerOrder]
  );

  // A held order is a set of ids from ONE axis. Carried across a scope change it
  // would rank the incoming groups against ids none of them have, stranding
  // every one of them at the tail — the stale order this hold exists to
  // prevent, arriving through the scope instead of through time.
  useEffect(() => {
    setPointerOrder(null);
  }, [scope]);

  /**
   * The narrowing pipeline, in the one order that makes the counts honest.
   *
   * Query first, then count, then the band filter. Counting between the two is
   * what makes each segment report the query-intersected population: count
   * after the band filter and every segment reads its own filtered total, which
   * is always the length of the list already on screen and therefore tells the
   * user nothing. The two narrowings intersect with AND, so "the blocked agents
   * in this repo" is one question.
   */
  const queryGroups = useMemo(
    () => filterPilotGroups(orderedGroups, query),
    [orderedGroups, query]
  );

  const filterCounts = useMemo(() => countPilotBands(queryGroups), [queryGroups]);

  const visibleGroups = useMemo(
    () => filterPilotBands(queryGroups, bandFilter),
    [queryGroups, bandFilter]
  );

  /**
   * The tree, in the shared model's shape.
   *
   * A group is structure, not content, on either axis: its header is
   * `navigable: false`, so the arrow keys walk agents and never stop on a
   * heading on the way past. That keeps the common case — compare what is
   * working against what is waiting — from costing an extra keystroke per
   * section, and it is why drilling in is a chord on the selected RUN rather
   * than Enter on a heading the arrows can never reach.
   */
  const paletteGroups = useMemo<PaletteTreeGroupInput<PilotDisplayGroup, PilotRow>[]>(
    () =>
      visibleGroups.map((group) => ({
        // The GROUP's id, which is a workspace id on one axis and an encoded
        // worktree path on the other. Nothing may read a workspace off it —
        // see `activate` below, which takes one off the run instead.
        groupId: group.groupId,
        group,
        header: {
          rowId: `group:${group.groupId}`,
          // The group container's id. Safe only because the header is not
          // navigable, so this id never reaches `aria-activedescendant`.
          // Making headers navigable here would first have to give the header
          // element an id of its own — pointing the active descendant at a
          // role-less container is the dangling reference #11071 was about.
          domId: groupDomId(group.groupId),
          navigable: false,
        },
        items: group.rows.map((row) => ({
          rowId: row.run.runId,
          domId: runDomId(row.run.runId),
          navigable: true,
          item: row,
        })),
      })),
    [visibleGroups]
  );

  /**
   * The run whose park is being edited, held by id so the pane always renders
   * live data: titles, bands and the candidate list keep updating underneath
   * the editor exactly as they do under the list.
   */
  const [parkTargetId, setParkTargetId] = useState<string | null>(null);

  const parkTarget = findParkTarget(liveGroups, parkTargetId);

  const gateCandidates = useMemo<PilotGateCandidate[]>(() => {
    if (parkTargetId === null) return [];
    const out: PilotGateCandidate[] = [];
    for (const group of liveGroups) {
      for (const row of group.rows) {
        if (row.run.runId === parkTargetId) continue;
        out.push({ row, group });
      }
    }
    return out;
  }, [parkTargetId, liveGroups]);

  // The run closed (or the fleet became unreadable) while its editor was open
  // — there is nothing left to park, so fall back to the list.
  useEffect(() => {
    if (parkTargetId !== null && parkTarget === null) setParkTargetId(null);
  }, [parkTargetId, parkTarget]);

  const parkEditing = parkTarget !== null;

  const closeParkEditor = useCallback((_changed: boolean) => {
    setParkTargetId(null);
  }, []);

  // The editor unmounts with focus inside it, and the search box only
  // REMOUNTS on the same commit — so the hand-back has to happen after that
  // commit, not inside the close handler, where the ref is still null.
  const wasParkEditingRef = useRef(false);
  useEffect(() => {
    if (wasParkEditingRef.current && !parkEditing && isOpen) {
      searchRef.current?.focus();
    }
    wasParkEditingRef.current = parkEditing;
  }, [parkEditing, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setBandFilter("all");
      setParkTargetId(null);
      // Closing takes focus with it without a blur ever reaching the bar.
      setIsFilterFocused(false);
    }
  }, [isOpen]);

  const activate = useCallback((row: NavigablePaletteTreeRow<PilotDisplayGroup, PilotRow>) => {
    if (row.kind !== "item") return;
    void actionService.dispatch("pilot.openRun", {
      runId: row.item.run.runId,
      // Read off the RUN, never off the group. A group id names a project on
      // one axis and a worktree on the other, so the row's own workspace is the
      // only field that answers this question in both — and it is the field
      // that was authoritative even when the two happened to coincide.
      workspaceId: row.item.run.workspaceId,
    });
  }, []);

  /**
   * `shouldPreserveInputCaretKey` is true where a caret exists to protect, and
   * the list's structural keys stand down for it.
   *
   * Home/End are structural keys, but they are also the search box's editing
   * keys, and the box owns focus by default. While the query is non-empty they
   * stay with the caret; an empty box has nothing to edit, so they jump to the
   * first and last row. The horizontal arrows are no longer contested at all —
   * with the disclosure gone the list has no horizontal axis, so they are the
   * caret's outright.
   *
   * Deliberately keyed on the query alone and not on the band filter: an active
   * filter with an empty box still leaves nothing to edit. The filter bar binds
   * its own arrows, but only while it physically holds focus, so the two never
   * contend.
   */
  const navigation = usePaletteTreeNavigation<PilotDisplayGroup, PilotRow>({
    groups: paletteGroups,
    isActive: isOpen,
    // Every narrowing scopes the selection. Keyed on the query alone, the
    // highlight would survive on a row the filter had just removed — and the
    // scope belongs here for the same reason, since drilling in replaces the
    // whole population rather than narrowing it.
    selectionScopeKey: `${scope.kind === "project" ? scope.workspaceId : "fleet"}|${query}|${bandFilter}`,
    onActivate: activate,
    shouldPreserveInputCaretKey: () => query.length > 0,
  });

  const { selectedRow, activeDescendantId, renderGroups, selectRow } = navigation;

  /**
   * A pointer aimed at a row selects it, and takes the order still while it is
   * being aimed.
   *
   * Both halves in one handler because they are one gesture: the hold exists to
   * keep the row under the cursor from moving before the click lands, so it has
   * to start at the same moment the cursor starts choosing.
   */
  const handleRowPointerMove = useCallback(
    (rowId: string) => {
      // Captured from what this render DREW, not from the live ranking. The two
      // are the same whenever there is no hold, but they part company in one
      // real sequence: pointer-leave queues the release, a fast re-entry queues
      // this updater from the same still-committed render, and the updater then
      // sees `held === null` while the screen the pointer came back to was
      // still showing the held order. Capturing `liveGroups` there would take a
      // snapshot of an order the user never saw and move rows under the cursor
      // on the next commit — the exact misclick this guards against.
      setPointerOrder((held) => (held === null ? capturePilotOrder(orderedGroups) : held));
      selectRow(rowId);
    },
    [orderedGroups, selectRow]
  );

  const releasePointerOrder = useCallback(() => setPointerOrder(null), []);

  /**
   * The two ways a hold outlives the pointer that took it.
   *
   * Backgrounding the app is the dangerous one: the cursor never moves, so no
   * boundary event fires, and coming back after ten minutes to a ranking frozen
   * since before you left is precisely the staleness this replaced. An emptied
   * list is the quieter one — there is no row left under the cursor to protect,
   * and whether removing the element the pointer was over fires a leave is not
   * something to depend on.
   */
  useEffect(() => {
    if (!isOpen || renderGroups.length === 0) {
      setPointerOrder(null);
      return;
    }
    window.addEventListener("blur", releasePointerOrder);
    return () => window.removeEventListener("blur", releasePointerOrder);
  }, [isOpen, renderGroups.length, releasePointerOrder]);

  /**
   * The keyboard takes the list back, and the pointer's hold with it.
   *
   * Released AFTER delegating, never before: the arrow has to act on the order
   * the user can currently see, and the resulting `rowId` then survives the
   * re-rank because selection was never index-keyed. `defaultPrevented` is the
   * signal because the model cancels exactly the keys it acted on — a Home the
   * search caret kept, or an arrow over an empty list, leaves the hold alone.
   */
  const releaseOnConsumedKey = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) setPointerOrder(null);
  }, []);

  /**
   * Alt+Enter on the highlighted row opens the park editor — a second verb on
   * the same selection, so it lives beside Enter in both key paths rather
   * than in the navigation model, which owns structure and not actions.
   */
  const interceptParkKey = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (event.key !== "Enter" || !event.altKey || event.defaultPrevented) return false;
      if (selectedRow === null || selectedRow.kind !== "item") return false;
      // No parking from retained data: Main rejects a park it cannot validate
      // against a healthy snapshot, so offering the editor over a stale fleet
      // would collect a note and then bounce it.
      if (snapshot === null || snapshot.degraded) return false;
      event.preventDefault();
      setParkTargetId(selectedRow.item.run.runId);
      return true;
    },
    [selectedRow, snapshot]
  );

  /**
   * The project the highlighted run would drill into, or null.
   *
   * Read off the selected row's own GROUP, which is the narrowed one already on
   * screen — so the chord is offered on exactly the projects whose headings are
   * currently drawing a chevron, and the two forms of one gesture can never
   * disagree about which projects have a worktree axis.
   */
  const drillTarget =
    scope.kind === "fleet" && selectedRow !== null && selectedRow.kind === "item"
      ? canDrill(selectedRow.group)
        ? selectedRow.group.workspaceId
        : null
      : null;

  /**
   * The keyboard form of clicking a project heading.
   *
   * On the selected RUN rather than on the heading, because the heading is not
   * in the arrow-key domain and making it one would reverse the ruling that
   * keeps the arrows walking agents. The run names its project unambiguously,
   * so "drill into where this one lives" needs no second selection.
   *
   * Beside Enter and Alt+Enter in both key paths rather than inside the
   * navigation model, which owns structure and not actions.
   */
  const interceptDrillKey = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (event.key !== "Enter" || event.defaultPrevented) return false;
      if (!(isMac() ? event.metaKey : event.ctrlKey)) return false;
      if (drillTarget === null) return false;
      event.preventDefault();
      openProject(drillTarget);
      return true;
    },
    [drillTarget, openProject]
  );

  /**
   * Backspace leaves the scope, but only with nothing left to delete.
   *
   * The search box owns focus by default, so a bare Backspace is an editing key
   * first and a navigation key second. Gated on an empty query it can never
   * take a character the user meant to remove — the same arbitration Home and
   * End already get.
   */
  const interceptScopeBackKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): boolean => {
      if (event.key !== "Backspace" || event.defaultPrevented) return false;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (scope.kind !== "project" || query.length > 0) return false;
      event.preventDefault();
      showFleet();
      return true;
    },
    [scope.kind, query, showFleet]
  );

  const handleInputKeyDown = useCallback<KeyboardEventHandler<HTMLInputElement>>(
    (event) => {
      // Park first: it is the one Enter variant that also carries a modifier
      // the drill checks, so letting the drill run first would let Alt+Cmd+
      // Enter regroup a project instead of parking the run under the cursor.
      if (interceptParkKey(event)) return;
      if (interceptDrillKey(event)) return;
      if (interceptScopeBackKey(event)) return;
      navigation.handleInputKeyDown(event);
      releaseOnConsumedKey(event);
    },
    [interceptParkKey, interceptDrillKey, interceptScopeBackKey, navigation, releaseOnConsumedKey]
  );

  const handleBodyKeyDown = useCallback<KeyboardEventHandler<HTMLElement>>(
    (event) => {
      // While the editor owns the body, the list's navigation must stand down
      // entirely: its selection is live underneath, and an Enter bubbling out
      // of the note input would otherwise OPEN the highlighted run.
      if (parkEditing) return;
      if (interceptParkKey(event)) return;
      if (interceptDrillKey(event)) return;
      navigation.handleBodyKeyDown(event);
      releaseOnConsumedKey(event);
    },
    [parkEditing, interceptParkKey, interceptDrillKey, navigation, releaseOnConsumedKey]
  );

  /**
   * What the surface can honestly claim right now.
   *
   * `degraded` means a PTY shard failed to answer, so `runs` is retained rather
   * than current. Distinguishing "never had data" from "have stale data" is the
   * whole point: the first cannot say anything about the fleet, and the second
   * can, as long as it says how old it is. Neither may render as all-clear.
   */
  const status = useMemo(() => {
    if (snapshot === null) return { kind: "loading" } as const;
    if (!snapshot.degraded) return { kind: "live" } as const;
    return snapshot.lastSuccessfulAt === null
      ? ({ kind: "unavailable" } as const)
      : ({ kind: "stale", since: snapshot.lastSuccessfulAt } as const);
  }, [snapshot]);

  /**
   * Summarised over the QUERY-filtered fleet, not the raw one.
   *
   * The footer's sentence is now a control that applies a filter, and a control
   * has to deliver what it advertises: counted over the whole fleet it would
   * promise five agents and reveal the two that also match the query.
   */
  const fleet = useMemo(() => summarizePilotGroups(queryGroups), [queryGroups]);

  /**
   * The demand the footer can actually isolate.
   *
   * NOT `fleet.demand`, which counts `review` as a demand — correct for the
   * band vocabulary, wrong here, because the Needs-you segment covers only
   * `blocked` and `needs-you`. A footer counting review would state a number
   * its own button then failed to produce. Review keeps its own sentence
   * instead of being folded into somebody else's.
   */
  const needsYou = filterCounts["needs-you"];
  const review = fleet.bands.review;

  // Counted by band, never off the raw row total: a fleet holding two working
  // agents and six exited ones is not "8 agents running".
  const live = fleet.bands.running;
  const fleetPhrase =
    status.kind === "loading" || status.kind === "unavailable"
      ? ""
      : needsYou > 0
        ? demandPhrase(needsYou)
        : review > 0
          ? reviewPhrase(review)
          : live > 0
            ? `Nothing needs you · ${live} ${live === 1 ? "agent" : "agents"} working`
            : fleet.total > 0
              ? `Nothing needs you · ${agentCount(fleet.total)}`
              : "";

  /**
   * The same sentence, qualified when the feed is dead.
   *
   * "Nothing needs you" over retained runs is the surface making a live
   * all-clear claim out of data it cannot currently see — the exact thing the
   * stale rule forbids, printed directly under the banner that contradicts it.
   * The sentence stays whole rather than being rewritten, because what changed
   * is how current it is, not what it says.
   */
  const summary =
    status.kind === "stale" && fleetPhrase !== "" ? `Last known: ${fleetPhrase}` : fleetPhrase;

  const hasTree = renderGroups.length > 0;

  /**
   * Whether either narrowing is in play, which is what an empty list means.
   *
   * A query or a filter turning up nothing is a true statement about the
   * narrowing. A fleet with nothing in it at all is a statement about the
   * fleet, and only live data can make that one.
   */
  const hasNarrowing = query.trim().length > 0 || bandFilter !== "all";

  // Stale narrows honestly — retained runs are real rows, so a query matching
  // none of them says something true — but a retained EMPTY fleet may not
  // render the zero-data prompt: "Start an agent in any project" over a feed
  // that stopped answering an hour ago presents an unknown as an all-clear.
  // `loading` and `unavailable` stay out entirely; they already render the
  // skeleton and the can't-reach-host message.
  const showEmpty =
    renderGroups.length === 0 &&
    (status.kind === "live" || (status.kind === "stale" && hasNarrowing));
  const showSkeleton = useDeferredLoading(status.kind === "loading", UI_DOHERTY_THRESHOLD);

  /**
   * The bar rides the un-narrowed fleet, not the visible one.
   *
   * Four zero segments over a fleet that hasn't been read yet would be a claim
   * the surface can't support, and over a genuinely empty one they are chrome
   * competing with the sentence telling the user to start an agent. But once
   * there ARE runs the bar has to stay, even when the current query and segment
   * leave nothing on screen — that is precisely when it is the way back.
   */
  const showFilterBar =
    (status.kind === "live" || status.kind === "stale") && orderedGroups.length > 0;

  // Removing a focused element does not reliably fire a blur, so a bar that
  // vanishes under the cursor — the fleet drains, or the host stops answering
  // — would leave the flag stuck true and the footer's hints suppressed for
  // the rest of the opening, including after the fleet comes back.
  useEffect(() => {
    if (!showFilterBar) setIsFilterFocused(false);
  }, [showFilterBar]);

  // Every selectable row is an agent now, so the verb never changes.
  //
  // Dropped while a filter segment holds focus: on a segment those keys drive
  // the filter, not the list, so the hints would be naming keys that do
  // something else. Gated on the bar still being here as well, because a bar
  // that unmounts while focused — the fleet drains, or the dialog closes —
  // never gets its blur, and the flag alone would suppress the hints for good.
  const actionLabel = selectedRow === null || (isFilterFocused && showFilterBar) ? null : "Open";

  // The second verb rides the same gating as the first — no selection or a
  // focused filter segment drops both hints — plus one of its own: parking
  // needs a healthy snapshot (Main validates the ids against it), so the hint
  // disappears with the data that would back it.
  const parkLabel =
    actionLabel === null ||
    selectedRow === null ||
    selectedRow.kind !== "item" ||
    status.kind !== "live"
      ? null
      : selectedRow.item.band === "parked"
        ? "Edit park"
        : "Park";

  // The drill verb rides the same "is a row actually actionable" gating as the
  // other two, and disappears with the target itself — a hint naming a chord
  // that would do nothing is the same false promise as an "↵ Open" over an
  // empty list.
  const drillLabel = actionLabel === null || drillTarget === null ? null : "Worktrees";

  return (
    // Dismissal is layered, innermost first: the park editor, then the project
    // scope, then the dialog. The palette's Escape runs through a
    // document-level backstop that fires before any inner listener can, so the
    // only reliable way to put anything under Escape is to redirect what
    // closing DOES — not to race the key. Backdrop clicks follow the same rule,
    // which is also the right gesture reading each time: dismiss the thing on
    // top, not the surface under it.
    <AppPaletteDialog
      isOpen={isOpen}
      onClose={
        parkEditing ? () => closeParkEditor(false) : scope.kind === "project" ? showFleet : close
      }
      ariaLabel={scopedName === null ? "All agents" : `Agents in ${scopedName}`}
      tier="command"
    >
      <AppPaletteDialog.Header
        label={scopedName === null ? "All agents" : "Agents by worktree"}
        shortcut={scopedName === null ? pilotShortcut : scopedShortcut}
      >
        {/*
          The search-and-narrow controls belong to the list. While the park
          editor owns the body they unmount — a query box filtering an
          invisible list is a control acting somewhere the user cannot see.
        */}
        {!parkEditing && (
          <>
            {/*
              The way back, and the only thing on screen saying where "here" is.

              A row above the input rather than an adornment inside it:
              `AppPaletteDialog.Input` renders a bare `<input>` or an `<input>`
              wrapped in a div depending on whether it was given a prefix, so
              moving the breadcrumb in there would change the element's type at
              this position on every scope change and remount the search box —
              taking focus with it mid-gesture. As a sibling rendered through
              `&&` the input's position never moves.

              Escape and an empty-box Backspace do the same thing; this is the
              form that is visible without being tried.
            */}
            {scopedName !== null && (
              <div className="mb-1.5 flex min-w-0 items-center gap-1 text-[11px] leading-none">
                <button
                  type="button"
                  data-testid="pilot-scope-back"
                  onClick={showFleet}
                  className={cn(
                    "flex shrink-0 items-center gap-0.5 rounded-[var(--radius-sm)] py-0.5 pr-1.5 pl-0.5",
                    "text-daintree-text/60 transition-colors",
                    "hover:bg-overlay-subtle hover:text-daintree-text",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent"
                  )}
                >
                  <ChevronLeft className="h-3 w-3" aria-hidden="true" />
                  All agents
                </button>
                <span aria-hidden="true" className="shrink-0 text-daintree-text/25">
                  /
                </span>
                <span
                  data-testid="pilot-scope-name"
                  className="min-w-0 truncate text-daintree-text/70"
                >
                  {scopedName}
                </span>
              </div>
            )}

            <AppPaletteDialog.Input
              inputRef={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Search agents…"
              aria-label="Search agents"
              // The role is constant, not conditional on there being results. A
              // control that changes role underneath a screen reader as rows come
              // and go is not re-announced, so it silently stops being what the
              // user was told it was. The tree container below is always mounted,
              // which is what keeps `aria-controls` resolving.
              role="combobox"
              aria-expanded={hasTree}
              aria-haspopup="listbox"
              aria-controls={LIST_ID}
              aria-activedescendant={activeDescendantId}
              data-testid="pilot-search"
            />

            {/*
              Inside the header, under the input, so the two narrowing controls read
              as one unit and the header's own rule closes the block. Full-bleed
              against the header's padding, matching the sidebar's bar exactly.
              After the input in DOM order, which is also the tab order: input →
              active segment → results.
            */}
            {showFilterBar && (
              <div className="-mx-3 -mb-2 mt-2 border-t border-border-default">
                <PilotFilterBar
                  value={bandFilter}
                  counts={filterCounts}
                  bands={fleet.bands}
                  onChange={setBandFilter}
                  onFocusChange={setIsFilterFocused}
                />
              </div>
            )}
          </>
        )}
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        className="p-0"
        ariaLabel="Agents"
        activeDescendant={parkEditing ? undefined : activeDescendantId}
        onNavigationKeyDown={handleBodyKeyDown}
      >
        {parkEditing && parkTarget !== null && (
          <PilotParkEditor
            target={parkTarget}
            candidates={gateCandidates}
            onClose={closeParkEditor}
          />
        )}

        {!parkEditing && showSkeleton && (
          /*
           * Gated at the Doherty threshold — a fleet read that resolves in
           * 80ms must not flash a skeleton on the way. The hint is a SIBLING of
           * the skeleton, never a child: the wrapper carries `aria-busy`, which
           * silences live-region mutations inside its own subtree.
           */
          <>
            <Skeleton className="flex flex-col gap-1 p-2" data-testid="pilot-skeleton">
              {/* Shaped like what is coming: a section label, then its runs. */}
              <SkeletonBone className="h-6 w-full" />
              <SkeletonBone className="h-8 w-full" />
              <SkeletonBone className="h-8 w-full" />
              <SkeletonBone className="h-6 w-full" />
            </Skeleton>
            <SkeletonHint firstThreshold={LOADING_HINT_MS} message="Still reading the fleet…" />
          </>
        )}

        {!parkEditing && status.kind === "unavailable" && (
          <div className="px-3 py-8 text-center" role="status" data-testid="pilot-unavailable">
            <p className="text-sm text-daintree-text/70">Can&apos;t reach the agent host</p>
            {/*
              No retry button: the service already re-reads every few seconds,
              so a control that does what the app is doing anyway would be a
              promise the user has to keep pressing.
            */}
            <p className="mt-1 text-xs text-daintree-text/40">
              Agents keep running. This reconnects on its own.
            </p>
          </div>
        )}

        {!parkEditing && status.kind === "stale" && (
          <div data-testid="pilot-stale" className="px-3 py-1.5 text-[11px] text-activity-waiting">
            {/*
              The announced copy is fixed and the ticking age is hidden from it.
              Putting the age inside the live region made a disconnected host
              announce itself afresh every minute, which is noise, not news.
            */}
            <span className="sr-only" role="status">
              Fleet data is stale. Reconnecting automatically.
            </span>
            <span aria-hidden="true">
              {`Can't reach the agent host — showing the last known state from ${agoPhrase(formatWaitAge(status.since, nowMs))}`}
            </span>
          </div>
        )}

        {!parkEditing && showEmpty && (
          /*
           * Names the next action rather than the absence. This is not the
           * completed-work state it first looks like: a finished agent stays in
           * the fleet as a `review` or `done` row, and an exited one as `idle`,
           * so an empty snapshot means no agent terminals exist at all.
           *
           * No button on the zero-data branch — launching is per-project and
           * this surface spans them all, so a CTA there would name an action it
           * cannot perform. The sentence is the affordance.
           *
           * A filtered empty IS actionable, though, and gets the one control
           * that undoes the constraint the user can't otherwise see: the filter
           * is named in the title, and clearing it keeps the query, because
           * throwing away both would make the button a reset rather than the
           * targeted correction it says it is.
           */
          <AppPaletteDialog.Empty
            query={query}
            emptyMessage={
              scopedName === null
                ? "Start an agent in any project"
                : `Start an agent in ${scopedName}`
            }
            {...(bandFilter !== "all" ? { filterLabel: PILOT_BAND_FILTER_LABEL[bandFilter] } : {})}
            noMatchContent={
              bandFilter === "all" ? undefined : (
                <button
                  type="button"
                  data-testid="pilot-clear-filter"
                  onClick={() => {
                    setBandFilter("all");
                    // This button is about to unmount itself. Without handing
                    // focus back, a keyboard user is left on the document body
                    // — and if the retained query still matches nothing there
                    // is no row to arrow to either.
                    searchRef.current?.focus();
                  }}
                  className={cn(
                    "rounded-[var(--radius-sm)] px-2 py-1 text-xs text-daintree-text/70 transition-colors",
                    "hover:bg-overlay-subtle hover:text-daintree-text",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent"
                  )}
                >
                  Clear filter
                </button>
              )
            }
          />
        )}

        {/*
          Always mounted so `aria-controls` on the combobox above always
          resolves, even while loading or empty — except while the park editor
          owns the body, when the combobox itself is unmounted too. No padding
          of its own: the palette body's scroller already carries `p-2`.
        */}
        <div
          id={LIST_ID}
          hidden={parkEditing}
          {...(hasTree
            ? {
                role: "listbox",
                "aria-label": scope.kind === "project" ? "Agents by worktree" : "Agents by project",
              }
            : {})}
          // The pointer stops working the list the moment it leaves it, so the
          // ranking goes back to being true. On the container rather than the
          // rows: moving between two rows leaves one and enters the next, and a
          // per-row handler would release and re-take the hold on the way past.
          onPointerLeave={releasePointerOrder}
        >
          {renderGroups.map(({ header, items }, groupIndex) => {
            // Bound to a const so the discriminant narrows inside the drill
            // handler's closure as well as at the branch.
            const group = header.group;
            const drillTo = canDrill(group) ? group.workspaceId : null;
            return (
              // `role="group"` is a permitted listbox child and carries the
              // group's name as the label for every option inside it, which is
              // how a screen reader still hears which project — or, scoped,
              // which worktree — a run belongs to now that the header itself is
              // not an item.
              //
              // Being in the current workspace decides whether opening a run is
              // instant or swaps the whole view, and the header renders that as
              // a word it then hides — so it rides the label rather than being
              // visual-only. Short on purpose: this name is re-announced as
              // context for every option inside, and the group's own contents
              // are those options, so a prose summary here would be read once
              // per row.
              <div
                key={header.domId}
                id={header.domId}
                role="group"
                aria-label={`${group.name}${group.axis === "workspace" && group.isCurrent ? ", current workspace" : ""}${group.demandCount > 0 ? `, ${demandPhrase(group.demandCount)}` : ""}`}
                // The scroller spaces siblings equally, so after a long run list
                // the next group arrives with no more separation than one more
                // agent. Only between groups — a leading gap would push the list
                // off its own top edge.
                className={groupIndex > 0 ? "mt-2" : undefined}
              >
                {group.axis === "worktree" ? (
                  <WorktreeGroupHeader group={group} />
                ) : (
                  <GroupHeader
                    group={group}
                    {...(drillTo !== null ? { onDrill: () => openProject(drillTo) } : {})}
                  />
                )}
                {items.map((row) => (
                  <RunRow
                    key={row.domId}
                    row={row.item}
                    isSelected={row.rowId === selectedRow?.rowId}
                    domId={row.domId}
                    onActivate={() => navigation.activateRow(row.rowId)}
                    onPointerMove={() => handleRowPointerMove(row.rowId)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </AppPaletteDialog.Body>

      {/*
        An empty fleet has no row to act on and nothing to summarise, so both
        halves of the footer go quiet — and the bar collapses to a bare ruled
        strip under the empty state. Drop the whole footer instead of shipping a
        divider with nothing beneath it.
      */}
      {!parkEditing && (actionLabel !== null || summary !== "") && (
        <AppPaletteDialog.Footer>
          <PilotFooter
            actionLabel={actionLabel}
            parkLabel={parkLabel}
            drillLabel={drillLabel}
            summary={summary}
            demandCount={needsYou}
            onShowDemand={() => {
              setBandFilter("needs-you");
              // This button leaves focus on itself, where the body's handler
              // bails on events that did not come from the scroller — so the
              // arrows stop moving the selection until focus goes back. The
              // Clear-filter button in the empty state already makes exactly
              // this handoff.
              searchRef.current?.focus();
            }}
          />
        </AppPaletteDialog.Footer>
      )}
    </AppPaletteDialog>
  );
}
