import { AGENT_DIRECTORY_RESUMABLE_PROJECTS_MAX } from "../../../shared/types/agentDirectory.js";
import { MAX_ASSISTANT_SLOTS, assistantSlotKey } from "../../../shared/config/assistantSlots.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { LocalAgentDirectory, type ResumableLane } from "../agentDirectory.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { getPendingHelpHibernationStore } from "../PendingHelpHibernationStore.js";
import { helpSessionService } from "../HelpSessionService.js";
import { getPtyClient } from "../../window/serviceRefs.js";

let directory: LocalAgentDirectory | null = null;

/**
 * This machine's agent directory, made on first read: `host.list`'s optional
 * inventory and a remote person's assistant picker (#14163) read the same one,
 * so a last known read is kept once for both.
 */
export function getLocalAgentDirectory(): LocalAgentDirectory {
  directory ??= new LocalAgentDirectory({
    hostId: LOCAL_HOST_ID,
    now: () => Date.now(),
    listRunningLanes: () => helpSessionService.listRunningLanes(),
    getRunningLaneSession: (projectId, slot) =>
      helpSessionService.getRunningLaneSession(projectId, slot),
    getLiveGeneration: (terminalId) => getPtyClient()?.getLiveGeneration(terminalId) ?? null,
    // Read fresh: a cached inventory can describe a run that has since been replaced.
    readTerminals: async () => {
      const pty = getPtyClient();
      if (!pty) throw new Error("No pty client");
      return pty.getAllTerminalsWithCompletenessAsync();
    },
    isHelpTerminal: (terminalId) => getAgentAvailabilityStore().isHelpTerminal(terminalId),
    resumableLanes: async (projectId) => {
      const { projectStore } = await import("../ProjectStore.js");
      const store = getPendingHelpHibernationStore();
      await store.load();
      const known = projectId ? [projectId] : projectStore.getProjectSummaries().map((p) => p.id);
      const projectIds = known.slice(0, AGENT_DIRECTORY_RESUMABLE_PROJECTS_MAX);
      const pointers: ResumableLane[] = [];
      for (const id of projectIds) {
        for (let slot = 0; slot < MAX_ASSISTANT_SLOTS; slot++) {
          const pending = store.get(assistantSlotKey(id, slot));
          if (pending) {
            pointers.push({
              projectId: id,
              slot,
              agentId: pending.agentId,
              capturedAt: pending.capturedAt,
            });
          }
        }
      }
      return { lanes: pointers, complete: projectIds.length === known.length };
    },
  });
  return directory;
}
