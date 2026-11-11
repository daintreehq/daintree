import { z } from "zod";
import {
  AgentDirectorySubjectSchema,
  type AgentDirectorySubject,
} from "../../../shared/types/agentDirectory.js";
import type { CanopyAssistantOpenRefusal } from "../../../shared/types/ipc/canopy.js";
import { isLocalHostId } from "../../../shared/types/remoteHosts.js";
import { readCanopyMode } from "../../services/canopy/canopyMode.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  focusCanopyWindow,
  focusLastProjectWindow,
  hasCanopyWindowOpenedThisSession,
  isCanopyWindowView,
  openCanopyWindow,
} from "../../window/canopyWindow.js";
import {
  goToCanopyRun,
  isWorkspaceViewHere,
  openCanopyAssistantLane,
  showCanopyGlobalAssistant,
} from "../../window/canopyGoToRun.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import {
  assistantLaneHolder,
  globalAssistantInputOwner,
  observeCanopySnapshots,
  resolveAssistantDestination,
} from "./canopy.js";
import { checkRateLimit } from "../utils.js";
import { CANOPY_WINDOW_METHOD_CHANNELS } from "./canopyWindow.preload.js";

const id = z.string().min(1).max(512);
const goToRunSchema = z.object({ workspaceId: id, runId: id });

function refuseUnlessCanopyIsOn(): void {
  if (readCanopyMode() !== "on") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "Canopy isn't on",
      // A view on another host asks too, whose own Canopy may be on: the
      // window is this computer's.
      userMessage: "Canopy is off on this computer. Turn it on before opening its window.",
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
    /**
     * Open in Assistant from the Canopy window (#16758), for an assistant on
     * this machine: the window holding its lane, or for the global session the
     * one with its input or else the one last in use, comes forward and shows
     * it. Main finds where it runs itself rather than take a project from the
     * renderer, and refuses before anything moves when it has ended or no view
     * here holds its lane: null once it is on its way. Another host's assistant
     * opens through that host's window switch instead.
     */
    openAssistant: opValidated(
      CANOPY_WINDOW_METHOD_CHANNELS.openAssistant,
      AgentDirectorySubjectSchema,
      async (
        ctx: IpcContext,
        subject: AgentDirectorySubject
      ): Promise<CanopyAssistantOpenRefusal | null> => {
        refuseUnlessCanopyWindow(ctx, "Only the Canopy window opens an assistant this way");
        checkRateLimit(CANOPY_WINDOW_METHOD_CHANNELS.openAssistant, 20, 10_000);
        if (!isLocalHostId(subject.hostId)) {
          throw new AppError({
            code: "UNSUPPORTED",
            message: "Another host's assistant opens through its own window switch",
          });
        }
        const destination = await resolveAssistantDestination(subject);
        if (!destination) return "ended";
        if (destination.scope === "global") {
          showCanopyGlobalAssistant(subject, await globalAssistantInputOwner());
          return null;
        }
        const holder = await assistantLaneHolder(destination.projectId, destination.lane);
        if (holder === null || !isWorkspaceViewHere(destination.projectId, holder)) {
          return "not-attached";
        }
        await openCanopyAssistantLane(destination.projectId, subject);
        return null;
      },
      { withContext: true }
    ),
  },
});

export function registerCanopyWindowHandlers(): () => void {
  return canopyWindowNamespace.register();
}
