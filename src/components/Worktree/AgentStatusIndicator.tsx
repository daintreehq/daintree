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
    pulse: boolean;
    label: string;
    tooltip: string;
  }
> = {
  working: {
    icon: "⟳",
    color: "status-working",
    pulse: false,
    label: "working",
    tooltip: "Agent is working on your request",
  },
  running: {
    icon: "▶",
    color: "text-status-info",
    borderColor: "border-status-info",
    pulse: false,
    label: "running",
    tooltip: "Process is running",
  },
  waiting: {
    icon: "?",
    color: "text-daintree-bg",
    bgColor: "bg-state-waiting",
    glow: "shadow-[0_0_8px_color-mix(in_srgb,var(--color-activity-waiting)_40%,transparent)]",
    pulse: false,
    label: "waiting",
    tooltip: "Agent is waiting for your direction",
  },
  completed: {
    icon: "✓",
    color: "text-status-success",
    pulse: false,
    label: "completed",
    tooltip: "Agent finished this task",
  },
  exited: {
    icon: "–",
    color: "text-daintree-text/40",
    pulse: false,
    label: "exited",
    tooltip: "Process exited",
  },
  directing: {
    icon: "✎",
    color: "text-status-info",
    borderColor: "border-status-info",
    pulse: false,
    label: "directing",
    tooltip: "You are typing a prompt for this agent",
  },
};

export function AgentStatusIndicator({ state, className }: AgentStatusIndicatorProps) {
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
            config.pulse && "animate-agent-pulse",
            className
          )}
          role="status"
          aria-label={`Agent status: ${config.label}`}
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
  running: 5,
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

export function agentStateDotColor(state: AgentState): string {
  switch (state) {
    case "working":
    case "running":
    case "directing":
      return "bg-state-working";
    case "waiting":
      return "bg-state-waiting";
    default:
      return "bg-daintree-accent";
  }
}
