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
import {
  GlobalAssistantService,
  type GlobalAssistantDeps,
  type GlobalAssistantPhaseExpectation,
} from "./GlobalAssistantService.js";
import {
  HELP_PAST_SESSIONS_LIMIT,
  type GlobalAssistantPastSessions,
  type GlobalAssistantState,
  type HelpPastSession,
} from "../../shared/types/ipc/help.js";
import { onAgentDefaultsChanged } from "./agentDefaults.js";
import type { HelpSessionService } from "./HelpSessionService.js";
import type { PtyClient } from "./PtyClient.js";
import { getWindowRegistry } from "../window/windowRef.js";

/** A keep-running choice that didn't reach disk (#18177): held, and saved again with the next write. */
export const keepRunningNotSaved = () =>
  new AppError({
    code: "INTERNAL",
    message: "The choice to keep the assistant running across restarts wasn't saved.",
    userMessage:
      "Daintree couldn't save that choice. It holds it and saves it with its next change.",
  });

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

/** The folder whose path stands in for the global assistant's project path. */
const globalAssistantFolder = () => path.join(app.getPath("userData"), GLOBAL_ASSISTANT_DIR_NAME);

/** The deps a session runs with in the app, each service loaded on first use. */
export function liveGlobalAssistantDeps(
  slot: GlobalAssistantSlot = GLOBAL_ASSISTANT_SLOT
): GlobalAssistantDeps {
  const launch = () => import("./assistants/assistantLaunch.js");
  const ptyClient = () => import("../window/serviceRefs.js").then((m) => m.getPtyClient());
  const folder = globalAssistantFolder;
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
    provision: async (agentId, options) => {
      const service = await help();
      return service.provisionSession({
        projectId: GLOBAL_ASSISTANT_ID,
        projectPath: folder(),
        agentId,
        slot,
        windowId: NO_VIEW_HANDLE,
        projectViewWebContentsId: NO_VIEW_HANDLE,
        global: true,
        ...(options?.switchingTo ? { switchingTo: options.switchingTo } : {}),
      });
    },
    // Loaded by the provision that came first, so the write is in memory at once.
    confirmSwitch: (sessionId) => {
      loadedHelp?.confirmLaneSwitch(sessionId).catch((err: unknown) => {
        console.warn("[GlobalAssistant] Keeping the conversation it switched to failed:", err);
      });
    },
    laneWork: () => loadedHelp?.laneWorkOwnershipId(GLOBAL_ASSISTANT_ID, slot),
    keptConversation: () => {
      const kept = loadedHelp?.peekPendingHibernation(GLOBAL_ASSISTANT_ID, slot) ?? null;
      return kept ? { agentId: kept.agentId, agentSessionId: kept.agentSessionId } : null;
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
    discardResume: async (options) => {
      const service = await help();
      // Forgotten once the pointers are in: one cleared before would come back with them.
      await service.whenPendingHibernationStoreWired();
      await service.discardConversation(GLOBAL_ASSISTANT_ID, slot, options);
    },
    keepsConversation: () => loadedHelp?.peekPendingHibernation(GLOBAL_ASSISTANT_ID, slot) != null,
    keptRunning: () => loadedHelp?.isLaneKeptRunning(GLOBAL_ASSISTANT_ID, slot) ?? false,
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
      // A switch to an earlier conversation (#18169) reopens that conversation
      // itself, and counts only a start its PTY reported: one that never
      // answered must not take the seat's work.
      const exact = spec.resumeAgentSessionId !== undefined && spec.exactResume === true;
      const switching = exact && spec.exactConversation === true;
      const start = () =>
        spawnHostAssistantLive(project, {
          terminalId: spec.terminalId,
          agentId: spec.agentId,
          cwd: spec.cwd,
          env: spec.env,
          prompt: spec.prompt ?? "",
          agentLaunchFlags: flags,
          ...(spec.resumeAgentSessionId ? { resumeAgentSessionId: spec.resumeAgentSessionId } : {}),
          ...(exact ? { exactResume: true as const } : {}),
          ...(switching ? { exactConversation: true as const } : {}),
        });
      return switching
        ? spawnAndConfirm(pty, start, spec.terminalId, { unreportedStarted: false })
        : spawnAndConfirm(pty, start, spec.terminalId);
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

const sessionName = (slot: GlobalAssistantSlot) => `Session ${globalAssistantSessionNumber(slot)}`;

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

/** Told the run of a session coordination just left, so what it still had in flight stops. */
const standDownListeners = new Set<(sessionId: string) => void>();

/**
 * Hear each run that stops coordinating (#18143), the moment it does. The
 * host-control runtime cancels the acting calls it still has in flight, so
 * none lands after the other session has taken over.
 */
export function onGlobalAssistantStandDown(listener: (sessionId: string) => void): () => void {
  standDownListeners.add(listener);
  return () => standDownListeners.delete(listener);
}

/**
 * Move coordination from `source` to `target` with the work it held (#18143):
 * the ownership its conversation holds, its prompts still waiting on busy
 * workers here, the terminals the person handed it, and its acting calls
 * still in flight, which are cancelled. Synchronous up to the write, so no
 * call admitted after it finds the old coordinator. Refused, with nothing
 * moved, while a launch holds `target`'s conversation, or while `target` has
 * no conversation to take the work into (`unheld` names what to say then).
 */
function moveCoordination(
  help: HelpSessionService,
  mcp: McpServer | null,
  source: GlobalAssistantService,
  target: GlobalAssistantService,
  unheld: () => AppError
): Promise<void> {
  const outgoing = source.getRunningSession();
  const handover = help.handOverLaneCoordination(GLOBAL_ASSISTANT_ID, source.slot, target.slot);
  if ("refused" in handover) {
    throw handover.refused === "unheld" ? unheld() : startingRefusal();
  }
  settleCoordinator();
  if (outgoing !== null) {
    for (const listener of [...standDownListeners]) {
      try {
        listener(outgoing.sessionId);
      } catch (err) {
        console.warn("[GlobalAssistant] A stand-down listener threw:", err);
      }
    }
    try {
      mcp?.handOverGlobalAssistantWork(outgoing.sessionId, target.getRunningSession());
    } catch (err) {
      console.warn("[GlobalAssistant] Handing the coordinator's terminals over failed:", err);
    }
  }
  return handover.written;
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
  await moveCoordination(
    help,
    mcp,
    source,
    target,
    () =>
      new AppError({
        code: "VALIDATION",
        message: "That global assistant session has no conversation to take the work into.",
        userMessage: `${sessionName(slot)} hasn't started a conversation yet. Start it, then hand coordination to it.`,
      })
  );
}

/**
 * Keep the session at `slot` running across restarts, or stop keeping it
 * (#18177); every window hears the change. Refused when it couldn't be saved,
 * though the choice is held and saved again with the next write.
 */
export async function setGlobalAssistantKeepRunning(
  slot: GlobalAssistantSlot,
  keep: boolean
): Promise<void> {
  if (shuttingDown) throw shuttingDownError();
  const service = await help();
  const saved = await service.setLaneKeepRunning(GLOBAL_ASSISTANT_ID, slot, keep);
  getGlobalAssistantService(slot).refresh();
  if (!saved) throw keepRunningNotSaved();
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
  // Asked before the pointers were in, a kept session beside it would read
  // free, and the stop would forget work it should hand over.
  if (!(await whenGlobalAssistantSessionsReadable())) throw stillStarting();
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
  const moved = moveCoordination(
    help,
    mcp,
    service,
    other,
    () =>
      new AppError({
        code: "VALIDATION",
        message: "The other global assistant session has no conversation to take the work into.",
        userMessage: `${sessionName(other.slot)} hasn't started a conversation yet. Start it before stopping this session, so it can take over the workers.`,
      })
  );
  const stopped = service.discard();
  await Promise.all([moved, stopped]);
}

/** Agents whose transcripts the past-conversation lister reads (#13206). */
function isListedAgent(agentId: string | null): agentId is HelpPastSession["agentId"] {
  return agentId === "claude" || agentId === "codex";
}

/**
 * The conversations on `agentId` a global session already holds (#18169): the
 * one each session's pointer names, running or kept, and one a launch under
 * way reopens by choice. Both sessions file their transcripts in one folder,
 * so these are what a listing of either must leave out.
 */
function heldGlobalConversations(
  agentId: string,
  slots: readonly GlobalAssistantSlot[] = GLOBAL_ASSISTANT_SLOTS
): Set<string> {
  const held = new Set<string>();
  for (const at of slots) {
    const kept = loadedHelp?.peekPendingHibernation(GLOBAL_ASSISTANT_ID, at) ?? null;
    if (kept?.agentId === agentId && kept.agentSessionId) held.add(kept.agentSessionId);
    const switching = instances.get(at)?.switchingTo() ?? null;
    if (switching?.agentId === agentId) held.add(switching.agentSessionId);
  }
  return held;
}

/**
 * Whether the session at `slot` runs, or starts, a conversation on `agentId`
 * whose id isn't known yet (a fresh Codex run names it only as it exits), so
 * nothing can tell which listed conversation is the one it has open.
 */
function runsUnnamedConversation(slot: GlobalAssistantSlot, agentId: string): boolean {
  const service = instances.get(slot);
  if (!service) return false;
  const { phase, agentId: shown } = service.getState();
  // A session tearing its run down for a switch shows no agent until the
  // successor picks one, but the conversation it captures is still on it.
  const running = shown ?? service.switchingTo()?.agentId ?? null;
  if (phase === "absent" || running !== agentId) return false;
  const kept = loadedHelp?.peekPendingHibernation(GLOBAL_ASSISTANT_ID, slot) ?? null;
  return kept === null || kept.agentId !== agentId || kept.agentSessionId === "";
}

/**
 * The global session's earlier conversations it can reopen (#18169), read from
 * the agent's own transcript store under the global assistant's folder: only
 * the agent it runs or would start on, and none either session holds.
 */
export async function listGlobalAssistantPastSessions(
  slot: GlobalAssistantSlot
): Promise<GlobalAssistantPastSessions> {
  if (!(await whenGlobalAssistantSessionsReadable())) throw stillStarting();
  const service = getGlobalAssistantService(slot);
  const agentId = await service.resumableAgentId().catch(() => null);
  if (!isListedAgent(agentId)) {
    return { slot, agentId, sessions: [], unreadable: [], truncated: false };
  }
  const exclude = heldGlobalConversations(agentId);
  const [helpSessions, lister, claudeStore, codex] = await Promise.all([
    help(),
    import("./helpPastSessions.js"),
    import("./claude/ClaudeSessionStore.js"),
    import("./codex/CodexSubagentService.js"),
  ]);
  const projectPath = globalAssistantFolder();
  const codexPath = helpSessions.getSessionPathForProject(projectPath, "codex");
  const legacyPath = helpSessions.getLegacySessionPathForProject(projectPath);
  const listing = await lister.listHelpPastSessions(
    {
      claude: helpSessions.getSessionPathForProject(projectPath, "claude"),
      codex: codexPath === legacyPath ? [codexPath] : [codexPath, legacyPath],
    },
    {
      claudeProjectsRoot:
        claudeStore.resolvePaneClaudeProjectsRoot() ?? lister.defaultClaudeProjectsRoot(),
      listCodexSessions: (cwd) =>
        codex.listCodexSessionsForCwd(cwd, undefined, HELP_PAST_SESSIONS_LIMIT + exclude.size),
    },
    { agentId, exclude }
  );
  return { slot, agentId, ...listing };
}

/**
 * Reopen one of the global session's earlier conversations in its place
 * (#18169), as the person approved it in a window. Only a conversation main
 * lists for that session now may be reopened, so a stale or forged id starts
 * nothing; the run it replaces is stopped with its conversation kept, and the
 * one reopened takes the seat's work once its spawn is confirmed.
 */
export async function resumeGlobalAssistantConversation(
  slot: GlobalAssistantSlot,
  agentSessionId: string,
  expected: GlobalAssistantPhaseExpectation
): Promise<GlobalAssistantService> {
  if (shuttingDown) throw shuttingDownError();
  const service = getGlobalAssistantService(slot);
  const listing = await listGlobalAssistantPastSessions(slot);
  const agentId = listing.agentId;
  if (!agentId || !listing.sessions.some((session) => session.sessionId === agentSessionId)) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "That conversation isn't one this global assistant session can reopen.",
      userMessage: "That conversation can't be reopened here now. Choose it again from the list.",
    });
  }
  if (shuttingDown) throw shuttingDownError();
  const other = GLOBAL_ASSISTANT_SLOTS.filter((at) => at !== slot);
  if (other.some((at) => runsUnnamedConversation(at, agentId))) {
    throw new AppError({
      code: "VALIDATION",
      message: "The other global assistant session runs a conversation whose id isn't known yet.",
      userMessage: `${sessionName(other[0]!)} has a conversation open that can't be told apart from the others yet. Stop it or try again once it has ended.`,
    });
  }
  await service.resumeConversation(
    { agentId, agentSessionId },
    expected,
    () =>
      !heldGlobalConversations(agentId, other).has(agentSessionId) &&
      !other.some((at) => runsUnnamedConversation(at, agentId))
  );
  return service;
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
