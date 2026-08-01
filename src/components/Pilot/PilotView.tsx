import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { actionService } from "@/services/ActionService";
import { countDemands } from "@/lib/fleetAttention";
import {
  buildPilotGroups,
  filterPilotGroups,
  type PilotProjectGroup,
  type PilotRow,
} from "./pilotRows";
import { PilotRunState, runStateLabel } from "./PilotRunState";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
// Leaf import, not the `@/hooks` barrel: palette suites routinely mock that
// barrel and throw on an export they don't list.
import { useOverlayClaim } from "@/hooks/useOverlayState";

/** Matches the project switcher, which this opens from and sits beside. */
const PALETTE_WIDTH = "w-[484px] max-w-[calc(100vw-2rem)]";
const TREE_ID = "pilot-tree";

/** Ages are minute-grained, so a 30s tick keeps them honest without churn. */
const AGE_TICK_MS = 30_000;

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
 * The accent bar is the region's single load-bearing signal: the search input
 * holds focus, so the bar is the only thing saying where the keyboard is.
 */
const ROW_BASE = cn(
  "relative flex w-full cursor-pointer items-center rounded-[var(--radius-md)] border border-transparent text-left transition-colors",
  "before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[2px] before:rounded-r before:bg-daintree-accent before:opacity-0 before:transition-opacity before:content-[''] aria-selected:before:opacity-100"
);

/** One phrasing of the demand, so the header chip and the footer can't disagree. */
function demandPhrase(count: number): string {
  return count === 1 ? "1 needs you" : `${count} need you`;
}

/** Only ever read aloud — the visible header renders the bare number. */
function agentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
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

function GroupHeader({
  group,
  isCollapsed,
  isSelected,
  domId,
  onActivate,
  onHover,
}: {
  group: PilotProjectGroup;
  isCollapsed: boolean;
  isSelected: boolean;
  domId: string;
  onActivate: () => void;
  onHover: () => void;
}) {
  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={1}
      aria-expanded={!isCollapsed}
      aria-selected={isSelected}
      // Pinned rather than computed from contents: the bare count and the
      // demand chip would otherwise read as "daintree 2 2 need you".
      aria-label={
        group.demandCount > 0
          ? `${group.name}, ${agentCount(group.rows.length)}, ${demandPhrase(group.demandCount)}`
          : `${group.name}, ${agentCount(group.rows.length)}`
      }
      data-testid="pilot-group-header"
      onClick={onActivate}
      onPointerMove={onHover}
      className={cn(ROW_BASE, rowTone(isSelected), "gap-2 py-1.5 pr-3 pl-2")}
    >
      {/*
        A span, not a button: `aria-expanded` on the row already exposes the
        disclosure, and a nested control would be a second tab stop inside a
        tree that navigates by active descendant.
      */}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-daintree-text/40 transition-transform duration-150 ease-out",
          !isCollapsed && "rotate-90"
        )}
      />

      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[11px] shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))]"
        style={{
          background: group.color
            ? `var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), ${getProjectGradient(group.color)}`
            : "var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), var(--color-daintree-sidebar)",
        }}
      >
        <span className="leading-none select-none">{group.emoji}</span>
      </span>

      <span className="min-w-0 truncate text-sm font-semibold text-daintree-text">
        {group.name}
      </span>
      {/*
        The total rides beside the name rather than the far edge: pushed right
        it sat against the demand chip, where "3 need you 3" reads as one
        garbled string instead of two separate facts.
      */}
      <span aria-hidden="true" className="shrink-0 text-[11px] tabular-nums text-daintree-text/40">
        {group.rows.length}
      </span>

      <span className="flex-1" />

      {group.demandCount > 0 && (
        <span aria-hidden="true" className="shrink-0 text-[11px] text-activity-waiting">
          {demandPhrase(group.demandCount)}
        </span>
      )}
    </div>
  );
}

function RunRow({
  row,
  isSelected,
  domId,
  onActivate,
  onHover,
}: {
  row: PilotRow;
  isSelected: boolean;
  domId: string;
  onActivate: () => void;
  onHover: () => void;
}) {
  const { run } = row;
  const subtitle = [row.worktreeLabel, row.agentLabel].filter(Boolean).join(" · ");

  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={2}
      aria-selected={isSelected}
      data-testid="pilot-row"
      onClick={onActivate}
      onPointerMove={onHover}
      // Indented to sit under the header's project tile — the chevron column
      // plus its gap, so the run rows read as belonging to the row above. The
      // min-height holds the list's rhythm even: a run whose worktree and agent
      // are both already implied by its title has no second line, and mixing
      // one- and two-line rows in one column reads as ragged.
      className={cn(ROW_BASE, rowTone(isSelected), "min-h-9 gap-2.5 py-1.5 pr-3 pl-7")}
    >
      <PilotRunState agentState={run.agentState} waitingReason={run.waitingReason} />
      <span className="sr-only">{runStateLabel(run.agentState, run.waitingReason)}</span>

      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm leading-tight",
            isSelected ? "text-daintree-text" : "text-daintree-text/85"
          )}
        >
          {row.title}
        </span>
        {subtitle && (
          <span className="mt-0.5 block truncate text-[11px] leading-none text-daintree-text/50">
            {subtitle}
          </span>
        )}
      </span>

      {row.age && (
        <span className="shrink-0 text-[11px] tabular-nums text-daintree-text/50">{row.age}</span>
      )}
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
   * when the query cleared. Scoping the toggle here keeps it honest — it acts on
   * what is on screen, and clearing the query discards it.
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
    const map = new Map<string, { name: string; emoji?: string; color?: string }>();
    for (const project of projects) {
      map.set(project.id, {
        name: project.name,
        ...(project.emoji ? { emoji: project.emoji } : {}),
        ...(project.color ? { color: project.color } : {}),
      });
    }
    for (const scratch of scratches) map.set(scratch.id, { name: scratch.name });
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
    return buildPilotGroups(snapshot.runs, { workspaces, agentNames, nowMs });
  }, [snapshot, workspaces, nowMs]);

  /**
   * Position, pinned for as long as the dialog stays open.
   *
   * Ordering is derived from live agent state, so without this a run changing
   * state reorders the list under the cursor — the classic sort-thrash misclick,
   * and the one that matters most here because every row is a navigation target.
   * The ORDER is pinned; the rows keep updating in place, so a state circle or
   * an age still moves the instant it changes.
   *
   * Held in state rather than a ref so every mutation — pinning, clearing on
   * close, appending — is a declared input of the memo below. A ref read during
   * render is invisible to memoization and would serve a stale order for a
   * frame after reopening.
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
  //
  // Keyed on the query VALUE rather than the input's onChange because Escape
  // also clears the box. Both routes happen to end in a keystroke today, so
  // this is not fixing a reachable bug — it just stops the invariant depending
  // on every future caller remembering to reset alongside `setQuery`.
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
      // Escape empties the box before it closes the palette, and it has to be
      // stopped HERE to do so. `AppPaletteDialog` closes from a document-bubble
      // backstop that also marks the event consumed, so the escape stack never
      // gets a turn — a `useEscapeStack` claim looks right and never runs.
      if (e.key === "Escape" && query !== "") {
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
        return;
      }
      handleNavigationKeyDown(e, query.length > 0);
    },
    [handleNavigationKeyDown, query]
  );

  const handleBodyKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => handleNavigationKeyDown(e, false),
    [handleNavigationKeyDown]
  );

  const demandCount = snapshot ? countDemands(snapshot.runs) : 0;
  const runCount = snapshot?.runs.length ?? 0;

  const summary =
    snapshot === null
      ? ""
      : demandCount > 0
        ? `${demandCount} ${demandCount === 1 ? "agent needs" : "agents need"} you`
        : runCount > 0
          ? `Nothing needs you · ${runCount} ${runCount === 1 ? "agent" : "agents"} running`
          : "";

  const actionLabel =
    selectedRow === undefined
      ? null
      : selectedRow.kind === "run"
        ? "Open"
        : selectedRow.isCollapsed
          ? "Expand"
          : "Collapse";

  const activeDescendant = selectedRow?.domId;
  const hasTree = snapshot !== null && navRows.length > 0;

  /**
   * Combobox semantics, but only while there is a popup to be a combobox for.
   *
   * Loading, empty-fleet and no-match all render no tree, and axe-core requires
   * BOTH `aria-expanded` and `aria-controls` on `role="combobox"` — so keeping
   * the role while dropping the dangling IDREF just trades one violation for
   * another. Standing the whole role down leaves an ordinary search box, which
   * is what it actually is when nothing is listed.
   */
  const comboboxProps = hasTree
    ? ({
        role: "combobox",
        "aria-expanded": true,
        "aria-haspopup": "tree",
        "aria-controls": TREE_ID,
        "aria-activedescendant": activeDescendant,
      } as const)
    : {};

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
          {...comboboxProps}
          data-testid="pilot-search"
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        maxHeight="max-h-[60vh]"
        className="p-0"
        ariaLabel="Agents"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleBodyKeyDown}
      >
        {snapshot === null ? (
          <Skeleton className="flex flex-col gap-2 p-4" data-testid="pilot-skeleton">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonBone key={i} className="h-8 w-full" />
            ))}
          </Skeleton>
        ) : !hasTree ? (
          /*
           * Deliberately quiet, and deliberately not a call to action. An empty
           * fleet here is overwhelmingly the completed-work state — everything
           * finished — which the empty-state rule says stays quiet rather than
           * nudging. Pilot also cannot start an agent: launching is per-project,
           * and this surface spans them all, so a CTA would name an action it
           * has no way to perform. The usual teaching gate (`hasEverLaunchedAgent`)
           * is no help either — it lives in a per-project-view store and would
           * answer only for whichever project happens to be active.
           */
          <AppPaletteDialog.Empty query={query} emptyMessage="No agents running">
            <p className="mt-2 text-xs text-daintree-text/40">
              Agents you start in any project show up here
            </p>
          </AppPaletteDialog.Empty>
        ) : (
          // No padding of its own: the palette body's scroller already carries
          // `p-2`, and a second layer here would inset every row twice.
          <div id={TREE_ID} role="tree" aria-label="Agents by project">
            {navRows.map((navRow, index) =>
              navRow.kind === "group" ? (
                <GroupHeader
                  key={navRow.domId}
                  group={navRow.group}
                  isCollapsed={navRow.isCollapsed}
                  isSelected={index === selectedIndex}
                  domId={navRow.domId}
                  onActivate={() => activate(navRow)}
                  onHover={() => setSelectedDomId(navRow.domId)}
                />
              ) : (
                <RunRow
                  key={navRow.domId}
                  row={navRow.row}
                  isSelected={index === selectedIndex}
                  domId={navRow.domId}
                  onActivate={() => activate(navRow)}
                  onHover={() => setSelectedDomId(navRow.domId)}
                />
              )
            )}
          </div>
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        <PilotFooter actionLabel={actionLabel} summary={summary} />
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
