import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { useEscapeStack } from "@/hooks";
import { useFleetArmingStore, type FleetArmStatePreset } from "@/store/fleetArmingStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
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
import { FleetComposer } from "./FleetComposer";
import { useFleetFocusPulse } from "./useFleetFocusPulse";

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
  const quickStateFilter = useWorktreeFilterStore((s) => s.quickStateFilter);
  const pending = useFleetPendingActionStore((s) => s.pending);
  const clearPending = useFleetPendingActionStore((s) => s.clear);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const isPulsing = useFleetFocusPulse(armedCount);

  useEffect(() => {
    if (armedCount < 2 && popoverOpen) {
      setPopoverOpen(false);
    }
  }, [armedCount, popoverOpen]);

  // Escape stack: confirmation cancel is owned here so a pending confirm
  // absorbs bare Escape before it reaches the targets. The armed-list
  // popover gets its own entry so bare Escape closes the list without
  // disarming the fleet. Plain Escape never disarms — the targets own it
  // (see issue #5750: agents use Esc for menus/prompts). Exit requires
  // the ⌘Esc chord or the visible ✕ chip.
  useEscapeStack(pending !== null, clearPending);
  useEscapeStack(popoverOpen, () => setPopoverOpen(false));

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
      announce(`${armedCount} ${armedCount === 1 ? "agent" : "agents"} armed`);
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
  // the chord fires before Radix popover dismissal and the composer's
  // textarea keydown handler.
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
      // Cmd on macOS, Ctrl on other platforms — keybindingService
      // normalizes the two, but for a raw listener we accept either.
      // The modifier is the discriminator: we accept the chord from any
      // focus target (including the composer textarea and xterm panes) so
      // the user can exit broadcast from wherever their cursor landed.
      // Bare Escape is filtered above and continues to reach targets.
      if (!e.metaKey && !e.ctrlKey) return;
      const now = Date.now();
      const prev = lastEscapeMsRef.current;

      if (prev !== 0 && now - prev <= DOUBLE_ESC_WINDOW_MS) {
        // Second press inside the chord window — cancel the pending exit
        // and fire the interrupt.
        lastEscapeMsRef.current = 0;
        clearPendingExit();
        e.stopPropagation();
        e.preventDefault();
        void actionService.dispatch("fleet.interrupt", undefined, { source: "keybinding" });
        return;
      }

      // First press — arm the chord and schedule the exit for when the
      // double-tap window closes without a second press.
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

    // Cmd-held + OS focus loss can leave the chord "half-armed" after
    // Cmd+Tab away-and-back. Reset so the first Esc on return doesn't
    // look like a stale second press.
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

  // "Match active filter" maps the sidebar's quick-state filter (which is
  // worktree-chip-state driven) to an agent-state preset 1:1 by name. In
  // edge cases a worktree's chip state can differ from an individual
  // agent's state (e.g. a worktree in "cleanup" with a still-waiting
  // agent), so "finished" here arms agents in terminal states, not every
  // agent under a "finished"-chip worktree. Acceptable — the menu arms
  // by agent state throughout.
  const filterPreset: FleetArmStatePreset | null =
    quickStateFilter === "all" ? null : (quickStateFilter as FleetArmStatePreset);
  const filterLabel = filterPreset
    ? filterPreset === "working"
      ? "Working"
      : filterPreset === "waiting"
        ? "Waiting"
        : "Finished"
    : null;

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
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={filterPreset === null}
        onSelect={() => {
          if (filterPreset === null) return;
          armByState(filterPreset, "current", false);
        }}
      >
        {filterLabel ? `Match active filter (${filterLabel})` : "Match active filter"}
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
          "surface-toolbar relative flex items-center gap-3 border-b border-daintree-border px-3 py-1 text-[12px] text-daintree-text",
          "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-[var(--color-accent-primary)] before:content-['']"
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

  return (
    <div data-testid="fleet-arming-ribbon-group">
      <AnimatePresence initial={false}>
        <motion.div
          key="fleet-arming-ribbon"
          role="status"
          aria-live="off"
          className={cn(
            "surface-toolbar relative flex items-center gap-3 overflow-hidden border-b border-daintree-border px-3 py-1 text-[12px] text-daintree-text",
            "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-[var(--color-accent-primary)] before:content-['']",
            "transition-shadow duration-300",
            isPulsing && "shadow-[0_0_0_2px_var(--color-accent-primary)]"
          )}
          data-testid="fleet-arming-ribbon"
          data-pulsing={isPulsing ? "true" : undefined}
          {...ribbonMotionProps}
        >
          <ArmedCountChip
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
              <kbd className="rounded border border-daintree-text/20 bg-tint/[0.06] px-1 font-mono text-[10px] leading-tight text-daintree-accent">
                {exitChordLabel}
              </kbd>
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
      <FleetComposer />
    </div>
  );
}

interface ArmedCountChipProps {
  armedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ArmedCountChip({ armedCount, open, onOpenChange }: ArmedCountChipProps): ReactElement {
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

  const label = `${armedCount} ${armedCount === 1 ? "agent" : "agents"} armed`;

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
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] transition-colors",
            "bg-tint/[0.08] hover:bg-tint/[0.14]"
          )}
        >
          <AnimatedLabel
            label={String(armedCount)}
            textClassName="font-semibold text-daintree-accent tabular-nums"
          />
          <span className="text-daintree-text/80">
            {armedCount === 1 ? "agent armed" : "agents armed"}
          </span>
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
          Armed terminals
        </div>
        <ul className="flex flex-col">
          {armOrder.length === 0 ? (
            <li className="px-2 py-1 text-[12px] text-daintree-text/60">None</li>
          ) : (
            armOrder.map((id) => (
              <li
                key={id}
                className="flex items-center gap-2 rounded px-2 py-1 hover:bg-tint/[0.08]"
              >
                <span className="flex-1 truncate text-[12px] text-daintree-text">
                  {panelsById[id] ?? id}
                </span>
                <button
                  type="button"
                  onClick={() => disarmId(id)}
                  aria-label={`Unarm ${panelsById[id] ?? id}`}
                  className="inline-flex shrink-0 items-center rounded p-0.5 text-daintree-text/50 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
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
