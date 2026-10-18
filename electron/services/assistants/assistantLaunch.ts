import { randomUUID } from "node:crypto";
import { HUB_STARTED_ASSISTANT_GREETING } from "../../../shared/config/helpAssistantGreeting.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { planChoice } from "../../../shared/utils/terminalChoice.js";
import {
  CHOOSE_SCREEN_LINES,
  keySequence,
  SEND_KEYS_GAP_MS,
} from "../../../shared/utils/terminalKeys.js";
import { MAX_ASSISTANT_SLOTS } from "../../../shared/config/assistantSlots.js";
import { NO_VIEW_HANDLE } from "../../ipc/endpoint.js";
import type { HelpSessionStartedBy } from "../HelpSessionService.js";
import type { PtyClient } from "../PtyClient.js";
import type { AssistantLaunchSettings } from "../../../shared/utils/assistantLaunchFlags.js";
import { READY_SCREEN_LINES, untilAssistantReady } from "./assistantReadiness.js";

/**
 * The agents started as an assistant with no view (#13511): the assistant
 * backends that run live, each answering its own folder-trust question or told
 * to trust its folder at launch.
 */
export const VIEWLESS_START_AGENT_IDS: readonly string[] = ["claude", "codex", "copilot"];

/** What one assistant asks of a start with no view (#13496). */
export interface AssistantLaunchRequest {
  projectId: string;
  /** A slot to take while it is vacant; absent, the lowest vacant one. */
  slot?: number;
  /** Absent: this machine's own default among the agents it starts this way. */
  agentId?: string;
  startedBy: HelpSessionStartedBy;
}

export type AssistantLaunchRefusal = "no-project" | "no-slot" | "launch-failed";

export type AssistantLaunchResult =
  | {
      status: "started";
      sessionId: string;
      terminalId: string;
      slot: number;
      agentId: string;
      /** At its prompt; otherwise left running, stopped short of one, for the first view to show. */
      ready: boolean;
      notReadyReason: "timed-out" | "agent-error" | null;
    }
  | { status: "refused"; reason: AssistantLaunchRefusal };

export interface AssistantLaunchDeps {
  getProject(projectId: string): { id: string; path: string } | null;
  /** Slots of the project an assistant runs in now, which a start without a slot skips. */
  occupiedSlots(projectId: string): readonly number[];
  /**
   * The agents this host can start as its assistant right now, its default
   * first. `byDefault`: one a start that names no agent may pick, as the
   * assistant's own picker offers it; any other runs only when named.
   */
  launchableAgents(): Promise<Array<{ id: string; byDefault: boolean }>>;
  /** `HelpSessionService.provisionSession`; throws `LANE_OCCUPIED` for a lane in use. */
  provision(input: {
    projectId: string;
    projectPath: string;
    agentId: string;
    slot: number;
    windowId: number;
    projectViewWebContentsId: number;
    vacantOnly: true;
    startedBy: HelpSessionStartedBy;
  }): Promise<{
    sessionId: string;
    sessionPath: string;
    token: string;
    mcpUrl: string | null;
  } | null>;
  revoke(sessionId: string): Promise<void>;
  /** The flags a launch of the assistant as `agentId` carries: its saved model, its custom args. */
  launchFlags(agentId: string): Promise<string[]>;
  /** Spawn the assistant's PTY; false when nothing started. */
  spawn(
    project: { id: string; path: string },
    spec: {
      terminalId: string;
      agentId: string;
      cwd: string;
      env: Record<string, string>;
      prompt: string;
      agentLaunchFlags: string[];
    }
  ): Promise<boolean>;
  /** Whether the session is still the one running in its lane. */
  isRunning(projectId: string, slot: number, sessionId: string): boolean;
  /** The PTY's screen, as its pty-host serializes it. */
  serializedState(
    terminalId: string,
    options?: { tailRows: number }
  ): Promise<{ data: string; partial?: true } | null>;
  /** Write to the assistant's own PTY. */
  write(terminalId: string, data: string): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const refused = (reason: AssistantLaunchRefusal): AssistantLaunchResult => ({
  status: "refused",
  reason,
});

/**
 * Start an assistant in one of this machine's projects with no view, for the
 * assistant that asked (#13511, #13496): in the slot named, or the lowest one
 * vacant, only while nobody uses it, past its folder-trust question for its
 * own session folder and no other. Who asked is recorded on the session for
 * as long as it runs. A run that started but isn't ready is left running, as
 * one a view starts is, and reported with its terminal so nobody starts a
 * second: the first view of the project shows it.
 */
export async function startAssistantWithoutView(
  request: AssistantLaunchRequest,
  deps: AssistantLaunchDeps
): Promise<AssistantLaunchResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const project = deps.getProject(request.projectId);
  if (!project) return refused("no-project");

  const launchable = (await deps.launchableAgents()).filter(({ id }) =>
    VIEWLESS_START_AGENT_IDS.includes(id)
  );
  const agentId = request.agentId ?? launchable.find((agent) => agent.byDefault)?.id ?? undefined;
  if (agentId === undefined || !launchable.some(({ id }) => id === agentId)) {
    return refused("launch-failed");
  }

  const occupied = new Set(deps.occupiedSlots(project.id));
  const slots =
    request.slot !== undefined
      ? [request.slot]
      : Array.from({ length: MAX_ASSISTANT_SLOTS }, (_, slot) => slot).filter(
          (slot) => !occupied.has(slot)
        );
  let session: Awaited<ReturnType<AssistantLaunchDeps["provision"]>> = null;
  let slot: number | undefined;
  for (const candidate of slots) {
    try {
      session = await deps.provision({
        projectId: project.id,
        projectPath: project.path,
        agentId,
        slot: candidate,
        windowId: NO_VIEW_HANDLE,
        projectViewWebContentsId: NO_VIEW_HANDLE,
        vacantOnly: true,
        startedBy: request.startedBy,
      });
    } catch (err) {
      // Taken since it was read: the next one may still be vacant.
      if ((err as { code?: unknown } | null)?.code === "LANE_OCCUPIED") continue;
      return refused("launch-failed");
    }
    if (!session) return refused("launch-failed");
    slot = candidate;
    break;
  }
  if (!session || slot === undefined) return refused("no-slot");

  const terminalId = `terminal-${randomUUID()}`;
  const env: Record<string, string> = {
    DAINTREE_MCP_TOKEN: session.token,
    DAINTREE_PROJECT_ID: project.id,
    ...(session.mcpUrl ? { DAINTREE_MCP_URL: session.mcpUrl } : {}),
  };
  const spawned = await deps
    .spawn(project, {
      terminalId,
      agentId,
      cwd: session.sessionPath,
      env,
      prompt: HUB_STARTED_ASSISTANT_GREETING,
      agentLaunchFlags: await deps.launchFlags(agentId).catch(() => []),
    })
    .catch(() => false);
  if (!spawned) {
    await deps.revoke(session.sessionId).catch(() => {});
    return refused("launch-failed");
  }

  const { sessionId } = session;
  const startedSlot = slot;
  const stillOurs = () => deps.isRunning(project.id, startedSlot, sessionId);
  const ready = await untilAssistantReady({
    agentId,
    cwd: session.sessionPath,
    screen: () => readScreen(deps, terminalId, READY_SCREEN_LINES),
    answerTrust: async (answer) => {
      const plan = planChoice(
        (await readScreen(deps, terminalId, CHOOSE_SCREEN_LINES)) ?? "",
        answer
      );
      if (!plan.ok) return;
      for (const [index, key] of plan.keys.entries()) {
        if (index > 0) await sleep(SEND_KEYS_GAP_MS);
        // Asked again before each key: a run displaced meanwhile is no longer this one.
        if (!stillOurs()) return;
        deps.write(terminalId, keySequence(key));
      }
    },
    // Only this run, while it still holds its lane, is ever typed into.
    authorized: stillOurs,
    now,
    sleep,
  });
  if (ready === "consent-withdrawn" || !stillOurs()) return refused("launch-failed");
  return {
    status: "started",
    sessionId,
    terminalId,
    slot: startedSlot,
    agentId,
    ready: ready === "ready",
    notReadyReason: ready === "ready" ? null : ready,
  };
}

async function readScreen(
  deps: AssistantLaunchDeps,
  terminalId: string,
  lines: number
): Promise<string | null> {
  try {
    const snapshot = await readTailSnapshot(
      (options) => deps.serializedState(terminalId, options),
      lines
    );
    return snapshot ? tailCapturedOutput(snapshot.data, lines, true).content : null;
  } catch {
    return null;
  }
}

/** The deps `startAssistantWithoutView` runs with in the app, loaded on first use. */
export async function liveAssistantLaunchDeps(): Promise<AssistantLaunchDeps> {
  const [
    { helpSessionService },
    { projectStore },
    { getPtyClient, getCliAvailabilityServiceRef, getAgentModelCatalogService },
    { spawnHostAssistantLive },
    { store },
    { getAssistantSupportedAgentIds, getAssistantWiredAgentIds, getEffectiveAgentConfig },
    { isAgentLaunchable },
    { readAgentDefaults },
    { assistantLaunchFlags, assistantModelNeedsCatalog },
  ] = await Promise.all([
    import("../HelpSessionService.js"),
    import("../ProjectStore.js"),
    import("../../window/serviceRefs.js"),
    import("../viewless/index.js"),
    import("../../store.js"),
    import("../../../shared/config/agentRegistry.js"),
    import("../../../shared/utils/agentAvailability.js"),
    import("../agentDefaults.js"),
    import("../../../shared/utils/assistantLaunchFlags.js"),
  ]);
  return {
    getProject: (projectId) => {
      const project = projectStore.getProjectById(projectId);
      return project ? { id: project.id, path: project.path } : null;
    },
    launchableAgents: async () => {
      const service = getCliAvailabilityServiceRef();
      const availability = service
        ? (service.getAvailability() ?? (await service.checkAvailability()))
        : null;
      // Wired takes an experimental backend run by name; the picker offers stable ones only.
      const wired = new Set(getAssistantWiredAgentIds());
      const offered = new Set(getAssistantSupportedAgentIds());
      const usable = VIEWLESS_START_AGENT_IDS.filter(
        (id) =>
          wired.has(id) &&
          isAgentLaunchable(availability?.[id as keyof typeof availability] ?? undefined)
      );
      // The assistant's own pick first, then the general default, as a view's launch reads them.
      const { assistantAgentId, defaultAgent } = readAgentDefaults();
      const preferred = [assistantAgentId, defaultAgent].filter(
        (id): id is string => typeof id === "string" && usable.includes(id)
      );
      return [...new Set([...preferred, ...usable])].map((id) => ({
        id,
        byDefault: offered.has(id),
      }));
    },
    occupiedSlots: (projectId) =>
      helpSessionService
        .listRunningLanes()
        .filter((lane) => lane.projectId === projectId)
        .map((lane) => lane.slot),
    provision: (input) => helpSessionService.provisionSession(input),
    revoke: (sessionId) => helpSessionService.revokeSession(sessionId),
    launchFlags: async (agentId) => {
      const settings = (store.get("helpAssistant") ?? {}) as AssistantLaunchSettings;
      if (!assistantModelNeedsCatalog(agentId, settings)) {
        return assistantLaunchFlags(agentId, settings, null);
      }
      // As a view's catalog read answers: the live one, else the bundled models.
      const catalog = await (getAgentModelCatalogService()
        ?.getResolvedModels(agentId)
        .catch(() => null) ?? Promise.resolve(null));
      return assistantLaunchFlags(
        agentId,
        settings,
        catalog ?? { models: getEffectiveAgentConfig(agentId)?.models ?? [] }
      );
    },
    spawn: (project, spec) =>
      spawnAndConfirm(getPtyClient(), () => spawnHostAssistantLive(project, spec), spec.terminalId),
    isRunning: (projectId, slot, sessionId) =>
      helpSessionService.getRunningLaneSession(projectId, slot)?.sessionId === sessionId,
    serializedState: (terminalId, options) =>
      getPtyClient()?.getSerializedStateAsync(terminalId, options) ?? Promise.resolve(null),
    write: (terminalId, data) => getPtyClient()?.write(terminalId, data),
  };
}

/**
 * How long a spawn the handler queued gets to report how it went. No report
 * in that time isn't a failure: the readiness wait that follows decides.
 */
const SPAWN_RESULT_WAIT_MS = 15_000;

/**
 * Whether the assistant's PTY actually started. The spawn handler only queues
 * it; a bad shell or a full spawn queue is reported afterwards, as its spawn
 * result, so that is listened for before the spawn is asked for.
 */
export async function spawnAndConfirm(
  pty: Pick<PtyClient, "on" | "off"> | null,
  spawn: () => Promise<boolean>,
  terminalId: string
): Promise<boolean> {
  if (!pty) return false;
  let settle: (started: boolean) => void = () => {};
  const reported = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const onResult = (id: string, result: { success?: boolean } | undefined) => {
    if (id === terminalId) settle(result?.success === true);
  };
  pty.on("spawn-result", onResult);
  const timer = setTimeout(() => settle(true), SPAWN_RESULT_WAIT_MS);
  try {
    return (await spawn()) && (await reported);
  } finally {
    clearTimeout(timer);
    pty.off("spawn-result", onResult);
  }
}
