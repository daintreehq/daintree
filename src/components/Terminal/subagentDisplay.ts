import type {
  AgentSubagent,
  AgentSubagentStatus,
  AgentSubagentUnavailableReason,
} from "@shared/types/ipc/agentSubagents";

/**
 * One derivation of every label a subagent row shows, for every provider.
 *
 * These take the raw fields off the wire rather than a pre-rendered title on
 * purpose: a title computed in each provider's main-process mapper would be the
 * same presentation logic written twice, drifting the moment one side changed.
 */

/**
 * Status is labelled for what was actually observed. `unknown` keeps its reason
 * because the three are not interchangeable — a provider that never loaded a
 * child, a child that stopped mid-step, and a record we could not parse are
 * different admissions, and smoothing them into one word would claim knowledge
 * none of them carries.
 */
export function subagentStatusLabel(status: AgentSubagentStatus): string {
  switch (status.type) {
    case "idle":
      return "Idle";
    case "working":
      return "Working";
    case "completed":
      return "Done";
    case "error":
      return "Error";
    case "blocked":
      return status.reason === "approval" ? "Waiting for approval" : "Waiting for input";
    case "unknown":
    default:
      return status.reason === "not-loaded" ? "Not loaded" : "Unknown";
  }
}

export function subagentStatusTone(status: AgentSubagentStatus): "error" | "active" | "muted" {
  if (status.type === "error") return "error";
  if (status.type === "working" || status.type === "blocked") return "active";
  return "muted";
}

function firstLine(value: string | null): string {
  return value?.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * The provider's own handle first — Codex's nickname and Claude's description
 * of the delegated task are both what the parent calls the child.
 */
export function subagentTitle(subagent: AgentSubagent): string {
  // Every field goes through the same normalizer: a whitespace-only label is
  // not a title, it's a blank row.
  return (
    firstLine(subagent.label) ||
    firstLine(subagent.role) ||
    firstLine(subagent.preview).slice(0, 48) ||
    subagent.id.slice(0, 8)
  );
}

/**
 * Shown under the title when it would not merely repeat it. Assembled from
 * whichever identifying facts the provider recorded and the title didn't
 * already spend, so a row says something new on its second line or nothing.
 */
export function subagentSubtitle(subagent: AgentSubagent): string | null {
  const title = subagentTitle(subagent);
  const parts: string[] = [];
  const task = firstLine(subagent.preview);
  const role = firstLine(subagent.role);
  if (task && task !== title) parts.push(task.slice(0, 120));
  if (role && role !== title) parts.push(role);
  if (subagent.model) parts.push(subagent.model);
  // Depth only earns a slot once it says something: every child is at least one
  // level down, so "Depth 1" is noise on every row.
  if (subagent.depth !== null && subagent.depth > 1) parts.push(`Depth ${subagent.depth}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function subagentUnavailableMessage(
  reason: AgentSubagentUnavailableReason,
  provider: string
): string {
  switch (reason) {
    case "cli-missing":
      return `${provider} CLI isn't available`;
    case "no-session":
      return `Couldn't match this terminal to a ${provider} session`;
    case "ambiguous-session":
      return `More than one ${provider} session ran in this folder, so this terminal's can't be identified`;
    case "subagent-not-found":
      return "That subagent isn't one of this terminal's";
    case "timeout":
      return `${provider} took too long to respond`;
    case "store-unreadable":
      return `Couldn't read ${provider}'s session files`;
    case "provider-mismatch":
    case "terminal-unknown":
      return `This terminal isn't running ${provider}`;
    case "protocol-error":
    default:
      return `Couldn't read ${provider} sessions`;
  }
}
