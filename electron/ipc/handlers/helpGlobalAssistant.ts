import { z } from "zod";
import { AppError } from "../../utils/errorTypes.js";
import type { IpcContext } from "../types.js";
import type {
  GlobalAssistantAttachment,
  GlobalAssistantView,
  WindowGlobalAssistantPanel,
} from "../../../shared/types/ipc/help.js";
import type { AgentState } from "../../../shared/types/agent.js";
import { AgentDirectorySubjectSchema } from "../../../shared/types/agentDirectory.js";
import { LOCAL_HOST_ID, isLocalHostId } from "../../../shared/types/remoteHosts.js";
import { events } from "../../services/events.js";
import type { GlobalAssistantService } from "../../services/GlobalAssistantService.js";
import { getGlobalAssistantService } from "../../services/globalAssistant.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getWindowRegistry } from "../../window/windowRef.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";

/**
 * The global assistant's window-facing surface (#14159). Every call is made by
 * a window; none can name another window's attachment, and none returns the
 * session's credentials. Attaching to a session that is not running is
 * allowed — the panel shows the empty state and asks to start it.
 */

/**
 * The state with the exact subject a view watches the run by. The PTY's launch
 * generation, not the lifecycle's, is what the terminal watch checks.
 */
export function globalAssistantView(service: GlobalAssistantService): GlobalAssistantView {
  const state = service.getState();
  const incarnation = runIncarnation(service);
  const seen = observed.get(service);
  return {
    ...state,
    subject:
      state.terminalId && incarnation !== null
        ? {
            hostId: LOCAL_HOST_ID,
            scope: { kind: "global" },
            terminalId: state.terminalId,
            incarnation,
          }
        : null,
    // Seen on an earlier PTY under the same id, it says nothing of this one.
    agentState:
      seen && seen.terminalId === state.terminalId && seen.incarnation === incarnation
        ? seen.agentState
        : null,
  };
}

/** The running session's PTY launch generation; null while nothing runs. */
function runIncarnation(service: GlobalAssistantService): number | null {
  const { phase, terminalId } = service.getState();
  return phase === "running" && terminalId
    ? (getPtyClient()?.getLiveGeneration(terminalId) ?? null)
    : null;
}

/** What the run's terminal was last seen doing, and on which PTY. */
interface Observation {
  terminalId: string;
  incarnation: number;
  agentState: AgentState;
}

const observed = new WeakMap<GlobalAssistantService, Observation>();
const published = new WeakSet<GlobalAssistantService>();

/**
 * The service, with every change of it told to the windows: who holds input
 * moves under a window without it asking, and it must hear so at once.
 *
 * So does what its terminal is seen doing, which a window shows on the scope
 * switch without attaching. Every transition reaches main whoever is
 * watching; a run already going when this is first wired, or respawned by a
 * PTY host recovery, is read once off its terminal to start from.
 */
function service(): GlobalAssistantService {
  const instance = getGlobalAssistantService();
  if (!published.has(instance)) {
    published.add(instance);
    const publish = () =>
      broadcastToRenderer(CHANNELS.HELP_GLOBAL_ASSISTANT_CHANGED, globalAssistantView(instance));
    // Bumped by every transition seen, so a read that left before one can't undo it.
    let transitions = 0;
    let reading: string | null = null;
    const seed = () => {
      const { terminalId } = instance.getState();
      const incarnation = runIncarnation(instance);
      const pty = getPtyClient();
      if (!pty || !terminalId || incarnation === null) return;
      const seen = observed.get(instance);
      if (seen?.terminalId === terminalId && seen.incarnation === incarnation) return;
      const key = `${terminalId}:${incarnation}`;
      if (reading === key) return;
      reading = key;
      const since = transitions;
      void pty.getTerminalAsync(terminalId).then(
        (info) => {
          if (reading === key) reading = null;
          if (transitions !== since || !info?.agentState) return;
          if (instance.getState().terminalId !== terminalId) return;
          if (runIncarnation(instance) !== incarnation) return;
          observed.set(instance, { terminalId, incarnation, agentState: info.agentState });
          publish();
        },
        () => {
          if (reading === key) reading = null;
        }
      );
    };
    instance.onChange(() => {
      publish();
      seed();
    });
    // A PTY host recovery respawns the run's terminal under a new launch
    // generation with no lifecycle change: the subject a view watches moves.
    getPtyClient()?.on("spawn-result", (id: string) => {
      if (id !== instance.getState().terminalId) return;
      publish();
      seed();
    });
    events.on("agent:state-changed", ({ terminalId, state }) => {
      if (!terminalId || terminalId !== instance.getState().terminalId) return;
      const incarnation = runIncarnation(instance);
      if (incarnation === null) return;
      transitions++;
      observed.set(instance, { terminalId, incarnation, agentState: state });
      publish();
    });
    seed();
  }
  return instance;
}

function requireWindow(ctx: IpcContext): { webContentsId: number; windowId: number } {
  if (!ctx.senderWindow) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "The global assistant is shown by a window of this machine.",
    });
  }
  return { webContentsId: ctx.webContentsId, windowId: ctx.senderWindow.id };
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new AppError({ code: "VALIDATION", message: "An attachment id is required." });
  }
  return value;
}

function requireEligible(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new AppError({ code: "VALIDATION", message: "Whether the view can type is required." });
  }
  return value;
}

export async function handleEnsureGlobalAssistant(ctx: IpcContext): Promise<GlobalAssistantView> {
  requireWindow(ctx);
  const instance = service();
  await instance.ensureSession();
  return globalAssistantView(instance);
}

export async function handleGetGlobalAssistantState(): Promise<GlobalAssistantView> {
  return globalAssistantView(service());
}

/**
 * `eligible` says whether the attaching view could type to the run now; one
 * that can't (Canopy covers it) is never handed input that nobody holds.
 */
export async function handleAttachGlobalAssistant(
  ctx: IpcContext,
  eligible?: boolean
): Promise<GlobalAssistantAttachment> {
  const { webContentsId, windowId } = requireWindow(ctx);
  const canType = eligible === undefined ? true : requireEligible(eligible);
  const instance = service();
  const attachmentId = instance.attach(webContentsId, windowId, canType);
  return { attachmentId, state: globalAssistantView(instance) };
}

/** The attachment's view can, or can no longer, type to the run; it may fill a vacancy. */
export async function handleSetGlobalAssistantInputEligible(
  ctx: IpcContext,
  attachmentId: string,
  eligible: boolean
): Promise<void> {
  const { webContentsId } = requireWindow(ctx);
  service().setEligible(requireId(attachmentId), webContentsId, requireEligible(eligible));
}

export async function handleDetachGlobalAssistant(
  ctx: IpcContext,
  attachmentId: string
): Promise<void> {
  const { webContentsId } = requireWindow(ctx);
  service().detach(requireId(attachmentId), webContentsId);
}

export async function handleClaimGlobalAssistantInput(
  ctx: IpcContext,
  attachmentId: string
): Promise<GlobalAssistantView> {
  const { webContentsId } = requireWindow(ctx);
  const instance = service();
  instance.claimInput(requireId(attachmentId), webContentsId);
  return globalAssistantView(instance);
}

export async function handleReleaseGlobalAssistantInput(
  ctx: IpcContext,
  attachmentId: string
): Promise<GlobalAssistantView> {
  const { webContentsId } = requireWindow(ctx);
  const instance = service();
  instance.releaseInput(requireId(attachmentId), webContentsId);
  return globalAssistantView(instance);
}

/**
 * A confirmation names the run it was asked about: one answered after that run
 * was already replaced must not end its successor.
 */
function requireGeneration(instance: GlobalAssistantService, expected: unknown): void {
  if (expected === undefined) return;
  if (!Number.isSafeInteger(expected)) {
    throw new AppError({ code: "VALIDATION", message: "Invalid generation" });
  }
  if (instance.getState().generation !== expected) {
    throw new AppError({
      code: "STALE_GENERATION",
      message: "The global assistant changed since this was asked",
      userMessage: "The global assistant changed since you asked. Nothing was stopped.",
    });
  }
}

export async function handleRestartGlobalAssistant(
  ctx: IpcContext,
  expectedGeneration?: number
): Promise<GlobalAssistantView> {
  requireWindow(ctx);
  const instance = service();
  requireGeneration(instance, expectedGeneration);
  await instance.restart();
  return globalAssistantView(instance);
}

export async function handleDiscardGlobalAssistant(
  ctx: IpcContext,
  expectedGeneration?: number
): Promise<GlobalAssistantView> {
  requireWindow(ctx);
  const instance = service();
  requireGeneration(instance, expectedGeneration);
  await instance.discard();
  return globalAssistantView(instance);
}

const WindowGlobalAssistantPanelSchema = z.object({
  showing: z.boolean(),
  target: AgentDirectorySubjectSchema.nullable(),
});

/** The sender's own window's view manager, when the sender is one of that window's views. */
function senderViewManager(ctx: IpcContext): ProjectViewManager | null {
  const windowId = ctx.senderWindow?.id;
  if (windowId === undefined) return null;
  const manager = getWindowRegistry()?.getByWindowId(windowId)?.services.projectViewManager;
  return manager?.ownsView(ctx.webContentsId) ? manager : null;
}

/**
 * Whether the sender's window last showed the global assistant in its panel
 * (#16099). Every switch entry point — the switcher, a notification, File →
 * Recent Projects — lands the incoming view here, which is why it's held in
 * main and read by the view rather than handed over by whoever switched.
 */
export async function handleGetWindowGlobalAssistantPanel(
  ctx: IpcContext
): Promise<WindowGlobalAssistantPanel | null> {
  return senderViewManager(ctx)?.getGlobalAssistantPanel() ?? null;
}

/**
 * The sender's panel, for its window to carry over a project switch. Ignored
 * from any view but the one the window shows: a late report from a view just
 * switched away from must not overwrite what the incoming view said.
 */
export async function handleReportWindowGlobalAssistantPanel(
  ctx: IpcContext,
  panel: WindowGlobalAssistantPanel
): Promise<void> {
  const parsed = WindowGlobalAssistantPanelSchema.safeParse(panel);
  if (
    !parsed.success ||
    (parsed.data.target !== null &&
      (parsed.data.target.scope.kind !== "global" || !isLocalHostId(parsed.data.target.hostId)))
  ) {
    throw new AppError({ code: "VALIDATION", message: "Invalid global assistant panel state." });
  }
  senderViewManager(ctx)?.recordGlobalAssistantPanel(ctx.webContentsId, parsed.data);
}
