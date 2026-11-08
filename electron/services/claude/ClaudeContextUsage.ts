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

/**
 * A reading that hasn't answered by now answers that the store couldn't be
 * read. Only a stalled filesystem gets here: the read itself is bounded, but a
 * read on a dead mount never returns, signal or not.
 */
export const CONTEXT_USAGE_HOST_DEADLINE_MS = 3_000;

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

/**
 * One read per terminal at a time. A terminal is in the map while a read of it
 * runs, with the callers waiting for their turn; a read past its deadline keeps
 * the slot until it settles, so a stalled store holds one read per pane, and a
 * caller never takes an answer read before it asked.
 */
const lanes = new Map<string, Set<() => void>>();

/** Hands the terminal's slot to the next caller still waiting, or frees it. */
function release(terminalId: string): void {
  const waiting = lanes.get(terminalId);
  const next = waiting?.values().next().value;
  if (!waiting || next === undefined) {
    lanes.delete(terminalId);
    return;
  }
  waiting.delete(next);
  next();
}

/**
 * {@link readClaudePaneContextUsage} with a deadline that holds whether or not
 * the filesystem honours the abort. A caller the deadline answers stops
 * waiting for its turn, so nothing of it is left behind a stalled read.
 */
export async function readClaudePaneContextUsageWithin(
  terminalId: string,
  deps: ClaudeContextUsageDeps & { deadlineMs?: number } = {}
): Promise<AgentContextUsageResult> {
  const deadlineMs = deps.deadlineMs ?? CONTEXT_USAGE_HOST_DEADLINE_MS;
  let answered = false;
  let waiter: (() => void) | undefined;
  const turn = new Promise<void>((resolve) => {
    const waiting = lanes.get(terminalId);
    if (!waiting) {
      lanes.set(terminalId, new Set());
      resolve();
      return;
    }
    waiter = resolve;
    waiting.add(resolve);
  });
  const work = turn.then(async (): Promise<AgentContextUsageResult> => {
    try {
      if (answered) return unavailable("store-unreadable");
      return await readClaudePaneContextUsage(terminalId, AbortSignal.timeout(deadlineMs), deps);
    } catch {
      // Nothing is logged: a filesystem error names a path under the user's home.
      return unavailable("store-unreadable");
    } finally {
      release(terminalId);
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AgentContextUsageResult>((resolve) => {
    timer = setTimeout(() => resolve(unavailable("store-unreadable")), deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    answered = true;
    clearTimeout(timer);
    if (waiter) lanes.get(terminalId)?.delete(waiter);
  }
}

/** Test-only: how many callers are waiting behind a terminal's running read. */
export function __contextUsageWaiters(terminalId: string): number {
  return lanes.get(terminalId)?.size ?? 0;
}
