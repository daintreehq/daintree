import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { checkKernelPressureCritical } from "../../services/SystemMemoryPressureMonitor.js";
import {
  claimSystemMemoryNotice,
  releaseSystemMemoryNotice,
} from "../../window/systemMemoryPressureDelivery.js";
import type { HandlerDependencies } from "../types.js";
import { MEMORY_PRESSURE_METHOD_CHANNELS } from "./memoryPressure.preload.js";

const NoticeSchema = z.object({
  episodeId: z.string().min(1).max(64),
  surface: z.enum(["inbox-warning", "inbox-critical", "critical-toast", "launch-bar"]),
});

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
      // A view claims a once-per-episode memory notice before showing it, so
      // no other view shows a second copy (#18274).
      claimMemoryNotice: opValidated(
        MEMORY_PRESSURE_METHOD_CHANNELS.claimMemoryNotice,
        NoticeSchema,
        (payload): boolean => claimSystemMemoryNotice(payload.episodeId, payload.surface)
      ),
      releaseMemoryNotice: opValidated(
        MEMORY_PRESSURE_METHOD_CHANNELS.releaseMemoryNotice,
        NoticeSchema,
        (payload): void => releaseSystemMemoryNotice(payload.episodeId, payload.surface)
      ),
    },
  });

  return namespace.register();
}
