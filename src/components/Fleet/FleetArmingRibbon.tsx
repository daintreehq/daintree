import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { AlertCircle, AlertTriangle, MoreHorizontal, X } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { useEscapeStack, useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import "./fleetRawInputBroadcast";
import { useFleetEscapeChords } from "./useFleetEscapeChords";
import { useFleetRibbonFlashes } from "./useFleetRibbonFlashes";
import { buildConfirmMessage, type FleetConfirmActionId } from "./buildConfirmMessage";
import { FleetCountChip } from "./FleetCountChip";
import { FleetFailureBanner } from "./FleetFailureBanner";
import { SavedFleetsSection } from "./SavedFleetsSection";
import { FLEET_LARGE_PASTE_BATCH_SIZE } from "./fleetBroadcast";
import { cancelActiveBroadcast } from "./fleetEnterBroadcast";
import {
  useFleetArmingStore,
  computeArmByStateIds,
  collectEligibleIds,
  type FleetArmStatePreset,
  type FleetArmScope,
} from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";
import { useFleetRunStore, summarizeFleetRun, type FleetRun } from "@/store/fleetRunStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Kbd } from "@/components/ui/Kbd";
import {
  FLEET_RIBBON_ICON_BUTTON_CLASS,
  FLEET_RIBBON_SHELL_CLASS,
  FLEET_RIBBON_TEXT_BUTTON_CLASS,
} from "./fleetRibbonStyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface RunCountSegment {
  label: string;
  tone: "neutral" | "error";
}

interface RunStatusLine {
  segments: RunCountSegment[];
  dismissible: boolean;
  failed: boolean;
}

function deriveRunStatus(run: FleetRun | null, progressActive: boolean): RunStatusLine | null {
  if (run === null || progressActive) return null;
  switch (run.status) {
    case "watching":
      return { segments: buildRunCountSegments(run), dismissible: false, failed: false };
    case "completed":
      return {
        segments: [{ label: "Run finished", tone: "neutral" }, ...buildRunCountSegments(run)],
        dismissible: true,
        failed: false,
      };
    case "failed":
      return {
        segments: [{ label: "Run failed · nothing sent", tone: "error" }],
        dismissible: true,
        failed: true,
      };
    default:
      return null;
  }
}

function buildRunCountSegments(run: FleetRun): RunCountSegment[] {
  const counts = summarizeFleetRun(run);
  const segments: RunCountSegment[] = [];
  if (counts.working > 0) segments.push({ label: `${counts.working} working`, tone: "neutral" });
  if (counts.waiting > 0) segments.push({ label: `${counts.waiting} waiting`, tone: "neutral" });
  if (counts.done > 0) segments.push({ label: `${counts.done} done`, tone: "neutral" });
  if (counts.sendFailed > 0) segments.push({ label: `${counts.sendFailed} failed`, tone: "error" });
  return segments;
}

/**
 * Its own component rather than inline JSX: reading `status.segments` inside
 * the ribbon's render made the React Compiler lose the stability of an
 * unrelated `useState` setter and bail out of the whole component.
 */
function FleetRunStatusLine({
  status,
  onDismiss,
}: {
  status: RunStatusLine;
  onDismiss: () => void;
}): ReactElement {
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-2xs tabular-nums text-text-secondary"
      data-testid="fleet-run-status"
    >
      {status.failed && (
        <AlertCircle className="h-3 w-3 shrink-0 text-status-error" aria-hidden="true" />
      )}
      <span className="truncate">
        {status.segments.map((segment, index) => (
          <span
            key={segment.label}
            className={segment.tone === "error" ? "text-status-error" : undefined}
          >
            {index > 0 ? " · " : ""}
            {segment.label}
          </span>
        ))}
      </span>
      {status.dismissible && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss run summary"
          data-testid="fleet-run-dismiss"
          className={FLEET_RIBBON_ICON_BUTTON_CLASS}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

export function FleetArmingRibbon(): ReactElement | null {
  const armedCount = useFleetArmingStore((s) => s.armedIds.size);
  const clear = useFleetArmingStore((s) => s.clear);
  const armByState = useFleetArmingStore((s) => s.armByState);
  const armAll = useFleetArmingStore((s) => s.armAll);
  const pending = useFleetPendingActionStore((s) => s.pending);
  const clearPending = useFleetPendingActionStore((s) => s.clear);

  const progressCompleted = useFleetBroadcastProgressStore((s) => s.completed);
  const progressTotal = useFleetBroadcastProgressStore((s) => s.total);
  const progressFailed = useFleetBroadcastProgressStore((s) => s.failed);
  const progressActive = useFleetBroadcastProgressStore((s) => s.isActive);
  const showProgress = useDeferredLoading(progressActive, UI_DOHERTY_THRESHOLD);

  // Supervised-run status line (#10930). Submission progress is owned by the
  // progress store above; once the fan-out lands, the run store's `watching`
  // phase takes over the same slot with live per-target counts, and a
  // finalized run leaves a dismissible one-line summary. Cancelled/superseded
  // runs render nothing — the announcer + progress store already covered them.
  const run = useFleetRunStore((s) => s.run);
  const dismissRun = useFleetRunStore((s) => s.dismiss);
  const runStatus = deriveRunStatus(run, progressActive);

  const [popoverOpen, setPopoverOpen] = useState(false);
  // The selection menu is controlled so a fleet-delete request can close it
  // before the confirm dialog opens — keeping the modal dropdown layer from
  // colliding with the dialog's focus trap (#8023, lesson #2828).
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const [pendingDeleteFleetId, setPendingDeleteFleetId] = useState<string | null>(null);
  const savedScopes = useProjectSettingsStore(
    useShallow((s) => s.settings?.fleetSavedScopes ?? [])
  );
  const ribbonRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (armedCount < 2 && popoverOpen) {
      setPopoverOpen(false);
    }
  }, [armedCount, popoverOpen]);

  // The fleet-delete confirm renders only in the armedCount>=2 branch. If the
  // armed set drains below 2 while it's pending, the dialog unmounts without
  // an onClose — clear the id so it can't resurface for a stale fleet when
  // the count climbs back. Also drop it if the scope disappears entirely
  // (deleted from another window) so the title can't show a phantom name.
  useEffect(() => {
    if (pendingDeleteFleetId === null) return;
    if (armedCount < 2 || !savedScopes.some((s) => s.id === pendingDeleteFleetId)) {
      setPendingDeleteFleetId(null);
    }
  }, [armedCount, pendingDeleteFleetId, savedScopes]);

  // Escape stack: confirmation cancel is owned here so a pending confirm
  // absorbs bare Escape before it reaches the targets. The armed-list
  // popover gets its own entry so bare Escape closes the list without
  // disarming the fleet.
  // Bare Escape with focus inside the ribbon (Exit button, count chip,
  // selection-menu trigger) exits the fleet — see handleRibbonKeyDown
  // below. Bare Escape from anywhere else (xterm, hybrid input) still
  // belongs to the agents (#5750) — only the ⌘Esc chord exits globally.
  useEscapeStack(pending !== null, clearPending);
  useEscapeStack(popoverOpen, () => setPopoverOpen(false));

  const exitFleet = useCallback(() => {
    const target = useFleetArmingStore.getState().lastArmedId;
    clear();
    if (target && usePanelStore.getState().panelsById[target]) {
      usePanelStore.getState().setFocused(target);
      // Fire a one-shot ring pulse on the panel that just became primary so
      // the focus restoration is visually anchored. Dispatched from React
      // (not the store/router) since this is a purely cosmetic event.
      window.dispatchEvent(
        new CustomEvent("daintree:fleet-exit-pulse", { detail: { panelId: target } })
      );
    }
  }, [clear]);

  // If the armed set drains while a confirmation is pending (e.g., all
  // armed agents exit), collapse the confirmation so it can't execute
  // against zero targets.
  useEffect(() => {
    if (armedCount === 0 && pending !== null) {
      clearPending();
    }
  }, [armedCount, pending, clearPending]);

  const lastAnnouncedCount = useRef<number>(0);
  useEffect(() => {
    if (armedCount === lastAnnouncedCount.current) return;
    const announce = useAnnouncerStore.getState().announce;
    if (armedCount === 0 && lastAnnouncedCount.current > 0) {
      announce("Fleet disarmed");
    } else if (armedCount > 0) {
      announce(`${armedCount} ${armedCount === 1 ? "terminal" : "terminals"} in fleet`);
    }
    lastAnnouncedCount.current = armedCount;
  }, [armedCount]);

  // Enter confirms a pending destructive action. Bound locally so that
  // `fleet.*` actions can be re-dispatched with `{ confirmed: true }` to
  // bypass the threshold check on the second pass.
  useEffect(() => {
    if (pending === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      // A modal owns the keyboard while it is open. This listener is capture-
      // phase, so without the guard it beat a focused Cancel button to the Enter
      // and confirmed the fleet action instead of activating that button
      // (issue #11106). Tested by existence rather than ancestry because modal
      // content can be portaled outside the dialog's subtree (Radix menus and
      // selects mount under <body>). The fleet's own confirmation is an inline
      // role="status" banner, not a modal, so its Enter stays reachable.
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      const rawTarget = e.target;
      const target =
        rawTarget && typeof (rawTarget as HTMLElement).closest === "function"
          ? (rawTarget as HTMLElement)
          : null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest(".xterm") !== null)
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const actionId: FleetConfirmActionId =
        pending.kind === "reject"
          ? "fleet.reject"
          : pending.kind === "interrupt"
            ? "fleet.interrupt"
            : pending.kind === "restart"
              ? "fleet.restart"
              : pending.kind === "kill"
                ? "fleet.kill"
                : "fleet.trash";
      void actionService.dispatch(actionId, { confirmed: true }, { source: "keybinding" });
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [pending]);

  useFleetEscapeChords(armedCount, exitFleet, pending, popoverOpen);

  useFleetRibbonFlashes(ribbonRef);

  // Preview cleanup: if the user opens the selection menu, hovers a
  // state-preset item (which sets previewArmedIds), and then disarms panes
  // one-by-one until armedCount drops below 2, the ribbon early-returns
  // null *before* the DropdownMenu's onOpenChange(false) fires. Without
  // this watcher the surviving pane keeps its preview tint indefinitely.
  // Also covers the full-unmount case for parent-driven removals.
  useEffect(() => {
    if (armedCount < 2) {
      useFleetArmingStore.getState().clearPreviewArmedIds();
    }
  }, [armedCount]);
  useEffect(() => {
    return () => {
      useFleetArmingStore.getState().clearPreviewArmedIds();
    };
  }, []);

  const handleRequestDeleteFleet = useCallback((id: string) => {
    // Close the selection menu first so its modal layer tears down before
    // the confirm dialog mounts; React 19 batches both state updates.
    setSelectionMenuOpen(false);
    setPendingDeleteFleetId(id);
  }, []);

  const pendingDeleteScope =
    pendingDeleteFleetId !== null
      ? (savedScopes.find((s) => s.id === pendingDeleteFleetId) ?? null)
      : null;

  const setPreviewArmedIds = useFleetArmingStore((s) => s.setPreviewArmedIds);
  const clearPreviewArmedIds = useFleetArmingStore((s) => s.clearPreviewArmedIds);

  // Compute which panel ids a state-preset menu item would arm — used to
  // light up the matching panes' title bars while the user hovers/focuses
  // the menu item, before they commit. Pure dry-run; no store mutation.
  const computePreviewByState = useCallback(
    (preset: FleetArmStatePreset, scope: FleetArmScope): Set<string> => {
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
      return new Set(computeArmByStateIds(preset, scope, activeWorktreeId));
    },
    []
  );

  const computePreviewAll = useCallback((scope: FleetArmScope): Set<string> => {
    const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
    return new Set(collectEligibleIds(scope, activeWorktreeId));
  }, []);

  // Radix DropdownMenuItem: onFocus fires for keyboard nav AND mouse hover
  // (Radix syncs them); onPointerMove with a mouse-only guard avoids phantom
  // events when the menu opens under a stationary cursor. onPointerLeave +
  // onBlur clear the preview. Never preventDefault — it would break Radix's
  // composeEventHandlers chain.
  const previewItemHandlers = useCallback(
    (compute: () => Set<string>) => ({
      onFocus: () => setPreviewArmedIds(compute()),
      onPointerMove: (e: React.PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        setPreviewArmedIds(compute());
      },
      onPointerLeave: () => clearPreviewArmedIds(),
      onBlur: () => clearPreviewArmedIds(),
    }),
    [setPreviewArmedIds, clearPreviewArmedIds]
  );

  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId) ?? null;
  // Panel-store re-render triggers keep the selection-menu preset counts
  // fresh, but only while the ribbon is actually visible — when it isn't,
  // return a constant so agent ticks don't re-render the hidden ribbon.
  // Hook order stays stable; only the subscription payload is gated.
  const ribbonActive = armedCount >= 2;
  usePanelStore((s) => (ribbonActive ? s.panelIds : null));
  usePanelStore((s) => (ribbonActive ? s.panelsById : null));

  // Bare Esc on the ribbon → exit the fleet. Scoped to ribbon-owned
  // controls (the bar's own keydown handler) so terminals' Esc handling
  // for menus / prompts under live echo (#5750) still wins everywhere
  // else. Defined before the early returns to keep hook order stable.
  const handleRibbonKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (popoverOpen || pending !== null || pendingDeleteFleetId !== null) return;
      e.preventDefault();
      e.stopPropagation();
      exitFleet();
    },
    [exitFleet, popoverOpen, pending, pendingDeleteFleetId]
  );

  // Render confirmation before the armedCount<2 null guard so single-agent
  // keybindings (fleet.restart / fleet.kill always require confirmation)
  // stay reachable — and so draining 3→1 while a confirm is pending
  // doesn't strand a live Enter listener with no visible UI. The failure
  // banner is rendered alongside so a prior partial-failure surface stays
  // visible while the user is in the confirm flow.
  if (armedCount > 0 && pending !== null) {
    const message = buildConfirmMessage(
      pending.kind,
      pending.targetCount,
      pending.sessionLossCount
    );
    return (
      <div data-testid="fleet-arming-ribbon-group">
        <FleetFailureBanner />
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          // Same shell as the armed bar so the mode chrome doesn't visually
          // exit and re-enter during a confirm — only the content swaps.
          className={FLEET_RIBBON_SHELL_CLASS}
          data-testid="fleet-arming-ribbon"
          data-pending-action={pending.kind}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <AlertTriangle
              className="h-3.5 w-3.5 shrink-0 text-category-amber-text"
              aria-hidden="true"
            />
            <span className="truncate font-semibold">{message}</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3 text-2xs text-text-secondary">
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd> to confirm
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> to cancel
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (armedCount < 2) {
    return null;
  }

  // Below the early returns so the five O(panels) scans and the menu JSX
  // only run while the ribbon is actually visible.
  const presetCounts = {
    waitingCurrent: computeArmByStateIds("waiting", "current", activeWorktreeId).length,
    waitingAll: computeArmByStateIds("waiting", "all", activeWorktreeId).length,
    workingCurrent: computeArmByStateIds("working", "current", activeWorktreeId).length,
    workingAll: computeArmByStateIds("working", "all", activeWorktreeId).length,
    eligibleCurrent: collectEligibleIds("current", activeWorktreeId).length,
  };

  const selectionMenuItems = (
    <>
      <DropdownMenuLabel>Select by state</DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={() => {
          armByState("waiting", "current", false);
        }}
        {...previewItemHandlers(() => computePreviewByState("waiting", "current"))}
      >
        All waiting — this worktree
        <span className="ml-auto text-2xs tabular-nums text-text-secondary">
          {presetCounts.waitingCurrent}
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("waiting", "all", false);
        }}
        {...previewItemHandlers(() => computePreviewByState("waiting", "all"))}
      >
        All waiting — all worktrees
        <span className="ml-auto text-2xs tabular-nums text-text-secondary">
          {presetCounts.waitingAll}
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("working", "current", false);
        }}
        {...previewItemHandlers(() => computePreviewByState("working", "current"))}
      >
        All working — this worktree
        <span className="ml-auto text-2xs tabular-nums text-text-secondary">
          {presetCounts.workingCurrent}
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("working", "all", false);
        }}
        {...previewItemHandlers(() => computePreviewByState("working", "all"))}
      >
        All working — all worktrees
        <span className="ml-auto text-2xs tabular-nums text-text-secondary">
          {presetCounts.workingAll}
        </span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          armAll("current");
        }}
        {...previewItemHandlers(() => computePreviewAll("current"))}
      >
        All in this worktree
        <span className="ml-auto text-2xs tabular-nums text-text-secondary">
          {presetCounts.eligibleCurrent}
        </span>
      </DropdownMenuItem>
      {armedCount > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              void actionService.dispatch("fleet.scope.enter", undefined, { source: "user" });
            }}
          >
            Focus selection
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              clear();
            }}
          >
            Clear selection
          </DropdownMenuItem>
        </>
      ) : null}
      <SavedFleetsSection onRequestDelete={handleRequestDeleteFleet} />
    </>
  );

  // Entrance is a low-bounce spring (~200ms). Exit is critically damped and
  // faster (~120ms) so the bar tucks away cleanly without overshoot —
  // important when the user is about to refocus an unarmed pane. Framer
  // Motion 12 reads `transition` from inside the exit variant when present,
  // overriding the top-level `transition` for exit only.
  const ribbonMotionProps = reduceMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.12 },
      }
    : {
        initial: { y: "-100%", opacity: 0 },
        animate: { y: 0, opacity: 1 },
        exit: {
          y: "-100%",
          opacity: 0,
          transition: { duration: 0.12, ease: [0.4, 0, 0.2, 1] as const },
        },
        transition: { type: "spring" as const, duration: 0.2, bounce: 0.12 },
      };

  const exitChordLabel = isMac() ? "⌘Esc" : "Ctrl+Esc";

  return (
    <div data-testid="fleet-arming-ribbon-group">
      <ConfirmDialog
        isOpen={pendingDeleteFleetId !== null}
        variant="destructive"
        title={`Delete '${pendingDeleteScope?.name ?? "fleet"}'?`}
        description="This removes the saved fleet. The terminals it points to are not affected."
        confirmLabel="Delete fleet"
        onConfirm={() => {
          if (pendingDeleteFleetId !== null) {
            void actionService.dispatch(
              "fleet.deleteNamedFleet",
              { id: pendingDeleteFleetId },
              { source: "user" }
            );
          }
          setPendingDeleteFleetId(null);
        }}
        onClose={() => setPendingDeleteFleetId(null)}
      />
      <FleetFailureBanner />
      <AnimatePresence initial={false}>
        <m.div
          ref={ribbonRef}
          key="fleet-arming-ribbon"
          role="status"
          aria-live="off"
          tabIndex={-1}
          onKeyDown={handleRibbonKeyDown}
          className={cn(FLEET_RIBBON_SHELL_CLASS, "overflow-hidden outline-hidden")}
          data-testid="fleet-arming-ribbon"
          {...ribbonMotionProps}
        >
          {/* Three areas — a fixed membership anchor, a flexible status slot,
           * and the trailing controls — so the transient centre content can
           * come and go without moving the menu or Exit. */}
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={exitFleet}
              aria-label="Exit fleet mode"
              data-testid="fleet-leading-exit"
              className={FLEET_RIBBON_ICON_BUTTON_CLASS}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <FleetCountChip
              armedCount={armedCount}
              open={popoverOpen}
              onOpenChange={setPopoverOpen}
            />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {showProgress && (
              <span
                role="progressbar"
                aria-label="Broadcast progress"
                aria-valuemin={0}
                aria-valuemax={progressTotal}
                aria-valuenow={progressCompleted}
                aria-valuetext={`${progressCompleted} of ${progressTotal} sent${progressFailed > 0 ? `, ${progressFailed} failed` : ""}`}
                className="shrink-0 text-2xs tabular-nums text-text-secondary"
                data-testid="fleet-broadcast-progress"
              >
                Sending {progressCompleted}/{progressTotal}
                {progressFailed > 0 && (
                  <span className="text-status-error"> · {progressFailed} failed</span>
                )}
              </span>
            )}
            {/* Cancel surface is gated on batching, not on the counter threshold:
             * cooperative cancellation can only interrupt batched fan-out
             * (resolved.length > FLEET_LARGE_PASTE_BATCH_SIZE), so showing
             * Cancel for sub-threshold but batching-eligible fleets keeps the
             * affordance reachable for 6–9 target large-paste broadcasts. */}
            {progressActive && progressTotal > FLEET_LARGE_PASTE_BATCH_SIZE && (
              <button
                type="button"
                onClick={cancelActiveBroadcast}
                aria-label="Cancel broadcast"
                data-testid="fleet-broadcast-cancel"
                className={FLEET_RIBBON_TEXT_BUTTON_CLASS}
              >
                Cancel
              </button>
            )}
            {runStatus !== null && <FleetRunStatusLine status={runStatus} onDismiss={dismissRun} />}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <DropdownMenu
              open={selectionMenuOpen}
              onOpenChange={(open) => {
                setSelectionMenuOpen(open);
                if (!open) clearPreviewArmedIds();
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Open selection menu"
                  className={FLEET_RIBBON_ICON_BUTTON_CLASS}
                  data-testid="fleet-selection-menu-trigger"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                {selectionMenuItems}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={exitFleet}
              aria-label={`Exit fleet mode (${exitChordLabel})`}
              data-testid="fleet-exit"
              className={FLEET_RIBBON_TEXT_BUTTON_CLASS}
            >
              <span>Exit</span>
              <Kbd>{exitChordLabel}</Kbd>
            </button>
          </div>
          {/* A 2px delivery track along the bottom edge: the only graphical
           * progress cue a 36px bar has room for. Width is the signal, so
           * reduced motion just drops the interpolation. */}
          {showProgress && progressTotal > 0 && (
            <span
              aria-hidden="true"
              data-testid="fleet-broadcast-track"
              className="absolute inset-x-0 bottom-0 h-0.5 bg-category-amber-text transition-[width] duration-150 ease-out motion-reduce:transition-none"
              style={{ width: `${Math.round((progressCompleted / progressTotal) * 100)}%` }}
            />
          )}
        </m.div>
      </AnimatePresence>
    </div>
  );
}
