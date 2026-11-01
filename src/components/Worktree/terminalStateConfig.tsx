import type { AgentState } from "@/types";
import {
  SpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
  DoneCircle,
  IdleCircle,
  UnreadCircle,
  BlockedCircle,
} from "@/components/icons";
import { pluralize } from "@/lib/pluralize";
import type { SessionPresentationState } from "@/lib/handBackPresentation";
import type { PaneSessionPresentationState } from "@/lib/paneSessionPresentation";

export const STATE_ICONS = {
  working: SpinnerCircle,
  waiting: HollowCircle,
  directing: InteractingCircle,
  idle: IdleCircle,
  completed: DoneCircle,
  exited: ExitedCircle,
} satisfies Record<AgentState, React.ComponentType<{ className?: string }>>;

export const STATE_COLORS = {
  working: "text-state-working",
  waiting: "text-state-waiting",
  directing: "text-category-blue",
  idle: "text-text-secondary",
  completed: "text-text-secondary",
  exited: "text-text-secondary",
} as const satisfies Record<AgentState, string>;

export const STATE_LABELS = {
  working: "working",
  idle: "idle",
  waiting: "waiting",
  directing: "directing",
  completed: "finished",
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

/**
 * The state maps for a session glyph, which adds the presentation-only `unread`
 * hand-back to the observed states. Neutral like `completed`: a turn handed
 * back is not the agent asking for anything, so it never takes the waiting hue.
 */
export const SESSION_ICONS = {
  ...STATE_ICONS,
  unread: UnreadCircle,
} satisfies Record<SessionPresentationState, React.ComponentType<{ className?: string }>>;

export const SESSION_COLORS = {
  ...STATE_COLORS,
  unread: "text-text-primary",
} as const satisfies Record<SessionPresentationState, string>;

export const SESSION_LABELS = {
  ...STATE_LABELS,
  unread: "unread",
} as const satisfies Record<SessionPresentationState, string>;

/**
 * The state maps for a pane header's glyph, which adds `blocked` for an error
 * wait: the same failure mark and hue the header gives a plugin's failed
 * activity, so an agent stopped on an error never wears the waiting ring.
 */
export const PANE_SESSION_ICONS = {
  ...SESSION_ICONS,
  blocked: BlockedCircle,
} satisfies Record<PaneSessionPresentationState, React.ComponentType<{ className?: string }>>;

export const PANE_SESSION_COLORS = {
  ...SESSION_COLORS,
  blocked: "text-status-error",
} as const satisfies Record<PaneSessionPresentationState, string>;

export const PANE_SESSION_LABELS = {
  ...SESSION_LABELS,
  blocked: "blocked",
} as const satisfies Record<PaneSessionPresentationState, string>;

export const SESSION_PRIORITY = [
  "working",
  "directing",
  "waiting",
  "unread",
  "completed",
  "exited",
  "idle",
] as const satisfies readonly SessionPresentationState[];

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

/**
 * The states that earn a corner pip on an agent's toolbar or dock button.
 * Passive states (working, completed, exited, idle) get none, so the few
 * sessions that want a human stand out on a toolbar running many agents.
 * Waiting is the agent asking; directing is the user's own unsent prompt.
 */
export const ATTENTION_PRIORITY = ["waiting", "directing"] as const satisfies readonly AgentState[];

export type AttentionAgentState = (typeof ATTENTION_PRIORITY)[number];

/**
 * The pip state for a set of sessions. Deliberately not `STATE_PRIORITY`,
 * which ranks working first: one busy session would then hide a sibling that
 * is waiting on the user, which is the one thing the pip exists to show.
 */
export function getAttentionAgentState(
  states: Iterable<AgentState | undefined>
): AttentionAgentState | null {
  const present = new Set<AgentState | undefined>(states);
  return ATTENTION_PRIORITY.find((state) => present.has(state)) ?? null;
}

// The pip takes the hue of the state's own glyph in STATE_COLORS, so a blue
// pip and a blue InteractingCircle mean the same thing wherever they appear.
const AGENT_DOT_COLORS = {
  waiting: "bg-state-waiting",
  directing: "bg-category-blue",
} as const satisfies Record<AttentionAgentState, string>;

export function agentStateDotColor(state: AgentState): string | null {
  return (AGENT_DOT_COLORS as Partial<Record<AgentState, string>>)[state] ?? null;
}

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
  visibleStates: { state: SessionPresentationState; count: number }[];
  /** "3 sessions: 2 working, 1 waiting" — also the collapsed indicator's tooltip. */
  label: string;
  /** "2 working, 1 waiting", or "" when every session is idle. */
  breakdown: string;
}

/**
 * The one derivation behind every collapsed session summary. Idle is left out
 * of the breakdown on purpose, so the total is stated separately rather than
 * left to be added up from the segments — it would come out short.
 *
 * `unread` counts hand-backs the user has not read, kept apart from `byState`
 * because `byState` holds observed states only.
 */
export function summarizeSessionStates(
  byState: Record<AgentState, number>,
  total: number,
  unread = 0
): SessionStateSummary {
  const counts: Record<SessionPresentationState, number> = { ...byState, unread };
  const visibleStates = SESSION_PRIORITY.filter((s) => s !== "idle" && counts[s] > 0).map((s) => ({
    state: s,
    count: counts[s],
  }));
  if (total <= 0) return { visibleStates, label: "", breakdown: "" };
  const breakdown = visibleStates.map((v) => `${v.count} ${SESSION_LABELS[v.state]}`).join(", ");
  const sessions = `${pluralize(total, "session")}`;
  return { visibleStates, label: breakdown ? `${sessions}: ${breakdown}` : sessions, breakdown };
}
