import { defineIpcNamespace, op } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { CANOPY_HOST_METHOD_CHANNELS } from "./canopyHost.preload.js";
import type {
  AssistantViewerChannel,
  AssistantViewerResult,
  CanopyHostChannel,
  CanopyHostResult,
  HostAssistantDirectory,
} from "../../../shared/types/ipc/canopyHost.js";
import type {
  AssistantOpenDestination,
  CanopyTerminalView,
} from "../../../shared/types/ipc/canopy.js";
import type { AgentDirectorySubject } from "../../../shared/types/agentDirectory.js";
import type { AssistantWorkReading } from "../../../shared/types/assistantWork.js";

export const canopyHostNamespace = defineIpcNamespace({
  name: "canopyHost",
  ops: {
    /**
     * One Canopy call on a host the view names, not the one it is bound to:
     * This Mac, or another connected host. The view's own host is refused here;
     * its calls take the ordinary `canopy:*` route.
     */
    invoke: op(
      CANOPY_HOST_METHOD_CHANNELS.invoke,
      async (
        ctx,
        hostId: string,
        channel: CanopyHostChannel,
        args: unknown[]
      ): Promise<CanopyHostResult> =>
        requireRemoteService("canopyHosts").invoke(
          ctx.webContentsId,
          hostId,
          channel,
          args
        ) as Promise<CanopyHostResult>,
      { withContext: true }
    ),
    /** The view's panel stopped reading the host. */
    release: op(
      CANOPY_HOST_METHOD_CHANNELS.release,
      async (ctx, hostId: string): Promise<void> => {
        getRemoteService("canopyHosts")?.release(ctx.webContentsId, hostId);
      },
      { withContext: true }
    ),
    /**
     * The assistants a host holds, for a person's picker (#14163): summaries,
     * read without watching any. A host without the assistant viewer says so.
     */
    listAssistants: op(
      CANOPY_HOST_METHOD_CHANNELS.listAssistants,
      async (ctx, hostId: string, projectId?: string): Promise<HostAssistantDirectory> =>
        requireRemoteService("canopyHosts").listAssistants(ctx.webContentsId, hostId, projectId),
      { withContext: true }
    ),
    /**
     * Which of a host's workers an assistant made or holds (#14166), named as
     * this Shell knows its own assistants. A host without it says so.
     */
    readAssistantWork: op(
      CANOPY_HOST_METHOD_CHANNELS.readAssistantWork,
      async (ctx, hostId: string): Promise<AssistantWorkReading> =>
        requireRemoteService("canopyHosts").readAssistantWork(ctx.webContentsId, hostId),
      { withContext: true }
    ),
    /** Stream the one assistant `consumer` shows, on the host the subject names. */
    watchAssistant: op(
      CANOPY_HOST_METHOD_CHANNELS.watchAssistant,
      async (ctx, consumer: string, subject: AgentDirectorySubject): Promise<CanopyTerminalView> =>
        requireRemoteService("canopyHosts").watchAssistant(ctx.webContentsId, consumer, subject),
      { withContext: true }
    ),
    /** Where "Open in Assistant" lands for the subject, as its own host says. */
    resolveAssistant: op(
      CANOPY_HOST_METHOD_CHANNELS.resolveAssistant,
      async (
        ctx,
        consumer: string,
        subject: AgentDirectorySubject
      ): Promise<AssistantOpenDestination | null> =>
        requireRemoteService("canopyHosts").resolveAssistant(ctx.webContentsId, consumer, subject),
      { withContext: true }
    ),
    /** Typing to, keying or ending the stream `consumer` holds; never resent. */
    assistantInvoke: op(
      CANOPY_HOST_METHOD_CHANNELS.assistantInvoke,
      async (
        ctx,
        consumer: string,
        channel: AssistantViewerChannel,
        args: unknown[]
      ): Promise<AssistantViewerResult> =>
        requireRemoteService("canopyHosts").assistantInvoke(
          ctx.webContentsId,
          consumer,
          channel,
          args
        ) as Promise<AssistantViewerResult>,
      { withContext: true }
    ),
    /** The consumer stopped showing its assistant. */
    releaseAssistant: op(
      CANOPY_HOST_METHOD_CHANNELS.releaseAssistant,
      async (ctx, consumer: string): Promise<void> => {
        getRemoteService("canopyHosts")?.releaseAssistant(ctx.webContentsId, consumer);
      },
      { withContext: true }
    ),
  },
});

export function registerCanopyHostHandlers(): () => void {
  return canopyHostNamespace.register();
}
