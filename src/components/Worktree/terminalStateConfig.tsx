import { Play, Circle, CheckCircle2, XCircle } from "lucide-react";
import type { AgentState } from "@/types";
import {
  SpinnerCircle,
  HollowCircle,
  InteractingCircle,
} from "@/components/icons/AgentStateCircles";

export const STATE_ICONS: Record<AgentState, React.ComponentType<{ className?: string }>> = {
  working: SpinnerCircle,
  running: Play,
  waiting: HollowCircle,
  directing: InteractingCircle,
  idle: Circle,
  completed: CheckCircle2,
  failed: XCircle,
};

export const STATE_COLORS: Record<AgentState, string> = {
  working: "text-state-working",
  running: "text-status-info",
  waiting: "text-state-waiting",
  directing: "text-status-info",
  idle: "text-canopy-text/40",
  completed: "text-status-success",
  failed: "text-status-error",
};

export const STATE_LABELS: Record<AgentState, string> = {
  working: "working",
  running: "running",
  idle: "idle",
  waiting: "waiting",
  directing: "directing",
  completed: "done",
  failed: "error",
};

export const STATE_PRIORITY: AgentState[] = [
  "working",
  "failed",
  "directing",
  "waiting",
  "running",
  "completed",
  "idle",
];

export const STATE_SORT_PRIORITY: Record<AgentState, number> = {
  working: 0,
  failed: 1,
  directing: 2,
  waiting: 3,
  running: 4,
  idle: 5,
  completed: 6,
};
