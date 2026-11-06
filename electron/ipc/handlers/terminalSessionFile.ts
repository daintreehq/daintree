import { z } from "zod";
import {
  unknownSessionFile,
  type AgentSessionFileResult,
} from "../../../shared/types/agentSessionFile.js";
import { getProjectIdFromSenderUrl } from "../senderIdentity.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { TERMINAL_SESSION_FILE_METHOD_CHANNELS } from "./terminalSessionFile.preload.js";

// The renderer names a terminal and nothing else: its process, its agent, its
// session and its store all come from the terminal host's record.
const getSchema = z.object({ terminalId: z.string().trim().min(1).max(128) });

/**
 * A view on another machine asks the host it drives, and a path on that host
 * opens nothing on the machine the view's plugins run on.
 */
function fromRemoteView(ctx: IpcContext): boolean {
  return ctx.endpoint?.kind === "remote-view" || ctx.client?.kind !== "local";
}

export const terminalSessionFileNamespace = defineIpcNamespace({
  name: "terminalSessionFile",
  ops: {
    get: opValidated(
      TERMINAL_SESSION_FILE_METHOD_CHANNELS.get,
      getSchema,
      async (ctx: IpcContext, { terminalId }): Promise<AgentSessionFileResult> => {
        if (fromRemoteView(ctx)) return unknownSessionFile("remote-pane");
        // Read before the first await: the context is the sender at invoke time.
        const senderWorkspaceId =
          ctx.projectId ?? (ctx.event ? getProjectIdFromSenderUrl(ctx.event.sender) : null);
        // Imported on first use, so registering the handler loads none of it.
        const { locateAgentSessionFile } =
          await import("../../services/AgentSessionFileService.js");
        return locateAgentSessionFile(terminalId, senderWorkspaceId ?? null);
      },
      { withContext: true }
    ),
  },
});

export function registerTerminalSessionFileHandlers(): () => void {
  return terminalSessionFileNamespace.register();
}
