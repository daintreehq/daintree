import { Play, Circle, CheckCircle2 } from "lucide-react";
import type { AgentState } from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import {
  SpinnerCircle,
  HollowCircle,
  ApprovalCircle,
  InteractingCircle,
} from "@/components/icons/AgentStateCircles";

export const STATE_ICONS: Record<AgentState, React.ComponentType<{ className?: string }>> = {
  working: SpinnerCircle,
  running: Play,
  waiting: HollowCircle,
  directing: InteractingCircle,
  idle: Circle,
  completed: CheckCircle2,
};

export const STATE_COLORS: Record<AgentState, string> = {
  working: "text-state-working",
  running: "text-status-info",
  waiting: "text-state-waiting",
  directing: "text-category-blue",
  idle: "text-canopy-text/40",
  completed: "text-status-success",
};

export const STATE_LABELS: Record<AgentState, string> = {
  working: "working",
  running: "running",
  idle: "idle",
  waiting: "waiting",
  directing: "directing",
  completed: "done",
};

export const STATE_PRIORITY: AgentState[] = [
  "working",
  "directing",
  "waiting",
  "running",
  "completed",
  "idle",
];

export const STATE_SORT_PRIORITY: Record<AgentState, number> = {
  working: 0,
  directing: 1,
  waiting: 2,
  running: 3,
  idle: 4,
  completed: 5,
};

export function getEffectiveStateIcon(
  agentState: AgentState,
  waitingReason?: WaitingReason
): React.ComponentType<{ className?: string }> {
  if (agentState === "waiting" && waitingReason === "approval") {
    return ApprovalCircle;
  }
  return STATE_ICONS[agentState];
}

export function getEffectiveStateColor(
  agentState: AgentState,
  waitingReason?: WaitingReason
): string {
  if (agentState === "waiting" && waitingReason === "approval") {
    return "text-state-approval";
  }
  return STATE_COLORS[agentState];
}

export function getEffectiveStateLabel(
  agentState: AgentState,
  waitingReason?: WaitingReason
): string {
  if (agentState === "waiting" && waitingReason === "approval") {
    return "approval";
  }
  return STATE_LABELS[agentState];
}
