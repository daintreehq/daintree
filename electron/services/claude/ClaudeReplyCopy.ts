/**
 * The host's half of a clean copy in a Claude Code pane (#15527): the stretch
 * of a recent reply a selection shows, as the agent wrote it.
 *
 * The renderer names a terminal and hands over what was selected, nothing
 * else. Which session and which store come from the host, as for the last
 * message (`terminalLastMessage.ts`), and a store that was never pinned down
 * reads nothing rather than Daintree's own `~/.claude`. Only the matching span
 * goes back, never the replies it was found in, and none of it is logged.
 */

import { findReplySpan } from "./ClaudeReplySpan.js";
import { readClaudeRecentReplies } from "./ClaudeSessionReader.js";
import { getClaudePaneProjectsRoot } from "./ClaudeSessionStore.js";
import { resolveClaudeTerminal } from "./ClaudeSubagentService.js";

export async function findClaudeReplySpan(
  terminalId: string,
  selection: string,
  signal: AbortSignal
): Promise<string | null> {
  const resolved = await resolveClaudeTerminal(terminalId);
  if ("status" in resolved) return null;
  const projectsRoot = getClaudePaneProjectsRoot(terminalId);
  if (!projectsRoot) return null;
  const replies = await readClaudeRecentReplies(
    { projectsRoot, cwd: resolved.cwd, sessionId: resolved.parentSessionId },
    { signal }
  );
  signal.throwIfAborted();
  return findReplySpan(selection, replies);
}
