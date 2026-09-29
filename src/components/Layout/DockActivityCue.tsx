import type { CSSProperties } from "react";
import { CheckCircle2 } from "lucide-react";
import { SpinnerCircle } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
  UI_ENTER_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_DURATION,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import { getDockFinishedCueDwellMs } from "./useDockActivityState";
import { DOCK_STATE_GLYPH_CLASS } from "./dockChipStyles";

/**
 * The finished check's whole life is set on mount: it eases in from
 * `@starting-style`, holds, and fades out on a delayed animation timed to end
 * exactly when the dwell timer unmounts it — so nothing is cut mid-fade and no
 * second timer is needed. Reduced motion keeps the fades and drops the scale.
 */
export function getFinishedCheckMotion(dwellMs: number): CSSProperties {
  const exitDelay = Math.max(0, dwellMs - UI_EXIT_DURATION);
  return {
    transitionDuration: `${UI_ENTER_DURATION}ms`,
    transitionTimingFunction: UI_ENTER_EASING,
    animation: `overlay-fade-out ${UI_EXIT_DURATION}ms ${UI_EXIT_EASING} ${exitDelay}ms forwards`,
  };
}

interface DockActivityCueProps {
  state: "working" | "finished";
}

/**
 * Plain-terminal running/finished cue — the same slot as an agent chip's state
 * icon, shown only when no agent state occupies it. aria-hidden: the running
 * state rides the chip's accessible name, and the finished cue is transient and
 * must not spam a live region.
 */
export function DockActivityCue({ state }: DockActivityCueProps) {
  const working = state === "working";
  return (
    <div
      className={cn(
        "ml-1.5 flex items-center shrink-0",
        working ? "text-text-secondary" : "text-status-success"
      )}
      data-dock-activity-state={state}
      aria-hidden="true"
    >
      {working ? (
        <SpinnerCircle
          className={cn(DOCK_STATE_GLYPH_CLASS, "animate-spin-slow motion-reduce:animate-none")}
        />
      ) : (
        <CheckCircle2
          className={cn(
            DOCK_STATE_GLYPH_CLASS,
            "transition-[opacity,scale] starting:opacity-0 starting:scale-50 motion-reduce:transition-opacity motion-reduce:scale-none"
          )}
          style={getFinishedCheckMotion(getDockFinishedCueDwellMs())}
        />
      )}
    </div>
  );
}
