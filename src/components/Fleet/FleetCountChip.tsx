import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ArrowLeft, Plus, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useEscapeStack } from "@/hooks";
import { useFleetPicker } from "@/hooks/useFleetPicker";
import { FleetPickerContent } from "@/components/Fleet/FleetPickerContent";
import type { AgentState } from "@/types";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { useFleetWorktreeScope } from "./useFleetWorktreeScope";
import { FleetWorktreeDots } from "./FleetWorktreeDots";
import { renderPaneStateBadge } from "./renderPaneStateBadge";

interface FleetCountChipProps {
  armedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FleetChipPopoverMode = "list" | "picker";

export function FleetCountChip({
  armedCount,
  open,
  onOpenChange,
}: FleetCountChipProps): ReactElement {
  const armOrder = useFleetArmingStore((s) => s.armOrder);
  const disarmId = useFleetArmingStore((s) => s.disarmId);
  const addToFleet = useFleetArmingStore((s) => s.addToFleet);

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
        out[id] = state.panelsById[id]?.agentState;
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
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] transition-colors",
            "bg-tint/[0.08] hover:bg-tint/[0.14]"
          )}
        >
          <FleetWorktreeDots scope={scope} />
          <AnimatedLabel
            label={String(armedCount)}
            textClassName="font-semibold tabular-nums text-daintree-text"
          />
          <span className="text-daintree-text/70">
            in fleet
            {scope.worktreeCount > 1 ? ` · ${scope.worktreeCount} worktrees` : ""}
          </span>
          {scope.exitedCount > 0 ? (
            <span className="text-daintree-text/40 tabular-nums" data-testid="fleet-exited-count">
              · {scope.exitedCount} exited
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        data-testid="fleet-armed-list"
        className={cn(
          "flex flex-col overflow-hidden p-1",
          popoverMode === "list" ? "max-h-[320px] w-[260px]" : "max-h-[420px] w-[340px]"
        )}
      >
        {popoverMode === "list" ? (
          <>
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-daintree-text/50">
              Fleet terminals
            </div>
            <ul className="flex flex-col overflow-y-auto">
              {armOrder.length === 0 ? (
                <li className="px-2 py-1 text-[12px] text-daintree-text/60">None</li>
              ) : (
                armOrder.map((id) => {
                  const title = titlesByPane[id] ?? id;
                  return (
                    <li key={id} className="flex items-center gap-2 rounded hover:bg-tint/[0.08]">
                      <button
                        type="button"
                        onClick={() => focusArmedPane(id)}
                        aria-label={`Focus ${title}`}
                        className="flex-1 truncate px-2 py-1 text-left text-[12px] text-daintree-text"
                      >
                        {title}
                      </button>
                      {renderPaneStateBadge(id, agentStatesByPane[id])}
                      <button
                        type="button"
                        onClick={() => disarmId(id)}
                        aria-label={`Unarm ${title}`}
                        className="inline-flex shrink-0 items-center rounded p-0.5 mr-1 text-daintree-text/50 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
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
                "mt-1 flex items-center gap-2 rounded px-2 py-1.5 text-[12px] text-daintree-text/80",
                "hover:bg-tint/[0.08] hover:text-daintree-text",
                "border-t border-daintree-border/50 pt-2",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
                  "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-daintree-text/70",
                  "hover:bg-tint/[0.08] hover:text-daintree-text",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                )}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Back</span>
              </button>
              <span className="text-[11px] font-medium uppercase tracking-wide text-daintree-text/50">
                Add panes
              </span>
            </div>
            <FleetPickerContent picker={picker} testIdPrefix="fleet-picker-add" autoFocusSearch />
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-daintree-border/50 px-1 pt-2">
              <span className="text-[11px] tabular-nums text-daintree-text/55">
                {picker.confirmedIds.length === 0
                  ? "Select panes to add"
                  : `${picker.confirmedIds.length} selected`}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPopoverMode("list")}
                  className={cn(
                    "rounded px-2 py-1 text-[11px] text-daintree-text/70",
                    "hover:bg-tint/[0.08] hover:text-daintree-text",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
                    "rounded border border-category-amber-border bg-category-amber-subtle px-2 py-1 text-[11px] text-category-amber-text transition",
                    "hover:brightness-110",
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
