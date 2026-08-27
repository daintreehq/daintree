import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import type { AgentState } from "@/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATE_LABELS, STATE_PRIORITY } from "./terminalStateConfig";

interface AgentStatusIndicatorProps {
  state: AgentState | null | undefined;
  className?: string;
}

// Keys deliberately narrowed to states the render guard below actually renders:
// "idle" and "waiting" both early-return null, so including them here would be
// dead config. The explicit Record annotation enforces both the narrowing and
// exhaustiveness at compile time.
const STATE_CONFIG: Record<
  Exclude<AgentState, "idle" | "waiting">,
  {
    icon: string;
    color: string;
    bgColor?: string;
    borderColor?: string;
    glow?: string;
    tooltip: string;
  }
> = {
  working: {
    icon: "⟳",
    color: "status-working",
    tooltip: "Agent is working on your request",
  },
  completed: {
    icon: "✓",
    color: "text-status-info",
    tooltip: "Agent finished this task",
  },
  exited: {
    icon: "–",
    color: "text-daintree-text/40",
    tooltip: "Process exited",
  },
  directing: {
    icon: "✎",
    color: "text-status-info",
    borderColor: "border-status-info",
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
          aria-label={`Agent status: ${STATE_LABELS[state]}`}
          onAnimationEnd={() => setIsFlashing(false)}
        >
          {config.icon}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{config.tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function getDominantAgentState(states: (AgentState | undefined)[]): AgentState | null {
  const present = new Set<AgentState>();
  for (const state of states) {
    if (state !== undefined) present.add(state);
  }
  if (present.size === 0) return null;

  for (const state of STATE_PRIORITY) {
    if (present.has(state)) {
      return state === "idle" ? null : state;
    }
  }
  return null;
}

// Returns null for passive states (working, completed, exited, idle) so the
// callers skip rendering a badge entirely. Only `waiting` and `directing` —
// the actionable states a human should attend to — earn a visible dot. Keeping
// passive sessions unmarked lets the actionable few stand out on a toolbar
// that may show many running agents at once.
const AGENT_DOT_COLORS = {
  directing: "bg-state-working",
  waiting: "bg-state-waiting",
} as const satisfies Record<Extract<AgentState, "directing" | "waiting">, string>;

export function agentStateDotColor(state: AgentState): string | null {
  return (AGENT_DOT_COLORS as Partial<Record<AgentState, string>>)[state] ?? null;
}
