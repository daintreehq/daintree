import { defineIpcNamespace, op } from "../define.js";
import { ASSISTANT_TIMERS_METHOD_CHANNELS } from "./assistantTimers.preload.js";
import { assistantHostService } from "../../services/assistant-host/AssistantHostService.js";
import type {
  DaemonTimerCancelResult,
  ProjectTimersResult,
} from "../../../shared/types/ipc/assistantTimers.js";

/**
 * The DETACHED route to a project's durable timers.
 *
 * The panel's own protocol is the primary one and is both cheaper and more current —
 * this exists for the case where there is no engine to ask: Daintree restarted, the
 * project view was evicted, or the assistant was never opened in this process. A
 * durable timer's whole purpose is to outlive the session that made it, so without
 * this the app has no answer at exactly the moment a scheduled agent spawn is closest
 * to happening.
 *
 * Thin, like the host namespace beside it: everything about reaching the supervisor —
 * where it listens, what "unavailable" means, how a refusal differs from an empty
 * list — lives in `AssistantTimerService`.
 */
export const assistantTimersNamespace = defineIpcNamespace({
  name: "assistantTimers",
  ops: {
    /**
     * Reads a project's scheduled timers and recent outcomes over its daemon socket.
     *
     * Never throws for the ordinary cases: no daemon, no endpoint, or a daemon that
     * has yielded its lease all come back as `available: false` with a reason. That
     * distinction is the point of the call — "nobody could be asked" must never
     * render as "nothing is scheduled", which would tell a user their overnight timer
     * is gone at the moment it is closest to firing.
     */
    list: op(
      ASSISTANT_TIMERS_METHOD_CHANNELS.list,
      async (projectId: string): Promise<ProjectTimersResult> => {
        if (typeof projectId !== "string" || !projectId) throw new Error("Invalid projectId");
        return assistantHostService.timers.list(projectId);
      }
    ),
    /**
     * Retires one timer over the daemon socket, revoking the automation grants scoped
     * to it.
     *
     * The RENDERER confirms first — this is a D1 mutation and there is no
     * confirmation channel on this path. Unlike `list` it rejects when the cancel
     * could not happen, because a mutation that did not occur must never settle as
     * though it had.
     */
    cancel: op(
      ASSISTANT_TIMERS_METHOD_CHANNELS.cancel,
      async (projectId: string, timerId: string): Promise<DaemonTimerCancelResult> => {
        if (typeof projectId !== "string" || !projectId) throw new Error("Invalid projectId");
        if (typeof timerId !== "string" || !timerId) throw new Error("Invalid timerId");
        return assistantHostService.timers.cancel(projectId, timerId);
      }
    ),
  },
});

export function registerAssistantTimersHandlers(): () => void {
  return assistantTimersNamespace.register();
}
