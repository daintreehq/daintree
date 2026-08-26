import type {
  CodexSubagent,
  CodexSubagentStatus,
  CodexSubagentUnavailableReason,
} from "@shared/types/ipc/codexSubagents";

/**
 * Daintree reads persisted thread state through its own app-server process, so
 * `notLoaded` is what a stored child normally reports. It is labelled honestly
 * rather than smoothed into "idle" — the two mean different things, and only
 * one of them is something we actually observed.
 */
export function subagentStatusLabel(status: CodexSubagentStatus): string {
  switch (status.type) {
    case "idle":
      return "Idle";
    case "systemError":
      return "Error";
    case "active":
      if (status.activeFlags.includes("waitingOnApproval")) return "Waiting for approval";
      if (status.activeFlags.includes("waitingOnUserInput")) return "Waiting for input";
      return "Working";
    case "notLoaded":
    default:
      return "Not loaded";
  }
}

export function subagentStatusTone(status: CodexSubagentStatus): "error" | "active" | "muted" {
  if (status.type === "systemError") return "error";
  if (status.type === "active") return "active";
  return "muted";
}

function firstLine(value: string | null): string {
  return value?.trim().split("\n")[0]?.trim() ?? "";
}

/** Nickname first — it's the handle the parent transcript uses for the child. */
export function subagentTitle(subagent: CodexSubagent): string {
  // Every field goes through the same normalizer: a whitespace-only nickname
  // is not a title, it's a blank row.
  return (
    firstLine(subagent.nickname) ||
    firstLine(subagent.role) ||
    firstLine(subagent.preview).slice(0, 48) ||
    subagent.threadId.slice(0, 8)
  );
}

/** Shown under the title when it would not merely repeat it. */
export function subagentSubtitle(subagent: CodexSubagent): string | null {
  const title = subagentTitle(subagent);
  const candidate = firstLine(subagent.preview) || firstLine(subagent.role);
  if (!candidate || candidate === title) return null;
  return candidate.slice(0, 120);
}

export function codexUnavailableMessage(reason: CodexSubagentUnavailableReason): string {
  switch (reason) {
    case "cli-missing":
      return "Codex CLI isn't available";
    case "no-session":
      return "Couldn't match this terminal to a Codex session";
    case "ambiguous-session":
      return "More than one Codex session ran in this folder, so we can't tell which is this terminal's";
    case "timeout":
      return "Codex took too long to respond";
    case "not-codex":
    case "terminal-unknown":
      return "This terminal isn't running Codex";
    case "protocol-error":
    default:
      return "Couldn't read Codex sessions";
  }
}
