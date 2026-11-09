import { z } from "zod";
import { readCanopyMode } from "../../services/canopy/canopyMode.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  focusCanopyWindow,
  focusLastProjectWindow,
  hasCanopyWindowOpenedThisSession,
  isCanopyWindowView,
  openCanopyWindow,
} from "../../window/canopyWindow.js";
import { goToCanopyRun } from "../../window/canopyGoToRun.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { observeCanopySnapshots } from "./canopy.js";
import { CANOPY_WINDOW_METHOD_CHANNELS } from "./canopyWindow.preload.js";

const id = z.string().min(1).max(512);
const goToRunSchema = z.object({ workspaceId: id, runId: id });

function refuseUnlessCanopyIsOn(): void {
  if (readCanopyMode() !== "on") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "Canopy isn't on",
      userMessage: "Turn Canopy on before opening its window.",
    });
  }
}

function refuseUnlessCanopyWindow(ctx: IpcContext, message: string): void {
  if (!isCanopyWindowView(ctx.webContentsId)) {
    throw new AppError({ code: "UNSUPPORTED", message });
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
    /** Bring the Canopy window forward. False when there is none to bring. */
    focus: op(CANOPY_WINDOW_METHOD_CHANNELS.focus, async (): Promise<boolean> => {
      return focusCanopyWindow();
    }),
    /**
     * From the Canopy window, bring forward the project window the user was
     * last in. False when no project window is open, and nothing moves.
     */
    focusLastProjectWindow: op(
      CANOPY_WINDOW_METHOD_CHANNELS.focusLastProjectWindow,
      async (ctx: IpcContext): Promise<boolean> => {
        refuseUnlessCanopyWindow(ctx, "Only the Canopy window goes back to a project window");
        return focusLastProjectWindow();
      },
      { withContext: true }
    ),
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
        refuseUnlessCanopyWindow(ctx, "Only the Canopy window goes to a run this way");
        await goToCanopyRun({ workspaceId, runId });
      },
      { withContext: true }
    ),
  },
});

export function registerCanopyWindowHandlers(): () => void {
  return canopyWindowNamespace.register();
}
