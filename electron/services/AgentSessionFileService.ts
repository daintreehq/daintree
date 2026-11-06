/**
 * Which session file a pane's agent is writing (#16097), for a plugin that
 * carries a conversation into another agent's CLI.
 *
 * Everything about the pane comes from the terminal host's own record; the
 * caller names a terminal id and nothing else. Codex is answered by what the
 * pane's processes hold open, Claude Code by the id Daintree recorded and the
 * store the pane launched against, and anything short of that is `unknown`.
 * Daintree's own `~/.codex` or `~/.claude` is never a fallback.
 *
 * On demand only: nothing runs until a lookup is asked for, and nothing is kept
 * after it answers.
 */

import path from "node:path";
import { isHostThrowawayWorkspaceId } from "../../shared/config/hostThrowaway.js";
import {
  unknownSessionFile,
  type AgentSessionFileResult,
} from "../../shared/types/agentSessionFile.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { isAssistantTerminalRecord } from "./assistantTerminal.js";
import { locateClaudeTranscript } from "./claude/ClaudeSessionReader.js";
import { getClaudePaneProjectsRoot } from "./claude/ClaudeSessionStore.js";
import { probeCodexSessionFile } from "./codex/CodexSessionFileProbe.js";
import type { PtyClient } from "./PtyClient.js";
import { subagentTerminalAgentId } from "./subagentTerminalAgent.js";

/** Lookups running at once; past it a call answers `busy` rather than queueing. */
const MAX_IN_FLIGHT = 2;
/** A lookup that hasn't answered by now answers `probe-failed`. */
const LOOKUP_DEADLINE_MS = 5_000;

type TerminalQueries = Pick<PtyClient, "getTerminalAsync" | "getTerminalInfo">;
type TerminalRecord = NonNullable<Awaited<ReturnType<PtyClient["getTerminalAsync"]>>>;

export interface AgentSessionFileDeps {
  ptyClient?: TerminalQueries | null;
  platform?: NodeJS.Platform;
  probeCodex?: (rootPid: number) => Promise<AgentSessionFileResult>;
  locateClaude?: typeof locateClaudeTranscript;
  getClaudeProjectsRoot?: (terminalId: string) => string | null;
  deadlineMs?: number;
}

let inFlight = 0;

/** The same run, still running the same agent: the answer still describes it. */
function sameRun(before: TerminalRecord, after: TerminalRecord | null, agentId: string): boolean {
  return (
    after !== null &&
    after.spawnedAt === before.spawnedAt &&
    after.launchGeneration === before.launchGeneration &&
    after.agentIncarnation === before.agentIncarnation &&
    after.agentSessionId === before.agentSessionId &&
    subagentTerminalAgentId(after) === agentId
  );
}

async function locateCodex(
  terminalId: string,
  record: TerminalRecord,
  queries: TerminalQueries,
  deps: AgentSessionFileDeps
): Promise<AgentSessionFileResult> {
  if ((deps.platform ?? process.platform) === "win32") {
    return unknownSessionFile("unsupported-platform");
  }
  // The process id is only on the diagnostic read. The process may be a shell
  // that started `codex`, so the probe walks everything under it.
  const info = await queries.getTerminalInfo(terminalId);
  if (!info) return unknownSessionFile("terminal-unavailable");
  if (info.spawnedAt !== record.spawnedAt || info.agentIncarnation !== record.agentIncarnation) {
    return unknownSessionFile("pane-changed");
  }
  if (info.hasPty !== true || typeof info.ptyPid !== "number") {
    return unknownSessionFile("no-live-agent");
  }
  const probe = deps.probeCodex ?? ((pid: number) => probeCodexSessionFile(pid));
  const result = await probe(info.ptyPid);
  if (result.status !== "observed") return result;
  const after = await queries.getTerminalAsync(terminalId);
  return sameRun(record, after, "codex") ? result : unknownSessionFile("pane-changed");
}

async function locateClaude(
  terminalId: string,
  record: TerminalRecord,
  queries: TerminalQueries,
  deps: AgentSessionFileDeps
): Promise<AgentSessionFileResult> {
  const sessionId = record.agentSessionId;
  // The id was recorded for the run Daintree launched. A later run in the same
  // pane (the user quit Claude Code and started it again) isn't that session.
  if (!sessionId || record.agentIncarnation !== 0) {
    return unknownSessionFile("session-id-unknown");
  }
  const projectsRoot = (deps.getClaudeProjectsRoot ?? getClaudePaneProjectsRoot)(terminalId);
  if (!projectsRoot) return unknownSessionFile("store-unknown");
  if (!record.cwd || !path.isAbsolute(record.cwd)) {
    return unknownSessionFile("terminal-unavailable");
  }
  const located = await (deps.locateClaude ?? locateClaudeTranscript)({
    projectsRoot,
    cwd: record.cwd,
    sessionId,
  });
  switch (located.status) {
    case "missing":
      return unknownSessionFile("not-observed");
    case "ambiguous":
      return unknownSessionFile("ambiguous");
    case "unverified":
      return unknownSessionFile("unverified");
    case "found":
      break;
  }
  const after = await queries.getTerminalAsync(terminalId);
  if (!sameRun(record, after, "claude")) return unknownSessionFile("pane-changed");
  return {
    status: "observed",
    agentId: "claude",
    sessionId,
    path: located.file,
    observedBy: "recorded-session-id",
  };
}

async function lookUp(
  terminalId: string,
  senderWorkspaceId: string | null,
  deps: AgentSessionFileDeps
): Promise<AgentSessionFileResult> {
  const queries = deps.ptyClient === undefined ? getPtyClient() : deps.ptyClient;
  if (!queries) return unknownSessionFile("terminal-unavailable");
  const record = await queries.getTerminalAsync(terminalId);
  // Another project's terminal, an assistant's own and a host's throwaway run
  // all answer as if there were no such terminal.
  if (
    !record ||
    (record.projectId ?? null) !== senderWorkspaceId ||
    isHostThrowawayWorkspaceId(record.projectId) ||
    isAssistantTerminalRecord(record)
  ) {
    return unknownSessionFile("terminal-unavailable");
  }
  const agentId = subagentTerminalAgentId(record);
  if (!agentId) return unknownSessionFile("no-live-agent");
  if (agentId === "codex") return locateCodex(terminalId, record, queries, deps);
  if (agentId === "claude") return locateClaude(terminalId, record, queries, deps);
  return unknownSessionFile("unsupported-agent");
}

/**
 * The session file the agent in `terminalId` is writing, for a caller in
 * `senderWorkspaceId`. A lookup past its deadline answers then, but keeps its
 * slot until its work has settled, so slow lookups can't pile up behind it.
 */
export async function locateAgentSessionFile(
  terminalId: string,
  senderWorkspaceId: string | null,
  deps: AgentSessionFileDeps = {}
): Promise<AgentSessionFileResult> {
  if (inFlight >= MAX_IN_FLIGHT) return unknownSessionFile("busy");
  inFlight += 1;
  const work = lookUp(terminalId, senderWorkspaceId, deps).catch(() =>
    unknownSessionFile("probe-failed")
  );
  void work.finally(() => {
    inFlight -= 1;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AgentSessionFileResult>((resolve) => {
    timer = setTimeout(
      () => resolve(unknownSessionFile("probe-failed")),
      deps.deadlineMs ?? LOOKUP_DEADLINE_MS
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
