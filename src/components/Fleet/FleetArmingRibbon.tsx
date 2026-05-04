import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { useEscapeStack } from "@/hooks";
import "./fleetRawInputBroadcast";
import { useFleetEscapeChords } from "./useFleetEscapeChords";
import { useFleetRibbonFlashes } from "./useFleetRibbonFlashes";
import { buildConfirmMessage, type FleetConfirmActionId } from "./buildConfirmMessage";
import { FleetCountChip } from "./FleetCountChip";
import { SavedFleetsSection } from "./SavedFleetsSection";
import { FLEET_PROGRESS_VISIBILITY_THRESHOLD } from "./fleetBroadcast";
import {
  useFleetArmingStore,
  computeArmByStateIds,
  collectEligibleIds,
  type FleetArmStatePreset,
  type FleetArmScope,
} from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetBroadcastConfirmStore } from "@/store/fleetBroadcastConfirmStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { usePanelStore } from "@/store/panelStore";
import { actionService } from "@/services/ActionService";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function FleetArmingRibbon(): ReactElement | null {
  const armedCount = useFleetArmingStore((s) => s.armedIds.size);
  const clear = useFleetArmingStore((s) => s.clear);
  const armByState = useFleetArmingStore((s) => s.armByState);
  const armAll = useFleetArmingStore((s) => s.armAll);
  const pending = useFleetPendingActionStore((s) => s.pending);
  const clearPending = useFleetPendingActionStore((s) => s.clear);

  // Pending broadcast that needs user confirmation — fed by Enter-broadcast
  // from a fleet primary's hybrid input bar.
  const pendingBroadcast = useFleetBroadcastConfirmStore((s) => s.pending);
  const clearPendingBroadcast = useFleetBroadcastConfirmStore((s) => s.clear);

  const progressCompleted = useFleetBroadcastProgressStore((s) => s.completed);
  const progressTotal = useFleetBroadcastProgressStore((s) => s.total);
  const progressFailed = useFleetBroadcastProgressStore((s) => s.failed);
  const progressActive = useFleetBroadcastProgressStore((s) => s.isActive);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isSendingBroadcast, setIsSendingBroadcast] = useState(false);
  const pasteCancelRef = useRef<HTMLButtonElement | null>(null);
  const ribbonRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (pendingBroadcast !== null) {
      pasteCancelRef.current?.focus();
    }
  }, [pendingBroadcast]);

  useEffect(() => {
    if (armedCount < 2 && pendingBroadcast !== null) {
      clearPendingBroadcast();
    }
  }, [armedCount, pendingBroadcast, clearPendingBroadcast]);

  useEffect(() => {
    if (armedCount < 2 && popoverOpen) {
      setPopoverOpen(false);
    }
  }, [armedCount, popoverOpen]);

  // Escape stack: confirmation cancel is owned here so a pending confirm
  // absorbs bare Escape before it reaches the targets. The armed-list
  // popover gets its own entry so bare Escape closes the list without
  // disarming the fleet. Broadcast confirmation also absorbs bare Escape so
  // the user can cancel a queued destructive send with a single tap.
  // Bare Escape with focus inside the ribbon (Exit button, count chip,
  // selection-menu trigger) exits the fleet — see handleRibbonKeyDown
  // below. Bare Escape from anywhere else (xterm, hybrid input) still
  // belongs to the agents (#5750) — only the ⌘Esc chord exits globally.
  useEscapeStack(pending !== null, clearPending);
  useEscapeStack(popoverOpen, () => setPopoverOpen(false));
  useEscapeStack(pendingBroadcast !== null, clearPendingBroadcast);

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

  useFleetEscapeChords(armedCount, exitFleet, pending, popoverOpen, pendingBroadcast);

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

  const cancelPendingBroadcast = useCallback(() => {
    clearPendingBroadcast();
  }, [clearPendingBroadcast]);

  const confirmPendingBroadcast = useCallback(async () => {
    if (pendingBroadcast == null || isSendingBroadcast) return;
    const { onConfirm } = pendingBroadcast;
    setIsSendingBroadcast(true);
    try {
      await onConfirm();
      // Success/failure dots (per-pane red dots) carry the result; no toast.
    } finally {
      setIsSendingBroadcast(false);
      clearPendingBroadcast();
    }
  }, [pendingBroadcast, isSendingBroadcast, clearPendingBroadcast]);

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
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("waiting", "all", false);
        }}
        {...previewItemHandlers(() => computePreviewByState("waiting", "all"))}
      >
        All waiting — all worktrees
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("working", "current", false);
        }}
        {...previewItemHandlers(() => computePreviewByState("working", "current"))}
      >
        All working — this worktree
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("working", "all", false);
        }}
        {...previewItemHandlers(() => computePreviewByState("working", "all"))}
      >
        All working — all worktrees
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          armAll("current");
        }}
        {...previewItemHandlers(() => computePreviewAll("current"))}
      >
        All in this worktree
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
            destructive
            onSelect={() => {
              clear();
            }}
          >
            Clear selection
          </DropdownMenuItem>
        </>
      ) : null}
      <SavedFleetsSection />
    </>
  );

  // Bare Esc on the ribbon → exit the fleet. Scoped to ribbon-owned
  // controls (the bar's own keydown handler) so terminals' Esc handling
  // for menus / prompts under live echo (#5750) still wins everywhere
  // else. Defined before the early returns to keep hook order stable.
  const handleRibbonKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (pendingBroadcast !== null || popoverOpen || pending !== null) return;
      e.preventDefault();
      e.stopPropagation();
      exitFleet();
    },
    [exitFleet, pendingBroadcast, popoverOpen, pending]
  );

  // Render confirmation before the armedCount<2 null guard so single-agent
  // keybindings (fleet.restart / fleet.kill always require confirmation)
  // stay reachable — and so draining 3→1 while a confirm is pending
  // doesn't strand a live Enter listener with no visible UI.
  if (armedCount > 0 && pending !== null) {
    const message = buildConfirmMessage(
      pending.kind,
      pending.targetCount,
      pending.sessionLossCount
    );
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "relative flex items-center gap-3 border-b border-daintree-border px-3 py-2 text-[12px] text-daintree-text",
          // Keep the Fleet surface continuous through confirm-pending so the
          // mode chrome doesn't visually exit and re-enter during a confirm.
          "bg-category-amber-subtle",
          "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--color-category-amber-border)]"
        )}
        data-testid="fleet-arming-ribbon"
        data-pending-action={pending.kind}
      >
        <span className="font-medium text-daintree-accent">{message}</span>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-daintree-text/70">
          <span>
            <kbd className="rounded border border-daintree-text/20 bg-tint/[0.08] px-1 py-0.5 font-mono text-[10px]">
              Enter
            </kbd>{" "}
            to confirm
          </span>
          <span>
            <kbd className="rounded border border-daintree-text/20 bg-tint/[0.08] px-1 py-0.5 font-mono text-[10px]">
              Esc
            </kbd>{" "}
            to cancel
          </span>
        </div>
      </div>
    );
  }

  if (armedCount < 2) {
    return null;
  }

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

  // When a destructive broadcast (paste or Enter) is pending, the right-side
  // controls collapse to the confirm question so we keep one ribbon row
  // instead of stacking a second strip below. Per-pane red dots (PanelHeader)
  // carry any post-broadcast failure state — no retry/dismiss buttons here.
  const isBroadcastConfirmActive = pendingBroadcast !== null;

  return (
    <div data-testid="fleet-arming-ribbon-group">
      <AnimatePresence initial={false}>
        <m.div
          ref={ribbonRef}
          key="fleet-arming-ribbon"
          role={isBroadcastConfirmActive ? "alertdialog" : "status"}
          aria-live={isBroadcastConfirmActive ? "polite" : "off"}
          aria-atomic={isBroadcastConfirmActive ? "true" : undefined}
          tabIndex={-1}
          onKeyDown={handleRibbonKeyDown}
          className={cn(
            "relative flex items-center gap-3 overflow-hidden border-b border-daintree-border px-3 py-2 text-[12px] text-daintree-text outline-hidden",
            "bg-category-amber-subtle",
            // Non-color structural cue: 2px amber left-edge stripe. Mirrors the
            // panel-worktree-identity idiom so the "mode surface" reads even
            // with CVD / low-saturation themes where the amber tint alone
            // might not register as a distinct surface.
            "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--color-category-amber-border)]"
          )}
          data-testid="fleet-arming-ribbon"
          {...ribbonMotionProps}
        >
          {!isBroadcastConfirmActive ? (
            <button
              type="button"
              onClick={exitFleet}
              aria-label="Exit fleet mode"
              data-testid="fleet-leading-exit"
              className="rounded p-1 text-daintree-text/50 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <FleetCountChip
            armedCount={armedCount}
            open={popoverOpen}
            onOpenChange={setPopoverOpen}
          />
          {progressActive && progressTotal >= FLEET_PROGRESS_VISIBILITY_THRESHOLD && (
            <span
              className="text-[11px] tabular-nums text-daintree-text/70"
              data-testid="fleet-broadcast-progress"
            >
              {progressCompleted}/{progressTotal}
              {progressFailed > 0 && (
                <span className="text-daintree-text/50"> · {progressFailed} failed</span>
              )}
            </span>
          )}
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) clearPreviewArmedIds();
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Open selection menu"
                className="rounded p-1 text-daintree-text/60 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
                data-testid="fleet-selection-menu-trigger"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4}>
              {selectionMenuItems}
            </DropdownMenuContent>
          </DropdownMenu>
          {isBroadcastConfirmActive && pendingBroadcast ? (
            <div
              data-testid="fleet-paste-confirm"
              className="ml-auto flex items-center gap-2 text-[11px] text-daintree-text"
            >
              <span className="text-daintree-text/85">
                Send to {armedCount} — {pendingBroadcast.warningReasons.join(", ")}?
              </span>
              <button
                type="button"
                ref={pasteCancelRef}
                onClick={cancelPendingBroadcast}
                data-testid="fleet-paste-confirm-cancel"
                className="rounded px-2 py-0.5 text-daintree-text/70 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSendingBroadcast}
                onClick={() => void confirmPendingBroadcast()}
                data-testid="fleet-paste-confirm-send"
                className="rounded bg-category-amber-subtle border border-category-amber-border px-2 py-0.5 text-category-amber-text transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none"
              >
                Send anyway
              </button>
            </div>
          ) : (
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={exitFleet}
                aria-label={`Exit fleet mode (${exitChordLabel})`}
                data-testid="fleet-exit"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition-colors",
                  "bg-tint/[0.08] text-daintree-text/80 hover:bg-tint/[0.14] hover:text-daintree-text"
                )}
              >
                <span>Exit</span>
                <kbd className="rounded border border-category-amber-border bg-category-amber-subtle px-1 font-mono text-[10px] leading-tight text-category-amber-text">
                  {exitChordLabel}
                </kbd>
              </button>
            </div>
          )}
        </m.div>
      </AnimatePresence>
    </div>
  );
}
