import { defineIpcNamespace, op } from "../define.js";
import { ASSISTANT_HOST_METHOD_CHANNELS } from "./assistantHost.preload.js";
import { assistantHostService } from "../../services/assistant-host/AssistantHostService.js";
import { parseAssistantHostCommand } from "../../schemas/ipc.js";
import { isValidAssistantSlot } from "../../../shared/config/assistantSlots.js";
import { createLogger } from "../../utils/logger.js";
import { getProjectIdFromSenderUrl } from "../senderIdentity.js";
import type { IpcContext } from "../types.js";
import type {
  AssistantHostResumableLane,
  AssistantHostStartPayload,
  AssistantHostStartResult,
} from "../../../shared/types/ipc/assistantHostIpc.js";

const logger = createLogger("main:ipc:assistantHost");

/**
 * The workspace the calling view belongs to.
 *
 * The registry's binding first, and the startup renderer's `?projectId=` only while that
 * binding does not exist yet: main loads the restored view before it registers it, and a
 * panel coming back cold asks for its lanes inside that gap — refusing it there would
 * leave every restored conversation behind. A bound view is never overridden by its URL,
 * and no answer at all stays an identity rather than a wildcard.
 */
function callerWorkspaceId(ctx: IpcContext): string | null {
  if (ctx.projectId) return ctx.projectId;
  const sender = ctx.event?.sender;
  return sender ? getProjectIdFromSenderUrl(sender) : null;
}

/**
 * Whether the calling view IS the workspace it names.
 *
 * A lane's recorded conversation belongs to one workspace, so a view may only read or
 * forget its own — the guard the PTY hibernation handlers put on their resume tokens.
 */
function callerOwnsWorkspace(
  ctx: IpcContext,
  projectId: unknown,
  operation: string
): projectId is string {
  if (typeof projectId !== "string" || !projectId) return false;
  if (callerWorkspaceId(ctx) === projectId) return true;
  logger.warn(`${operation}: projectId mismatch — refusing a cross-workspace call`, {
    requested: projectId,
    fromView: ctx.projectId,
    webContentsId: ctx.webContentsId,
  });
  return false;
}

/**
 * IPC surface for the native assistant engine.
 *
 * Deliberately thin: commands in, an event stream out on push channels. All the
 * lifecycle (one engine per project, pinned delivery, displacement, which conversation a
 * lane continues) lives in `AssistantHostService`, so this layer only validates and
 * routes.
 */
export const assistantHostNamespace = defineIpcNamespace({
  name: "assistantHost",
  ops: {
    /**
     * Starts an engine for one of a project's lanes, displacing any existing engine on
     * THAT lane, and returns the session id the renderer will see on every subsequent
     * event. Sibling lanes are untouched — that is what makes parallel sessions work.
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
        // A start with no owning window is REFUSED rather than filed under window 0.
        //
        // `senderWindow` resolves through Daintree's own registry, not Electron's native
        // lookup — which returns null for a `WebContentsView` — so every live project
        // view does have one. Reaching here without it means the sender is destroyed,
        // unregistered, or otherwise ownerless, and `?? 0` only papered over that: the
        // window id is one of the three fields the engine binds a session to, and it is
        // what a window's teardown reclaims sessions by. A session filed under a window
        // that has never existed is one nothing can reclaim, and it holds the project's
        // state lease against every later launch.
        const windowId = ctx.senderWindow?.id;
        if (windowId === undefined) throw new Error("No owning window for this session");
        return assistantHostService.start({
          projectId: payload.projectId,
          cwd: payload.cwd,
          // The lane. Unlike the two identities below this one is the renderer's to
          // name — it is a piece of the window's own layout, not a permission — and
          // `startLocked` resolves anything out of range down to the default lane.
          slot: payload.slot,
          // Strictly `true`: anything else continues the lane's conversation, which is
          // the default a malformed payload should fall back to rather than discarding it.
          fresh: payload.fresh === true,
          // A view that is not the workspace it names may still start an engine there, as
          // it always could — but it may not continue, discard or overwrite that
          // workspace's conversation (#12365).
          recordable: callerWorkspaceId(ctx) === payload.projectId,
          // BOTH identities come from the IPC CONTEXT, never the payload. A renderer
          // must not be able to nominate which view an assistant session — and
          // therefore its approval prompts — gets delivered to.
          webContentsId: ctx.webContentsId,
          windowId,
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
        // The sending surface is carried through: a shared engine has to mirror the
        // prompt to the other windows and move the control plane to this one.
        return { delivered: assistantHostService.send(command, ctx.webContentsId) };
      },
      { withContext: true }
    ),

    stop: op(
      ASSISTANT_HOST_METHOD_CHANNELS.stop,
      async (ctx, sessionId: string, attachmentId: string): Promise<{ stopped: boolean }> => {
        if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid sessionId");
        if (typeof attachmentId !== "string" || !attachmentId) {
          throw new Error("Invalid attachmentId");
        }
        // Same rule as `send`: a caller may only act on a session it is watching.
        if (!assistantHostService.isOwnedBy(sessionId, ctx.webContentsId)) {
          return { stopped: false };
        }
        // DETACH, not stop. One project's engine is shared by every window showing it,
        // so a panel closing speaks only for its own attachment — ending the engine on
        // its say-so would tear the conversation out from under the other windows. The
        // engine stops when the last surface leaves.
        assistantHostService.detachSession(sessionId, ctx.webContentsId, attachmentId);
        return { stopped: true };
      },
      { withContext: true }
    ),

    /**
     * The lanes of this workspace whose conversation a start would continue (#12365).
     *
     * Slot numbers and whether each one's panel was open — the conversation ids stay in
     * main.
     */
    listResumable: op(
      ASSISTANT_HOST_METHOD_CHANNELS.listResumable,
      async (ctx, projectId: string): Promise<AssistantHostResumableLane[]> => {
        if (!callerOwnsWorkspace(ctx, projectId, "listResumable")) return [];
        return assistantHostService.listResumable(projectId);
      },
      { withContext: true }
    ),

    /**
     * Forgets the conversation a lane would continue, so its next start is a new one.
     *
     * What Stop and closing a lane's tab mean, both confirmed in the panel when there is
     * anything to lose. An out-of-range slot is refused rather than resolved down to lane
     * 0 the way a start's is: resolving a DISCARD would throw away a conversation the
     * caller never named.
     */
    discardResume: op(
      ASSISTANT_HOST_METHOD_CHANNELS.discardResume,
      async (ctx, projectId: string, slot: number): Promise<{ discarded: boolean }> => {
        if (!callerOwnsWorkspace(ctx, projectId, "discardResume")) return { discarded: false };
        if (!isValidAssistantSlot(slot)) return { discarded: false };
        // The asking surface, from the context: a discard is refused while another surface
        // is still watching the lane's engine, and only main can tell the two apart.
        return {
          discarded: await assistantHostService.discardResume(projectId, slot, ctx.webContentsId),
        };
      },
      { withContext: true }
    ),
  },
});

export function registerAssistantHostHandlers(): () => void {
  return assistantHostNamespace.register();
}
