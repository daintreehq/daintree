import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { CrossHostFleetTarget } from "@/store/fleetArmingStore";
import { XCircle, ArrowLeft, ChevronDown, Lock, Plus, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useEscapeStack, useWorktreeColorMap } from "@/hooks";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { useFleetPicker } from "@/hooks/useFleetPicker";
import { FleetPickerContent } from "@/components/Fleet/FleetPickerContent";
import type { AgentState } from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetRunStore } from "@/store/fleetRunStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { fleetBandForRun, type FleetBand } from "@/lib/fleetAttention";
import { usePanelStore } from "@/store/panelStore";
import { exitProjectHome } from "@/store/storeAccessors";
import { isGridPanelLocation, isPtyPanel } from "@shared/types/panel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { useFleetWorktreeScope } from "./useFleetWorktreeScope";
import { FleetWorktreeDots } from "./FleetWorktreeDots";
import { renderPaneStateBadge } from "./renderPaneStateBadge";
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";
import { Badge } from "@/components/ui/badge";
import {
  POPOVER_HEADER_CLASS,
  POPOVER_ROW_HOVER_CLASS,
  POPOVER_TITLE_CLASS,
} from "@/components/ui/popoverHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { pluralize } from "@/lib/pluralize";
import { RemoteAgentMark } from "./RemoteAgentMark";
import { shortTerminalId } from "./crossHostFleet";

interface FleetCountChipProps {
  armedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FleetChipPopoverMode = "list" | "picker";

const EMPTY_WORKTREES: ReadonlyMap<string, { name: string }> = new Map();

/** Section label inside the member list. Normal case: host names are typed by the person. */
const GROUP_LABEL_CLASS = "truncate px-2 pt-2 pb-0.5 text-2xs font-medium text-text-secondary";

interface HostGroup {
  hostId: string;
  hostName: string;
  targets: CrossHostFleetTarget[];
}

function groupByHost(targets: readonly CrossHostFleetTarget[]): HostGroup[] {
  const groups = new Map<string, HostGroup>();
  for (const target of targets) {
    const group = groups.get(target.hostId);
    if (group) group.targets.push(target);
    else
      groups.set(target.hostId, {
        hostId: target.hostId,
        hostName: target.hostName,
        targets: [target],
      });
  }
  return [...groups.values()];
}

/**
 * Where the fleet's members are, for the chip beside the composer: up to two
 * places by name, so a message's destination stays in view while it is typed.
 */
function describeHostScope(localCount: number, remoteHosts: readonly string[]): string {
  if (remoteHosts.length === 0) return "";
  const places = localCount > 0 ? ["this window", ...remoteHosts] : [...remoteHosts];
  return places.length <= 2 ? places.join(", ") : pluralize(places.length, "host");
}

export function FleetCountChip({
  armedCount,
  open,
  onOpenChange,
}: FleetCountChipProps): ReactElement {
  const armOrder = useFleetArmingStore((s) => s.armOrder);
  const crossHostTargets = useFleetArmingStore((s) => s.crossHostTargets);
  const disarmId = useFleetArmingStore((s) => s.disarmId);
  const addToFleet = useFleetArmingStore((s) => s.addToFleet);
  // Supervised-run submission failures per pane (#10930): the armed list is
  // the per-target drill-down surface, so a pane that rejected the last
  // broadcast write carries an inline "Send failed" marker next to its live
  // agent-state badge.
  const run = useFleetRunStore((s) => s.run);
  const headingId = useId();

  // Internal mode toggle for the popover content. "list" shows the armed
  // terminals (default). "picker" swaps to FleetPickerContent for adding new
  // panes — single Radix layer, no nested popovers, so z-index and
  // dismissable-layer behavior stay clean (verified against z-popover/z-modal
  // ordering in src/index.css).
  const [popoverMode, setPopoverMode] = useState<FleetChipPopoverMode>("list");

  // Reset to "list" whenever the popover closes — opening it again should
  // always start at the armed list, never reopen mid-picker.
  useEffect(() => {
    if (!open) setPopoverMode("list");
  }, [open]);

  // Esc stack ordering (LIFO, last-registered fires first):
  //   1. FleetPickerContent's `useEscapeStack(query !== "", clearSearch)` —
  //      first Esc clears a non-empty query.
  //   2. This hook — second Esc returns to list mode.
  //   3. The ribbon-level `useEscapeStack(popoverOpen, ...)` — third Esc
  //      closes the popover.
  useEscapeStack(open && popoverMode === "picker", () => setPopoverMode("list"));

  const handlePickerCommit = useCallback(
    (selected: string[]) => {
      addToFleet(selected);
      setPopoverMode("list");
    },
    [addToFleet]
  );

  const picker = useFleetPicker({
    isOpen: open && popoverMode === "picker",
    mode: "add",
    onCommit: handlePickerCommit,
    owner: "ribbon-add",
  });
  // Two separate primitive-valued selectors keeps useShallow happy. A single
  // selector returning Record<string, {title, agentState}> would create new
  // inner object identities per call and trigger an infinite re-render loop
  // because useShallow only compares one level deep.
  const titlesByPane = usePanelStore(
    useShallow((state) => {
      const out: Record<string, string> = {};
      for (const id of armOrder) {
        const t = state.panelsById[id];
        if (t) out[id] = t.title;
      }
      return out;
    })
  );
  const agentStatesByPane = usePanelStore(
    useShallow((state) => {
      const out: Record<string, AgentState | undefined> = {};
      for (const id of armOrder) {
        const p = state.panelsById[id];
        out[id] = p && isPtyPanel(p) ? p.agentState : undefined;
      }
      return out;
    })
  );
  // Worktree per armed pane, so the inventory can carry the same colour dot
  // the chip summarises — a truncated title alone does not say which tree a
  // pane belongs to.
  const worktreeIdsByPane = usePanelStore(
    useShallow((state) => {
      const out: Record<string, string | undefined> = {};
      for (const id of armOrder) {
        out[id] = state.panelsById[id]?.worktreeId;
      }
      return out;
    })
  );
  // A locked pane stays armed but gets nothing a broadcast sends (#14964), so
  // its row says why it's being left out.
  const inputLockedByPane = usePanelStore(
    useShallow((state) => {
      const out: Record<string, boolean> = {};
      for (const id of armOrder) {
        const p = state.panelsById[id];
        out[id] = !!p && isPtyPanel(p) && p.isInputLocked === true;
      }
      return out;
    })
  );
  const colorMap = useWorktreeColorMap();
  const worktrees = useWorktreeStoreOptional((state) => state.worktrees, EMPTY_WORKTREES);
  const focusedId = usePanelStore((state) => state.focusedId);
  const waitingReasonsByPane = usePanelStore(
    useShallow((state) => {
      const out: Record<string, WaitingReason | undefined> = {};
      for (const id of armOrder) {
        const p = state.panelsById[id];
        out[id] = p && isPtyPanel(p) ? p.waitingReason : undefined;
      }
      return out;
    })
  );
  // Each armed pane's fleet band, which alone decides whether its badge wears
  // the waiting hue. Primitive values, so a fleet push that moves no armed
  // pane's band doesn't re-render the inventory.
  const bandsByPane = useFleetSnapshotStore(
    useShallow((state) => {
      const out: Record<string, FleetBand | undefined> = {};
      for (const id of armOrder) out[id] = fleetBandForRun(state.snapshot, id);
      return out;
    })
  );

  // Scale-bump the chip on every count change. AnimatedLabel handles the
  // text crossfade; this adds a subtle "tick" to the chip itself so the
  // membership change registers peripherally. Skips first mount to avoid
  // a phantom bump when the ribbon first renders.
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const lastCountRef = useRef(armedCount);
  const bumpClearRef = useRef<number | null>(null);
  useEffect(() => {
    if (armedCount === lastCountRef.current) return;
    lastCountRef.current = armedCount;
    const node = chipRef.current;
    if (!node) return;
    if (bumpClearRef.current !== null) {
      window.clearTimeout(bumpClearRef.current);
    }
    node.classList.remove("animate-badge-bump");
    void node.offsetWidth;
    node.classList.add("animate-badge-bump");
    bumpClearRef.current = window.setTimeout(() => {
      node.classList.remove("animate-badge-bump");
      bumpClearRef.current = null;
    }, 240);
    return () => {
      if (bumpClearRef.current !== null) {
        window.clearTimeout(bumpClearRef.current);
        bumpClearRef.current = null;
      }
    };
  }, [armedCount]);

  // Click a row → focus that pane (mouse path to "set primary"). Existing
  // terminal-nav chords (⌘⌥Arrow, Ctrl+Tab, ⌘1-9) cover the keyboard path
  // since focus already promotes any armed pane to primary. Closes the
  // popover; the focus change triggers HybridInputBar's primary→follower
  // mirror direction reversal automatically.
  const focusArmedPane = useCallback(
    (id: string) => {
      const panel = usePanelStore.getState().panelsById[id];
      if (!panel) return;
      // A grid pane is hidden while the project's Home shows.
      if (isGridPanelLocation(panel.location)) exitProjectHome();
      usePanelStore.getState().setFocused(id);
      onOpenChange(false);
    },
    [onOpenChange]
  );

  const scope = useFleetWorktreeScope();
  const hostGroups = groupByHost(crossHostTargets);
  const hostScope = describeHostScope(
    armOrder.length,
    hostGroups.map((group) => group.hostName)
  );
  const worktreeScopeText = scope.worktreeCount > 1 ? ` · ${scope.worktreeCount} worktrees` : "";
  const hostScopeText = hostScope ? ` · ${hostScope}` : "";
  const exitedAriaText = scope.exitedCount > 0 ? `, ${scope.exitedCount} exited` : "";
  const label = `${armedCount} in fleet${worktreeScopeText}${hostScopeText}${exitedAriaText}`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={chipRef}
          type="button"
          aria-label={`${label} — show list`}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="fleet-armed-count-chip"
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs leading-[inherit] transition-colors",
            "bg-tint/[0.08] hover:bg-tint/[0.14] data-[state=open]:bg-tint/[0.14]"
          )}
        >
          <AnimatedLabel
            label={String(armedCount)}
            textClassName="font-semibold tabular-nums text-text-primary"
          />
          {/* One run of text with the place in it, so the separator keeps the
              sentence's spacing rather than the chip's gap. */}
          <span className="flex min-w-0 text-text-secondary">
            in fleet
            {scope.worktreeCount > 1 ? ` · ${scope.worktreeCount} worktrees` : ""}
            {hostScope && (
              <span className="max-w-40 truncate" data-testid="fleet-host-scope">
                {`\u00a0· ${hostScope}`}
              </span>
            )}
          </span>
          <FleetWorktreeDots scope={scope} />
          {scope.exitedCount > 0 ? (
            <span className="text-text-secondary tabular-nums" data-testid="fleet-exited-count">
              · {scope.exitedCount} exited
            </span>
          ) : null}
          <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        data-testid="fleet-armed-list"
        aria-labelledby={headingId}
        className={cn(
          "flex flex-col overflow-hidden p-1",
          popoverMode === "list" ? "max-h-[320px] w-[320px]" : "max-h-[420px] w-[380px]"
        )}
      >
        {popoverMode === "list" ? (
          <>
            {/* -mx-1 -mt-1: the strip spans the popover's own p-1 inset, edge to edge. */}
            <div className={cn(POPOVER_HEADER_CLASS, "-mx-1 -mt-1 mb-1 shrink-0")}>
              <span id={headingId} className={POPOVER_TITLE_CLASS}>
                Fleet terminals
              </span>
            </div>
            <ul className="flex flex-col overflow-y-auto">
              {armOrder.length === 0 && crossHostTargets.length === 0 ? (
                <li>
                  <EmptyState
                    variant="zero-data"
                    scale="popover"
                    title="Add panes to the fleet"
                    className="py-4"
                  />
                </li>
              ) : (
                <>
                  {hostGroups.length > 0 && armOrder.length > 0 && (
                    <li aria-hidden="true" className={GROUP_LABEL_CLASS}>
                      This window
                    </li>
                  )}
                  {armOrder.map((id) => {
                    const title = titlesByPane[id] ?? id;
                    const sendFailed = run?.targets.some(
                      (t) => t.terminalId === id && t.submission === "failed"
                    );
                    const worktreeId = worktreeIdsByPane[id];
                    const dotColor = worktreeId && colorMap ? colorMap[worktreeId] : undefined;
                    const worktreeName = worktreeId ? worktrees.get(worktreeId)?.name : undefined;
                    return (
                      // Identity beyond the truncated title lives in the aria-label and
                      // a tooltip on the title text — a span, so it opens for the
                      // pointer only; on the button it would open on the focus
                      // Radix hands the first row. A focus-driven unwrap was tried and rejected:
                      // Radix focuses the first row on open, so the row expanded every
                      // time, and blurring it mid-click moved "Add panes…" between
                      // mousedown and mouseup.
                      <li
                        key={id}
                        className={cn(
                          "flex items-center gap-2 rounded-[var(--radius-md)]",
                          POPOVER_ROW_HOVER_CLASS
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => focusArmedPane(id)}
                          aria-label={[
                            `Focus ${title}`,
                            worktreeName ? `in ${worktreeName}` : null,
                            id === focusedId ? "(primary)" : null,
                            inputLockedByPane[id] ? "(input locked, left out of broadcasts)" : null,
                          ]
                            .filter((part) => part !== null)
                            .join(" ")}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-xs leading-[inherit] text-text-primary",
                            PALETTE_ROW_FOCUS_CLASS
                          )}
                        >
                          {dotColor && (
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: dotColor }}
                            />
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="truncate">{title}</span>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              {worktreeName ? `${title} · ${worktreeName}` : title}
                            </TooltipContent>
                          </Tooltip>
                          {id === focusedId && (
                            <Badge size="xs" data-testid={`fleet-row-primary-${id}`}>
                              Primary
                            </Badge>
                          )}
                        </button>
                        {sendFailed && (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 text-3xs font-medium text-text-primary"
                            data-testid={`fleet-row-send-failed-${id}`}
                          >
                            <XCircle className="h-3 w-3 text-status-error" aria-hidden="true" />
                            Send failed
                          </span>
                        )}
                        {inputLockedByPane[id] && (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 text-3xs font-medium text-text-secondary"
                            data-testid={`fleet-row-input-locked-${id}`}
                          >
                            <Lock className="h-3 w-3" aria-hidden="true" />
                            Input locked
                          </span>
                        )}
                        {renderPaneStateBadge(
                          id,
                          agentStatesByPane[id],
                          waitingReasonsByPane[id],
                          bandsByPane[id]
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => disarmId(id)}
                          aria-label={`Disarm ${title}`}
                          // Ringed inside: the list scrolls and clips anything outside it.
                          className="mr-0.5 shrink-0 [&_svg]:size-3.5 focus-visible:-outline-offset-2"
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </li>
                    );
                  })}
                </>
              )}
              {hostGroups.map((group) => (
                // Another host's agents, under that host: none has a pane here to
                // focus, so a row names its agent and lets it leave the fleet.
                <li key={group.hostId}>
                  <div id={`${headingId}-${group.hostId}`} className={GROUP_LABEL_CLASS}>
                    {group.hostName}
                  </div>
                  <ul aria-labelledby={`${headingId}-${group.hostId}`} className="flex flex-col">
                    {group.targets.map((target) => {
                      const twin = group.targets.some(
                        (other) =>
                          other.key !== target.key &&
                          other.title === target.title &&
                          (other.projectName ?? null) === (target.projectName ?? null)
                      );
                      const twinId = twin ? shortTerminalId(target.terminalId) : null;
                      const detail = [target.projectName, twinId].filter(Boolean).join(" · ");
                      const sendFailed = run?.targets.some(
                        (t) => t.terminalId === target.key && t.submission === "failed"
                      );
                      return (
                        <li
                          key={target.key}
                          className={cn(
                            "flex items-center gap-2 rounded-[var(--radius-md)]",
                            POPOVER_ROW_HOVER_CLASS
                          )}
                          data-testid={`fleet-row-host-${target.key}`}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-xs leading-[inherit] text-text-primary">
                            <RemoteAgentMark agentId={target.agentId} />
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="min-w-0 flex-1 truncate">{target.title}</span>
                              </TooltipTrigger>
                              <TooltipContent side="right">
                                {[target.title, detail, target.hostName]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </TooltipContent>
                            </Tooltip>
                            {/* Never truncated: it is what tells two same-named agents apart. */}
                            {twinId && (
                              <span className="shrink-0 font-mono text-2xs text-text-secondary">
                                {twinId}
                              </span>
                            )}
                            {target.projectName && (
                              <span className="min-w-0 max-w-[45%] shrink truncate text-2xs text-text-secondary">
                                {target.projectName}
                              </span>
                            )}
                          </span>
                          {sendFailed && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-3xs font-medium text-text-primary">
                              <XCircle className="h-3 w-3 text-status-error" aria-hidden="true" />
                              Send failed
                            </span>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => disarmId(target.key)}
                            aria-label={`Disarm ${target.title}${detail ? ` (${detail})` : ""} on ${target.hostName}`}
                            // Ringed inside: the list scrolls and clips anything outside it.
                            className="mr-0.5 shrink-0 [&_svg]:size-3.5 focus-visible:-outline-offset-2"
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="mt-1 border-t border-divider pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPopoverMode("picker")}
                data-testid="fleet-armed-list-add-panes"
                className="w-full justify-start gap-2 px-2 focus-visible:-outline-offset-2"
              >
                <Plus aria-hidden="true" />
                <span>Add panes…</span>
              </Button>
            </div>
          </>
        ) : picker.acquired ? (
          <>
            <div
              className={cn(POPOVER_HEADER_CLASS, "-mx-1 -mt-1 mb-1 shrink-0 justify-start pl-1.5")}
            >
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setPopoverMode("list")}
                aria-label="Back to fleet list"
                data-testid="fleet-picker-back"
                className="-my-1 px-1.5 text-xs [&_svg]:size-3.5"
              >
                <ArrowLeft aria-hidden="true" />
                <span>Back</span>
              </Button>
              <span id={headingId} className={POPOVER_TITLE_CLASS}>
                Add panes
              </span>
            </div>
            <FleetPickerContent picker={picker} testIdPrefix="fleet-picker-add" autoFocusSearch />
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-divider px-1 pt-2">
              <span className="text-2xs tabular-nums text-text-secondary">
                {picker.confirmedIds.length === 0
                  ? "Select panes to add"
                  : `${picker.confirmedIds.length} selected${
                      picker.hiddenSelectedCount > 0
                        ? ` · ${picker.hiddenSelectedCount} hidden by search`
                        : ""
                    }`}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setPopoverMode("list")}
                  className="px-2 text-2xs"
                >
                  Cancel
                </Button>
                {/* Matches the cold-start picker's confirm: the house neutral
                    high-contrast primary, not a category fill. */}
                <Button
                  variant="contrast"
                  size="xs"
                  onClick={picker.handleConfirm}
                  disabled={picker.confirmedIds.length === 0}
                  data-testid="fleet-picker-add-confirm"
                  className="px-2 text-2xs"
                >
                  {picker.confirmedIds.length === 0 ? "Add" : `Add ${picker.confirmedIds.length}`}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
