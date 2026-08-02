import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { actionService } from "@/services/ActionService";
import { FLEET_BANDS, isDemandBand, type FleetBand } from "@/lib/fleetAttention";
import { UI_ANIMATION_DURATION, UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { agoPhrase, formatWaitAge, ROW_TONE_CLASS } from "@/lib/projectRowStatus";
import {
  buildPilotGroups,
  countPilotBands,
  filterPilotBands,
  filterPilotGroups,
  summarizePilotGroups,
  PILOT_BAND_FILTER_LABEL,
  type PilotBandFilter,
  type PilotProjectGroup,
  type PilotRow,
  type PilotWorkspaceMeta,
} from "./pilotRows";
import { BAND_GLYPH, BAND_GLYPH_TONE, PilotRunState } from "./PilotRunState";
import { PilotFilterBar } from "./PilotFilterBar";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import {
  usePaletteTreeNavigation,
  type NavigablePaletteTreeRow,
  type PaletteTreeGroupInput,
} from "@/hooks/usePaletteTreeNavigation";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { CircleHelp, FileText } from "@/components/icons";
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
 * Id of a project's run container, which its disclosure button `aria-controls`.
 */
function groupDomId(workspaceId: string): string {
  return `pilot-option-group-${workspaceId}`;
}

function runDomId(runId: string): string {
  return `pilot-option-run-${runId}`;
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

/** The worst band's own sentence, plural-aware. */
function bandPhrase(band: FleetBand, count: number): string {
  switch (band) {
    case "blocked":
      return count === 1 ? "Agent blocked" : `${count} agents blocked`;
    case "needs-you":
      return demandPhrase(count);
    case "review":
      return count === 1 ? "Ready for review" : `${count} agents ready for review`;
    case "running":
      return count === 1 ? "Agent working" : `${count} agents working`;
    case "done":
      return count === 1 ? "Agent finished" : `${count} agents finished`;
    default:
      return agentCount(count);
  }
}

/**
 * A group's one status sentence, in the switcher's shape: what the worst thing
 * in it is, then how much else is there.
 *
 * Named rather than left to the tone: "blocked" and "needs input" are both
 * demands and would otherwise differ only in hue, which is the colour-only
 * encoding the switcher's own status line exists to avoid.
 *
 * The remainder is "N more" rather than a repeated total — "2 agents blocked ·
 * 3 agents" states the same population twice and reads as a contradiction, and
 * naming that remainder "running" would be false for an exited or idle run.
 */
function groupSummary(group: PilotProjectGroup): string {
  const inTopBand = group.rows.filter((row) => row.band === group.topBand).length;
  const rest = group.rows.length - inTopBand;
  const lead = bandPhrase(group.topBand, inTopBand);
  return rest > 0 ? `${lead} · ${rest} more` : lead;
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
 * What a collapsed project is still holding, as one pip per band present.
 *
 * Expanded, the rows ARE the summary and a sentence restating them in prose is
 * a third thing to read for facts already on screen. Collapsed, the rows are
 * gone and something has to stop a project hiding a blocked agent behind a
 * chevron — so the summary earns its place at exactly the moment the rows stop
 * being visible, and nowhere else.
 *
 * Glyphs, not words, and the same glyphs the filter bar uses, so the cluster
 * reads as a compressed version of the list rather than a new notation.
 * `aria-hidden` throughout: the toggle's own label already carries
 * `groupSummary()` in both states, and announcing four glyph-count fragments
 * beside it would be the same fact twice, less intelligibly the second time.
 */
function CollapsedBandPips({ group }: { group: PilotProjectGroup }) {
  const counts = new Map<FleetBand, number>();
  for (const row of group.rows) counts.set(row.band, (counts.get(row.band) ?? 0) + 1);

  return (
    <span aria-hidden="true" className="flex shrink-0 items-center gap-2">
      {FLEET_BANDS.filter((band) => counts.has(band)).map((band) => {
        const Glyph = BAND_GLYPH[band];
        return (
          <span key={band} className="flex items-center gap-1">
            <Glyph className={cn("size-2.5 shrink-0", BAND_GLYPH_TONE[band])} />
            <span className="text-[10px] leading-none tabular-nums text-daintree-text/50">
              {counts.get(band)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * A project, as a heading — never a row.
 *
 * Deliberately outside the selection domain. The arrow keys walk agents,
 * because agents are what this surface is for; stopping on a project on the way
 * past made the common case (compare what is working against what is waiting)
 * cost an extra keystroke per project, and put Enter one mistake away from
 * collapsing the group instead of opening the run you were aiming at.
 *
 * The disclosure is a real button rather than a click handler on the row, so it
 * announces its state and its target. `tabIndex={-1}` keeps it out of the tab
 * order — the search box owns the keyboard — matching the switcher's own
 * in-header sort control.
 */
function GroupHeader({
  group,
  isCollapsed,
  groupId,
  className,
  onToggle,
}: {
  group: PilotProjectGroup;
  isCollapsed: boolean;
  groupId: string;
  className?: string;
  onToggle: () => void;
}) {
  const summary = groupSummary(group);

  return (
    <div
      data-testid="pilot-group-header"
      className={cn("flex w-full items-center gap-2 py-1 pr-3 pl-3 select-none", className)}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-expanded={!isCollapsed}
        aria-controls={groupId}
        // The summary rides the label in BOTH states. Collapsed it is the only
        // account of what is inside; expanded it saves a screen-reader user
        // walking the rows to learn what walking them would cost.
        aria-label={`${group.name}, ${summary}`}
        data-testid="pilot-group-toggle"
        onClick={onToggle}
        className="flex shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-daintree-text/40 transition-colors hover:text-daintree-text"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 transition-transform ease-out motion-reduce:transition-none",
            !isCollapsed && "rotate-90"
          )}
          style={{ transitionDuration: `${UI_ANIMATION_DURATION}ms` }}
        />
      </button>

      <WorkspaceTile group={group} />

      {/*
        The shared section-label treatment every other palette gives this
        element — 10px, tracked, uppercase, muted. A project is structure, and
        structure has to weigh less than the content it organises; the 14px
        semibold name plus a second coloured line outweighed the very rows it
        was meant to be filing.

        The toggle's label already carries the name and the summary, so this is
        hidden rather than announced a second time.
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

      {isCollapsed && <CollapsedBandPips group={group} />}
    </div>
  );
}

function RunRow({
  row,
  isSelected,
  domId,
  onActivate,
}: {
  row: PilotRow;
  isSelected: boolean;
  domId: string;
  onActivate: () => void;
}) {
  // Only a demand gets a visible word. The other three states are neutral by
  // design now, and a status word for each of them was half of what made every
  // row look equally important — but the state still has to be readable as
  // text, so it moves into the option's accessible name instead of vanishing.
  const isDemand = isDemandBand(row.band);

  /**
   * Spelled out rather than left to the name-from-content computation.
   *
   * Those spans are inline, so a computed name concatenates them with no
   * separators at all: "Fix authWorkingfeature-x2m". Naming the parts here is
   * what turns the row back into a sentence, and it lets the age be announced
   * as an age ("2m ago") instead of a bare token a screen reader reads as
   * "two em".
   */
  const accessibleName = [
    row.title,
    row.statusLabel,
    row.worktreeLabel,
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
      // One line, ~32px. Two-line rows made 8 agents into 16 lines of identical
      // shape with nothing to scan down; the trailing group below puts the
      // facts into columns instead.
      className={cn(ROW_BASE, ROW_TONE, "gap-2 py-1 pr-3 pl-3")}
    >
      {/*
        State rides the chevron column, so every agent's mark sits in one
        vertical line down the left edge and the fleet's working-vs-waiting
        split reads in a single glance without tracking across each row.
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
          userChosen={row.presetColor !== undefined}
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
        The scan column. Everything here is `aria-hidden` — the row's own label
        above says all of it, in order and with separators, so announcing these
        as well would read each row's facts twice.

        The group may shrink, but only into the worktree: the status word and
        the age are short and bounded, while an untruncatable 10rem worktree
        beside a 3.5rem age floor could push the title out of a narrow palette
        entirely and give the list a horizontal scrollbar.
      */}
      <span aria-hidden="true" className="flex min-w-0 items-center gap-2 text-[11px] leading-none">
        {isDemand && (
          <span className={cn("shrink-0", ROW_TONE_CLASS[row.tone])}>{row.statusLabel}</span>
        )}
        {row.worktreeLabel !== null && (
          <span className="max-w-[8rem] truncate text-daintree-text/40">{row.worktreeLabel}</span>
        )}
        {/*
          Right-aligned, tabular, and given a floor width so "just now" and
          "2h 15m" start at the same x. Without that the ages sit at eight
          different offsets and "how long has this been stuck" goes back to
          being eight separate reads instead of one scan.
        */}
        {row.age !== null && (
          <span className="min-w-[3.5rem] shrink-0 text-right tabular-nums text-daintree-text/50">
            {row.age}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * `actionLabel` is null when nothing is listed, and the key hints go with it —
 * a footer offering "↵ Open" over a loading or empty list is chrome promising
 * a key that visibly does nothing.
 *
 * `onShowDemand` turns the demand sentence into the control it was already
 * implying. "2 agents need you" stated a fact the surface gave no way to act
 * on; as a button it isolates exactly the two agents it counted. Present only
 * when there is a demand to isolate, so the footer never grows a control that
 * would filter to nothing.
 */
function PilotFooter({
  actionLabel,
  summary,
  demandCount,
  onShowDemand,
}: {
  actionLabel: string | null;
  summary: string;
  demandCount: number;
  onShowDemand: () => void;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {actionLabel !== null && (
          <>
            <span>
              <kbd className={KBD_CLASS}>↵</kbd>
              <span className="ml-1.5">{actionLabel}</span>
            </span>
            <span className="text-daintree-text/50">
              <kbd className={KBD_CLASS}>↑↓</kbd>
              <span className="ml-1.5">Navigate</span>
            </span>
          </>
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

export function PilotView() {
  const isOpen = usePilotStore((s) => s.isOpen);
  const close = usePilotStore((s) => s.close);
  const collapsedIds = usePilotStore((s) => s.collapsedWorkspaceIds);
  const toggleCollapsed = usePilotStore((s) => s.toggleWorkspaceCollapsed);
  const snapshot = useFleetSnapshotStore((s) => s.snapshot);
  const projects = useProjectStore((s) => s.projects);
  const scratches = useScratchStore((s) => s.scratches);
  const pilotShortcut = useEffectiveCombo("pilot.toggle");

  useOverlayClaim("pilot", isOpen);

  const [query, setQuery] = useState("");
  /**
   * The state segment, held locally beside the query rather than in
   * `pilotStore`.
   *
   * Both are narrowing state for one opening of the dialog and both reset when
   * it closes. `collapsedWorkspaceIds` lives in the store because it is the
   * opposite thing — a durable preference about a project that should survive
   * closing — and a filter that persisted would reopen the surface already
   * hiding agents, with the reason two openings in the past.
   */
  const [bandFilter, setBandFilter] = useState<PilotBandFilter>("all");
  /**
   * Collapse overrides that apply only while the list is narrowed.
   *
   * Narrowing force-expands every matching group, so without a separate set the
   * header toggle would be a dead control: `aria-expanded` pinned open while the
   * click silently edited the persisted set, collapsing the group minutes later
   * when the query cleared.
   */
  const [narrowingCollapsed, setNarrowingCollapsed] = useState<readonly string[]>([]);
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
   * Position, pinned for as long as the dialog stays open.
   *
   * Ordering is derived from live agent state, so without this a run changing
   * state reorders the list under the cursor — the classic sort-thrash misclick,
   * and the one that matters most here because every row is a navigation target.
   * The ORDER is pinned; the rows keep updating in place, so a state glyph or
   * an age still moves the instant it changes.
   *
   * Held in state rather than a ref so every mutation is a declared input of the
   * memo below. A ref read during render is invisible to memoization and would
   * serve a stale order for a frame after reopening.
   */
  const [frozenOrder, setFrozenOrder] = useState<{
    groups: string[];
    rows: Map<string, string[]>;
  } | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setFrozenOrder(null);
      return;
    }
    // Pin on the FIRST non-empty fleet after opening, not on open itself: the
    // snapshot can still be null when the dialog mounts.
    if (liveGroups.length === 0) return;

    setFrozenOrder((prev) => {
      if (prev === null) {
        return {
          groups: liveGroups.map((g) => g.workspaceId),
          rows: new Map(liveGroups.map((g) => [g.workspaceId, g.rows.map((r) => r.run.runId)])),
        };
      }

      // Anything that appears while the dialog is open takes a permanent place
      // at the end, assigned once. Leaving new ids unranked would let them keep
      // sorting against each other on every snapshot — reintroducing exactly
      // the movement this exists to prevent, just among the newcomers.
      let changed = false;
      const groups = [...prev.groups];
      const seenGroups = new Set(groups);
      const rows = new Map(prev.rows);

      for (const group of liveGroups) {
        if (!seenGroups.has(group.workspaceId)) {
          groups.push(group.workspaceId);
          seenGroups.add(group.workspaceId);
          changed = true;
        }
        const known = rows.get(group.workspaceId);
        const next = known ? [...known] : [];
        const seenRows = new Set(next);
        for (const row of group.rows) {
          if (!seenRows.has(row.run.runId)) {
            next.push(row.run.runId);
            seenRows.add(row.run.runId);
            changed = true;
          }
        }
        if (!known || next.length !== known.length) rows.set(group.workspaceId, next);
      }

      // Returning the previous object when nothing moved is what stops this
      // effect from re-rendering itself on every snapshot.
      return changed ? { groups, rows } : prev;
    });
  }, [isOpen, liveGroups]);

  const stableGroups = useMemo(() => {
    if (!frozenOrder) return liveGroups;

    const groupIndex = new Map(frozenOrder.groups.map((id, i) => [id, i]));
    const ordered = [...liveGroups].sort((a, b) => {
      const ai = groupIndex.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      const bi = groupIndex.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

    return ordered.map((group) => {
      const rowOrder = frozenOrder.rows.get(group.workspaceId);
      if (!rowOrder) return group;
      const rowIndex = new Map(rowOrder.map((id, i) => [id, i]));
      return {
        ...group,
        rows: [...group.rows].sort((a, b) => {
          const ai = rowIndex.get(a.run.runId) ?? Number.MAX_SAFE_INTEGER;
          const bi = rowIndex.get(b.run.runId) ?? Number.MAX_SAFE_INTEGER;
          return ai - bi;
        }),
      };
    });
  }, [liveGroups, frozenOrder]);

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
  const queryGroups = useMemo(() => filterPilotGroups(stableGroups, query), [stableGroups, query]);

  const filterCounts = useMemo(() => countPilotBands(queryGroups), [queryGroups]);

  const visibleGroups = useMemo(
    () => filterPilotBands(queryGroups, bandFilter),
    [queryGroups, bandFilter]
  );

  /**
   * Either narrowing is in play, so a group holding a match must open itself.
   *
   * The filter has exactly the same claim on this as the query does: finding
   * the blocked agent you filtered for still collapsed behind a chevron is the
   * same "narrowing failing to do its job" the query path already solves.
   */
  const isNarrowing = query.trim().length > 0 || bandFilter !== "all";

  /**
   * The tree, in the shared model's shape.
   *
   * A project is structure, not content: its header is `navigable: false`, so
   * the arrow keys walk agents and never stop on a heading on the way past.
   * That kept the common case — compare what is working against what is waiting
   * — from costing an extra keystroke per project, and kept Enter from sitting
   * one mistake away from collapsing a group instead of opening the run.
   */
  const paletteGroups = useMemo<PaletteTreeGroupInput<PilotProjectGroup, PilotRow>[]>(
    () =>
      visibleGroups.map((group) => ({
        groupId: group.workspaceId,
        group,
        header: {
          rowId: `group:${group.workspaceId}`,
          // The runs container's id, which is what the disclosure button
          // `aria-controls`. Safe only because the header is not navigable, so
          // this id never reaches `aria-activedescendant`. Making headers
          // navigable here would first have to give the header element an id
          // of its own — pointing the active descendant at a role-less
          // container is the dangling reference #11071 was about.
          domId: groupDomId(group.workspaceId),
          navigable: false,
        },
        // A collapsed group that contains a match opens itself — making someone
        // click to reveal the thing they just narrowed to is the narrowing
        // failing to do its job.
        isCollapsed: isNarrowing
          ? narrowingCollapsed.includes(group.workspaceId)
          : collapsedIds.includes(group.workspaceId),
        items: group.rows.map((row) => ({
          rowId: row.run.runId,
          domId: runDomId(row.run.runId),
          navigable: true,
          item: row,
        })),
      })),
    [visibleGroups, isNarrowing, narrowingCollapsed, collapsedIds]
  );

  // The narrowing-scoped collapses belong to the query AND the filter that
  // produced them — a collapse made while looking at blocked agents has no
  // claim on the list once the segment changes. Closing drops them too, so a
  // reopen doesn't restore state from a fleet that has moved on. The selection
  // resets alongside, inside the navigation model.
  useEffect(() => {
    setNarrowingCollapsed([]);
  }, [query, bandFilter, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setBandFilter("all");
    }
  }, [isOpen]);

  const setGroupCollapsed = useCallback(
    (workspaceId: string, collapsed: boolean) => {
      if (isNarrowing) {
        setNarrowingCollapsed((ids) => {
          const has = ids.includes(workspaceId);
          if (collapsed === has) return ids;
          return collapsed ? [...ids, workspaceId] : ids.filter((id) => id !== workspaceId);
        });
      } else if (collapsedIds.includes(workspaceId) !== collapsed) {
        toggleCollapsed(workspaceId);
      }
    },
    [isNarrowing, collapsedIds, toggleCollapsed]
  );

  const activate = useCallback((row: NavigablePaletteTreeRow<PilotProjectGroup, PilotRow>) => {
    if (row.kind !== "item") return;
    void actionService.dispatch("pilot.openRun", {
      runId: row.item.run.runId,
      workspaceId: row.groupId,
    });
  }, []);

  /**
   * `shouldPreserveInputCaretKey` is true where a caret exists to protect, and
   * the list's structural keys stand down for it.
   *
   * Home/End/←/→ are structural keys, but they are also the search box's
   * editing keys, and the box owns focus by default. While the query is
   * non-empty they stay with the caret; an empty box has nothing to edit, so
   * they navigate. Search force-expands every matching group anyway, which is
   * where collapse would matter least.
   *
   * Deliberately keyed on the query alone and not on the band filter: an active
   * filter with an empty box still leaves nothing to edit, and handing the
   * caret keys over then would take collapse and expand away from a keyboard
   * user for no gain. The filter bar binds its own arrows, but only while it
   * physically holds focus, so the two never contend.
   */
  const navigation = usePaletteTreeNavigation<PilotProjectGroup, PilotRow>({
    groups: paletteGroups,
    isActive: isOpen,
    // Both narrowings scope the selection. Keyed on the query alone, the
    // highlight would survive on a row the filter had just removed.
    selectionScopeKey: `${query}|${bandFilter}`,
    onActivate: activate,
    onGroupCollapsedChange: setGroupCollapsed,
    shouldPreserveInputCaretKey: () => query.length > 0,
  });

  const { selectedRow, activeDescendantId, renderGroups } = navigation;

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
  const summary =
    status.kind === "loading" || status.kind === "unavailable"
      ? ""
      : needsYou > 0
        ? demandPhrase(needsYou)
        : review > 0
          ? bandPhrase("review", review)
          : live > 0
            ? `Nothing needs you · ${live} ${live === 1 ? "agent" : "agents"} working`
            : fleet.total > 0
              ? `Nothing needs you · ${agentCount(fleet.total)}`
              : "";

  // Every selectable row is an agent now, so the verb never changes.
  // Dropped while a filter segment holds focus: on a segment those keys drive
  // the filter, not the list, so the hints would be naming keys that do
  // something else.
  const actionLabel = selectedRow === null || isFilterFocused ? null : "Open";

  const hasTree = renderGroups.length > 0;
  // Stale counts as well as live: retained runs are real rows, so a query that
  // matches none of them is a true statement about the query rather than a claim
  // that the fleet is clear. `loading` and `unavailable` stay out — they already
  // render the skeleton and the can't-reach-host message.
  const showEmpty =
    (status.kind === "live" || status.kind === "stale") && renderGroups.length === 0;
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
    (status.kind === "live" || status.kind === "stale") && stableGroups.length > 0;

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={close} ariaLabel="All agents">
      <AppPaletteDialog.Header label="All agents" shortcut={pilotShortcut}>
        <AppPaletteDialog.Input
          inputRef={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={navigation.handleInputKeyDown}
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
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        className="p-0"
        ariaLabel="Agents"
        activeDescendant={activeDescendantId}
        onNavigationKeyDown={navigation.handleBodyKeyDown}
      >
        {showSkeleton && (
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

        {status.kind === "unavailable" && (
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

        {status.kind === "stale" && (
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

        {showEmpty && (
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
            emptyMessage="Start an agent in any project"
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
          resolves, even while loading or empty. No padding of its own: the
          palette body's scroller already carries `p-2`.
        */}
        <div
          id={LIST_ID}
          {...(hasTree ? { role: "listbox", "aria-label": "Agents by project" } : {})}
        >
          {renderGroups.map(({ header, items }, groupIndex) => (
            // `role="group"` is a permitted listbox child and carries the
            // project's name as the label for every option inside it, which
            // is how a screen reader still hears which project a run belongs
            // to now that the header itself is not an item.
            <div
              key={header.domId}
              role="group"
              aria-label={header.group.name}
              // The scroller spaces siblings equally, so after a long run list
              // the next project arrives with no more separation than one more
              // agent. Only between groups — a leading gap would push the list
              // off its own top edge.
              className={groupIndex > 0 ? "mt-2" : undefined}
            >
              <GroupHeader
                group={header.group}
                isCollapsed={header.isCollapsed}
                groupId={header.domId}
                onToggle={() => setGroupCollapsed(header.groupId, !header.isCollapsed)}
              />
              <div id={header.domId}>
                {items.map((row) => (
                  <RunRow
                    key={row.domId}
                    row={row.item}
                    isSelected={row.rowId === selectedRow?.rowId}
                    domId={row.domId}
                    onActivate={() => navigation.activateRow(row.rowId)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </AppPaletteDialog.Body>

      {/*
        An empty fleet has no row to act on and nothing to summarise, so both
        halves of the footer go quiet — and the bar collapses to a bare ruled
        strip under the empty state. Drop the whole footer instead of shipping a
        divider with nothing beneath it.
      */}
      {(actionLabel !== null || summary !== "") && (
        <AppPaletteDialog.Footer>
          <PilotFooter
            actionLabel={actionLabel}
            summary={summary}
            demandCount={needsYou}
            onShowDemand={() => {
              setBandFilter("needs-you");
              // Cleared explicitly, not left to the narrowing effect. With the
              // filter ALREADY on needs-you the state set is a no-op, the
              // effect never re-runs, and a group the user had collapsed stays
              // collapsed — leaving the button advertising agents it then
              // failed to put on screen.
              setNarrowingCollapsed([]);
            }}
          />
        </AppPaletteDialog.Footer>
      )}
    </AppPaletteDialog>
  );
}
