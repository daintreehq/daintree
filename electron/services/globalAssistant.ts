import path from "node:path";
import { app } from "electron";
import { NO_VIEW_HANDLE } from "../ipc/endpoint.js";
import {
  GLOBAL_ASSISTANT_DIR_NAME,
  GLOBAL_ASSISTANT_ID,
  GLOBAL_ASSISTANT_SLOT,
  GLOBAL_ASSISTANT_SESSION_AGENT_IDS,
  GLOBAL_ASSISTANT_SLOTS,
  globalAssistantSessionNumber,
  isGlobalAssistantSlot,
  type GlobalAssistantSlot,
} from "../../shared/config/globalAssistant.js";
import { getAgentConfig } from "../../shared/config/agentRegistry.js";
import { AppError } from "../utils/errorTypes.js";
import { store } from "../store.js";
import { GlobalAssistantService, type GlobalAssistantDeps } from "./GlobalAssistantService.js";
import type { GlobalAssistantState } from "../../shared/types/ipc/help.js";
import { onAgentDefaultsChanged } from "./agentDefaults.js";
import type { HelpSessionService } from "./HelpSessionService.js";
import type { PtyClient } from "./PtyClient.js";
import { getWindowRegistry } from "../window/windowRef.js";

const stillStarting = () =>
  new AppError({
    code: "UNSUPPORTED",
    message: "The assistants' saved conversations aren't readable yet.",
    userMessage: "Daintree is still starting. Try again in a moment.",
  });

// Held once loaded, so whether a session's lane keeps a conversation reads synchronously.
let loadedHelp: HelpSessionService | null = null;
const help = () =>
  import("./HelpSessionService.js").then((m) => (loadedHelp = m.helpSessionService));

/**
 * Whether each session can tell if its lane keeps a conversation, once it can
 * or after a bounded wait: the help service loaded and the pointers read at
 * boot wired into it.
 */
export function whenGlobalAssistantSessionsReadable(): Promise<boolean> {
  return help().then(
    (service) => service.whenPendingHibernationStoreWired(),
    () => false
  );
}

/** The deps a session runs with in the app, each service loaded on first use. */
export function liveGlobalAssistantDeps(
  slot: GlobalAssistantSlot = GLOBAL_ASSISTANT_SLOT
): GlobalAssistantDeps {
  const launch = () => import("./assistants/assistantLaunch.js");
  const ptyClient = () => import("../window/serviceRefs.js").then((m) => m.getPtyClient());
  const folder = () => path.join(app.getPath("userData"), GLOBAL_ASSISTANT_DIR_NAME);
  void help().catch(() => {});

  return {
    // Only the first session follows the assistant's default agent: a second
    // one runs as the person chose (#18142), and only when the choice itself
    // was lost does it fall back to the agent its kept conversation ran on.
    agentId:
      slot === GLOBAL_ASSISTANT_SLOT
        ? async () => {
            const { liveAssistantLaunchDeps, firstUsableDefault } = await launch();
            const deps = await liveAssistantLaunchDeps();
            const newEnough = (id: string) => deps.meetsVersionFloor?.(id) ?? Promise.resolve(true);
            return (await firstUsableDefault(await deps.launchableAgents(), newEnough)) ?? null;
          }
        : async () => {
            const service = await help();
            if (!(await service.whenPendingHibernationStoreWired())) throw stillStarting();
            return service.peekPendingHibernation(GLOBAL_ASSISTANT_ID, slot)?.agentId ?? null;
          },
    // As a start with no view takes an agent named for it.
    canRun: (agentId) => liveAgentUsable(agentId),
    provision: async (agentId) => {
      const service = await help();
      return service.provisionSession({
        projectId: GLOBAL_ASSISTANT_ID,
        projectPath: folder(),
        agentId,
        slot,
        windowId: NO_VIEW_HANDLE,
        projectViewWebContentsId: NO_VIEW_HANDLE,
        global: true,
      });
    },
    takeResume: async () => {
      const service = await help();
      // A take before the pointers are in would start fresh over a kept conversation.
      if (!(await service.whenPendingHibernationStoreWired())) throw stillStarting();
      const taken = await service.takePendingHibernation(GLOBAL_ASSISTANT_ID, slot);
      return taken
        ? { agentId: taken.agentId, agentSessionId: taken.agentSessionId, claimId: taken.claimId }
        : null;
    },
    releaseResume: async (claimId) => {
      const service = await help();
      await service.restorePendingHibernation(GLOBAL_ASSISTANT_ID, slot, claimId);
    },
    discardResume: async () => {
      const service = await help();
      // Forgotten once the pointers are in: one cleared before would come back with them.
      await service.whenPendingHibernationStoreWired();
      await service.discardConversation(GLOBAL_ASSISTANT_ID, slot);
    },
    keepsConversation: () => loadedHelp?.peekPendingHibernation(GLOBAL_ASSISTANT_ID, slot) != null,
    savePinnedAgent: (agentId) => writePinnedAgent(slot, agentId),
    coordinates: () => globalAssistantCoordinatorSlot() === slot,
    spawn: async (spec) => {
      const [{ spawnAndConfirm }, { spawnHostAssistantLive }, { liveAssistantLaunchDeps }, pty] =
        await Promise.all([launch(), import("./viewless/index.js"), launch(), ptyClient()]);
      const flags = await (
        await liveAssistantLaunchDeps()
      )
        .launchFlags(spec.agentId)
        .catch(() => []);
      const project = { id: GLOBAL_ASSISTANT_ID, path: folder() };
      return spawnAndConfirm(
        pty,
        () =>
          spawnHostAssistantLive(project, {
            terminalId: spec.terminalId,
            agentId: spec.agentId,
            cwd: spec.cwd,
            env: spec.env,
            prompt: spec.prompt ?? "",
            agentLaunchFlags: flags,
            ...(spec.resumeAgentSessionId
              ? { resumeAgentSessionId: spec.resumeAgentSessionId }
              : {}),
          }),
        spec.terminalId
      );
    },
    revoke: async (sessionId, { capture }) => {
      const service = await help();
      await service.revokeSession(sessionId, capture ? { captureHibernation: true } : undefined);
    },
    kill: (terminalId) => {
      void ptyClient().then((pty) => pty?.kill(terminalId, "global-assistant-ended"));
    },
    focusedWindows: () =>
      (getWindowRegistry()?.focusOrder({ focusedOnly: true }) ?? [])
        .filter((ctx) => !ctx.browserWindow.isDestroyed())
        .map((ctx) => ctx.windowId),
  };
}

/**
 * Whenever input changes hands, drop whatever the PTY host still holds for the
 * run: a submit queued, or the Enter of one in flight, was the previous
 * owner's and must not land in the new owner's line (#14454). Main has already
 * refused anything the old owner sends from here on.
 */
export function fenceInputOnOwnerChange(
  service: GlobalAssistantService,
  ptyClient: () => Promise<Pick<PtyClient, "cancelPendingInput"> | null>
): void {
  let epoch = service.getState().inputEpoch;
  service.onChange((state) => {
    if (state.inputEpoch === epoch) return;
    epoch = state.inputEpoch;
    const terminalId = state.terminalId;
    if (!terminalId) return;
    void ptyClient().then((pty) => pty?.cancelPendingInput(terminalId));
  });
}

/** The agent each session was started on by choice (#18142), by slot. */
function readPinnedAgent(slot: GlobalAssistantSlot): string | null {
  try {
    const agentId = store.get("globalAssistantPinnedAgents")?.[String(slot)];
    return typeof agentId === "string" && agentId !== "" ? agentId : null;
  } catch (err) {
    console.warn("[GlobalAssistant] Reading the sessions' agents failed:", err);
    return null;
  }
}

function writePinnedAgent(slot: GlobalAssistantSlot, agentId: string | null): void {
  const pinned = { ...store.get("globalAssistantPinnedAgents") };
  if (agentId === null) delete pinned[String(slot)];
  else pinned[String(slot)] = agentId;
  store.set("globalAssistantPinnedAgents", pinned);
}

const instances = new Map<GlobalAssistantSlot, GlobalAssistantService>();
let shuttingDown = false;

export function getGlobalAssistantService(
  slot: GlobalAssistantSlot = GLOBAL_ASSISTANT_SLOT
): GlobalAssistantService {
  const existing = instances.get(slot);
  if (existing) return existing;
  const deps = liveGlobalAssistantDeps(slot);
  const service = new GlobalAssistantService(deps, {
    slot,
    pinnedAgentId: readPinnedAgent(slot),
    followsDefault: slot === GLOBAL_ASSISTANT_SLOT,
  });
  if (shuttingDown) service.closeAdmission();
  instances.set(slot, service);
  if (slot === GLOBAL_ASSISTANT_SLOT) {
    onAgentDefaultsChanged(() => {
      void deps.agentId().then((agentId) => service.onAgentChanged(agentId));
    });
  }
  void import("../window/serviceRefs.js").then(({ getPtyClient }) => {
    getPtyClient()?.on("exit", (id: string) => service.handleTerminalExit(id));
  });
  fenceInputOnOwnerChange(service, () =>
    import("../window/serviceRefs.js").then(({ getPtyClient }) => getPtyClient())
  );
  service.onChange(() => settleCoordinator());
  // A session told before the pointers were in may have said it keeps nothing:
  // it says its state again once they are, however late.
  void help()
    .then((helpSessions) => helpSessions.pendingHibernationStoreReady())
    .then(
      () => service.refresh(),
      () => {}
    );
  return service;
}

/** Every session the machine may hold, created as needed: a read of one never starts it. */
export function getGlobalAssistantServices(): GlobalAssistantService[] {
  return GLOBAL_ASSISTANT_SLOTS.map((slot) => getGlobalAssistantService(slot));
}

/** Whether the session has been created; shutdown must not create it just to stop it. */
export function peekGlobalAssistantService(
  slot: GlobalAssistantSlot = GLOBAL_ASSISTANT_SLOT
): GlobalAssistantService | null {
  return instances.get(slot) ?? null;
}

/** The sessions created so far, first session first. */
export function peekGlobalAssistantServices(): GlobalAssistantService[] {
  return GLOBAL_ASSISTANT_SLOTS.flatMap((slot) => instances.get(slot) ?? []);
}

/** The created session whose current run is on this terminal, if any. */
export function peekGlobalAssistantServiceForTerminal(
  terminalId: string
): GlobalAssistantService | null {
  return (
    peekGlobalAssistantServices().find((service) => service.getState().terminalId === terminalId) ??
    null
  );
}

/** A view went away: drop its attachments to every session, and nothing else. */
export function detachGlobalAssistantWebContents(webContentsId: number): void {
  for (const service of peekGlobalAssistantServices()) service.detachWebContents(webContentsId);
}

/** A window closed: drop its views' attachments to every session, and nothing else. */
export function detachGlobalAssistantWindow(windowId: number): void {
  for (const service of peekGlobalAssistantServices()) service.detachWindow(windowId);
}

const LIMIT_REACHED =
  "This machine already has two global assistant sessions. Stop one to start another.";

const shuttingDownError = () =>
  new AppError({ code: "CANCELLED", message: "The app is shutting down." });

/** The launch each new session began, by slot, for the window that asked to join. */
const newLaunches = new Map<
  GlobalAssistantSlot,
  { generation: number; launch: Promise<GlobalAssistantState> }
>();

/**
 * Start a global assistant session on the agent the person chose (#18142),
 * in the first session the machine has free: never more than two at once.
 * The agent is checked first; the choice of session and its claim then run
 * with no await between them, so two windows asking at once never share one.
 * Answers once the session is claimed; its launch is joined by generation.
 */
export async function startNewGlobalAssistantSession(
  agentId: string,
  usable: (agentId: string) => Promise<boolean> = liveAgentUsable
): Promise<GlobalAssistantService> {
  if (shuttingDown) throw shuttingDownError();
  const name = getAgentConfig(agentId)?.name ?? agentId;
  if (!GLOBAL_ASSISTANT_SESSION_AGENT_IDS.includes(agentId) || !(await usable(agentId))) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: `${agentId} can't run a global assistant session here.`,
      userMessage: `${name} can't run a global assistant session on this machine.`,
    });
  }
  // Read once the pointers are in, so a kept conversation counts: never guessed.
  if (!(await whenGlobalAssistantSessionsReadable())) throw stillStarting();
  if (shuttingDown) throw shuttingDownError();
  const free = getGlobalAssistantServices().find((service) => !service.isOccupied());
  if (!free) {
    throw new AppError({
      code: "VALIDATION",
      message: "Both global assistant sessions are in use.",
      userMessage: LIMIT_REACHED,
    });
  }
  const launch = free.startOn(agentId);
  launch.catch(() => {});
  newLaunches.set(free.slot, { generation: free.getState().generation, launch });
  return free;
}

/**
 * The outcome of the launch a new session began at `generation`, for the
 * window that asked for it: never a launch of its own. One already over
 * that nobody joined answers as it ended.
 */
export function joinNewGlobalAssistantLaunch(
  slot: GlobalAssistantSlot,
  generation: number
): Promise<GlobalAssistantState> {
  const pending = newLaunches.get(slot);
  if (pending && pending.generation === generation) {
    newLaunches.delete(slot);
    return pending.launch;
  }
  const service = getGlobalAssistantService(slot);
  const state = service.getState();
  if (state.generation === generation && state.phase !== "absent") return service.ensureSession();
  return Promise.reject(
    new AppError({ code: "CANCELLED", message: "That global assistant launch has ended." })
  );
}

/** The session every window was last told coordinates, so a change reaches both states. */
let toldCoordinator: GlobalAssistantSlot | null = null;

/** Whether the session counts toward the limit, read without creating it. */
function slotOccupied(slot: GlobalAssistantSlot): boolean {
  const service = instances.get(slot);
  if (service) return service.isOccupied();
  return (
    readPinnedAgent(slot) !== null ||
    loadedHelp?.peekPendingHibernation(GLOBAL_ASSISTANT_ID, slot) != null
  );
}

/**
 * The session that coordinates (#18143): the only one whose `host.call` acts
 * on workers. A lone session always does; with two, the one the person chose,
 * the first when no choice was ever kept. Nothing but the person's handover
 * or a stop of the coordinator changes it.
 */
export function globalAssistantCoordinatorSlot(): GlobalAssistantSlot {
  const occupied = GLOBAL_ASSISTANT_SLOTS.filter(slotOccupied);
  if (occupied.length === 1) return occupied[0]!;
  const chosen = loadedHelp?.getLaneCoordinator(GLOBAL_ASSISTANT_ID);
  return isGlobalAssistantSlot(chosen) ? chosen : GLOBAL_ASSISTANT_SLOT;
}

/**
 * A lone session is kept as the coordinator, so a second one started later
 * never takes it, and both states say so whenever the coordinator changes.
 * Kept only once the pointers are in: before then a kept session reads free.
 */
function settleCoordinator(): void {
  const help = loadedHelp;
  if (!shuttingDown && help !== null) {
    const occupied = GLOBAL_ASSISTANT_SLOTS.filter(slotOccupied);
    if (occupied.length === 1) {
      help.setLaneCoordinator(GLOBAL_ASSISTANT_ID, occupied[0]!).catch((err: unknown) => {
        console.warn("[GlobalAssistant] Keeping the coordinating session failed:", err);
      });
    }
  }
  const coordinator = globalAssistantCoordinatorSlot();
  if (coordinator === toldCoordinator) return;
  toldCoordinator = coordinator;
  for (const service of peekGlobalAssistantServices()) service.refresh();
}

const sessionName = (slot: GlobalAssistantSlot) =>
  `Session ${globalAssistantSessionNumber(slot)}`;

type McpServer = Pick<
  import("./McpServerService.js").McpServerService,
  "handOverGlobalAssistantWork"
>;

/** Loaded before a handover, so the work moves in the same turn as the choice. */
function loadMcpServer(): Promise<McpServer | null> {
  return import("./McpServerService.js").then(
    (m) => m.mcpServerService,
    (err: unknown) => {
      console.warn("[GlobalAssistant] The MCP server didn't load for a handover:", err);
      return null;
    }
  );
}

const startingRefusal = () =>
  new AppError({
    code: "VALIDATION",
    message: "A global assistant session is starting or stopping.",
    userMessage: "A global assistant session is starting or stopping. Try again once it settles.",
  });

/**
 * Move coordination from `source` to `target` with the work it held (#18143):
 * the ownership its conversation holds, its prompts still waiting on busy
 * workers here, and the terminals the person handed it. Synchronous up to the
 * write, so no call admitted after it finds the old coordinator. Refused,
 * with nothing moved, while a launch holds `target`'s conversation.
 */
function moveCoordination(
  help: HelpSessionService,
  mcp: McpServer | null,
  source: GlobalAssistantService,
  target: GlobalAssistantService
): Promise<void> {
  const outgoing = source.getRunningSession();
  const written = help.handOverLaneCoordination(GLOBAL_ASSISTANT_ID, source.slot, target.slot);
  if (written === null) throw startingRefusal();
  settleCoordinator();
  if (outgoing !== null && mcp !== null) {
    try {
      mcp.handOverGlobalAssistantWork(outgoing.sessionId, target.getRunningSession());
    } catch (err) {
      console.warn("[GlobalAssistant] Handing the coordinator's terminals over failed:", err);
    }
  }
  return written;
}

/**
 * Hand coordination to the session at `slot`, as the person asked (#18143).
 * The session handing it over keeps its conversation and can read, but acts
 * on no worker until coordination comes back to it.
 */
export async function handGlobalAssistantCoordination(slot: GlobalAssistantSlot): Promise<void> {
  if (shuttingDown) throw shuttingDownError();
  if (!(await whenGlobalAssistantSessionsReadable())) throw stillStarting();
  const mcp = await loadMcpServer();
  if (shuttingDown) throw shuttingDownError();
  const help = loadedHelp;
  if (!help) throw stillStarting();
  const from = globalAssistantCoordinatorSlot();
  if (from === slot) return;
  const source = getGlobalAssistantService(from);
  const target = getGlobalAssistantService(slot);
  if (!target.isOccupied()) {
    throw new AppError({
      code: "VALIDATION",
      message: "That global assistant session isn't open.",
      userMessage: `${sessionName(slot)} isn't open. Start it to hand coordination to it.`,
    });
  }
  if (!source.isSettled() || !target.isSettled()) throw startingRefusal();
  await moveCoordination(help, mcp, source, target);
}

/**
 * Stop the session at `slot` and forget its conversation. When it coordinates
 * and the other session stays, coordination and the work it held go to that
 * one first, in the same turn (#18143), so nothing it launched is forgotten
 * with it. `check` runs just before, once nothing is awaited between it and
 * the stop, and refuses by throwing.
 */
export async function stopGlobalAssistantSession(
  slot: GlobalAssistantSlot,
  check: (service: GlobalAssistantService) => void = () => {}
): Promise<void> {
  const service = getGlobalAssistantService(slot);
  const other = getGlobalAssistantService(slot === 0 ? 1 : 0);
  const mcp = other.isOccupied() ? await loadMcpServer() : null;
  check(service);
  const help = loadedHelp;
  if (
    shuttingDown ||
    help === null ||
    !other.isOccupied() ||
    globalAssistantCoordinatorSlot() !== slot
  ) {
    return service.discard();
  }
  if (!other.isSettled()) {
    throw new AppError({
      code: "VALIDATION",
      message: "The other global assistant session is starting.",
      userMessage: `${sessionName(other.slot)} is starting. Stop this session once it has, so it can take over the workers.`,
    });
  }
  const moved = moveCoordination(help, mcp, service, other);
  const stopped = service.discard();
  await Promise.all([moved, stopped]);
}

async function liveAgentUsable(agentId: string): Promise<boolean> {
  const { liveAssistantLaunchDeps } = await import("./assistants/assistantLaunch.js");
  const deps = await liveAssistantLaunchDeps();
  if (!(await deps.launchableAgents()).some((agent) => agent.id === agentId)) return false;
  return (await deps.meetsVersionFloor?.(agentId)) ?? true;
}

/**
 * Quit began. Latched whether or not a session exists yet, so a window that
 * asks for one afterwards finds admission closed instead of launching a run
 * the shutdown capture has already passed. Every session captures at once.
 */
export function beginGlobalAssistantShutdown(): Promise<void> {
  shuttingDown = true;
  return Promise.all(peekGlobalAssistantServices().map((service) => service.shutdown())).then(
    () => undefined
  );
}
