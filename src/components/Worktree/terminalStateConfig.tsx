import { Circle, CheckCircle2 } from "lucide-react";
import type { AgentState } from "@/types";
import {
  SpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
} from "@/components/icons/AgentStateCircles";

export const STATE_ICONS: Record<AgentState, React.ComponentType<{ className?: string }>> = {
  working: SpinnerCircle,
  waiting: HollowCircle,
  directing: InteractingCircle,
  idle: Circle,
  completed: CheckCircle2,
  exited: ExitedCircle,
};

export const STATE_COLORS: Record<AgentState, string> = {
  working: "text-state-working",
  waiting: "text-state-waiting",
  directing: "text-category-blue",
  idle: "text-daintree-text/40",
  completed: "text-status-success",
  exited: "text-daintree-text/40",
};

export const STATE_LABELS: Record<AgentState, string> = {
  working: "working",
  idle: "idle",
  waiting: "waiting",
  directing: "directing",
  completed: "done",
  exited: "exited",
};

export const STATE_PRIORITY: AgentState[] = [
  "working",
  "directing",
  "waiting",
  "completed",
  "exited",
  "idle",
];

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
