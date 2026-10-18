import { randomUUID } from "node:crypto";
import { HUB_STARTED_ASSISTANT_GREETING } from "../../../shared/config/helpAssistantGreeting.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { planChoice } from "../../../shared/utils/terminalChoice.js";
import {
  CHOOSE_SCREEN_LINES,
  keySequence,
  SEND_KEYS_GAP_MS,
} from "../../../shared/utils/terminalKeys.js";
import { NO_VIEW_HANDLE } from "../../ipc/endpoint.js";
import type { HelpSessionStartedBy } from "../../services/HelpSessionService.js";
import { READY_SCREEN_LINES, untilAssistantReady } from "./assistantReadiness.js";
import type { StartPayload, StartResult } from "./linkMethods.js";

/**
 * The agents a host starts with no view (#13511): the assistant backends that
 * run live, each answering its own folder-trust question or told to trust its
 * folder at launch.
 */
export const HOST_START_AGENT_IDS: readonly string[] = ["claude", "codex", "copilot"];

export interface HostAssistantLaunchDeps {
  getProject(projectId: string): { id: string; path: string } | null;
  /** The agents this host can start as its assistant right now, its default first. */
  launchableAgents(): Promise<string[]>;
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
  launchFlags(agentId: string): string[];
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

const refused = (reason: Extract<StartResult, { status: "refused" }>["reason"]): StartResult => ({
  status: "refused",
  reason,
});

/**
 * Start this host's own assistant in one of its projects with no view
 * (#13511), for the Shell whose link session asked: in the lane named, only
 * while nobody uses it, past its folder-trust question for its own session
 * folder and no other. Who asked is recorded on the session for as long as
 * it runs. A run that started but isn't ready is left running, as one a view
 * starts is: the first view of the project shows it.
 */
export async function startHostAssistant(
  payload: StartPayload,
  startedBy: Omit<HelpSessionStartedBy, "askingHelpSessionId">,
  deps: HostAssistantLaunchDeps
): Promise<StartResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const project = deps.getProject(payload.projectId);
  if (!project) return refused("no-project");

  const launchable = (await deps.launchableAgents()).filter((id) =>
    HOST_START_AGENT_IDS.includes(id)
  );
  const agentId = payload.agentId ?? launchable[0];
  if (agentId === undefined || !launchable.includes(agentId)) return refused("launch-failed");

  let session: Awaited<ReturnType<HostAssistantLaunchDeps["provision"]>>;
  try {
    session = await deps.provision({
      projectId: project.id,
      projectPath: project.path,
      agentId,
      slot: payload.slot,
      windowId: NO_VIEW_HANDLE,
      projectViewWebContentsId: NO_VIEW_HANDLE,
      vacantOnly: true,
      startedBy: { ...startedBy, askingHelpSessionId: payload.askingHelpSessionId },
    });
  } catch (err) {
    return refused(
      (err as { code?: unknown } | null)?.code === "LANE_OCCUPIED" ? "no-slot" : "launch-failed"
    );
  }
  if (!session) return refused("launch-failed");

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
      agentLaunchFlags: deps.launchFlags(agentId),
    })
    .catch(() => false);
  if (!spawned) {
    await deps.revoke(session.sessionId).catch(() => {});
    return refused("launch-failed");
  }

  const { sessionId } = session;
  const stillOurs = () => deps.isRunning(project.id, payload.slot, sessionId);
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
  if (ready === "consent-withdrawn") return refused("launch-failed");
  if (ready !== "ready") return refused(ready);
  if (!stillOurs()) return refused("launch-failed");
  return { status: "started", lane: { slot: payload.slot, sessionId, agentId } };
}

async function readScreen(
  deps: HostAssistantLaunchDeps,
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

/** The deps `startHostAssistant` runs with on a live host, loaded on first use. */
export async function liveHostAssistantLaunchDeps(): Promise<HostAssistantLaunchDeps> {
  const [
    { helpSessionService },
    { projectStore },
    { getPtyClient, getCliAvailabilityServiceRef },
    { spawnHostAssistantLive },
    { store },
    { getAssistantSupportedAgentIds, getSavedAssistantModelId, resolveAssistantModelId },
    { isAgentLaunchable },
  ] = await Promise.all([
    import("../../services/HelpSessionService.js"),
    import("../../services/ProjectStore.js"),
    import("../../window/serviceRefs.js"),
    import("../../services/viewless/index.js"),
    import("../../store.js"),
    import("../../../shared/config/agentRegistry.js"),
    import("../../../shared/utils/agentAvailability.js"),
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
      const supported = new Set(getAssistantSupportedAgentIds());
      const usable = HOST_START_AGENT_IDS.filter(
        (id) =>
          supported.has(id) &&
          isAgentLaunchable(availability?.[id as keyof typeof availability] ?? undefined)
      );
      // The person's default agent first, as a launch from a view picks it.
      const preferred = store.get("agentSettings")?.defaultAgent ?? null;
      return preferred !== null && usable.includes(preferred)
        ? [preferred, ...usable.filter((id) => id !== preferred)]
        : usable;
    },
    provision: (input) => helpSessionService.provisionSession(input),
    revoke: (sessionId) => helpSessionService.revokeSession(sessionId),
    launchFlags: (agentId) => {
      // The assistant's saved model and custom args, as a view's launch reads
      // them; with no catalog here, a saved model goes as saved.
      const settings = (store.get("helpAssistant") ?? {}) as {
        modelIds?: Record<string, string | null>;
        customArgs?: string;
      };
      const modelId = resolveAssistantModelId(
        agentId,
        getSavedAssistantModelId(settings.modelIds, agentId)
      ).trim();
      const custom = typeof settings.customArgs === "string" ? settings.customArgs.trim() : "";
      return [
        ...(modelId ? ["--model", modelId] : []),
        ...(custom ? custom.split(/\s+/).filter(Boolean) : []),
      ];
    },
    spawn: (project, spec) => spawnHostAssistantLive(project, spec),
    isRunning: (projectId, slot, sessionId) =>
      helpSessionService.getRunningLaneSession(projectId, slot)?.sessionId === sessionId,
    serializedState: (terminalId, options) =>
      getPtyClient()?.getSerializedStateAsync(terminalId, options) ?? Promise.resolve(null),
    write: (terminalId, data) => getPtyClient()?.write(terminalId, data),
  };
}
