import type { PluginAgentRun, PluginAllAgentsSnapshot } from "../types/plugin.js";
import type { AgentState } from "../types/agent.js";
import type { FleetRunRow, FleetSnapshot } from "../types/ipc/fleet.js";
import { isScratchWorkspaceId } from "./workspaceIds.js";

/**
 * The answer before the fleet has been read once, and after the plugin is gone.
 * Degraded with no successful read is "can't tell", which a plugin must not
 * render as an empty app.
 */
export const UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT: PluginAllAgentsSnapshot = Object.freeze({
  agents: Object.freeze([]) as readonly PluginAgentRun[],
  degraded: true,
  lastSuccessfulAt: null,
});

type AgentRunFields = {
  workspaceId: string;
  terminalId: string;
  worktreeId?: unknown;
  title?: unknown;
  agentId?: unknown;
  observedState?: unknown;
};

/**
 * Build one frozen {@link PluginAgentRun} by explicit assignment — never a
 * spread. A fleet row also carries the cwd, the raw OSC title, launch hints and
 * park/snooze records (with the user's note), none of which `agent:read`
 * exposes; a type narrower than the data strips nothing at runtime.
 */
function buildAgentRun(fields: AgentRunFields): PluginAgentRun {
  const run: {
    workspaceId: string;
    workspaceKind: "project" | "scratch";
    terminalId: string;
    worktreeId?: string;
    title?: string;
    agentId?: string;
    observedState?: AgentState;
  } = {
    workspaceId: fields.workspaceId,
    workspaceKind: isScratchWorkspaceId(fields.workspaceId) ? "scratch" : "project",
    terminalId: fields.terminalId,
  };
  if (typeof fields.worktreeId === "string") run.worktreeId = fields.worktreeId;
  if (typeof fields.title === "string") run.title = fields.title;
  if (typeof fields.agentId === "string") run.agentId = fields.agentId;
  if (typeof fields.observedState === "string") {
    run.observedState = fields.observedState as AgentState;
  }
  return Object.freeze(run);
}

function freezeSnapshot(
  agents: PluginAgentRun[],
  degraded: boolean,
  lastSuccessfulAt: number | null
): PluginAllAgentsSnapshot {
  return Object.freeze({
    agents: Object.freeze(agents) as readonly PluginAgentRun[],
    degraded,
    lastSuccessfulAt,
  });
}

function toPluginAgentRun(row: FleetRunRow): PluginAgentRun {
  return buildAgentRun({
    workspaceId: row.workspaceId,
    terminalId: row.runId,
    worktreeId: row.worktreeId,
    title: row.title,
    agentId: row.agentId,
    observedState: row.agentState,
  });
}

/**
 * Project main's fleet snapshot down to the plugin allowlist. A null snapshot
 * (nothing computed yet) becomes the unavailable answer, not an empty fleet.
 */
export function toPluginAllAgentsSnapshot(
  snapshot: FleetSnapshot | null | undefined
): PluginAllAgentsSnapshot {
  if (!snapshot) return UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT;
  return freezeSnapshot(
    snapshot.runs.map(toPluginAgentRun),
    snapshot.degraded,
    snapshot.lastSuccessfulAt
  );
}

/**
 * Re-apply the allowlist and freeze to a snapshot that was already projected
 * but crossed a structured clone (worker IPC drops frozenness) or came from a
 * test seed that may carry extra fields. Malformed input reads as unavailable.
 */
export function normalizePluginAllAgentsSnapshot(value: unknown): PluginAllAgentsSnapshot {
  if (typeof value !== "object" || value === null) return UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT;
  const raw = value as { agents?: unknown; degraded?: unknown; lastSuccessfulAt?: unknown };
  if (!Array.isArray(raw.agents)) return UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT;
  const agents: PluginAgentRun[] = [];
  for (const entry of raw.agents as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.workspaceId !== "string" || typeof e.terminalId !== "string") continue;
    agents.push(
      buildAgentRun({
        workspaceId: e.workspaceId,
        terminalId: e.terminalId,
        worktreeId: e.worktreeId,
        title: e.title,
        agentId: e.agentId,
        observedState: e.observedState,
      })
    );
  }
  return freezeSnapshot(
    agents,
    raw.degraded === true,
    typeof raw.lastSuccessfulAt === "number" ? raw.lastSuccessfulAt : null
  );
}
