import type {
  RunHistoryAppendInput,
  RunHistoryRecord,
} from "../../../shared/types/ipc/runHistory.js";
import { RunHistoryAppendInputSchema } from "../../schemas/runHistory.js";
import { broadcastRunHistory, runHistoryLog } from "../../services/runHistory/runHistoryService.js";
import { defineIpcNamespace, op } from "../define.js";
import { RUN_HISTORY_METHOD_CHANNELS } from "./runHistory.preload.js";

export const runHistoryNamespace = defineIpcNamespace({
  name: "runHistory",
  ops: {
    getRecords: op(RUN_HISTORY_METHOD_CHANNELS.getRecords, async (): Promise<RunHistoryRecord[]> =>
      runHistoryLog.getRecords()
    ),
    append: op(
      RUN_HISTORY_METHOD_CHANNELS.append,
      async (input: RunHistoryAppendInput): Promise<void> => {
        // The renderer is the producer — validate the payload at the boundary
        // before it reaches the ring buffer. A parse failure rejects the IPC
        // call; callers fire-and-forget with `.catch`, so a bad record is
        // dropped rather than corrupting the log.
        const parsed = RunHistoryAppendInputSchema.parse(input);
        runHistoryLog.append(parsed);
        broadcastRunHistory();
      }
    ),
    clear: op(RUN_HISTORY_METHOD_CHANNELS.clear, async (): Promise<void> => {
      runHistoryLog.clear();
      broadcastRunHistory();
    }),
  },
});

export function registerRunHistoryHandlers(): () => void {
  return runHistoryNamespace.register();
}
