import { Loader2, Play, AlertCircle, Circle, CheckCircle2, XCircle } from "lucide-react";
import type { AgentState } from "@/types";

export const STATE_ICONS: Record<AgentState, React.ComponentType<{ className?: string }>> = {
  working: Loader2,
  running: Play,
  waiting: AlertCircle,
  idle: Circle,
  completed: CheckCircle2,
  failed: XCircle,
};

export const STATE_COLORS: Record<AgentState, string> = {
  working: "text-[var(--color-state-working)]",
  running: "text-[var(--color-status-info)]",
  waiting: "text-[var(--color-state-waiting)]",
  idle: "text-canopy-text/40",
  completed: "text-[var(--color-status-success)]",
  failed: "text-[var(--color-status-error)]",
};

export const STATE_LABELS: Record<AgentState, string> = {
  working: "working",
  running: "running",
  idle: "idle",
  waiting: "waiting",
  completed: "done",
  failed: "error",
};

export const STATE_PRIORITY: AgentState[] = [
  "working",
  "waiting",
  "failed",
  "running",
  "completed",
  "idle",
];

export const STATE_SORT_PRIORITY: Record<AgentState, number> = {
  working: 0,
  waiting: 1,
  running: 2,
  idle: 3,
  completed: 4,
  failed: 5,
};
