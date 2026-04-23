import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { useEscapeStack, useWorktreeColorMap } from "@/hooks";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetBroadcastConfirmStore } from "@/store/fleetBroadcastConfirmStore";
import {
  useFleetPendingActionStore,
  type FleetPendingActionKind,
} from "@/store/fleetPendingActionStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { usePanelStore } from "@/store/panelStore";
import { actionService } from "@/services/ActionService";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const DOUBLE_ESC_WINDOW_MS = 350;

type FleetConfirmActionId =
  | "fleet.reject"
  | "fleet.interrupt"
  | "fleet.restart"
  | "fleet.kill"
  | "fleet.trash";

function buildConfirmMessage(
  kind: FleetPendingActionKind,
  count: number,
  sessionLoss: number
): string {
  switch (kind) {
    case "reject":
      return `Reject ${count} ${count === 1 ? "prompt" : "prompts"}?`;
    case "interrupt":
      return `Interrupt ${count} ${count === 1 ? "agent" : "agents"}?`;
    case "restart": {
      const base = `Restart ${count} ${count === 1 ? "agent" : "agents"}?`;
      if (sessionLoss > 0) {
        const noun = sessionLoss === 1 ? "agent will lose its" : "agents will lose their";
        return `${base} ${sessionLoss} ${noun} session.`;
      }
      return base;
    }
    case "kill":
      return `Kill ${count} ${count === 1 ? "terminal" : "terminals"}?`;
    case "trash":
      return `Trash ${count} ${count === 1 ? "worktree" : "worktrees"}?`;
  }
}

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

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isSendingBroadcast, setIsSendingBroadcast] = useState(false);
  const pasteCancelRef = useRef<HTMLButtonElement | null>(null);
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
      announce(`${armedCount} ${armedCount === 1 ? "agent" : "agents"} in fleet`);
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

  // ⌘Esc chord. Single press (released; 350ms timeout) → exit broadcast
  // (clear selection, restore focus to lastArmedId). Rapid second press
  // within 350ms → cancel the pending exit and dispatch fleet.interrupt
  // instead. Bare Escape is intentionally ignored: targets own it for
  // menus/prompts under live echo (#5750). Listener is capture-phase so
  // the chord fires before Radix popover dismissal.
  const lastEscapeMsRef = useRef<number>(0);
  const pendingExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitFleetRef = useRef(exitFleet);
  useEffect(() => {
    exitFleetRef.current = exitFleet;
  }, [exitFleet]);

  useEffect(() => {
    const clearPendingExit = () => {
      if (pendingExitTimerRef.current !== null) {
        clearTimeout(pendingExitTimerRef.current);
        pendingExitTimerRef.current = null;
      }
    };

    if (armedCount === 0) {
      lastEscapeMsRef.current = 0;
      clearPendingExit();
      return;
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!e.metaKey && !e.ctrlKey) return;
      const now = Date.now();
      const prev = lastEscapeMsRef.current;

      if (prev !== 0 && now - prev <= DOUBLE_ESC_WINDOW_MS) {
        lastEscapeMsRef.current = 0;
        clearPendingExit();
        e.stopPropagation();
        e.preventDefault();
        void actionService.dispatch("fleet.interrupt", undefined, { source: "keybinding" });
        return;
      }

      lastEscapeMsRef.current = now;
      e.stopPropagation();
      e.preventDefault();
      clearPendingExit();
      pendingExitTimerRef.current = setTimeout(() => {
        pendingExitTimerRef.current = null;
        lastEscapeMsRef.current = 0;
        exitFleetRef.current();
      }, DOUBLE_ESC_WINDOW_MS);
    };

    const handleBlur = () => {
      lastEscapeMsRef.current = 0;
      clearPendingExit();
    };

    window.addEventListener("keydown", handler, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("blur", handleBlur);
      clearPendingExit();
    };
  }, [armedCount]);

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

  const selectionMenuItems = (
    <>
      <DropdownMenuLabel>Select by state</DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={() => {
          armByState("waiting", "current", false);
        }}
      >
        All waiting — this worktree
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("waiting", "all", false);
        }}
      >
        All waiting — all worktrees
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("working", "current", false);
        }}
      >
        All working — this worktree
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          armByState("working", "all", false);
        }}
      >
        All working — all worktrees
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          armAll("current");
        }}
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
        exit: { y: "-100%", opacity: 0 },
        transition: { type: "spring" as const, duration: 0.2, bounce: 0.15 },
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
        <motion.div
          key="fleet-arming-ribbon"
          role={isBroadcastConfirmActive ? "alertdialog" : "status"}
          aria-live={isBroadcastConfirmActive ? "polite" : "off"}
          aria-atomic={isBroadcastConfirmActive ? "true" : undefined}
          tabIndex={-1}
          onKeyDown={handleRibbonKeyDown}
          className={cn(
            "relative flex items-center gap-3 overflow-hidden border-b border-daintree-border px-3 py-2 text-[12px] text-daintree-text outline-none",
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
          <FleetCountChip
            armedCount={armedCount}
            open={popoverOpen}
            onOpenChange={setPopoverOpen}
          />
          <DropdownMenu>
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
                className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-100 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-40"
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
                <kbd className="rounded border border-category-amber-border bg-amber-500/5 px-1 font-mono text-[10px] leading-tight text-category-amber-text">
                  {exitChordLabel}
                </kbd>
              </button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

interface FleetCountChipProps {
  armedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function FleetCountChip({ armedCount, open, onOpenChange }: FleetCountChipProps): ReactElement {
  const armOrder = useFleetArmingStore((s) => s.armOrder);
  const disarmId = useFleetArmingStore((s) => s.disarmId);
  const panelsById = usePanelStore(
    useShallow((state) => {
      const out: Record<string, string> = {};
      for (const id of armOrder) {
        const t = state.panelsById[id];
        if (t) out[id] = t.title;
      }
      return out;
    })
  );

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
  const scopeAriaLabel = scope.worktreeCount > 1 ? ` across ${scope.worktreeCount} worktrees` : "";
  const label = `${armedCount} in fleet${scopeAriaLabel}`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
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
          <span className="text-daintree-text/70">in fleet</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        data-testid="fleet-armed-list"
        className="max-h-[320px] w-[260px] overflow-y-auto p-1"
      >
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-daintree-text/50">
          Fleet terminals
        </div>
        <ul className="flex flex-col">
          {armOrder.length === 0 ? (
            <li className="px-2 py-1 text-[12px] text-daintree-text/60">None</li>
          ) : (
            armOrder.map((id) => (
              <li key={id} className="flex items-center gap-2 rounded hover:bg-tint/[0.08]">
                <button
                  type="button"
                  onClick={() => focusArmedPane(id)}
                  aria-label={`Focus ${panelsById[id] ?? id}`}
                  className="flex-1 truncate px-2 py-1 text-left text-[12px] text-daintree-text"
                >
                  {panelsById[id] ?? id}
                </button>
                <button
                  type="button"
                  onClick={() => disarmId(id)}
                  aria-label={`Unarm ${panelsById[id] ?? id}`}
                  className="inline-flex shrink-0 items-center rounded p-0.5 mr-1 text-daintree-text/50 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

interface FleetWorktreeScope {
  worktreeCount: number;
  colors: string[];
}

/**
 * Computes the fleet's worktree scope (count + deduped identity colors).
 *
 * Stable-sorted by worktreeId so the color strip doesn't re-order every time
 * a pane joins or leaves the fleet — peripheral jitter on the left edge of
 * the chip would feel twitchier than the actual information warrants.
 *
 * Counts unique worktreeIds (not colors) so the aria-label stays accurate
 * when the palette wraps modulo 8 and two worktrees happen to share a color.
 */
function useFleetWorktreeScope(): FleetWorktreeScope {
  const armOrder = useFleetArmingStore((s) => s.armOrder);
  const colorMap = useWorktreeColorMap();
  const worktreeIdsByPane = usePanelStore(
    useShallow((state) => {
      const out: Record<string, string | undefined> = {};
      for (const id of armOrder) {
        out[id] = state.panelsById[id]?.worktreeId;
      }
      return out;
    })
  );

  return useMemo<FleetWorktreeScope>(() => {
    if (!colorMap) return { worktreeCount: 0, colors: [] };
    const uniqueWorktreeIds = new Set<string>();
    for (const paneId of armOrder) {
      const wtId = worktreeIdsByPane[paneId];
      if (wtId) uniqueWorktreeIds.add(wtId);
    }
    const sortedIds = Array.from(uniqueWorktreeIds).sort();
    const seenColors = new Set<string>();
    const colors: string[] = [];
    for (const wtId of sortedIds) {
      const color = colorMap[wtId];
      if (!color || seenColors.has(color)) continue;
      seenColors.add(color);
      colors.push(color);
    }
    return { worktreeCount: uniqueWorktreeIds.size, colors };
  }, [armOrder, worktreeIdsByPane, colorMap]);
}

/**
 * At-a-glance scope marker — stacked worktree identity dots rendered inside
 * the count chip so the scope read and the "show list" affordance are one
 * clickable bundle. Marked aria-hidden; the parent chip button's aria-label
 * carries the scope for assistive tech.
 *
 * Single-worktree projects get no colors from useWorktreeColorMap by design,
 * so the component renders nothing — no signal to carry when everything is
 * one color anyway.
 */
function FleetWorktreeDots({ scope }: { scope: FleetWorktreeScope }): ReactElement | null {
  if (scope.colors.length === 0) return null;

  // Cap at 3 — the dots are a glance signal, not an inventory. The chip's
  // aria-label already carries the precise worktree count.
  const shown = scope.colors.slice(0, 3);

  return (
    <span
      className="flex items-center -space-x-1"
      aria-hidden="true"
      data-testid="fleet-worktree-dots"
    >
      {shown.map((color, i) => (
        <span
          key={color}
          className="h-2.5 w-2.5 rounded-full ring-2 ring-[var(--theme-surface-canvas)]"
          style={{ backgroundColor: color, zIndex: shown.length - i }}
        />
      ))}
    </span>
  );
}
