import { Play, Circle, CheckCircle2 } from "lucide-react";
import type { AgentState } from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import {
  SpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
  PromptCircle,
  QuestionCircle,
} from "@/components/icons/AgentStateCircles";

export const STATE_ICONS: Record<AgentState, React.ComponentType<{ className?: string }>> = {
  working: SpinnerCircle,
  running: Play,
  waiting: HollowCircle,
  directing: InteractingCircle,
  idle: Circle,
  completed: CheckCircle2,
  exited: ExitedCircle,
};

export const STATE_COLORS: Record<AgentState, string> = {
  working: "text-state-working",
  running: "text-status-info",
  waiting: "text-state-waiting",
  directing: "text-category-blue",
  idle: "text-daintree-text/40",
  completed: "text-status-success",
  exited: "text-daintree-text/40",
};

export const STATE_LABELS: Record<AgentState, string> = {
  working: "working",
  running: "running",
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
  "running",
  "completed",
  "exited",
  "idle",
];

export const STATE_SORT_PRIORITY: Record<AgentState, number> = {
  working: 0,
  directing: 1,
  waiting: 2,
  running: 3,
  idle: 4,
  completed: 5,
  exited: 6,
};

export function getEffectiveStateIcon(
  agentState: AgentState,
  waitingReason?: WaitingReason
): React.ComponentType<{ className?: string }> {
  if (agentState === "waiting" && waitingReason) {
    if (waitingReason === "prompt") return PromptCircle;
    if (waitingReason === "question") return QuestionCircle;
  }
  return STATE_ICONS[agentState];
}

export function getEffectiveStateColor(
  agentState: AgentState,
  waitingReason?: WaitingReason
): string {
  if (agentState === "waiting" && waitingReason === "prompt") {
    return "text-status-warning";
  }
  return STATE_COLORS[agentState];
}

export function getEffectiveStateLabel(
  agentState: AgentState,
  waitingReason?: WaitingReason
): string {
  if (agentState === "waiting") {
    if (waitingReason === "prompt") return "waiting for input";
    if (waitingReason === "question") return "waiting (question)";
  }
  return STATE_LABELS[agentState];
}
