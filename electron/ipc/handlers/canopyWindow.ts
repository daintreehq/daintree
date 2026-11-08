import { z } from "zod";
import type { CanopyPendingPopOut, CanopyPopOut } from "../../../shared/types/ipc/canopy.js";
import { readCanopyMode } from "../../services/canopy/canopyMode.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  acknowledgePopOut,
  focusCanopyWindow,
  hasCanopyWindowOpenedThisSession,
  isCanopyWindowView,
  openCanopyWindow,
  peekPendingPopOut,
  popOutToCanopyWindow,
} from "../../window/canopyWindow.js";
import { goToCanopyRun } from "../../window/canopyGoToRun.js";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { typedBroadcastToLocalViews } from "../utils.js";
import { observeCanopySnapshots } from "./canopy.js";
import { CANOPY_WINDOW_METHOD_CHANNELS } from "./canopyWindow.preload.js";

const id = z.string().min(1).max(512);
const goToRunSchema = z.object({ workspaceId: id, runId: id });

/** An All hosts row's key carries its host's id and its own, so it may be longer than either. */
const listedKey = z.string().min(1).max(2048);
const popOutSchema = z.object({
  hostId: id,
  query: z.string().max(10_000),
  selection: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("worker"), runId: listedKey }),
      z.object({ kind: z.literal("assistant"), assistantId: listedKey }),
    ])
    .nullable(),
  roleFilter: z.enum(["all", "workers", "assistants"]),
  unreadOnly: z.boolean(),
  keptUnread: z.array(listedKey).max(5_000),
  archivedExpanded: z.boolean(),
  trashExpanded: z.boolean(),
  workOf: z.object({ assistantId: listedKey, name: z.string().max(512) }).nullable(),
});
const acknowledgeSchema = z.object({ id: z.number().int().positive() });

function refuseUnlessCanopyIsOn(): void {
  if (readCanopyMode() !== "on") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "Canopy isn't on",
      userMessage: "Turn Canopy on before opening its window.",
    });
  }
}

function refuseUnlessCanopyWindow(ctx: IpcContext): void {
  if (!isCanopyWindowView(ctx.webContentsId)) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "Only the Canopy window takes up a pop-out",
    });
  }
}

/** Canopy stopped being on: the window has nothing it may show. */
function closeWhenCanopyIsOff(close: () => void): () => void {
  return observeCanopySnapshots((snapshot) => {
    if (snapshot.mode !== "on") close();
  });
}

/**
 * Bring back the Canopy window a launch found open at the last quit (#16336):
 * only while Canopy is on, behind the window the user is in, and never once a
 * Canopy window has stood this session, which would reopen one the user has
 * since opened or closed themselves. True when it opened one.
 */
export function restoreCanopyWindow(): boolean {
  if (readCanopyMode() !== "on" || hasCanopyWindowOpenedThisSession()) return false;
  openCanopyWindow(closeWhenCanopyIsOff, { revealMode: "showInactive" });
  return true;
}

export const canopyWindowNamespace = defineIpcNamespace({
  name: "canopyWindow",
  ops: {
    /** Open the one Canopy window, or bring it forward. Refused unless Canopy is on. */
    open: op(CANOPY_WINDOW_METHOD_CHANNELS.open, async (): Promise<void> => {
      refuseUnlessCanopyIsOn();
      openCanopyWindow(closeWhenCanopyIsOff);
    }),
    /**
     * Move a project view's dialog into the Canopy window (#16338), opening it
     * or bringing it forward. Resolves once the window has the dialog's place,
     * when every other view's dialog is told to close; the asking view closes
     * its own. Refused or failed, nothing closes anywhere.
     */
    popOut: opValidated(
      CANOPY_WINDOW_METHOD_CHANNELS.popOut,
      popOutSchema,
      async (ctx: IpcContext, popOut: CanopyPopOut): Promise<void> => {
        if (isCanopyWindowView(ctx.webContentsId)) {
          throw new AppError({
            code: "UNSUPPORTED",
            message: "The Canopy window can't pop out into itself",
          });
        }
        refuseUnlessCanopyIsOn();
        await popOutToCanopyWindow(popOut, closeWhenCanopyIsOff);
        typedBroadcastToLocalViews(CHANNELS.CANOPY_WINDOW_POPPED_OUT, undefined, ctx.webContentsId);
      },
      { withContext: true }
    ),
    /** The pop-out waiting for the Canopy window, which asks as it boots and when told. */
    peekPopOut: op(
      CANOPY_WINDOW_METHOD_CHANNELS.peekPopOut,
      async (ctx: IpcContext): Promise<CanopyPendingPopOut | null> => {
        refuseUnlessCanopyWindow(ctx);
        return peekPendingPopOut();
      },
      { withContext: true }
    ),
    /** The Canopy window has the pop-out's place. False for one no longer waiting. */
    acknowledgePopOut: opValidated(
      CANOPY_WINDOW_METHOD_CHANNELS.acknowledgePopOut,
      acknowledgeSchema,
      async (ctx: IpcContext, { id: popOutId }: { id: number }): Promise<boolean> => {
        refuseUnlessCanopyWindow(ctx);
        return acknowledgePopOut(popOutId);
      },
      { withContext: true }
    ),
    /** Bring the Canopy window forward. False when there is none to bring. */
    focus: op(CANOPY_WINDOW_METHOD_CHANNELS.focus, async (): Promise<boolean> => {
      return focusCanopyWindow();
    }),
    /**
     * Go to a run's pane on this machine from the Canopy window, in the window
     * that has its workspace or a new one. Only the Canopy window asks: a
     * project window moves itself there instead.
     */
    goToRun: opValidated(
      CANOPY_WINDOW_METHOD_CHANNELS.goToRun,
      goToRunSchema,
      async (
        ctx: IpcContext,
        { workspaceId, runId }: { workspaceId: string; runId: string }
      ): Promise<void> => {
        if (!isCanopyWindowView(ctx.webContentsId)) {
          throw new AppError({
            code: "UNSUPPORTED",
            message: "Only the Canopy window goes to a run this way",
          });
        }
        await goToCanopyRun({ workspaceId, runId });
      },
      { withContext: true }
    ),
  },
});

export function registerCanopyWindowHandlers(): () => void {
  return canopyWindowNamespace.register();
}
