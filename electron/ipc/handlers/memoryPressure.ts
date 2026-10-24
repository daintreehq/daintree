import { defineIpcNamespace, op } from "../define.js";
import { checkKernelPressureCritical } from "../../services/SystemMemoryPressureMonitor.js";
import type { HandlerDependencies } from "../types.js";
import { MEMORY_PRESSURE_METHOD_CHANNELS } from "./memoryPressure.preload.js";

export function registerMemoryPressureHandlers(_deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "memoryPressure",
    ops: {
      // Asked before an agent launch, and polled while launches wait on it
      // (#13530). Answered from a live kernel reading, not the episode notice,
      // which takes minutes to open and covers swap and fseventsd too.
      isMemoryPressureCritical: op(
        MEMORY_PRESSURE_METHOD_CHANNELS.isMemoryPressureCritical,
        async (): Promise<boolean> => checkKernelPressureCritical()
      ),
    },
  });

  return namespace.register();
}
