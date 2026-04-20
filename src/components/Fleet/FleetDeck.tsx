import { useCallback, useMemo, type ReactElement } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore, collectEligibleIds } from "@/store/fleetArmingStore";
import { useFleetDeckStore, type FleetDeckStateFilter } from "@/store/fleetDeckStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { matchesDeckFilter, DECK_FILTER_ORDER, DECK_FILTER_LABELS } from "@/utils/agentStateFilter";
import { ClusterAttentionPill } from "./ClusterAttentionPill";
import { FleetComposer } from "./FleetComposer";
import { FleetScopeBar } from "./FleetScopeBar";
import { FleetDeckRow } from "./FleetDeckRow";

const FLEET_DECK_WIDTH = 340;

interface WorktreeGroup {
  worktreeId: string | null;
  worktreeName: string | null;
  ids: string[];
}

export function FleetDeck(): ReactElement | null {
  const { isOpen, stateFilter, close, setStateFilter } = useFleetDeckStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      stateFilter: s.stateFilter,
      close: s.close,
      setStateFilter: s.setStateFilter,
    }))
  );
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const armIds = useFleetArmingStore((s) => s.armIds);
  const clearArmed = useFleetArmingStore((s) => s.clear);
  const panelsById = usePanelStore((s) => s.panelsById);
  // panelIds also drives eligibleIds (appearance order) — subscribe so that
  // reorders (which mutate panelIds without touching panelsById) trigger a
  // re-render.
  const panelIds = usePanelStore((s) => s.panelIds);
  const worktrees = useWorktreeStore((s) => s.worktrees);

  const eligibleIds = useMemo(() => {
    // collectEligibleIds reads panelsById and panelIds from usePanelStore
    // directly. Referencing both here ensures the memo re-runs whenever
    // either mutates.
    void panelsById;
    void panelIds;
    return collectEligibleIds("all", null);
  }, [panelsById, panelIds]);

  const filteredIds = useMemo(() => {
    if (stateFilter === "all") return eligibleIds;
    return eligibleIds.filter((id) => {
      const t = panelsById[id];
      return matchesDeckFilter(t?.agentState, stateFilter);
    });
  }, [eligibleIds, stateFilter, panelsById]);

  const groups = useMemo<WorktreeGroup[]>(() => {
    const out: WorktreeGroup[] = [];
    const byId = new Map<string, WorktreeGroup>();
    for (const id of filteredIds) {
      const panel = panelsById[id];
      const wtId = panel?.worktreeId ?? null;
      const key = wtId ?? "__none__";
      let group = byId.get(key);
      if (!group) {
        const wtName = wtId ? (worktrees.get(wtId)?.name ?? wtId) : null;
        group = { worktreeId: wtId, worktreeName: wtName, ids: [] };
        byId.set(key, group);
        out.push(group);
      }
      group.ids.push(id);
    }
    return out;
  }, [filteredIds, panelsById, worktrees]);

  // Grouped render order: shift-click range must reuse this list, not
  // `filteredIds`, so the anchor/target indices match what the user sees.
  // Otherwise panels from interleaved worktrees can arm non-visible rows.
  const renderOrderIds = useMemo(() => groups.flatMap((g) => g.ids), [groups]);

  const handleArmFiltered = useCallback(() => {
    if (filteredIds.length === 0) return;
    armIds(filteredIds);
  }, [armIds, filteredIds]);

  if (!isOpen) return null;

  return (
    <div
      role="region"
      aria-label="Fleet Deck"
      data-testid="fleet-deck"
      className={cn(
        "absolute top-0 bottom-0 right-0 z-40 flex flex-col h-full",
        "bg-daintree-bg shadow-2xl border-l border-daintree-border"
      )}
      style={{ width: FLEET_DECK_WIDTH }}
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-daintree-border">
        <span className="text-[13px] font-medium text-daintree-text">Fleet Deck</span>
        <span
          className="rounded-full bg-tint/[0.08] px-2 py-0.5 text-[11px] text-daintree-text/70"
          data-testid="fleet-deck-count"
        >
          {filteredIds.length} of {eligibleIds.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={close}
            aria-label="Close Fleet Deck"
            className="rounded p-1 text-daintree-text/60 hover:bg-tint/[0.08] hover:text-daintree-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="px-3 pt-1">
        <ClusterAttentionPill />
      </div>

      <div className="px-3 py-1">
        <FleetScopeBar />
      </div>

      <nav
        aria-label="Fleet Deck filters"
        className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-daintree-border"
      >
        <div role="toolbar" aria-label="State filter" className="flex items-center gap-1">
          {DECK_FILTER_ORDER.map((filter) => {
            const active = filter === stateFilter;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setStateFilter(filter as FleetDeckStateFilter)}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                  active
                    ? "bg-daintree-accent/20 text-daintree-text"
                    : "bg-tint/[0.06] text-daintree-text/70 hover:bg-tint/[0.12] hover:text-daintree-text"
                )}
                aria-pressed={active}
                data-testid={`fleet-deck-filter-${filter}`}
              >
                {DECK_FILTER_LABELS[filter as FleetDeckStateFilter]}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1 text-[11px]">
          <button
            type="button"
            onClick={handleArmFiltered}
            disabled={filteredIds.length === 0}
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              filteredIds.length === 0
                ? "cursor-not-allowed text-daintree-text/30"
                : "bg-tint/[0.08] text-daintree-text/80 hover:bg-tint/[0.16] hover:text-daintree-text"
            )}
          >
            Arm visible
          </button>
          <button
            type="button"
            onClick={clearArmed}
            disabled={armedIds.size === 0}
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              armedIds.size === 0
                ? "cursor-not-allowed text-daintree-text/30"
                : "bg-tint/[0.08] text-daintree-text/80 hover:bg-tint/[0.16] hover:text-daintree-text"
            )}
          >
            Disarm all
          </button>
        </div>
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto py-1" data-testid="fleet-deck-list">
        {filteredIds.length === 0 ? (
          <div
            role="status"
            className="flex h-full items-center justify-center px-3 text-[12px] text-daintree-text/60"
          >
            No agents match the current filter.
          </div>
        ) : (
          groups.map((group) => (
            <div
              key={group.worktreeId ?? "__none__"}
              data-testid="fleet-deck-group"
              data-worktree-id={group.worktreeId ?? undefined}
              className="mb-1"
            >
              {group.worktreeName !== null && (
                <div
                  className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-daintree-text/50"
                  data-testid="fleet-deck-group-header"
                >
                  {group.worktreeName}
                </div>
              )}
              <div className="px-1">
                {group.ids.map((id) => (
                  <FleetDeckRow
                    key={id}
                    panelId={id}
                    filteredIds={renderOrderIds}
                    worktreeName={group.worktreeName}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <footer className="border-t border-daintree-border">
        <FleetComposer />
      </footer>
    </div>
  );
}
