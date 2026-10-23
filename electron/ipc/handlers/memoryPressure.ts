import { defineIpcNamespace, op } from "../define.js";
import { checkKernelPressureCritical } from "../../services/SystemMemoryPressureMonitor.js";
import { getAgentLaunchAdmission } from "../../services/agentLaunchAdmission.js";
import type {
  AgentLaunchAdmission,
  AgentLaunchObservation,
} from "../../../shared/types/agentLaunchAdmission.js";
import type { HandlerDependencies } from "../types.js";
import { MEMORY_PRESSURE_METHOD_CHANNELS } from "./memoryPressure.preload.js";

export function registerMemoryPressureHandlers(_deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "memoryPressure",
    ops: {
      // Asked before a cold project open, and polled while it waits on it
      // (#13530). Answered from a live kernel reading, not the episode notice,
      // which takes minutes to open and covers swap and fseventsd too.
      isMemoryPressureCritical: op(
        MEMORY_PRESSURE_METHOD_CHANNELS.isMemoryPressureCritical,
        async (): Promise<boolean> => checkKernelPressureCritical()
      ),
      // Asked as each agent launch reaches the front of its view's queue: the
      // kernel reading plus how many agents this host already runs (#14221).
      // Host-wide, so every project view shares one count.
      requestAgentLaunchAdmission: op(
        MEMORY_PRESSURE_METHOD_CHANNELS.requestAgentLaunchAdmission,
        async (terminalId: string): Promise<AgentLaunchAdmission> => {
          if (typeof terminalId !== "string" || terminalId.length === 0) {
            throw new Error("Invalid terminal id");
          }
          return getAgentLaunchAdmission().request(terminalId);
        }
      ),
      // Polled while agent launches wait; reserves nothing.
      observeAgentLaunchAdmission: op(
        MEMORY_PRESSURE_METHOD_CHANNELS.observeAgentLaunchAdmission,
        async (): Promise<AgentLaunchObservation> => getAgentLaunchAdmission().observe()
      ),
    },
  });

  return namespace.register();
}
