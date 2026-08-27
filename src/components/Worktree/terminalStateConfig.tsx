import { Circle, CheckCircle2 } from "lucide-react";
import type { AgentState } from "@/types";
import { SpinnerCircle, HollowCircle, InteractingCircle, ExitedCircle } from "@/components/icons";

export const STATE_ICONS = {
  working: SpinnerCircle,
  waiting: HollowCircle,
  directing: InteractingCircle,
  idle: Circle,
  completed: CheckCircle2,
  exited: ExitedCircle,
} satisfies Record<AgentState, React.ComponentType<{ className?: string }>>;

export const STATE_COLORS = {
  working: "text-state-working",
  waiting: "text-state-waiting",
  directing: "text-category-blue",
  idle: "text-text-secondary",
  completed: "text-category-slate",
  exited: "text-text-secondary",
} as const satisfies Record<AgentState, string>;

export const STATE_LABELS = {
  working: "working",
  idle: "idle",
  waiting: "waiting",
  directing: "directing",
  completed: "done",
  exited: "exited",
} as const satisfies Record<AgentState, string>;

export const STATE_PRIORITY = [
  "working",
  "directing",
  "waiting",
  "completed",
  "exited",
  "idle",
] as const satisfies readonly AgentState[];

export function getEffectiveStateIcon(
  agentState: AgentState
): React.ComponentType<{ className?: string }> {
  return STATE_ICONS[agentState];
}

export function getEffectiveStateColor(agentState: AgentState): string {
  return STATE_COLORS[agentState];
}

export function getEffectiveStateLabel(agentState: AgentState): string {
  return STATE_LABELS[agentState];
}
