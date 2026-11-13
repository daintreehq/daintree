import { randomUUID } from "node:crypto";
import * as semver from "semver";
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
import type { ScheduledRunRef } from "../../../shared/types/scheduledRunRef.js";
import type { AgentId } from "../../../shared/types/agent.js";
import type { PtyClient } from "../PtyClient.js";
import type { AssistantLaunchSettings } from "../../../shared/utils/assistantLaunchFlags.js";
import { READY_SCREEN_LINES, untilAssistantReady } from "./assistantReadiness.js";

/**
 * The agents started as an assistant with no view (#13511): the assistant
 * backends that run live, each answering its own folder-trust question or told
 * to trust its folder at launch.
 */
export const VIEWLESS_START_AGENT_IDS: readonly string[] = [
  "claude",
  "codex",
  "copilot",
  "antigravity",
];

/** One agent a start with no view could run, as `AssistantLaunchDeps.launchableAgents` lists it. */
export interface LaunchableAssistantAgent {
  id: string;
  byDefault: boolean;
}

/**
 * The agents a start with no view can run here, the machine's own pick first.
 * Wired takes an experimental backend run by name; the picker offers stable
 * ones only, and only those may be picked for a start that names none.
 */
export function viewlessLaunchableAgents(input: {
  wired: readonly string[];
  offered: readonly string[];
  isLaunchable(agentId: string): boolean;
  /** The assistant's own pick, then the general default, as a view's launch reads them. */
  preferred: readonly (string | null | undefined)[];
}): LaunchableAssistantAgent[] {
  const wired = new Set(input.wired);
  const offered = new Set(input.offered);
  const usable = VIEWLESS_START_AGENT_IDS.filter((id) => wired.has(id) && input.isLaunchable(id));
  const preferred = input.preferred.filter(
    (id): id is string => typeof id === "string" && usable.includes(id)
  );
  return [...new Set([...preferred, ...usable])].map((id) => ({ id, byDefault: offered.has(id) }));
}

/**
 * Whether an installed CLI is new enough for its assistant wiring (#16815): an
 * `agy` before 1.5.5 would start without its lane's `--settings`. Only a
 * definite too-old reading fails, and it is read once more past any cache, so
 * an upgrade counts at once; a version that can't be read or compared passes,
 * as the panel's own gate lets it.
 */
export async function meetsAssistantVersionFloor(
  required: string | undefined,
  installedVersion: (refresh: boolean) => Promise<string | null>
): Promise<boolean> {
  if (!required) return true;
  const tooOld = (installed: string | null): boolean => {
    if (!installed) return false;
    try {
      return semver.lt(installed, required);
    } catch {
      return false;
    }
  };
  if (!tooOld(await installedVersion(false).catch(() => null))) return true;
  return !tooOld(await installedVersion(true).catch(() => null));
}

/**
 * The agent a start that names none settles on: the first default whose CLI is
 * new enough, each asked in turn, so no later one's version read holds it up.
 */
export async function firstUsableDefault(
  agents: readonly LaunchableAssistantAgent[],
  newEnough: (agentId: string) => Promise<boolean>
): Promise<string | undefined> {
  for (const agent of agents) {
    if (agent.byDefault && (await newEnough(agent.id))) return agent.id;
  }
  return undefined;
}

/** What one assistant asks of a start with no view (#13496). */
export interface AssistantLaunchRequest {
  projectId: string;
  /** A slot to take while it is vacant; absent, the lowest vacant one. */
  slot?: number;
  /** Absent: this machine's own default among the agents it starts this way. */
  agentId?: string;
  startedBy: HelpSessionStartedBy;
  /**
   * A schedule's run (#16169): its reserved terminal id, and its prompt in
   * place of the hub's greeting. The spawn adds the run's handback instruction
   * and carries the run, so the spawn handler registers it.
   */
  scheduled?: {
    terminalId: string;
    prompt: string;
    scheduledRun: ScheduledRunRef;
  };
  /**
   * Reopen this exact conversation instead of starting one (#16753): only in
   * the slot and on the agent named, in the folder it ran in, with no greeting.
   * Refused rather than started fresh when it can't be resumed.
   */
  resume?: {
    agentSessionId: string;
    /** The folder the conversation ran in, which the lane's must still be. */
    cwd: string;
    /** The claim on the lane's pointer the resume holds, which its provision quotes. */
    claimId: string;
  };
  /**
   * Never take a slot keeping a stopped conversation (#16763): a start that
   * names one is refused, and one that names none skips them, rather than
   * replace the lane's pointer. Absent, they are only tried last.
   */
  preserveKept?: true;
  /** Asked again right before the spawn; false abandons the start. */
  stillWanted?: () => boolean;
}

export type AssistantLaunchRefusal =
  | "no-project"
  | "no-slot"
  /** The slot named keeps a stopped conversation, which `preserveKept` leaves alone. */
  | "kept"
  /** The agent can't start here as an assistant with no view. */
  | "agent-unavailable"
  /** A resume's lane would run in another folder than its conversation did. */
  | "folder-moved"
  /** Asked again before the spawn and no longer wanted: its claim was dropped. */
  | "withdrawn"
  | "launch-failed";

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
   * Slots holding a stopped session's conversation for the person to resume,
   * which a start without a slot tries last, so it keeps them when it can.
   */
  keptSlots?(projectId: string): readonly number[];
  /**
   * The agents this host can start as its assistant right now, its default
   * first. `byDefault`: one a start that names no agent may pick, as the
   * assistant's own picker offers it; any other runs only when named.
   */
  launchableAgents(): Promise<LaunchableAssistantAgent[]>;
  /**
   * Whether the agent's CLI is new enough for its assistant wiring, asked only
   * of the agent a start settles on. Absent, every launchable one is.
   */
  meetsVersionFloor?(agentId: string): Promise<boolean>;
  /** `HelpSessionService.provisionSession`; throws `LANE_OCCUPIED` for a lane in use. */
  provision(input: {
    projectId: string;
    projectPath: string;
    agentId: string;
    slot: number;
    windowId: number;
    projectViewWebContentsId: number;
    vacantOnly: true;
    refuseKept?: true;
    resumeClaimId?: string;
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
      /** A schedule's run, whose handback instruction the spawn adds to `prompt`. */
      scheduledRun?: ScheduledRunRef;
      /** The conversation to reopen, refused rather than started fresh. */
      resumeAgentSessionId?: string;
      exactResume?: true;
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
  const { scheduled, resume } = request;
  // A resume names its lane and agent: any other would be a fresh session.
  if (resume && (request.slot === undefined || request.agentId === undefined || scheduled)) {
    return refused("launch-failed");
  }
  if (resume && (!resume.agentSessionId || !resume.claimId)) return refused("launch-failed");
  const project = deps.getProject(request.projectId);
  if (!project) return refused("no-project");

  const launchable = (await deps.launchableAgents()).filter(({ id }) =>
    VIEWLESS_START_AGENT_IDS.includes(id)
  );
  // A CLI too old for its wiring is passed over like an uninstalled one, as
  // `help.launchAgent` does; only the agents a start could settle on are
  // asked, in turn, so no other CLI's version read holds it up.
  const newEnough = (id: string) => deps.meetsVersionFloor?.(id) ?? Promise.resolve(true);
  let agentId: string | undefined;
  if (request.agentId !== undefined) {
    if (launchable.some(({ id }) => id === request.agentId) && (await newEnough(request.agentId))) {
      agentId = request.agentId;
    }
  } else {
    agentId = await firstUsableDefault(launchable, newEnough);
  }
  if (agentId === undefined) return refused("agent-unavailable");

  const occupied = new Set(deps.occupiedSlots(project.id));
  const kept = new Set(deps.keptSlots?.(project.id) ?? []);
  const preserveKept = request.preserveKept === true && !resume;
  // A running lane has its pointer too; its provision answers it as in use.
  if (
    preserveKept &&
    request.slot !== undefined &&
    kept.has(request.slot) &&
    !occupied.has(request.slot)
  ) {
    return refused("kept");
  }
  const vacant = Array.from({ length: MAX_ASSISTANT_SLOTS }, (_, slot) => slot).filter(
    (slot) => !occupied.has(slot)
  );
  const slots =
    request.slot !== undefined
      ? [request.slot]
      : [
          ...vacant.filter((slot) => !kept.has(slot)),
          ...(preserveKept ? [] : vacant.filter((slot) => kept.has(slot))),
        ];
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
        ...(preserveKept ? { refuseKept: true as const } : {}),
        ...(resume ? { resumeClaimId: resume.claimId } : {}),
        startedBy: request.startedBy,
      });
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      // A resume whose claim was dropped meanwhile (a discard) is refused as
      // the lane in use; it was withdrawn, not taken.
      if (resume && request.stillWanted?.() === false) return refused("withdrawn");
      // Taken or kept since it was read: the next one may still be vacant.
      if (code === "LANE_OCCUPIED") continue;
      if (code === "LANE_KEPT") {
        if (request.slot !== undefined) return refused("kept");
        continue;
      }
      return refused("launch-failed");
    }
    if (!session) return refused("launch-failed");
    slot = candidate;
    break;
  }
  if (!session || slot === undefined) return refused("no-slot");

  const agentLaunchFlags = await deps.launchFlags(agentId).catch(() => []);
  // A conversation lives in the folder it ran in; a lane provisioned anywhere
  // else would reopen nothing there.
  const moved = resume !== undefined && session.sessionPath !== resume.cwd;
  if (moved || request.stillWanted?.() === false) {
    await deps.revoke(session.sessionId).catch(() => {});
    return refused(moved ? "folder-moved" : "withdrawn");
  }

  const terminalId = scheduled?.terminalId ?? `terminal-${randomUUID()}`;
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
      prompt: resume ? "" : (scheduled?.prompt ?? HUB_STARTED_ASSISTANT_GREETING),
      agentLaunchFlags,
      ...(scheduled ? { scheduledRun: scheduled.scheduledRun } : {}),
      ...(resume
        ? { resumeAgentSessionId: resume.agentSessionId, exactResume: true as const }
        : {}),
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
    // A schedule's prompt or a resumed conversation: no greeting to wait on.
    ...(scheduled || resume ? { greeted: false } : {}),
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
    {
      getPtyClient,
      getCliAvailabilityServiceRef,
      getAgentModelCatalogService,
      getAgentVersionService,
    },
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
      const { assistantAgentId, defaultAgent } = readAgentDefaults();
      return viewlessLaunchableAgents({
        wired: getAssistantWiredAgentIds(),
        offered: getAssistantSupportedAgentIds(),
        isLaunchable: (id) =>
          isAgentLaunchable(availability?.[id as keyof typeof availability] ?? undefined),
        preferred: [assistantAgentId, defaultAgent],
      });
    },
    meetsVersionFloor: (agentId) => {
      const versions = getAgentVersionService();
      return meetsAssistantVersionFloor(
        getEffectiveAgentConfig(agentId)?.assistantMinVersion,
        async (refresh) =>
          versions ? versions.getInstalledVersionForLaunch(agentId as AgentId, refresh) : null
      );
    },
    occupiedSlots: (projectId) =>
      helpSessionService
        .listRunningLanes()
        .filter((lane) => lane.projectId === projectId)
        .map((lane) => lane.slot),
    keptSlots: (projectId) => helpSessionService.listPendingHibernationSlots(projectId),
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
  terminalId: string,
  /** What no report in time means; a caller with no readiness wait after it reads it as no start. */
  options: { unreportedStarted?: boolean } = {}
): Promise<boolean> {
  if (!pty) return false;
  const unreportedStarted = options.unreportedStarted ?? true;
  let settle: (started: boolean) => void = () => {};
  const reported = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const onResult = (id: string, result: { success?: boolean } | undefined) => {
    if (id === terminalId) settle(result?.success === true);
  };
  pty.on("spawn-result", onResult);
  const timer = setTimeout(() => settle(unreportedStarted), SPAWN_RESULT_WAIT_MS);
  try {
    return (await spawn()) && (await reported);
  } finally {
    clearTimeout(timer);
    pty.off("spawn-result", onResult);
  }
}
