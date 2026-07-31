import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Radar } from "@/components/icons";
import { cn } from "@/lib/utils";
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
import { AppDialog } from "@/components/ui/AppDialog";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";

/** Ages are minute-grained, so a 30s tick keeps them honest without churn. */
const AGE_TICK_MS = 30_000;

function RunRow({ row }: { row: PilotRow }) {
  const { run } = row;

  return (
    <button
      type="button"
      data-testid="pilot-row"
      onClick={() => {
        void actionService.dispatch("pilot.openRun", {
          runId: run.runId,
          workspaceId: run.workspaceId,
        });
      }}
      className="flex w-full items-center gap-3 rounded-[var(--radius-md)] py-1.5 pr-2 pl-7 text-left transition-colors duration-150 ease-out hover:bg-overlay-subtle"
    >
      <PilotRunState agentState={run.agentState} waitingReason={run.waitingReason} />
      <span className="sr-only">{runStateLabel(run.agentState, run.waitingReason)}</span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-daintree-text">{row.title}</span>
        {(row.worktreeLabel || row.agentLabel) && (
          <span className="block truncate text-xs text-daintree-text/50">
            {[row.worktreeLabel, row.agentLabel].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>

      <span className="shrink-0 text-xs tabular-nums text-daintree-text/50">{row.age ?? ""}</span>
    </button>
  );
}

function ProjectGroup({
  group,
  isCollapsed,
  onToggle,
}: {
  group: PilotProjectGroup;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const listId = `pilot-group-${group.workspaceId}`;

  return (
    <section data-testid="pilot-project-group">
      {/*
        The whole header is the toggle, not just the chevron — a 16px hit target
        for the primary structural control of the list fails every hit-size
        guideline. Disclosure pattern: aria-expanded + aria-controls.
      */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        aria-controls={listId}
        data-testid="pilot-group-header"
        className="flex w-full items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-left transition-colors duration-150 ease-out hover:bg-overlay-subtle"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-daintree-text/40 transition-transform duration-150 ease-out",
            !isCollapsed && "rotate-90"
          )}
        />
        {group.emoji && (
          <span aria-hidden="true" className="text-sm">
            {group.emoji}
          </span>
        )}
        <span className="truncate text-sm font-medium text-daintree-text/90">{group.name}</span>
        <span className="shrink-0 text-xs tabular-nums text-daintree-text/40">
          {group.rows.length}
        </span>
        {group.demandCount > 0 && (
          <span className="shrink-0 text-xs text-state-waiting">{group.demandCount} need you</span>
        )}
      </button>

      {!isCollapsed && (
        <div id={listId} role="group" aria-label={group.name} className="flex flex-col">
          {group.rows.map((row) => (
            <RunRow key={row.run.runId} row={row} />
          ))}
        </div>
      )}
    </section>
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
    const map = new Map<string, { name: string; emoji?: string }>();
    for (const project of projects) {
      map.set(project.id, {
        name: project.name,
        ...(project.emoji ? { emoji: project.emoji } : {}),
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
   * Position is frozen for as long as the dialog stays open.
   *
   * Ordering is derived from live agent state, so without this a run changing
   * state reorders the list under the cursor — the classic sort-thrash misclick,
   * and the one that matters most here because every row is a navigation target.
   * The ORDER is pinned on open; the rows themselves keep updating in place, so
   * a state circle or an age still moves the instant it changes. A run that
   * appears while the dialog is open is appended to its project rather than
   * sorted into it, for the same reason.
   */
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

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={close}
      size="lg"
      // Content-hugging between bounds rather than a fixed frame: Spotlight,
      // Alfred, Raycast, Linear and Slack all shrink to fit a short list and cap
      // at a max, and a half-empty 500px frame reads as broken. The floor keeps
      // a one-agent fleet looking deliberate. Height snaps — never animate it
      // while someone is typing in the field above.
      maxHeight="max-h-[min(32rem,80vh)]"
      className="min-h-[16rem]"
      data-testid="pilot-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Radar className="size-4" aria-hidden="true" />}>
          All agents
        </AppDialog.Title>
        {summary && <p className="mt-0.5 text-xs text-daintree-text/50">{summary}</p>}
      </AppDialog.Header>

      <div className="shrink-0 border-b border-daintree-border px-4 pb-3">
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-transparent bg-overlay-subtle px-2.5 py-1.5 transition-colors duration-150 ease-out focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent">
          <Search className="size-3.5 shrink-0 text-daintree-text/40" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchCollapsed([]);
            }}
            placeholder="Search agents"
            aria-label="Search agents by title"
            data-testid="pilot-search"
            className="min-w-0 flex-1 bg-transparent text-sm text-daintree-text placeholder:text-daintree-text/40 focus:outline-hidden"
          />
        </div>
      </div>

      <AppDialog.BodyScroll className="p-2">
        {snapshot === null ? (
          <Skeleton className="flex flex-col gap-2 p-2" data-testid="pilot-skeleton">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonBone key={i} className="h-9 w-full" />
            ))}
          </Skeleton>
        ) : visibleGroups.length === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-1 px-6 py-10 text-center"
            data-testid="pilot-empty"
          >
            <p className="text-sm text-daintree-text/70">
              {isSearching ? "No agents match your search" : "No agents running"}
            </p>
            <p className="text-xs text-daintree-text/50">
              {isSearching
                ? "Try a different title, worktree or project"
                : "Agents you start in any project show up here"}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleGroups.map((group) => (
              <ProjectGroup
                key={group.workspaceId}
                group={group}
                // A collapsed group that contains a match opens itself — making
                // someone click to reveal the thing they just searched for is
                // the search failing to do its job.
                isCollapsed={
                  isSearching
                    ? searchCollapsed.includes(group.workspaceId)
                    : collapsedIds.includes(group.workspaceId)
                }
                onToggle={() => {
                  if (isSearching) {
                    setSearchCollapsed((ids) =>
                      ids.includes(group.workspaceId)
                        ? ids.filter((id) => id !== group.workspaceId)
                        : [...ids, group.workspaceId]
                    );
                    return;
                  }
                  toggleCollapsed(group.workspaceId);
                }}
              />
            ))}
          </div>
        )}
      </AppDialog.BodyScroll>
    </AppDialog>
  );
}
