import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { actionService } from "@/services/ActionService";
import { BAND_TONE, type FleetBand } from "@/lib/fleetAttention";
import { UI_ANIMATION_DURATION, UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { agoPhrase, formatWaitAge, ROW_TONE_CLASS } from "@/lib/projectRowStatus";
import {
  buildPilotGroups,
  filterPilotGroups,
  summarizePilotGroups,
  type PilotProjectGroup,
  type PilotRow,
  type PilotWorkspaceMeta,
} from "./pilotRows";
import { PilotRunState } from "./PilotRunState";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { CircleHelp, FileText } from "@/components/icons";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
// Leaf import, not the `@/hooks` barrel: palette suites routinely mock that
// barrel and throw on an export they don't list.
import { useOverlayClaim } from "@/hooks/useOverlayState";

/** Matches the project switcher, which this opens from and sits beside. */
const PALETTE_WIDTH = "w-[484px] max-w-[calc(100vw-2rem)]";
const PALETTE_MAX_HEIGHT = "max-h-[60vh]";
const TREE_ID = "pilot-tree";

/** Ages are minute-grained, so a 30s tick keeps them honest without churn. */
const AGE_TICK_MS = 30_000;
/** The loading rule's ">5s says something" threshold. */
const LOADING_HINT_MS = 5_000;

/**
 * The tree is flat in the DOM — every node is a sibling, depth carried by
 * `aria-level` — matching `FileTreeView`. The nested alternative puts each
 * group's children inside the group's own `treeitem`, where name-from-contents
 * folds the whole subtree into the header's accessible name.
 */
function groupDomId(workspaceId: string): string {
  return `pilot-option-group-${workspaceId}`;
}

function runDomId(runId: string): string {
  return `pilot-option-run-${runId}`;
}

/**
 * Selection styling, lifted verbatim from the switcher's rows so one palette
 * doesn't invent a second vocabulary for "this is the row Enter will act on".
 */
const ROW_BASE = cn(
  "relative flex w-full cursor-pointer items-center rounded-[var(--radius-md)] border border-transparent text-left transition-colors",
  "before:absolute before:top-2 before:bottom-2 before:left-0 before:w-[2px] before:rounded-r before:bg-daintree-accent before:opacity-0 before:transition-opacity before:content-[''] aria-selected:before:opacity-100"
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

function rowTone(isSelected: boolean): string {
  return isSelected
    ? "bg-overlay-raised border-overlay text-daintree-text"
    : "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text";
}

/**
 * A visible node of the tree, and simultaneously one step of the arrow-key
 * domain. Never re-filter this into a narrower array to render from: a second
 * list is how a highlight ends up addressing a row that isn't on screen
 * (the switcher's #11071).
 */
type PilotNavRow =
  | {
      kind: "group";
      domId: string;
      workspaceId: string;
      group: PilotProjectGroup;
      isCollapsed: boolean;
    }
  | { kind: "run"; domId: string; workspaceId: string; row: PilotRow };

const TILE_BASE =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-base";

/**
 * The workspace's identity tile, at the switcher's size and radius.
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
        <Glyph className="h-4 w-4" aria-hidden="true" />
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

function GroupHeader({
  group,
  isCollapsed,
  isSelected,
  domId,
  className,
  onActivate,
}: {
  group: PilotProjectGroup;
  isCollapsed: boolean;
  isSelected: boolean;
  domId: string;
  className?: string;
  onActivate: () => void;
}) {
  const summary = groupSummary(group);

  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={1}
      aria-expanded={!isCollapsed}
      aria-selected={isSelected}
      // Pinned rather than computed from contents, which would fold the
      // "Current" marker and the separator dots into one run-on string.
      aria-label={
        group.isCurrent
          ? `${group.name}, current workspace, ${summary}`
          : `${group.name}, ${summary}`
      }
      data-testid="pilot-group-header"
      onClick={onActivate}
      className={cn(ROW_BASE, rowTone(isSelected), "gap-2 py-2 pr-3 pl-3", className)}
    >
      {/*
        A span, not a button: `aria-expanded` on the row already exposes the
        disclosure, and a nested control would be a second tab stop inside a
        tree that navigates by active descendant.
      */}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-daintree-text/40 transition-transform ease-out motion-reduce:transition-none",
          !isCollapsed && "rotate-90"
        )}
        style={{ transitionDuration: `${UI_ANIMATION_DURATION}ms` }}
      />

      <WorkspaceTile group={group} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center">
          <span className="truncate text-sm leading-tight font-semibold text-daintree-text">
            {group.name}
          </span>
          {/*
            Which workspace you are already in decides whether opening a run is
            instant or swaps the whole view, so it is worth a word. Muted and
            textual — membership is never an accent signal.
          */}
          {group.isCurrent && (
            <span
              aria-hidden="true"
              className="ml-1.5 shrink-0 text-[11px] leading-none text-daintree-text/40"
            >
              Current
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center">
          <span
            aria-hidden="true"
            className={cn(
              "truncate text-[11px] leading-none",
              ROW_TONE_CLASS[BAND_TONE[group.topBand]]
            )}
          >
            {summary}
          </span>
        </div>
      </div>
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
  // State first, then how long it has been that way, then where it is running.
  // The age sat on the trailing edge before, where a bare "2h" beside a title
  // named no quantity — runtime, wait, and time-since-finish all read the same.
  const detail = [row.age, row.worktreeLabel, row.agentLabel].filter(Boolean).join(" · ");

  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={2}
      aria-selected={isSelected}
      data-testid="pilot-row"
      onClick={onActivate}
      // Deliberately the header's own column structure — same padding, a spacer
      // the width of its chevron, then a tile-width column — rather than a
      // hand-computed indent. Alignment then holds by construction: titles line
      // up with the project title above them, and stay lined up if either
      // column ever changes size.
      className={cn(ROW_BASE, rowTone(isSelected), "gap-2 py-1.5 pr-3 pl-3")}
    >
      <span aria-hidden="true" className="size-3.5 shrink-0" />
      {/*
        A tile-width column, not a flush glyph. Left flush, the 14px glyph
        stands in for the header's 32px tile and every run title starts LEFT of
        its own project's title — the child outdenting itself.
      */}
      <span className="flex w-8 shrink-0 items-center justify-center">
        <PilotRunState band={row.band} agentState={row.run.agentState} />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm leading-tight",
            isSelected ? "text-daintree-text" : "text-daintree-text/85"
          )}
        >
          {row.title}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-none">
          <span className={ROW_TONE_CLASS[row.tone]}>{row.statusLabel}</span>
          {detail && <span className="text-daintree-text/50">{` · ${detail}`}</span>}
        </span>
      </span>
    </div>
  );
}

/**
 * `actionLabel` is null when nothing is listed, and the key hints go with it —
 * a footer offering "↵ Open" over a loading or empty list is chrome promising
 * a key that visibly does nothing.
 */
function PilotFooter({ actionLabel, summary }: { actionLabel: string | null; summary: string }) {
  return (
    <div className="flex w-full items-center justify-between">
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
      {summary && <span className="truncate text-daintree-text/50">{summary}</span>}
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
   * Collapse overrides that apply only while a search is active.
   *
   * Searching force-expands every matching group, so without a separate set the
   * header toggle would be a dead control: `aria-expanded` pinned open while the
   * click silently edited the persisted set, collapsing the group minutes later
   * when the query cleared.
   */
  const [searchCollapsed, setSearchCollapsed] = useState<readonly string[]>([]);

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
    const agentNames = new Map<string, string>();
    for (const run of snapshot.runs) {
      if (run.agentId && !agentNames.has(run.agentId)) {
        agentNames.set(run.agentId, getAgentConfig(run.agentId)?.name ?? run.agentId);
      }
    }
    return buildPilotGroups(snapshot.runs, {
      workspaces,
      agentNames,
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

  const visibleGroups = useMemo(
    () => filterPilotGroups(stableGroups, query),
    [stableGroups, query]
  );

  const isSearching = query.trim().length > 0;

  const navRows = useMemo<PilotNavRow[]>(() => {
    const out: PilotNavRow[] = [];
    for (const group of visibleGroups) {
      // A collapsed group that contains a match opens itself — making someone
      // click to reveal the thing they just searched for is the search failing
      // to do its job.
      const isCollapsed = isSearching
        ? searchCollapsed.includes(group.workspaceId)
        : collapsedIds.includes(group.workspaceId);
      out.push({
        kind: "group",
        domId: groupDomId(group.workspaceId),
        workspaceId: group.workspaceId,
        group,
        isCollapsed,
      });
      if (isCollapsed) continue;
      for (const row of group.rows) {
        out.push({
          kind: "run",
          domId: runDomId(row.run.runId),
          workspaceId: group.workspaceId,
          row,
        });
      }
    }
    return out;
  }, [visibleGroups, isSearching, searchCollapsed, collapsedIds]);

  /**
   * The selected ROW is the state; its index is derived. Tracking an index
   * instead would let it outlive the row it pointed at — this list shrinks
   * under the open dialog whenever an agent exits or a group collapses, and the
   * index would then address a different row than the user selected, with Enter
   * committing that one (the switcher's #11071).
   */
  const [selectedDomId, setSelectedDomId] = useState<string | null>(null);
  /**
   * Where the highlight sits before anyone has moved it: the first RUN, not the
   * first row. Open-then-Enter should reach the most urgent agent — landing on
   * a project header would make that reflex collapse the group holding it.
   */
  const defaultIndex = useMemo(() => {
    const firstRun = navRows.findIndex((row) => row.kind === "run");
    return firstRun >= 0 ? firstRun : 0;
  }, [navRows]);
  const selectedIndex = useMemo(() => {
    if (navRows.length === 0) return -1;
    const index = selectedDomId ? navRows.findIndex((row) => row.domId === selectedDomId) : -1;
    return index >= 0 ? index : defaultIndex;
  }, [navRows, selectedDomId, defaultIndex]);
  const selectedRow = selectedIndex >= 0 ? navRows[selectedIndex] : undefined;

  // A new query re-ranks the list, so fall back to the top match, and the
  // search-scoped collapses belong to the query that produced them. Closing
  // drops both so a reopen doesn't restore state from a fleet that has moved on.
  useEffect(() => {
    setSelectedDomId(null);
    setSearchCollapsed([]);
  }, [query, isOpen]);

  useEffect(() => {
    if (!isOpen) setQuery("");
  }, [isOpen]);

  // Keyed on the id rather than the row object: the row is rebuilt on every
  // snapshot, and re-running this each tick would fight the user's own scroll.
  const selectedRowDomId = selectedRow?.domId;
  useEffect(() => {
    if (selectedRowDomId === undefined) return;
    document.getElementById(selectedRowDomId)?.scrollIntoView({ block: "nearest" });
  }, [selectedRowDomId]);

  const step = useCallback(
    (delta: number) => {
      if (navRows.length === 0) return;
      // Resolve the current row from the id inside the updater so two calls
      // batched into one tick compose instead of collapsing into one.
      setSelectedDomId((previousId) => {
        const current = previousId ? navRows.findIndex((row) => row.domId === previousId) : -1;
        const from = current >= 0 ? current : defaultIndex;
        const next = (from + delta + navRows.length) % navRows.length;
        return navRows[next]!.domId;
      });
    },
    [navRows, defaultIndex]
  );

  const setGroupCollapsed = useCallback(
    (workspaceId: string, collapsed: boolean) => {
      if (isSearching) {
        setSearchCollapsed((ids) => {
          const has = ids.includes(workspaceId);
          if (collapsed === has) return ids;
          return collapsed ? [...ids, workspaceId] : ids.filter((id) => id !== workspaceId);
        });
      } else if (collapsedIds.includes(workspaceId) !== collapsed) {
        toggleCollapsed(workspaceId);
      }
    },
    [isSearching, collapsedIds, toggleCollapsed]
  );

  const activate = useCallback(
    (row: PilotNavRow) => {
      // Selecting first is what keeps the highlight out of a group the very
      // next line is about to hide — a click on a header can arrive while the
      // selection sits on one of that header's runs.
      setSelectedDomId(row.domId);
      if (row.kind === "group") {
        setGroupCollapsed(row.workspaceId, !row.isCollapsed);
        return;
      }
      void actionService.dispatch("pilot.openRun", {
        runId: row.row.run.runId,
        workspaceId: row.workspaceId,
      });
    },
    [setGroupCollapsed]
  );

  /**
   * `allowCaretKeys` is true where a caret exists to protect, and the tree's
   * structural keys stand down for it.
   *
   * Home/End/←/→ are the tree's structural keys, but they are also the search
   * box's editing keys, and the box owns focus by default. While the query is
   * non-empty they stay with the caret; an empty box has nothing to edit, so
   * they navigate. Search force-expands every matching group anyway, which is
   * where collapse would matter least.
   */
  const handleNavigationKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>, allowCaretKeys: boolean) => {
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      // Nothing listed means nothing to navigate or open. Swallowing the key
      // anyway would leave the region eating Enter and the arrows during
      // loading and empty states, where the browser's own behaviour is the
      // only useful one left.
      if (navRows.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          consume();
          step(1);
          break;
        case "ArrowUp":
          consume();
          step(-1);
          break;
        case "Home":
          if (allowCaretKeys) break;
          consume();
          setSelectedDomId(navRows[0]!.domId);
          break;
        case "End":
          if (allowCaretKeys) break;
          consume();
          setSelectedDomId(navRows[navRows.length - 1]!.domId);
          break;
        case "ArrowRight": {
          if (allowCaretKeys || selectedRow?.kind !== "group") break;
          consume();
          if (selectedRow.isCollapsed) {
            setGroupCollapsed(selectedRow.workspaceId, false);
            break;
          }
          const child = navRows[selectedIndex + 1];
          if (child?.kind === "run") setSelectedDomId(child.domId);
          break;
        }
        case "ArrowLeft": {
          if (allowCaretKeys || !selectedRow) break;
          consume();
          if (selectedRow.kind === "run") {
            setSelectedDomId(groupDomId(selectedRow.workspaceId));
            break;
          }
          if (!selectedRow.isCollapsed) setGroupCollapsed(selectedRow.workspaceId, true);
          break;
        }
        case "Enter":
          consume();
          if (selectedRow) activate(selectedRow);
          break;
      }
    },
    [step, navRows, selectedRow, selectedIndex, setGroupCollapsed, activate]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      // Escape is deliberately NOT intercepted to clear the query first. The
      // project switcher — which opens this and sits beside it — closes on the
      // first Escape, and two adjacent palettes that hand off to each other
      // must not disagree about what the key does.
      handleNavigationKeyDown(e, query.length > 0);
    },
    [handleNavigationKeyDown, query]
  );

  const handleBodyKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => handleNavigationKeyDown(e, false),
    [handleNavigationKeyDown]
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

  const fleet = useMemo(() => summarizePilotGroups(stableGroups), [stableGroups]);

  // Counted by band, never off the raw row total: a fleet holding two working
  // agents and six exited ones is not "8 agents running".
  const live = fleet.bands.running;
  const summary =
    status.kind === "loading" || status.kind === "unavailable"
      ? ""
      : fleet.demand > 0
        ? demandPhrase(fleet.demand)
        : live > 0
          ? `Nothing needs you · ${live} ${live === 1 ? "agent" : "agents"} working`
          : fleet.total > 0
            ? `Nothing needs you · ${agentCount(fleet.total)}`
            : "";

  const actionLabel =
    selectedRow === undefined
      ? null
      : selectedRow.kind === "run"
        ? "Open"
        : selectedRow.isCollapsed
          ? "Expand"
          : "Collapse";

  const hasTree = navRows.length > 0;
  const showEmpty = status.kind === "live" && !hasTree;
  const showSkeleton = useDeferredLoading(status.kind === "loading", UI_DOHERTY_THRESHOLD);

  return (
    <AppPaletteDialog
      isOpen={isOpen}
      onClose={close}
      ariaLabel="All agents"
      className={PALETTE_WIDTH}
    >
      <AppPaletteDialog.Header label="All agents" shortcut={pilotShortcut} className="pb-2">
        <AppPaletteDialog.Input
          className="bg-overlay-soft border-[var(--border-overlay)]"
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
          aria-haspopup="tree"
          aria-controls={TREE_ID}
          aria-activedescendant={selectedRow?.domId}
          data-testid="pilot-search"
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        maxHeight={PALETTE_MAX_HEIGHT}
        className="p-0"
        ariaLabel="Agents"
        activeDescendant={selectedRow?.domId}
        onNavigationKeyDown={handleBodyKeyDown}
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
              {/* Shaped like what is coming: a group header, then its runs. */}
              <SkeletonBone className="h-12 w-full" />
              <SkeletonBone className="h-10 w-full" />
              <SkeletonBone className="h-10 w-full" />
              <SkeletonBone className="h-12 w-full" />
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
           * No button — launching is per-project and this surface spans them
           * all, so a CTA here would name an action it cannot perform. The
           * sentence is the affordance.
           */
          <AppPaletteDialog.Empty query={query} emptyMessage="Start an agent in any project" />
        )}

        {/*
          Always mounted so `aria-controls` on the combobox above always
          resolves, even while loading or empty. No padding of its own: the
          palette body's scroller already carries `p-2`.
        */}
        <div id={TREE_ID} {...(hasTree ? { role: "tree", "aria-label": "Agents by project" } : {})}>
          {navRows.map((navRow, index) =>
            navRow.kind === "group" ? (
              <GroupHeader
                key={navRow.domId}
                group={navRow.group}
                isCollapsed={navRow.isCollapsed}
                isSelected={index === selectedIndex}
                domId={navRow.domId}
                // The scroller spaces every flat-tree sibling equally, so after
                // a long run list the next project header arrives with no more
                // separation than one more run. Only between groups — a leading
                // gap would just push the list off its own top edge.
                className={index > 0 ? "mt-2" : undefined}
                onActivate={() => activate(navRow)}
              />
            ) : (
              <RunRow
                key={navRow.domId}
                row={navRow.row}
                isSelected={index === selectedIndex}
                domId={navRow.domId}
                onActivate={() => activate(navRow)}
              />
            )
          )}
        </div>
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        <PilotFooter actionLabel={actionLabel} summary={summary} />
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
