import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from "react";
import { m } from "framer-motion";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { FleetPickerContent, FleetPickerFooterHint } from "@/components/Fleet/FleetPickerContent";
import { useFleetPicker } from "@/hooks/useFleetPicker";
import { useUiMotionTransition } from "@/hooks/useShouldSkipMotion";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { ACTIVE_AGENT_STATES } from "@shared/types/agent";

type CommitMode = "replace" | "append";

const COMMIT_MODES: { mode: CommitMode; label: string }[] = [
  { mode: "replace", label: "Replace" },
  { mode: "append", label: "Append" },
];

export interface FleetPickerPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Cold-start fleet picker — the centered palette that opens from the sidebar
 * Zap button when the user wants to arm terminals as a fleet.
 *
 * Mounts `FleetPickerContent` inside `AppPaletteDialog` so the picker inherits
 * the canonical centered/scrimmed/aria-modal palette tier-fast animation
 * (~150ms enter / ~100ms exit). Cold-start mode: pre-selects active-worktree
 * eligibles. A footer segmented control lets the user choose between replace
 * (`armIds`, default) and append (`addToFleet`) semantics per session. The
 * palette is mounted persistently by its parent (only `isOpen` toggles), so
 * `commitMode` is explicitly reset to `"replace"` whenever the palette closes
 * — relying on unmount-driven reset would silently retain Append across opens.
 * The hook's `mode` prop is kept frozen at `"cold-start"` regardless of the
 * toggle, because changing it would re-fire the pre-selection effect and wipe
 * the user's picks.
 */
export function FleetPickerPalette({ isOpen, onClose }: FleetPickerPaletteProps): ReactElement {
  const armIds = useFleetArmingStore((s) => s.armIds);
  const addToFleet = useFleetArmingStore((s) => s.addToFleet);
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const [commitMode, setCommitMode] = useState<CommitMode>("replace");
  const thumbLayoutId = `${useId()}-segmented-thumb`;
  const uiMotionTransition = useUiMotionTransition();
  // Closing resets the mode to Replace while the palette is still fading out, which
  // would otherwise slide the thumb back across a disappearing dialog.
  const thumbTransition = isOpen ? uiMotionTransition : { ...uiMotionTransition, duration: 0 };

  useEffect(() => {
    if (!isOpen) setCommitMode("replace");
  }, [isOpen]);

  const handleCommit = useCallback(
    (selected: string[]) => {
      if (commitMode === "append") {
        addToFleet(selected);
      } else {
        armIds(selected);
      }
      onClose();
    },
    [armIds, addToFleet, commitMode, onClose]
  );

  const picker = useFleetPicker({
    isOpen,
    mode: "cold-start",
    onCommit: handleCommit,
    owner: "cold-start",
  });

  // In Append mode the hook stays frozen in `cold-start`, so already-armed
  // terminals remain selectable — and `addToFleet` silently skips them. "Add 3"
  // could therefore add one. Count only what would actually be new.
  const appendCount = useMemo(
    () => picker.confirmedIds.filter((id) => !armedIds.has(id)).length,
    [picker.confirmedIds, armedIds]
  );

  const allVisibleSelected = useMemo(
    () =>
      picker.visibleIds.length > 0 && picker.visibleIds.every((id) => picker.selectedIds.has(id)),
    [picker.visibleIds, picker.selectedIds]
  );

  // Scope is `agentState`-only — terminals are picked by their reported
  // agent state (working/waiting/directing). No capability-id gate, so a
  // terminal whose `agentState` is set but whose registered agent has gone
  // away is still eligible to be armed (arming broadcasts keystrokes, not
  // agent commands — the surface is acceptable).
  const agentVisibleIds = useMemo(
    () =>
      picker.visibleTerminals
        .filter((t) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState))
        .map((t) => t.id),
    [picker.visibleTerminals]
  );

  const hasQuery = picker.query.trim() !== "";
  // One label per action, fixed. This was a single button whose text cycled
  // through four different strings ("Select all" / "Deselect all" /
  // "Select all visible" / "Deselect visible"), each a different width, which
  // reflowed its neighbour every time the selection changed — and meant the
  // same control reversed its own meaning under the pointer. Scope is stated
  // by the label when a filter is narrowing the target set.
  const selectLabel = hasQuery ? "Select all visible" : "Select all";
  const canSelect = picker.visibleIds.length > 0 && !allVisibleSelected;
  const canClear = picker.selectedIds.size > 0;

  // Select → replace visible (matches Cmd+A in useFleetPicker).
  // Deselect when filtered → scoped removal so picks for filtered-out
  // terminals survive. Deselect when unfiltered → full clear, otherwise
  // drifted (transiently-ineligible) ids would sneak back into the
  // selection after re-eligibility, contradicting the "Deselect all" label.
  // Union, never replace — a pick the filter is hiding stays picked, because
  // it is still going to be armed on commit.
  const handleSelectAllVisible = useCallback(() => {
    picker.setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of picker.visibleIds) next.add(id);
      return next;
    });
  }, [picker]);

  // Clears everything, including picks outside the current filter. That is the
  // point of a separate control: the scoped-removal behaviour the old toggle
  // had was invisible, and "clear" that leaves things selected is a trap.
  const handleClearSelection = useCallback(() => {
    picker.setSelectedIds(new Set());
  }, [picker]);

  // Additive — preserves existing picks (including non-agent terminals).
  const handleSelectAgents = useCallback(() => {
    if (agentVisibleIds.length === 0) return;
    picker.setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of agentVisibleIds) next.add(id);
      return next;
    });
  }, [agentVisibleIds, picker]);

  // Bulk-selection helpers live in the list's search section, not the commit
  // footer — they act on the list, and the footer is reserved for commit
  // controls (mode toggle + Cancel + Arm). Passed to `FleetPickerContent` as a
  // slot so the layer-agnostic component stays unaware of palette concerns.
  const helperClass = cn(
    "rounded-sm px-2.5 py-1 text-xs leading-[inherit] text-text-secondary",
    "hover:bg-tint/[0.08] hover:text-text-primary transition-colors duration-150",
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
  );

  // Confirmed, not raw selected: an id that drifted out of eligibility while
  // the picker was open is not going to be armed, and counting it produced
  // "3 of 2 selected" against a button that armed two. The drift notice in the
  // hint strip is what reports the difference.
  const selectedCount = picker.confirmedIds.length;
  const hiddenSelected = picker.hiddenSelectedCount;

  const selectionHelpers = (
    <div className="flex items-center justify-between gap-2 pt-2">
      <div role="group" aria-label="Selection helpers" className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleSelectAllVisible}
          disabled={!canSelect}
          data-testid="fleet-picker-cold-start-select-all"
          className={helperClass}
        >
          {selectLabel}
        </button>
        <button
          type="button"
          onClick={handleSelectAgents}
          disabled={agentVisibleIds.length === 0}
          data-testid="fleet-picker-cold-start-select-agents"
          className={helperClass}
        >
          Select agents
        </button>
        <button
          type="button"
          onClick={handleClearSelection}
          disabled={!canClear}
          data-testid="fleet-picker-cold-start-clear-selection"
          className={helperClass}
        >
          Clear
        </button>
      </div>
      {/*
        The running total, where the convention puts it. Until now the ONLY
        statement of how many terminals were selected was the commit button —
        and when a filter hid a pick, the button promised to arm a terminal the
        user could neither see nor name. Say how many are hidden.
      */}
      <span
        className="shrink-0 text-2xs tabular-nums text-text-secondary"
        data-testid="fleet-picker-cold-start-selection-summary"
      >
        {selectedCount} of {picker.eligibleCount} selected
        {hiddenSelected > 0 ? ` · ${hiddenSelected} hidden by search` : ""}
      </span>
    </div>
  );

  // `FleetPickerFooterHint` collapses to nothing when the list is empty and
  // nothing has drifted — skip the bordered strip entirely in that case so
  // there's no empty bar between the list and the footer.
  // The hint strip used to vanish whenever the list was empty, so the dialog
  // dropped a whole band and the footer jumped up the screen mid-typing.
  // Chrome that comes and goes is worse than chrome that stays.
  const hasVisibleRows = picker.visibleTerminals.length > 0;

  return (
    <AppPaletteDialog
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel="Select terminals to arm"
      tier="command"
    >
      <div className="flex flex-col">
        <div
          className={cn(
            "flex items-center gap-2 px-4 py-3 border-b border-border-default",
            "text-text-primary"
          )}
        >
          <Zap className="h-4 w-4 text-text-secondary" aria-hidden="true" />
          <h2 className="text-sm leading-[inherit] font-semibold">Select terminals to arm</h2>
        </div>

        {picker.acquired ? (
          <>
            <div className="max-h-[60vh] flex flex-col">
              <FleetPickerContent
                picker={picker}
                testIdPrefix="fleet-picker-cold-start"
                autoFocusSearch
                headerSlot={selectionHelpers}
              />
            </div>

            <div className="flex min-h-7 flex-wrap items-center gap-1.5 border-t border-border-default px-3 py-1.5 text-2xs text-text-secondary">
              <FleetPickerFooterHint
                confirmedCount={picker.confirmedIds.length}
                driftCount={picker.driftCount}
                hasVisibleRows={hasVisibleRows}
              />
            </div>

            <div className="flex flex-nowrap items-center justify-between gap-2 border-t border-border-default px-3 py-2">
              <div
                // A visible track. Without one the inactive half is bare dim
                // text beside a filled chip, so the pair reads as "a button and
                // some grey words" rather than a two-position switch.
                className="relative isolate flex rounded-sm border border-border-default bg-tint/[0.04] p-0.5 text-2xs"
                role="radiogroup"
                aria-label="Commit mode"
                data-testid="fleet-picker-cold-start-commit-mode"
              >
                {COMMIT_MODES.map(({ mode, label }) => {
                  const isActive = commitMode === mode;

                  return (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      onClick={() => setCommitMode(mode)}
                      data-testid={`fleet-picker-cold-start-commit-mode-${mode}`}
                      className={cn(
                        "relative rounded-xs px-2 py-1 transition-colors duration-150",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
                        isActive ? "text-text-primary" : "text-text-secondary hover:bg-tint/[0.04]"
                      )}
                    >
                      {isActive && (
                        <m.div
                          data-slot="segmented-thumb"
                          layout
                          layoutId={thumbLayoutId}
                          layoutCrossfade={false}
                          transition={thumbTransition}
                          className="absolute inset-0 z-0 rounded-xs bg-tint/[0.10] pointer-events-none"
                          aria-hidden="true"
                        />
                      )}
                      <span className="relative z-10">{label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onClose}
                  className={cn(
                    "rounded-sm px-2.5 py-1 text-xs leading-[inherit] text-text-secondary",
                    "hover:bg-tint/[0.08] hover:text-text-primary transition-colors duration-150",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  )}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={picker.handleConfirm}
                  // In Append mode the live count is what would actually be
                  // added; without this the button stayed enabled on a selection
                  // that was already entirely armed, and closed having done
                  // nothing.
                  disabled={
                    commitMode === "append" ? appendCount === 0 : picker.confirmedIds.length === 0
                  }
                  data-testid="fleet-picker-cold-start-confirm"
                  className={cn(
                    // Neutral high-contrast, the house primary treatment
                    // (`AppDialog.Footer` hard-codes `variant="contrast"`). The
                    // amber category fill this used to carry was the only
                    // category-coloured confirm in ~111 dialogs. Fleet keeps its
                    // amber identity where it belongs — the arming ribbon, the
                    // drafting pill, the pane header — and this surface is left
                    // with exactly one gold, the Waiting badge.
                    "rounded-sm bg-text-primary px-2.5 py-1 text-xs leading-[inherit] text-text-inverse ring-1 ring-tint/15",
                    "transition-[background-color,opacity] duration-150 hover:bg-[color-mix(in_oklab,var(--color-text-primary)_90%,var(--color-text-inverse))]",
                    // The label changes width with the count, and it sits at the
                    // end of the row, so every change dragged Cancel sideways
                    // with it. A floor wide enough for the longest common label
                    // pins the pair in place.
                    "min-w-[7.5rem] text-center tabular-nums",
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  )}
                >
                  {commitMode === "append"
                    ? appendCount === 0
                      ? "Add selected"
                      : `Add ${appendCount}`
                    : picker.confirmedIds.length === 0
                      ? "Arm selected"
                      : `Arm ${picker.confirmedIds.length} selected`}
                </button>
              </div>
            </div>
          </>
        ) : (
          // Another picker (likely the ribbon `+ Add panes…`) holds the
          // single-active session. Surface a soft empty state and let the
          // user dismiss via Cancel/Esc.
          <div
            className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center"
            data-testid="fleet-picker-cold-start-blocked"
          >
            <div className="text-sm leading-[inherit] font-medium text-text-primary">
              Another fleet picker is open
            </div>
            <div className="text-xs leading-[inherit] text-text-secondary">
              Close it and try again.
            </div>
          </div>
        )}
      </div>
    </AppPaletteDialog>
  );
}
