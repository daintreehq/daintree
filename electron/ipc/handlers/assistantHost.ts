import { defineIpcNamespace, op } from "../define.js";
import { ASSISTANT_HOST_METHOD_CHANNELS } from "./assistantHost.preload.js";
import { assistantHostService } from "../../services/assistant-host/AssistantHostService.js";
import { parseAssistantHostCommand } from "../../schemas/ipc.js";
import type {
  AssistantHostStartPayload,
  AssistantHostStartResult,
} from "../../../shared/types/ipc/assistantHostIpc.js";

/**
 * IPC surface for the native assistant engine.
 *
 * Deliberately thin: three commands in, an event stream out on push channels. All the
 * lifecycle (one engine per project, pinned delivery, displacement) lives in
 * `AssistantHostService`, so this layer only validates and routes.
 */
export const assistantHostNamespace = defineIpcNamespace({
  name: "assistantHost",
  ops: {
    /**
     * Starts an engine for a project, displacing any existing one, and returns the
     * session id the renderer will see on every subsequent event.
     *
     * The owning view comes from the IPC context, not the payload — see below.
     */
    start: op(
      ASSISTANT_HOST_METHOD_CHANNELS.start,
      async (ctx, payload: AssistantHostStartPayload): Promise<AssistantHostStartResult> => {
        if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
        if (typeof payload.projectId !== "string" || !payload.projectId) {
          throw new Error("Invalid projectId");
        }
        if (typeof payload.cwd !== "string" || !payload.cwd) throw new Error("Invalid cwd");
        if (payload.tier !== undefined && typeof payload.tier !== "string") {
          throw new Error("Invalid tier");
        }
        return assistantHostService.start({
          projectId: payload.projectId,
          cwd: payload.cwd,
          // BOTH identities come from the IPC CONTEXT, never the payload. A renderer
          // must not be able to nominate which view an assistant session — and
          // therefore its approval prompts — gets delivered to.
          webContentsId: ctx.webContentsId,
          windowId: ctx.senderWindow?.id ?? 0,
          tier: payload.tier,
        });
      },
      { withContext: true }
    ),

    /**
     * Forwards one command to a live session.
     *
     * Validated against the same Zod union the engine's own events go through. A
     * malformed command is refused rather than written to the engine's stdin, where an
     * unparseable line is silently dropped and the caller would be left waiting for a
     * response to something the engine never saw.
     */
    send: op(
      ASSISTANT_HOST_METHOD_CHANNELS.send,
      async (ctx, raw: unknown): Promise<{ delivered: boolean }> => {
        const command = parseAssistantHostCommand(raw);
        if (!command) throw new Error("Invalid assistant host command");
        // A session is operable only by the renderer that started it. Routing on the
        // session id alone would make a guessed or leaked id enough to drive another
        // project's assistant — approve its tool calls, interrupt it, read nothing but
        // change everything — from a view that never owned it.
        if (!assistantHostService.isOwnedBy(command.sessionId, ctx.webContentsId)) {
          return { delivered: false };
        }
        return { delivered: assistantHostService.send(command) };
      },
      { withContext: true }
    ),

    stop: op(
      ASSISTANT_HOST_METHOD_CHANNELS.stop,
      async (ctx, sessionId: string): Promise<{ stopped: boolean }> => {
        if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid sessionId");
        // Same ownership rule as `send`: stopping is the most disruptive thing a
        // caller can do to a session it does not own.
        if (!assistantHostService.isOwnedBy(sessionId, ctx.webContentsId)) {
          return { stopped: false };
        }
        assistantHostService.stop(sessionId);
        return { stopped: true };
      },
      { withContext: true }
    ),
  },
});

export function registerAssistantHostHandlers(): () => void {
  return assistantHostNamespace.register();
}
