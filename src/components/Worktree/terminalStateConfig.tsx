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

export interface SessionStateSummary {
  visibleStates: { state: AgentState; count: number }[];
  /** "3 sessions: 2 working, 1 waiting" — also the collapsed indicator's tooltip. */
  label: string;
  /** "2 working, 1 waiting", or "" when every session is idle. */
  breakdown: string;
}

/**
 * The one derivation behind every collapsed session summary. Idle is left out
 * of the breakdown on purpose, so the total is stated separately rather than
 * left to be added up from the segments — it would come out short.
 */
export function summarizeSessionStates(
  byState: Record<AgentState, number>,
  total: number
): SessionStateSummary {
  const visibleStates = STATE_PRIORITY.filter((s) => s !== "idle" && byState[s] > 0).map((s) => ({
    state: s,
    count: byState[s],
  }));
  if (total <= 0) return { visibleStates, label: "", breakdown: "" };
  const breakdown = visibleStates.map((v) => `${v.count} ${STATE_LABELS[v.state]}`).join(", ");
  const sessions = `${total} session${total !== 1 ? "s" : ""}`;
  return { visibleStates, label: breakdown ? `${sessions}: ${breakdown}` : sessions, breakdown };
}
