import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import type { AgentState } from "@/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface AgentStatusIndicatorProps {
  state: AgentState | null | undefined;
  className?: string;
}

const STATE_CONFIG: Record<
  Exclude<AgentState, "idle">,
  {
    icon: string;
    color: string;
    bgColor?: string;
    borderColor?: string;
    glow?: string;
    label: string;
    tooltip: string;
  }
> = {
  working: {
    icon: "⟳",
    color: "status-working",
    label: "working",
    tooltip: "Agent is working on your request",
  },
  waiting: {
    icon: "?",
    color: "text-daintree-bg",
    bgColor: "bg-state-waiting",
    glow: "shadow-[0_0_8px_color-mix(in_srgb,var(--color-activity-waiting)_40%,transparent)]",
    label: "waiting",
    tooltip: "Agent is waiting for your direction",
  },
  completed: {
    icon: "✓",
    color: "text-status-success",
    label: "completed",
    tooltip: "Agent finished this task",
  },
  exited: {
    icon: "–",
    color: "text-daintree-text/40",
    label: "exited",
    tooltip: "Process exited",
  },
  directing: {
    icon: "✎",
    color: "text-status-info",
    borderColor: "border-status-info",
    label: "directing",
    tooltip: "You are typing a prompt for this agent",
  },
};

export function AgentStatusIndicator({ state, className }: AgentStatusIndicatorProps) {
  const prevStateRef = useRef<AgentState | null | undefined>(state);
  const [isFlashing, setIsFlashing] = useState(false);

  // Trigger a one-shot flash when the state actually changes — replaces the
  // previous 1.5s infinite pulse. Status being a value doesn't deserve motion;
  // status changing does. Skipped on first render (prevState seeded to current).
  useEffect(() => {
    if (prevStateRef.current !== state) {
      prevStateRef.current = state;
      setIsFlashing(true);
    }
  }, [state]);

  // Safety cleanup — under reduced-motion CSS sets `animation: none`, so the
  // `animationend` event never fires and `isFlashing` would latch true,
  // preventing subsequent transitions from producing a class-remove/re-add
  // cycle. The timeout is slightly longer than the animation so it only wins
  // the race when `animationend` is suppressed.
  useEffect(() => {
    if (!isFlashing) return;
    const timer = setTimeout(() => setIsFlashing(false), 250);
    return () => clearTimeout(timer);
  }, [isFlashing]);

  if (!state || state === "idle" || state === "waiting") {
    return null;
  }

  const config = STATE_CONFIG[state];
  if (!config) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center justify-center w-5 h-5 text-xs font-bold rounded-full",
            config.color,
            config.bgColor,
            config.borderColor && "border",
            config.borderColor,
            config.glow,
            isFlashing && "animate-agent-pulse",
            className
          )}
          role="img"
          aria-label={`Agent status: ${config.label}`}
          onAnimationEnd={() => setIsFlashing(false)}
        >
          {config.icon}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{config.tooltip}</TooltipContent>
    </Tooltip>
  );
}

const STATE_PRIORITY: Record<AgentState, number> = {
  working: 7,
  directing: 6,
  completed: 4,
  waiting: 3,
  exited: 2,
  idle: 1,
};

export function getDominantAgentState(states: (AgentState | undefined)[]): AgentState | null {
  const validStates = states.filter((s): s is AgentState => s !== undefined);

  if (validStates.length === 0) {
    return null;
  }

  let dominant: AgentState = "idle";
  let highestPriority = 0;

  for (const state of validStates) {
    const priority = STATE_PRIORITY[state] ?? 0;
    if (priority > highestPriority) {
      highestPriority = priority;
      dominant = state;
    }
  }

  return dominant === "idle" ? null : dominant;
}

// Returns null for passive states (working, completed, exited, idle) so the
// callers skip rendering a badge entirely. Only `waiting` and `directing` —
// the actionable states a human should attend to — earn a visible dot. Keeping
// passive sessions unmarked lets the actionable few stand out on a toolbar
// that may show many running agents at once.
export function agentStateDotColor(state: AgentState): string | null {
  switch (state) {
    case "directing":
      return "bg-state-working";
    case "waiting":
      return "bg-state-waiting";
    default:
      return null;
  }
}
