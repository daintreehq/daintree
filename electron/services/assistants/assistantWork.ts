import { createHash } from "node:crypto";
import { isGlobalAssistantId } from "../../../shared/config/globalAssistant.js";
import type { AgentDirectorySubject } from "../../../shared/types/agentDirectory.js";
import {
  ASSISTANT_WORK_WORKERS_MAX,
  type AssistantWorkHostReading,
  type AssistantWorkHostRef,
  type AssistantWorkHostWorker,
  type AssistantWorkReading,
  type AssistantWorkRef,
} from "../../../shared/types/assistantWork.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import type { AssistantOwnershipPrincipal } from "../mcp-server/resourceOwnership.js";
import type { RunAssistantWork } from "../mcp-server/workerCreationHistory.js";
import type { PtyClient } from "../PtyClient.js";
import type { RunningLaneSession } from "../HelpSessionService.js";

type PtyTerminal = Awaited<
  ReturnType<PtyClient["getAllTerminalsWithCompletenessAsync"]>
>["terminals"][number];

/**
 * The sender this machine's own `host.call` is admitted under
 * (`LOCAL_RELAY_SENDER_ID`), named here without loading the remote module.
 */
const LOCAL_RELAY_SENDER = LOCAL_HOST_ID;

export interface AssistantWorkSources {
  hostId: string;
  now(): number;
  readTerminals(): Promise<{ terminals: readonly PtyTerminal[]; degraded: boolean }>;
  getLiveGeneration(terminalId: string): number | null;
  isHelpTerminal(terminalId: string): boolean;
  /** Null while no MCP server holds any records: then no assistant made or holds anything. */
  workOf(terminalId: string, launchGeneration: number): RunAssistantWork | null;
  /** Forget creations of runs no longer alive, after a complete read. */
  retainCreations(liveTerminalIds: ReadonlySet<string>): void;
  getSessionLane(helpSessionId: string): { projectId: string; slot: number } | null;
  getRunningLaneSession(projectId: string, slot: number): RunningLaneSession | null;
}

/**
 * The key a Shell's assistant session is named by in another host's reading:
 * one-way, so the help session id itself never leaves the host it was relayed
 * to, and only the Shell that holds that session can recognise it.
 */
export function assistantWorkSessionKey(helpSessionId: string): string {
  return createHash("sha256")
    .update(`daintree.assistant-work\0${helpSessionId}`, "utf8")
    .digest("hex");
}

type SessionSources = Pick<
  AssistantWorkSources,
  "hostId" | "getSessionLane" | "getRunningLaneSession" | "getLiveGeneration"
>;

/**
 * The live run a help session is now, exactly, or null once the session has
 * ended. A lane alone never answers: a successor in the same lane is another
 * session and names nothing the ended one made.
 */
export function assistantOfSession(
  sources: SessionSources,
  helpSessionId: string
): AgentDirectorySubject | null {
  const lane = sources.getSessionLane(helpSessionId);
  if (!lane) return null;
  const running = sources.getRunningLaneSession(lane.projectId, lane.slot);
  if (!running || running.sessionId !== helpSessionId) return null;
  const incarnation = sources.getLiveGeneration(running.terminalId);
  if (incarnation === null) return null;
  return isGlobalAssistantId(lane.projectId)
    ? {
        hostId: sources.hostId,
        scope: { kind: "global" },
        terminalId: running.terminalId,
        incarnation,
      }
    : {
        hostId: sources.hostId,
        scope: { kind: "project", projectId: lane.projectId },
        terminalId: running.terminalId,
        incarnation,
        lane: lane.slot,
      };
}

function hostRef(
  sources: SessionSources,
  principal: AssistantOwnershipPrincipal
): AssistantWorkHostRef {
  if (principal.kind === "relay" && principal.senderId !== LOCAL_RELAY_SENDER) {
    return {
      kind: "relay",
      senderId: principal.senderId,
      sessionKey: assistantWorkSessionKey(principal.helpSessionId),
    };
  }
  const subject = assistantOfSession(sources, principal.helpSessionId);
  return subject ? { kind: "assistant", subject } : { kind: "ended" };
}

/**
 * One read of which runs on this machine an assistant made or holds. Passive
 * like the agent directory: the pty inventory and main's own records are read,
 * and nothing is started, claimed or watched to produce it.
 */
export async function collectAssistantWork(
  sources: AssistantWorkSources
): Promise<AssistantWorkHostReading> {
  const { terminals, degraded } = await sources.readTerminals();
  let complete = !degraded;
  const workers: AssistantWorkHostWorker[] = [];
  for (const terminal of terminals) {
    if (!terminal.projectId) continue;
    if (terminal.isAssistantTerminal === true || sources.isHelpTerminal(terminal.id)) continue;
    const incarnation = sources.getLiveGeneration(terminal.id);
    if (incarnation === null) {
      // A run with no generation can't be matched to a record exactly, nor left out silently.
      complete = false;
      continue;
    }
    const work = sources.workOf(terminal.id, incarnation);
    if (!work || (work.createdBy === null && work.controlledBy === null)) continue;
    workers.push({
      terminalId: terminal.id,
      projectId: terminal.projectId,
      incarnation,
      spawnedAt: terminal.spawnedAt,
      createdBy: work.createdBy ? hostRef(sources, work.createdBy) : null,
      controlledBy: work.controlledBy ? hostRef(sources, work.controlledBy.principal) : null,
      control: work.controlledBy?.basis ?? null,
    });
  }
  if (complete) sources.retainCreations(new Set(terminals.map((terminal) => terminal.id)));
  const kept = workers.slice(0, ASSISTANT_WORK_WORKERS_MAX);
  return {
    coverage: "ok",
    observedAt: sources.now(),
    complete,
    omitted: workers.length - kept.length,
    workers: kept,
  };
}

export interface AssistantWorkResolution {
  /** The id this Shell knows the reading's host by, never one the host gave itself. */
  hostId: HostId;
  /** The sender this Shell proves to that host; null when it never authenticated there. */
  ownSenderId: string | null;
  /** This Shell's live assistant whose session the key names, or null. */
  assistantBySessionKey(sessionKey: string): AgentDirectorySubject | null;
}

/**
 * A host's reading as this Shell names it. The host's own assistants take the
 * id this Shell knows the host by; a relayed one is this Shell's only when the
 * sender is the one this Shell proves there, and is then its live assistant or
 * ended. Anyone else's is another installation's, never a guess.
 */
export function resolveAssistantWork(
  reading: AssistantWorkHostReading,
  resolution: AssistantWorkResolution
): AssistantWorkReading {
  const resolve = (ref: AssistantWorkHostRef | null): AssistantWorkRef | null => {
    if (ref === null) return null;
    switch (ref.kind) {
      case "assistant":
        return { kind: "assistant", subject: { ...ref.subject, hostId: resolution.hostId } };
      case "ended":
        return ref;
      case "relay": {
        if (resolution.ownSenderId === null || ref.senderId !== resolution.ownSenderId) {
          return { kind: "other-installation" };
        }
        const subject = resolution.assistantBySessionKey(ref.sessionKey);
        return subject ? { kind: "assistant", subject } : { kind: "ended" };
      }
    }
  };
  return {
    ...reading,
    workers: reading.workers.map((worker) => ({
      ...worker,
      createdBy: resolve(worker.createdBy),
      controlledBy: resolve(worker.controlledBy),
    })),
  };
}
