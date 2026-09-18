import type { AgentLastMessageResult } from "../../../shared/types/agentLastMessage.js";
import { readClaudeLastMessage } from "../claude/ClaudeSessionReader.js";
import { getClaudePaneProjectsRoot } from "../claude/ClaudeSessionStore.js";
import { resolveClaudeTerminal } from "../claude/ClaudeSubagentService.js";

/**
 * Main-process execution for `terminal.readLastMessageOwned` (#12479), reached
 * only once the session's ownership of the panel has been checked.
 *
 * The caller supplies a terminal id and nothing else. Which agent it runs, its
 * session id, its cwd and the store its transcript lives in all come from the
 * host: the pty-host record for the first three, and the store remembered at the
 * pane's own spawn for the last. Where that store was never certain — Windows,
 * a shell the startup probe did not see, a pane-level `CLAUDE_CONFIG_DIR` — the
 * answer is that it is unknown. Daintree's own `~/.claude` is never a fallback:
 * reading the wrong store would hand back another conversation's reply.
 *
 * Claude only for now. Every other agent is a `provider-mismatch`, and the
 * result names its provider so another one can be added without changing the
 * contract.
 */
export async function handleTerminalReadLastMessageOwned(
  terminalId: string,
  signal: AbortSignal
): Promise<AgentLastMessageResult> {
  signal.throwIfAborted();
  const resolved = await resolveClaudeTerminal(terminalId);
  if ("status" in resolved) return { status: "unavailable", reason: resolved.reason };
  const projectsRoot = getClaudePaneProjectsRoot(terminalId);
  if (!projectsRoot) return { status: "unavailable", reason: "store-unknown" };
  return readClaudeLastMessage(
    { projectsRoot, cwd: resolved.cwd, sessionId: resolved.parentSessionId },
    { signal }
  );
}
