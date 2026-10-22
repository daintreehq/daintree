import type { PluginTerminalStatus } from "../types/plugin.js";
import { validatePluginWorktreeCardStatus } from "./pluginWorktreeCardStatus.js";

export type PluginTerminalStatusResult =
  | { ok: true; terminalId: string; status: PluginTerminalStatus | null }
  | { ok: false; error: string };

/**
 * Vet one `host.setTerminalStatus(terminalId, status)` call (#13802). A
 * terminal's chip takes exactly a worktree card chip's fields and rules, so the
 * status itself goes through the worktree validator; only the id is this
 * one's. Whether the terminal is one the plugin may reach is the host's check.
 */
export function validatePluginTerminalStatus(
  terminalId: unknown,
  status: unknown,
  manifestId: string,
  instanceId: string
): PluginTerminalStatusResult {
  if (typeof terminalId !== "string" || terminalId.length === 0) {
    return { ok: false, error: "terminalId must be a non-empty string" };
  }
  const vetted = validatePluginWorktreeCardStatus(terminalId, status, manifestId, instanceId);
  if (!vetted.ok) return vetted;
  return { ok: true, terminalId, status: vetted.status };
}

/** Whether two vetted statuses would draw the same chip. */
export function sameTerminalStatus(
  a: PluginTerminalStatus | undefined,
  b: PluginTerminalStatus
): boolean {
  return (
    a !== undefined && a.label === b.label && a.tooltip === b.tooltip && a.command === b.command
  );
}
