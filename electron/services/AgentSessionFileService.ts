/**
 * Which session file a pane's agent is writing (#16097), for a plugin that
 * carries a conversation into another agent's CLI.
 *
 * Everything about the pane comes from the terminal host's own record; the
 * caller names a terminal id and nothing else. A caller reaches its own
 * workspace's terminals, its assistants included, and the global assistant's
 * run (#18139). Codex is answered by what the
 * pane's processes hold open, Claude Code by the id Daintree recorded and the
 * store the pane launched against, and anything short of that is `unknown`.
 * Daintree's own `~/.codex` or `~/.claude` is never a fallback.
 *
 * On demand only: nothing runs until a lookup is asked for, and nothing is kept
 * after it answers.
 */

import path from "node:path";
import { isGlobalAssistantId } from "../../shared/config/globalAssistant.js";
import { isHostThrowawayWorkspaceId } from "../../shared/config/hostThrowaway.js";
import {
  unknownSessionFile,
  type AgentSessionFileResult,
} from "../../shared/types/agentSessionFile.js";
import { isProjectWorkspaceId, isScratchWorkspaceId } from "../../shared/utils/workspaceIds.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { forksClaudeConversation } from "./claude/claudeForkSession.js";
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
  getClaudeProjectsRoot?: (terminalId: string, sessionId?: string) => string | null;
  deadlineMs?: number;
}

let inFlight = 0;

/** The same run, still running the same agent: the answer still describes it. */
function sameRun(before: TerminalRecord, after: TerminalRecord | null, agentId: string): boolean {
  return (
    after !== null &&
    after.projectId === before.projectId &&
    after.isAssistantTerminal === before.isAssistantTerminal &&
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
  // pane (the user quit Claude Code and started it again) isn't that session,
  // and neither is a launch that forked the one it resumed.
  if (
    !sessionId ||
    record.agentIncarnation !== 0 ||
    forksClaudeConversation(record.agentLaunchFlags, record.launchAgentId)
  ) {
    return unknownSessionFile("session-id-unknown");
  }
  const projectsRoot = (deps.getClaudeProjectsRoot ?? getClaudePaneProjectsRoot)(
    terminalId,
    sessionId
  );
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

/**
 * Whether a caller in `senderWorkspaceId` may look up `record`. A workspace
 * reaches its own terminals, its assistants among them. The global assistant's
 * run belongs to no workspace and every local one can show it, so any project
 * or scratch here reaches it, and nothing else in its workspace: the sealed
 * stamp says which run it is, never the renderer's late mark. A remote view
 * never gets this far.
 */
function inCallerScope(record: TerminalRecord, senderWorkspaceId: string | null): boolean {
  const workspaceId = record.projectId ?? null;
  if (senderWorkspaceId === null || workspaceId === null) return false;
  if (isHostThrowawayWorkspaceId(workspaceId)) return false;
  if (isGlobalAssistantId(workspaceId)) {
    return (
      record.isAssistantTerminal === true &&
      (isProjectWorkspaceId(senderWorkspaceId) || isScratchWorkspaceId(senderWorkspaceId))
    );
  }
  return workspaceId === senderWorkspaceId;
}

async function lookUp(
  terminalId: string,
  senderWorkspaceId: string | null,
  deps: AgentSessionFileDeps
): Promise<AgentSessionFileResult> {
  const queries = deps.ptyClient === undefined ? getPtyClient() : deps.ptyClient;
  if (!queries) return unknownSessionFile("terminal-unavailable");
  const record = await queries.getTerminalAsync(terminalId);
  // Out of scope answers as if there were no such terminal.
  if (!record || !inCallerScope(record, senderWorkspaceId)) {
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
