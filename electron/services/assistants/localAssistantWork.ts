import {
  unreadAssistantWork,
  type AssistantWorkHostReading,
  type AssistantWorkReading,
} from "../../../shared/types/assistantWork.js";
import type { AgentDirectorySubject } from "../../../shared/types/agentDirectory.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { helpSessionService } from "../HelpSessionService.js";
import { getMcpServerServiceRef, getPtyClient } from "../../window/serviceRefs.js";
import {
  assistantOfSession,
  assistantWorkSessionKey,
  collectAssistantWork,
  resolveAssistantWork,
  type AssistantWorkSources,
} from "./assistantWork.js";

/** How long a read may take before it answers as unreachable. */
const ASSISTANT_WORK_READ_MS = 4_000;

const sources: AssistantWorkSources = {
  hostId: LOCAL_HOST_ID,
  now: () => Date.now(),
  readTerminals: async () => {
    const pty = getPtyClient();
    if (!pty) throw new Error("No pty client");
    return pty.getAllTerminalsWithCompletenessAsync();
  },
  getLiveGeneration: (terminalId) => getPtyClient()?.getLiveGeneration(terminalId) ?? null,
  isHelpTerminal: (terminalId) => getAgentAvailabilityStore().isHelpTerminal(terminalId),
  workOf: (terminalId, generation) =>
    getMcpServerServiceRef()?.assistantWorkOf(terminalId, generation) ?? null,
  creationsMark: () => getMcpServerServiceRef()?.workerCreationsMark() ?? 0,
  retainCreations: (live, mark) => getMcpServerServiceRef()?.retainWorkerCreations(live, mark),
  getSessionLane: (sessionId) => helpSessionService.getSessionLane(sessionId),
  getRunningLaneSession: (projectId, slot) =>
    helpSessionService.getRunningLaneSession(projectId, slot),
};

/** This machine's reading, as the host it is: relayed assistants still keyed. */
export async function readLocalAssistantWorkForHost(): Promise<AssistantWorkHostReading> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AssistantWorkHostReading>((resolve) => {
    timer = setTimeout(() => resolve(unreadAssistantWork("unreachable")), ASSISTANT_WORK_READ_MS);
  });
  try {
    return await Promise.race([
      collectAssistantWork(sources).catch(() => unreadAssistantWork("unreachable")),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * This machine's reading, as its own window names it. A relayed assistant
 * here is another installation's: this machine's own `host.call` was already
 * named as its assistant by the read.
 */
export async function readLocalAssistantWork(): Promise<AssistantWorkReading> {
  return resolveAssistantWork(await readLocalAssistantWorkForHost(), {
    hostId: LOCAL_HOST_ID,
    ownSenderId: null,
    assistantBySessionKey: () => null,
  });
}

/** This machine's live assistant whose session another host's reading keys, or null. */
export function localAssistantBySessionKey(sessionKey: string): AgentDirectorySubject | null {
  for (const lane of helpSessionService.listRunningLanes()) {
    const running = helpSessionService.getRunningLaneSession(lane.projectId, lane.slot);
    if (!running || assistantWorkSessionKey(running.sessionId) !== sessionKey) continue;
    return assistantOfSession(sources, running.sessionId);
  }
  return null;
}
