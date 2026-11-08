/**
 * The host's half of a Claude Code pane's context reading (#16371).
 *
 * The renderer names a terminal and nothing else. Which session, which folder
 * and which store come from the host: the pty-host record for the first two,
 * and the store remembered at the pane's own spawn for the last, which reads
 * nothing when it was never pinned down rather than Daintree's own `~/.claude`.
 * Over a remote link this runs on the host, so a remote pane is read where its
 * transcript is.
 */

import path from "node:path";
import type {
  AgentContextUsageResult,
  AgentContextUsageUnavailableReason,
} from "../../../shared/types/ipc/agentContextUsage.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import type { PtyClient } from "../PtyClient.js";
import { subagentTerminalAgentId } from "../subagentTerminalAgent.js";
import { readClaudeContextUsage } from "./ClaudeSessionReader.js";
import { getClaudePaneProjectsRoot } from "./ClaudeSessionStore.js";

type TerminalQueries = Pick<PtyClient, "getTerminalAsync">;
type TerminalRecord = NonNullable<Awaited<ReturnType<PtyClient["getTerminalAsync"]>>>;

export interface ClaudeContextUsageDeps {
  ptyClient?: TerminalQueries | null;
  getClaudeProjectsRoot?: (terminalId: string) => string | null;
  read?: typeof readClaudeContextUsage;
}

function unavailable(reason: AgentContextUsageUnavailableReason): AgentContextUsageResult {
  return { status: "unavailable", reason };
}

/** The same run of the same session: the reading still describes the pane. */
function sameRun(before: TerminalRecord, after: TerminalRecord | null): boolean {
  return (
    after !== null &&
    after.spawnedAt === before.spawnedAt &&
    after.launchGeneration === before.launchGeneration &&
    after.agentIncarnation === before.agentIncarnation &&
    after.agentSessionId === before.agentSessionId &&
    subagentTerminalAgentId(after) === "claude"
  );
}

export async function readClaudePaneContextUsage(
  terminalId: string,
  signal: AbortSignal,
  deps: ClaudeContextUsageDeps = {}
): Promise<AgentContextUsageResult> {
  signal.throwIfAborted();
  const queries = deps.ptyClient === undefined ? getPtyClient() : deps.ptyClient;
  if (!queries) return unavailable("terminal-unknown");
  const record = await queries.getTerminalAsync(terminalId);
  if (!record) return unavailable("terminal-unknown");
  // An exited agent answers for nothing, though the record keeps its session id.
  if (subagentTerminalAgentId(record) !== "claude") return unavailable("provider-mismatch");
  if (!record.cwd || !path.isAbsolute(record.cwd)) return unavailable("terminal-unknown");
  // The id was recorded for the run Daintree launched. A later run in the same
  // pane (Claude Code quit and started again) writes another session.
  if (!record.agentSessionId || record.agentIncarnation !== 0) return unavailable("no-session");
  const projectsRoot = (deps.getClaudeProjectsRoot ?? getClaudePaneProjectsRoot)(terminalId);
  if (!projectsRoot) return unavailable("store-unknown");

  const result = await (deps.read ?? readClaudeContextUsage)(
    { projectsRoot, cwd: record.cwd, sessionId: record.agentSessionId },
    { signal }
  );
  if (result.status !== "ok") return result;
  const after = await queries.getTerminalAsync(terminalId);
  return sameRun(record, after) ? result : unavailable("pane-changed");
}
