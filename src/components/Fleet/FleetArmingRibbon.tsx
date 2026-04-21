import { useEffect, useRef, useState, type ReactElement } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useEscapeStack } from "@/hooks";
import { useFleetArmingStore, type FleetArmStatePreset } from "@/store/fleetArmingStore";
import {
  useFleetPendingActionStore,
  type FleetPendingActionKind,
} from "@/store/fleetPendingActionStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { usePanelStore } from "@/store/panelStore";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FleetComposer } from "./FleetComposer";

interface PresetOption {
  value: FleetArmStatePreset;
  label: string;
}

const PRESETS: PresetOption[] = [
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "finished", label: "Finished" },
];

interface ArmedCounts {
  live: number;
  waiting: number;
  workingOrRunning: number;
  sessionLoss: number;
}

const DOUBLE_ESC_WINDOW_MS = 350;

function useArmedCounts(): ArmedCounts {
  return usePanelStore(
    useShallow((state) => {
      const armedIds = useFleetArmingStore.getState().armedIds;
      let live = 0;
      let waiting = 0;
      let workingOrRunning = 0;
      let sessionLoss = 0;
      for (const id of armedIds) {
        const t = state.panelsById[id];
        if (!t) continue;
        if (t.location === "trash" || t.location === "background") continue;
        if (t.hasPty === false) continue;
        live++;
        if (t.agentState === "waiting") waiting++;
        if (t.agentState === "working" || t.agentState === "running") workingOrRunning++;
        if (t.agentSessionId) sessionLoss++;
      }
      return { live, waiting, workingOrRunning, sessionLoss };
    })
  );
}

type QuickActionId =
  | "fleet.accept"
  | "fleet.reject"
  | "fleet.interrupt"
  | "fleet.restart"
  | "fleet.kill"
  | "fleet.trash";

interface QuickAction {
  id: QuickActionId;
  label: string;
  chordOverride?: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { id: "fleet.accept", label: "Accept" },
  { id: "fleet.reject", label: "Reject" },
  { id: "fleet.interrupt", label: "Interrupt", chordOverride: "⌘⎋⎋" },
  { id: "fleet.restart", label: "Restart" },
  { id: "fleet.kill", label: "Kill" },
  { id: "fleet.trash", label: "Trash" },
];

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
  const counts = useArmedCounts();
  const pending = useFleetPendingActionStore((s) => s.pending);
  const clearPending = useFleetPendingActionStore((s) => s.clear);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (armedCount === 0 && popoverOpen) {
      setPopoverOpen(false);
    }
  }, [armedCount, popoverOpen]);

  // Escape stack: confirmation cancel sits above the fleet-disarm entry, so
  // the first Escape while confirming clears the pending action and a
  // second Escape disarms the fleet. The armed-list popover, when open,
  // sits on top so the first Escape closes the list and a subsequent
  // Escape disarms.
  useEscapeStack(pending !== null, clearPending);
  useEscapeStack(armedCount > 0 && pending === null, clear);
  useEscapeStack(popoverOpen, () => setPopoverOpen(false));

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
      const actionId: QuickActionId =
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

  // Cmd+Esc Esc double-tap → fleet.interrupt. The Cmd modifier is what
  // separates this from the plain-Escape escape-stack LIFO used elsewhere
  // in the app: bare Escape continues to dismiss confirmations / disarm
  // the fleet without poisoning the double-tap timer. (An earlier
  // bare-Escape version had a race where cancelling a confirmation with
  // Escape then pressing Escape again to disarm fired fleet.interrupt.)
  const lastEscapeMsRef = useRef<number>(0);
  useEffect(() => {
    if (armedCount === 0) {
      lastEscapeMsRef.current = 0;
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Cmd on macOS, Ctrl on other platforms — keybindingService
      // normalizes the two, but for a raw listener we accept either.
      if (!e.metaKey && !e.ctrlKey) return;
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
      const now = Date.now();
      const prev = lastEscapeMsRef.current;
      lastEscapeMsRef.current = now;
      if (prev === 0 || now - prev > DOUBLE_ESC_WINDOW_MS) return;
      lastEscapeMsRef.current = 0;
      e.stopPropagation();
      e.preventDefault();
      void actionService.dispatch("fleet.interrupt", undefined, { source: "keybinding" });
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [armedCount]);

  if (armedCount === 0) return null;

  if (pending !== null) {
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

  const isEligible = (id: QuickActionId): boolean => {
    switch (id) {
      case "fleet.accept":
      case "fleet.reject":
        return counts.waiting > 0;
      case "fleet.interrupt":
        return counts.workingOrRunning > 0 || counts.waiting > 0;
      case "fleet.restart":
      case "fleet.kill":
      case "fleet.trash":
        return counts.live > 0;
    }
  };

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

  return (
    <div data-testid="fleet-arming-ribbon-group">
      <AnimatePresence initial={false}>
        <motion.div
          key="fleet-arming-ribbon"
          role="status"
          aria-live="off"
          className={cn(
            "surface-toolbar relative flex items-center gap-3 overflow-hidden border-b border-daintree-border px-3 py-1 text-[12px] text-daintree-text",
            "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-[var(--color-accent-primary)] before:content-['']"
          )}
          data-testid="fleet-arming-ribbon"
          {...ribbonMotionProps}
        >
          <ArmedCountChip
            armedCount={armedCount}
            open={popoverOpen}
            onOpenChange={setPopoverOpen}
          />
          <div className="flex items-center gap-1" role="toolbar" aria-label="Arm by state">
            {PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={(e) => {
                  armByState(preset.value, "current", e.shiftKey);
                }}
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] transition-colors",
                  "bg-tint/[0.08] text-daintree-text/80 hover:bg-tint/[0.14] hover:text-daintree-text"
                )}
                aria-label={`Arm ${preset.label.toLowerCase()} agents (shift to extend)`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1" role="toolbar" aria-label="Fleet quick actions">
            {QUICK_ACTIONS.map((action) => {
              const eligible = isEligible(action.id);
              const chord =
                action.chordOverride ?? keybindingService.getDisplayCombo(action.id) ?? "";
              return (
                <button
                  key={action.id}
                  type="button"
                  disabled={!eligible}
                  onClick={() => {
                    void actionService.dispatch(action.id, undefined, { source: "user" });
                  }}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors",
                    eligible
                      ? "bg-tint/[0.08] text-daintree-text/80 hover:bg-tint/[0.14] hover:text-daintree-text"
                      : "cursor-not-allowed bg-tint/[0.04] text-daintree-text/30"
                  )}
                  aria-label={`${action.label} armed agents (${chord})`}
                  data-testid={`fleet-quick-${action.id.replace("fleet.", "")}`}
                >
                  <span>{action.label}</span>
                  {chord ? (
                    <kbd className="rounded border border-daintree-text/20 bg-tint/[0.06] px-1 font-mono text-[10px] leading-tight">
                      {chord}
                    </kbd>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={clear}
              aria-label="Exit fleet mode (Esc)"
              data-testid="fleet-exit"
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition-colors",
                "bg-tint/[0.08] text-daintree-text/80 hover:bg-tint/[0.14] hover:text-daintree-text"
              )}
            >
              <span>Exit</span>
              <kbd className="rounded border border-daintree-text/20 bg-tint/[0.06] px-1 font-mono text-[10px] leading-tight text-daintree-accent">
                Esc
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
          <span className="font-semibold text-daintree-accent tabular-nums">{armedCount}</span>
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
