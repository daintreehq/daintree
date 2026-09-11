import { Cpu, Hourglass, Pause, type LucideIcon } from "lucide-react";
import type { TerminalFlowStatus } from "@/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";

// FUTURE_SAB: the `flowStatus` prop is widened to `TerminalFlowStatus` (not
// `PersistableFlowStatus`) so the suspended presentation below remains
// type-safe while `suspended` is a skeleton value with no production producer
// (#9900). Callers in practice only pass `PersistableFlowStatus` values; the
// wider type is purely so the future-sab branch is reachable. When the SAB
// transport path is revived, restore the narrow prop type.

type HoldStatus = Extract<
  TerminalFlowStatus,
  "paused-backpressure" | "paused-resource-governor" | "suspended"
>;

interface HoldDisplay {
  icon: LucideIcon;
  label: string;
  title: string;
  body: string;
  showsHeldDuration: boolean;
}

// Auto-recovering flow holds are Tier-1 ambient, demoted off `status-warning`
// per docs/architecture/resource-governance.md#173. Each keeps its own glyph.
const HOLD_DISPLAY: Record<HoldStatus, HoldDisplay> = {
  "paused-backpressure": {
    icon: Pause,
    label: "Output paused",
    title: "Buffer overflow",
    body: "Output paused to prevent data loss.",
    showsHeldDuration: true,
  },
  "paused-resource-governor": {
    icon: Cpu,
    label: "Paused for memory pressure",
    title: "System memory pressure",
    body: "Paused to reduce memory pressure. Recovers automatically.",
    // ResourceGovernor pauses via the coordinator but does not emit
    // `pause-start` / `pause-end` reliability metrics, so the
    // `pause-duration-gauge` funnel never tracks it. A frozen "Paused for Xs"
    // line would be a lie.
    showsHeldDuration: false,
  },
  // FUTURE_SAB: `suspended` is only emitted by the SharedArrayBuffer transport
  // path in the PTY host (`BackpressureManager.suspendVisualStream`, see
  // `electron/pty-host/backpressure.ts`). That path is unreachable in
  // production — SharedArrayBuffer is not supported in Electron UtilityProcess
  // (PR #7724, issue #7653) — so this never renders until the SAB transport is
  // revived. See issue #9900.
  suspended: {
    icon: Hourglass,
    label: "Output suspended",
    title: "Output suspended",
    body: "Streaming stalled. Recovers automatically on focus.",
    showsHeldDuration: true,
  },
};

function toHoldStatus(status: TerminalFlowStatus | undefined): HoldStatus | null {
  switch (status) {
    case "paused-backpressure":
    case "paused-resource-governor":
    case "suspended":
      return status;
    default:
      return null;
  }
}

function HeldDuration({ id }: { id: string }) {
  const heldDurationMs = usePanelStore((state) => {
    const panel = state.panelsById[id];
    return panel && isPtyPanel(panel) ? panel.heldDurationMs : undefined;
  });
  if (heldDurationMs == null || heldDurationMs <= 0) return null;
  return (
    <span className="text-text-secondary tabular-nums">
      Paused for {formatElapsedDuration(heldDurationMs)}
    </span>
  );
}

export interface TerminalStatusSlotProps {
  id: string;
  flowStatus?: TerminalFlowStatus;
  /**
   * Submit-lane state for this terminal (#11875). Only `"slow"` renders here —
   * it is the Tier-1 ambient half of the signal. `"stalled"`/`"failed"` escalate
   * to `TerminalSubmitStatusBanner` in the pane, which owns the recovery action.
   */
  submitStatus?: "slow" | "stalled" | "failed";
}

/**
 * Transient pane status as one fixed-size glyph, with the explanation in its
 * tooltip. `PanelHeader` reserves the box whether or not anything is showing,
 * so a status coming or going never moves the window controls and never
 * resizes the terminal (#12374).
 *
 * Deliberately no action: a slow submit still has its original Enter armed, so
 * any "send again" affordance would double-submit, and flow holds recover on
 * their own.
 */
export function TerminalStatusSlot({ id, flowStatus, submitStatus }: TerminalStatusSlotProps) {
  const hold = toHoldStatus(flowStatus);
  const isSubmitSlow = submitStatus === "slow";
  const isActive = hold !== null || isSubmitSlow;

  const holdDisplay = hold ? HOLD_DISPLAY[hold] : null;
  // Held output is often why a prompt has not landed yet, so the hold owns the
  // glyph; the label and tooltip still name both states.
  const Icon = holdDisplay?.icon ?? Hourglass;
  const label = holdDisplay
    ? isSubmitSlow
      ? `${holdDisplay.label}, prompt still sending`
      : holdDisplay.label
    : "Prompt still sending";

  // The glyph shows no text, so it takes focus and its tooltip stays up while
  // focused — the tooltip is the only place a keyboard user can read the
  // explanation. The same trigger element renders when nothing is showing, so
  // focus sitting on it when the status clears stays put instead of dropping
  // to the document body; idle, it has no role, no name and no tab stop.
  //
  // aria-live="off" overrides role="status"'s implicit polite live region; the
  // global announcer owns announcements across a multi-pane fleet (#9204).
  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <span
          className="flex h-5 w-5 items-center justify-center rounded-sm text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
          role={isActive ? "status" : undefined}
          aria-live="off"
          aria-label={isActive ? label : undefined}
          tabIndex={isActive ? 0 : -1}
        >
          {isActive && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
        </span>
      </TooltipTrigger>
      {isActive && (
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="flex flex-col gap-2">
            {holdDisplay && (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{holdDisplay.title}</span>
                <span>{holdDisplay.body}</span>
                {holdDisplay.showsHeldDuration && <HeldDuration id={id} />}
              </div>
            )}
            {isSubmitSlow && (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">Still sending</span>
                <span>Later prompts stay queued so they can&apos;t merge into this one.</span>
              </div>
            )}
          </div>
        </TooltipContent>
      )}
    </Tooltip>
  );
}
