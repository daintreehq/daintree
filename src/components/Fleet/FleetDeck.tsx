import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type MouseEvent,
  type KeyboardEvent,
} from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore, collectEligibleIds } from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import {
  useFleetDeckStore,
  FLEET_DECK_MIN_WIDTH,
  FLEET_DECK_MAX_WIDTH,
  FLEET_DECK_LIVE_TILE_CAP,
  type FleetDeckScope,
  type FleetDeckStateFilter,
} from "@/store/fleetDeckStore";
import { computeLiveSlotIds } from "@/utils/fleetDeckLiveSlots";
import { matchesDeckFilter, DECK_FILTER_ORDER, DECK_FILTER_LABELS } from "@/utils/agentStateFilter";
import { ClusterAttentionPill } from "./ClusterAttentionPill";
import { FleetComposer } from "./FleetComposer";
import { FleetScopeBar } from "./FleetScopeBar";
import { MirrorTile } from "./MirrorTile";

interface ScopeOption {
  value: FleetDeckScope;
  label: string;
}

const SCOPE_OPTIONS: ScopeOption[] = [
  { value: "current", label: "Current worktree" },
  { value: "all", label: "All worktrees" },
];

const RESIZE_KEYBOARD_STEP = 16;

export function FleetDeck(): ReactElement | null {
  const {
    isOpen,
    width,
    edge,
    scope,
    stateFilter,
    pinnedLiveIds,
    close,
    setWidth,
    setScope,
    setStateFilter,
    prunePins,
  } = useFleetDeckStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      width: s.width,
      edge: s.edge,
      scope: s.scope,
      stateFilter: s.stateFilter,
      pinnedLiveIds: s.pinnedLiveIds,
      close: s.close,
      setWidth: s.setWidth,
      setScope: s.setScope,
      setStateFilter: s.setStateFilter,
      prunePins: s.prunePins,
    }))
  );
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const armAll = useFleetArmingStore((s) => s.armAll);
  const clearArmed = useFleetArmingStore((s) => s.clear);
  const panelsById = usePanelStore((s) => s.panelsById);
  // panelIds also drives eligibleIds (appearance order) — subscribe so that
  // reorders (which mutate panelIds without touching panelsById) trigger a
  // re-render.
  const panelIds = usePanelStore((s) => s.panelIds);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId ?? null);

  const [isResizing, setIsResizing] = useState(false);
  const snapshotsRef = useRef<Map<string, string>>(new Map());
  // Mirror into state so JSX doesn't read the ref during render (React Compiler).
  // The ref remains the live accumulator; state snapshots it for render.
  const [snapshots, setSnapshots] = useState<Map<string, string>>(() => new Map());

  const eligibleIds = useMemo(() => {
    // collectEligibleIds reads panelsById and panelIds from usePanelStore
    // directly. Referencing both here ensures the memo re-runs whenever
    // either mutates (panelsById on agent state updates, panelIds on
    // reorder/add/remove).
    void panelsById;
    void panelIds;
    return collectEligibleIds(scope, activeWorktreeId);
  }, [scope, activeWorktreeId, panelsById, panelIds]);

  const filteredIds = useMemo(() => {
    if (stateFilter === "all") return eligibleIds;
    return eligibleIds.filter((id) => {
      const t = panelsById[id];
      return matchesDeckFilter(t?.agentState, stateFilter);
    });
  }, [eligibleIds, stateFilter, panelsById]);

  const liveIds = useMemo(() => {
    return computeLiveSlotIds(
      filteredIds,
      armedIds,
      pinnedLiveIds,
      panelsById,
      FLEET_DECK_LIVE_TILE_CAP
    );
  }, [filteredIds, armedIds, pinnedLiveIds, panelsById]);

  const liveIdSet = useMemo(() => new Set(liveIds), [liveIds]);

  // Prune pinned ids whose terminals have disappeared (trashed/killed) so the
  // pin count never represents stale panels. Also evict stale snapshot
  // entries so the session-lifetime Map doesn't accumulate for terminals
  // the user has killed.
  useEffect(() => {
    const validIds = new Set<string>(eligibleIds);
    if (pinnedLiveIds.size > 0) {
      for (const id of pinnedLiveIds) {
        if (!validIds.has(id)) {
          prunePins(validIds);
          break;
        }
      }
    }
    if (snapshotsRef.current.size > 0) {
      let changed = false;
      for (const id of Array.from(snapshotsRef.current.keys())) {
        if (!validIds.has(id)) {
          snapshotsRef.current.delete(id);
          changed = true;
        }
      }
      if (changed) setSnapshots(new Map(snapshotsRef.current));
    }
  }, [eligibleIds, pinnedLiveIds, prunePins]);

  const handleCaptureSnapshot = useCallback((id: string, snapshot: string) => {
    snapshotsRef.current.set(id, snapshot);
    setSnapshots(new Map(snapshotsRef.current));
  }, []);

  const handleArmFiltered = useCallback(() => {
    if (filteredIds.length === 0) return;
    if (filteredIds.length === eligibleIds.length) {
      armAll(scope);
      return;
    }
    useFleetArmingStore.getState().armIds(filteredIds);
  }, [armAll, filteredIds, eligibleIds.length, scope]);

  const handleResizeMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsResizing(true);
      const startX = event.clientX;
      const startWidth = width;

      const handleMove = (e: globalThis.MouseEvent) => {
        const delta = edge === "left" ? e.clientX - startX : startX - e.clientX;
        setWidth(startWidth + delta);
      };

      const handleUp = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [edge, setWidth, width]
  );

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Arrow keys grow/shrink the deck — semantics mirror PortalDock.
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setWidth(width + (edge === "left" ? -RESIZE_KEYBOARD_STEP : RESIZE_KEYBOARD_STEP));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setWidth(width + (edge === "left" ? RESIZE_KEYBOARD_STEP : -RESIZE_KEYBOARD_STEP));
      }
    },
    [edge, setWidth, width]
  );

  useEffect(() => {
    return () => {
      setIsResizing(false);
    };
  }, []);

  if (!isOpen) return null;

  const dockSide = edge === "left" ? "left-0 border-r" : "right-0 border-l";
  const resizeHandleSide = edge === "left" ? "-right-1.5" : "-left-1.5";

  return (
    <div
      role="region"
      aria-label="Fleet Deck"
      data-testid="fleet-deck"
      data-edge={edge}
      className={cn(
        "absolute top-0 bottom-0 z-40 flex flex-col h-full bg-daintree-bg shadow-2xl border-daintree-border",
        dockSide
      )}
      style={{ width }}
    >
      <div
        role="separator"
        aria-label="Resize Fleet Deck"
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        aria-valuemin={FLEET_DECK_MIN_WIDTH}
        aria-valuemax={FLEET_DECK_MAX_WIDTH}
        tabIndex={0}
        className={cn(
          "group absolute top-0 bottom-0 w-3 cursor-col-resize flex items-center justify-center z-50",
          "hover:bg-overlay-soft transition-colors focus:outline-none focus:bg-tint/[0.04] focus:ring-1 focus:ring-daintree-accent/50",
          resizeHandleSide,
          isResizing && "bg-daintree-accent/20"
        )}
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
      >
        <div
          className={cn(
            "w-px h-8 rounded-full transition-[width] duration-150 delay-100 group-hover:w-0.5",
            "bg-daintree-text/20",
            "group-hover:bg-daintree-text/35 group-focus:bg-daintree-accent",
            isResizing && "bg-daintree-accent"
          )}
        />
      </div>

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
        aria-label="Fleet Deck scope and filters"
        className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-daintree-border"
      >
        <div role="tablist" aria-label="Scope" className="inline-flex rounded-md bg-tint/[0.06]">
          {SCOPE_OPTIONS.map((opt) => {
            const active = opt.value === scope;
            return (
              <button
                key={opt.value}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setScope(opt.value)}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] transition-colors",
                  active
                    ? "bg-daintree-accent/20 text-daintree-text"
                    : "text-daintree-text/70 hover:text-daintree-text"
                )}
                data-testid={`fleet-deck-scope-${opt.value}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

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

      <div className="flex-1 min-h-0 overflow-y-auto p-3" data-testid="fleet-deck-grid-scroll">
        {filteredIds.length === 0 ? (
          <div
            role="status"
            className="flex h-full items-center justify-center text-[12px] text-daintree-text/60"
          >
            No agents match the current scope and filter.
          </div>
        ) : (
          <div
            data-testid="fleet-deck-grid"
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
          >
            {filteredIds.map((id) => (
              <MirrorTile
                key={id}
                terminalId={id}
                isLive={liveIdSet.has(id)}
                initialSnapshot={snapshots.get(id)}
                onCaptureSnapshot={handleCaptureSnapshot}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-daintree-border">
        <FleetComposer />
      </footer>
    </div>
  );
}
