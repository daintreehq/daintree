import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ArrowLeft, ChevronDown, Plus, X } from "lucide-react";
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
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { useFleetWorktreeScope } from "./useFleetWorktreeScope";
import { FleetWorktreeDots } from "./FleetWorktreeDots";
import { renderPaneStateBadge } from "./renderPaneStateBadge";
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";
import { FLEET_RIBBON_ICON_BUTTON_CLASS } from "./fleetRibbonStyles";

interface FleetCountChipProps {
  armedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FleetChipPopoverMode = "list" | "picker";

const EMPTY_WORKTREES: ReadonlyMap<string, { name: string }> = new Map();

export function FleetCountChip({
  armedCount,
  open,
  onOpenChange,
}: FleetCountChipProps): ReactElement {
  const armOrder = useFleetArmingStore((s) => s.armOrder);
  const disarmId = useFleetArmingStore((s) => s.disarmId);
  const addToFleet = useFleetArmingStore((s) => s.addToFleet);
  // Supervised-run submission failures per pane (#10930): the armed list is
  // the per-target drill-down surface, so a pane that rejected the last
  // broadcast write carries an inline "Send failed" marker next to its live
  // agent-state badge.
  const run = useFleetRunStore((s) => s.run);

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
      if (!usePanelStore.getState().panelsById[id]) return;
      usePanelStore.getState().setFocused(id);
      onOpenChange(false);
    },
    [onOpenChange]
  );

  const scope = useFleetWorktreeScope();
  const worktreeScopeText = scope.worktreeCount > 1 ? ` · ${scope.worktreeCount} worktrees` : "";
  const exitedAriaText = scope.exitedCount > 0 ? `, ${scope.exitedCount} exited` : "";
  const label = `${armedCount} in fleet${worktreeScopeText}${exitedAriaText}`;

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
          <span className="text-text-secondary">
            in fleet
            {scope.worktreeCount > 1 ? ` · ${scope.worktreeCount} worktrees` : ""}
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
        sideOffset={6}
        data-testid="fleet-armed-list"
        className={cn(
          "flex flex-col overflow-hidden p-1",
          popoverMode === "list" ? "max-h-[320px] w-[320px]" : "max-h-[420px] w-[380px]"
        )}
      >
        {popoverMode === "list" ? (
          <>
            <div className="px-2 py-1 text-3xs font-medium uppercase tracking-wide text-text-secondary">
              Fleet terminals
            </div>
            <ul className="flex flex-col overflow-y-auto">
              {armOrder.length === 0 ? (
                <li className="px-2 py-1 text-xs leading-[inherit] text-text-secondary">None</li>
              ) : (
                armOrder.map((id) => {
                  const title = titlesByPane[id] ?? id;
                  const sendFailed = run?.targets.some(
                    (t) => t.terminalId === id && t.submission === "failed"
                  );
                  const worktreeId = worktreeIdsByPane[id];
                  const dotColor = worktreeId && colorMap ? colorMap[worktreeId] : undefined;
                  const worktreeName = worktreeId ? worktrees.get(worktreeId)?.name : undefined;
                  return (
                    // Identity beyond the truncated title lives in the aria-label and
                    // the native title. A focus-driven unwrap was tried and rejected:
                    // Radix focuses the first row on open, so the row expanded every
                    // time, and blurring it mid-click moved "Add panes…" between
                    // mousedown and mouseup.
                    <li
                      key={id}
                      className="flex items-center gap-2 rounded-[var(--radius-md)] hover:bg-tint/[0.08]"
                    >
                      <button
                        type="button"
                        onClick={() => focusArmedPane(id)}
                        aria-label={
                          worktreeName ? `Focus ${title} in ${worktreeName}` : `Focus ${title}`
                        }
                        title={worktreeName ? `${title} · ${worktreeName}` : title}
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
                        <span className="truncate">{title}</span>
                        {id === focusedId && (
                          <span
                            className="shrink-0 text-3xs uppercase tracking-wide text-text-secondary"
                            data-testid={`fleet-row-primary-${id}`}
                          >
                            Primary
                          </span>
                        )}
                      </button>
                      {sendFailed && (
                        <span
                          className="shrink-0 text-3xs text-status-error"
                          data-testid={`fleet-row-send-failed-${id}`}
                        >
                          Send failed
                        </span>
                      )}
                      {renderPaneStateBadge(id, agentStatesByPane[id], waitingReasonsByPane[id])}
                      <button
                        type="button"
                        onClick={() => disarmId(id)}
                        aria-label={`Disarm ${title}`}
                        className={cn(FLEET_RIBBON_ICON_BUTTON_CLASS, "mr-0.5")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
            <button
              type="button"
              onClick={() => setPopoverMode("picker")}
              data-testid="fleet-armed-list-add-panes"
              className={cn(
                "mt-1 flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-xs leading-[inherit] text-text-secondary",
                "hover:bg-tint/[0.08] hover:text-text-primary",
                "border-t border-daintree-border/50 pt-2",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
              )}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Add panes…</span>
            </button>
          </>
        ) : picker.acquired ? (
          <>
            <div className="flex items-center gap-2 px-1 pb-1">
              <button
                type="button"
                onClick={() => setPopoverMode("list")}
                aria-label="Back to fleet list"
                data-testid="fleet-picker-back"
                className={cn(
                  "inline-flex items-center gap-1 rounded-[var(--radius-md)] px-1.5 py-1 text-xs leading-[inherit] text-text-secondary",
                  "hover:bg-tint/[0.08] hover:text-text-primary",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                )}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Back</span>
              </button>
              <span className="text-2xs font-medium uppercase tracking-wide text-text-secondary">
                Add panes
              </span>
            </div>
            <FleetPickerContent picker={picker} testIdPrefix="fleet-picker-add" autoFocusSearch />
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-daintree-border/50 px-1 pt-2">
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
                <button
                  type="button"
                  onClick={() => setPopoverMode("list")}
                  className={cn(
                    "rounded-[var(--radius-md)] px-2 py-1 text-2xs text-text-secondary",
                    "hover:bg-tint/[0.08] hover:text-text-primary",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  )}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={picker.handleConfirm}
                  disabled={picker.confirmedIds.length === 0}
                  data-testid="fleet-picker-add-confirm"
                  className={cn(
                    // Matches the cold-start picker's confirm: the house
                    // neutral high-contrast primary, not a category fill.
                    "rounded-sm bg-text-primary px-2 py-1 text-2xs text-text-inverse ring-1 ring-tint/15",
                    "transition-[background-color,opacity] duration-150 hover:bg-[color-mix(in_oklab,var(--color-text-primary)_90%,var(--color-text-inverse))]",
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  )}
                >
                  {picker.confirmedIds.length === 0 ? "Add" : `Add ${picker.confirmedIds.length}`}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
