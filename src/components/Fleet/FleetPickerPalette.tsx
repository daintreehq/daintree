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
  const selectAllLabel = allVisibleSelected
    ? hasQuery
      ? "Deselect visible"
      : "Deselect all"
    : hasQuery
      ? "Select all visible"
      : "Select all";

  // Select → replace visible (matches Cmd+A in useFleetPicker).
  // Deselect when filtered → scoped removal so picks for filtered-out
  // terminals survive. Deselect when unfiltered → full clear, otherwise
  // drifted (transiently-ineligible) ids would sneak back into the
  // selection after re-eligibility, contradicting the "Deselect all" label.
  const handleToggleAllVisible = useCallback(() => {
    if (!allVisibleSelected) {
      picker.setSelectedIds(new Set(picker.visibleIds));
      return;
    }
    if (hasQuery) {
      picker.setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of picker.visibleIds) next.delete(id);
        return next;
      });
    } else {
      picker.setSelectedIds(new Set());
    }
  }, [allVisibleSelected, hasQuery, picker]);

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
  const selectionHelpers = (
    <div role="group" aria-label="Selection helpers" className="flex items-center gap-1.5 pt-2">
      <button
        type="button"
        onClick={handleToggleAllVisible}
        disabled={picker.visibleIds.length === 0}
        data-testid="fleet-picker-cold-start-select-all"
        className={cn(
          "rounded px-2.5 py-1 text-xs leading-[inherit] text-daintree-text/70",
          "hover:bg-tint/[0.08] hover:text-text-primary",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
        )}
      >
        {selectAllLabel}
      </button>
      <button
        type="button"
        onClick={handleSelectAgents}
        disabled={agentVisibleIds.length === 0}
        data-testid="fleet-picker-cold-start-select-agents"
        className={cn(
          "rounded px-2.5 py-1 text-xs leading-[inherit] text-daintree-text/70",
          "hover:bg-tint/[0.08] hover:text-text-primary",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
        )}
      >
        Select agents
      </button>
    </div>
  );

  // `FleetPickerFooterHint` collapses to nothing when the list is empty and
  // nothing has drifted — skip the bordered strip entirely in that case so
  // there's no empty bar between the list and the footer.
  const hasVisibleRows = picker.visibleTerminals.length > 0;
  const showFooterHint = hasVisibleRows || picker.driftCount > 0;

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
          <Zap className="h-4 w-4 text-daintree-text/70" aria-hidden="true" />
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

            {showFooterHint && (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-daintree-border/50 px-3 py-1.5 text-2xs text-daintree-text/55">
                <FleetPickerFooterHint
                  confirmedCount={picker.confirmedIds.length}
                  driftCount={picker.driftCount}
                  hasVisibleRows={hasVisibleRows}
                />
              </div>
            )}

            <div className="flex flex-nowrap items-center justify-between gap-2 border-t border-border-default px-3 py-2">
              <div
                className="relative isolate flex bg-tint/[0.04] rounded text-2xs"
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
                        "relative rounded px-2 py-1 transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
                        isActive
                          ? "text-text-primary"
                          : "text-daintree-text/70 hover:bg-tint/[0.04]"
                      )}
                    >
                      {isActive && (
                        <m.div
                          data-slot="segmented-thumb"
                          layout
                          layoutId={thumbLayoutId}
                          layoutCrossfade={false}
                          transition={thumbTransition}
                          className="absolute inset-0 z-0 rounded bg-tint/[0.10] pointer-events-none"
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
                    "rounded px-2.5 py-1 text-xs leading-[inherit] text-daintree-text/70",
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
                  data-testid="fleet-picker-cold-start-confirm"
                  className={cn(
                    "rounded border border-category-amber-border bg-category-amber-subtle px-2.5 py-1 text-xs leading-[inherit] text-category-amber-text transition",
                    "hover:brightness-110",
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  )}
                >
                  {commitMode === "append"
                    ? picker.confirmedIds.length === 0
                      ? "Add"
                      : `Add ${picker.confirmedIds.length}`
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
            <div className="text-xs leading-[inherit] text-daintree-text/60">
              Close it and try again.
            </div>
          </div>
        )}
      </div>
    </AppPaletteDialog>
  );
}
