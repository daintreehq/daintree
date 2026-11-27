import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { checkKernelPressureCritical } from "../../services/SystemMemoryPressureMonitor.js";
import { noteSystemMemoryNoticeShown } from "../../window/systemMemoryPressureDelivery.js";
import type { HandlerDependencies } from "../types.js";
import { MEMORY_PRESSURE_METHOD_CHANNELS } from "./memoryPressure.preload.js";

const NoticeShownSchema = z.object({
  episodeId: z.string().min(1).max(64),
  surface: z.enum(["inbox-warning", "inbox-critical", "launch-bar"]),
});

export function registerMemoryPressureHandlers(deps: HandlerDependencies): () => void {
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
      // A view showed the episode's inbox row or launch bar, so no other view
      // raises its own copy for the same episode (#18274).
      noteMemoryNoticeShown: opValidated(
        MEMORY_PRESSURE_METHOD_CHANNELS.noteMemoryNoticeShown,
        NoticeShownSchema,
        (payload): void => {
          const windows = deps.windowRegistry?.all().map((wCtx) => wCtx.browserWindow) ?? [];
          noteSystemMemoryNoticeShown(payload.episodeId, payload.surface, windows);
        }
      ),
    },
  });

  return namespace.register();
}
