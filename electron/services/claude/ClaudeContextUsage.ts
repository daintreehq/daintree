/**
 * The host's half of a Claude Code pane's context reading (#16371).
 *
 * The renderer names a terminal and nothing else. Which session, which folder
 * and which store come from the host, as for the last message
 * (`terminalLastMessage.ts`), and a store that was never pinned down reads
 * nothing rather than Daintree's own `~/.claude`. Over a remote link this runs
 * on the host, so a remote pane is read where its transcript is.
 */

import type { AgentContextUsageResult } from "../../../shared/types/ipc/agentContextUsage.js";
import { readClaudeContextUsage } from "./ClaudeSessionReader.js";
import { getClaudePaneProjectsRoot } from "./ClaudeSessionStore.js";
import { resolveClaudeTerminal } from "./ClaudeSubagentService.js";

export async function readClaudePaneContextUsage(
  terminalId: string,
  signal: AbortSignal
): Promise<AgentContextUsageResult> {
  signal.throwIfAborted();
  const resolved = await resolveClaudeTerminal(terminalId);
  if ("status" in resolved) return { status: "unavailable", reason: resolved.reason };
  const projectsRoot = getClaudePaneProjectsRoot(terminalId);
  if (!projectsRoot) return { status: "unavailable", reason: "store-unknown" };
  return readClaudeContextUsage(
    { projectsRoot, cwd: resolved.cwd, sessionId: resolved.parentSessionId },
    { signal }
  );
}
