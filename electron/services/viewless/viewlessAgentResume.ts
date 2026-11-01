import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../ipc/channels.js";
import type { PanelSnapshot, Project } from "../../../shared/types/project.js";
import type { AgentSessionRecord } from "../../../shared/types/ipc/agentSessionHistory.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { buildResumeCommand, dropRetiredAgentModel } from "../../../shared/types/agentSettings.js";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability.js";
import { resolveAgentLaunchBaseCommandFor } from "../../../shared/utils/agentLaunchCommand.js";
import { buildLaunchIdentity } from "../../../shared/utils/agentLaunchPlan.js";
import { unknownAgentIdMessage } from "../../../shared/utils/agentLaunchValidation.js";
import { reconcileResumeLaunchFlagsWith } from "../../../shared/utils/agentResumeFlags.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  buildPanelLimitSnapshot,
  computeHardwareDefaults,
} from "../../../shared/utils/panelLimit.js";
import { serializePtyPanel } from "../../../shared/utils/ptyPanelSnapshot.js";
import { mergeTerminalLaunchEnv } from "../../../shared/utils/terminalLaunchOptions.js";
import type { ViewlessDeps, ViewlessTerminalRecord } from "./ViewlessActionExecutor.js";
import { hostStartedTerminals } from "./hostStartedTerminals.js";
import { recordViewlessTerminal } from "./projectStateAuthoring.js";
import { paneLaunchContext } from "./viewlessAgents.js";
import { countProjectPanels } from "./viewlessTerminals.js";
import { readProjectWorktrees } from "./viewlessWorktrees.js";

/** A saved agent session to reopen as a pane of its own worktree. */
export interface AgentSessionPaneRequest {
  projectId: string;
  worktreeId: string;
  agentId: string;
  /** The conversation to reopen; absent or blank when none was ever captured. */
  sessionId: string | null | undefined;
  /**
   * The directory the session ran in, inside the worktree, for a session the
   * history no longer holds. A journaled directory always wins; absent both,
   * the worktree's root.
   */
  cwd?: string;
}

export type AgentSessionPaneRefusal =
  | "no-session-id"
  | "unknown-agent"
  | "no-resume-support"
  | "unknown-project"
  | "history-unavailable"
  | "worktrees-unavailable"
  | "worktree-gone"
  | "other-worktree"
  | "terminals-unavailable"
  | "panel-limit"
  | "missing-cli"
  | "spawn-failed";

export type AgentSessionPaneResult =
  | {
      status: "launched";
      projectId: string;
      worktreeId: string;
      terminalId: string;
      cwd: string;
      /** False when the pane runs but the project's saved layout could not take it. */
      savedInLayout: boolean;
    }
  | {
      /** A live pane of this worktree already holds the session; nothing was launched. */
      status: "existing";
      projectId: string;
      worktreeId: string;
      terminalId: string;
    }
  | { status: "refused"; reason: AgentSessionPaneRefusal; message: string };

/** What a resume needs beyond the viewless deps: the filesystem and the spawn's own report. */
export interface AgentSessionPaneRuntime {
  isDirectory(path: string): Promise<boolean>;
  /**
   * Runs `spawn` and resolves whether the PTY started: false only once the
   * pty-host reports the spawn failed, or nothing could listen for its report.
   */
  confirmSpawn(terminalId: string, spawn: () => Promise<void>): Promise<boolean>;
}

/**
 * What a resume target never is: an option, or a CLI's own word for "the
 * latest" (`codex resume --last`, `gemini --resume latest`), either of which
 * would reopen some other conversation under this one's id.
 */
function isResumeTarget(sessionId: string): boolean {
  return /^[A-Za-z0-9][\w.:-]*$/.test(sessionId) && !/^(latest|last)$/i.test(sessionId);
}

const refused = (reason: AgentSessionPaneRefusal, message: string): AgentSessionPaneResult => ({
  status: "refused",
  reason,
  message,
});

/**
 * Resumes keyed by project, worktree, agent and session. The duplicate scan
 * alone can't stop two concurrent calls each launching one: the second scans
 * inside the first one's awaits, before its terminal exists. A joiner gets
 * the first call's result.
 */
const inFlight = new Map<string, Promise<AgentSessionPaneResult>>();

/**
 * Reopen a saved agent session as a new pane in its own worktree, from main
 * and with no view involved (#16000): spawned through the same handler a
 * view's launch reaches, so the pane gets its launch-time MCP config, a fresh
 * bearer and a fresh launch generation, and recorded in the project's saved
 * layout, so the next view to open the project shows it (#14473).
 *
 * The resume is built as a view's resume builds it: the journaled launch
 * flags reconciled against the current settings, the agent's name as the
 * title, the ambient environment. It never falls back to "the latest"
 * conversation: an agent that can't reopen one by id is refused.
 *
 * A live pane of the same worktree already holding the session is returned
 * instead of a second agent on one transcript, as `findLiveResumePanelId`
 * does in a view.
 */
export async function resumeAgentSessionAsPane(
  request: AgentSessionPaneRequest,
  deps: ViewlessDeps,
  runtime: AgentSessionPaneRuntime
): Promise<AgentSessionPaneResult> {
  const sessionId = request.sessionId?.trim() ?? "";
  if (sessionId === "") {
    return refused("no-session-id", "No session id is known for this agent session.");
  }
  if (!isResumeTarget(sessionId)) {
    return refused("no-session-id", "That isn't a session id an agent can reopen exactly.");
  }
  const agentConfig = getEffectiveAgentConfig(request.agentId);
  if (!agentConfig) return refused("unknown-agent", unknownAgentIdMessage(request.agentId));
  const resumeKind = agentConfig.resume?.kind;
  // The other kinds reopen whatever was last in the directory, whatever id they're given.
  if (resumeKind !== "session-id" && resumeKind !== "named-target") {
    return refused(
      "no-resume-support",
      `${agentConfig.name} can't reopen a conversation by its session id.`
    );
  }
  const project = deps.getProject(request.projectId);
  if (!project) return refused("unknown-project", "No project with that id is known.");

  const key = JSON.stringify([project.id, request.worktreeId, request.agentId, sessionId]);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = Promise.resolve().then(() =>
    launchResumedPane(project, { ...request, sessionId }, agentConfig, deps, runtime)
  );
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

async function launchResumedPane(
  project: Project,
  request: AgentSessionPaneRequest & { sessionId: string },
  agentConfig: NonNullable<ReturnType<typeof getEffectiveAgentConfig>>,
  deps: ViewlessDeps,
  runtime: AgentSessionPaneRuntime
): Promise<AgentSessionPaneResult> {
  const { worktreeId, agentId, sessionId } = request;

  const worktrees = await readProjectWorktrees(project, deps).catch(() => null);
  if (worktrees === null) {
    return refused(
      "worktrees-unavailable",
      "This project's worktrees couldn't be read, so the session's worktree can't be confirmed."
    );
  }
  const worktree = worktrees.find((candidate) => candidate.id === worktreeId);
  if (!worktree) {
    return refused("worktree-gone", "That worktree is no longer one of this project's worktrees.");
  }

  // The journal only adds what it kept of the launch: an id it no longer
  // holds (aged out of retention) still resumes, with the current settings.
  let records: AgentSessionRecord[];
  try {
    records = await deps.invoke<AgentSessionRecord[]>(project.id, CHANNELS.AGENT_SESSION_LIST, [
      { projectId: project.id },
    ]);
  } catch {
    return refused(
      "history-unavailable",
      "The session history couldn't be read, so where that session ran can't be confirmed."
    );
  }
  const record = (Array.isArray(records) ? records : []).find(
    (candidate) => candidate.sessionId === sessionId && candidate.agentId === agentId
  );
  // The CLI finds a conversation from its launch directory (#4781): reopening
  // it anywhere else starts a new one wearing this one's id.
  if (record?.worktreeId && record.worktreeId !== worktreeId) {
    return refused(
      "other-worktree",
      "That session was recorded in another worktree, and resuming it anywhere else would start a new conversation."
    );
  }
  const cwd = record?.cwd?.trim() || request.cwd?.trim() || worktree.path;
  const { cwdOutsideWorktree } = buildLaunchIdentity(worktreeId, worktree, cwd, {
    caseInsensitive: process.platform === "darwin" || process.platform === "win32",
  });
  if (cwdOutsideWorktree !== false || cwd.split(/[\\/]/).includes("..")) {
    return refused(
      "other-worktree",
      "That session's directory isn't inside the worktree, and resuming it anywhere else would start a new conversation."
    );
  }

  const cliDetail = await deps.agents.getCliDetail(agentId).catch(() => undefined);
  const settings = await deps.agents.getSettings().catch(() => null);
  // A retired model fails the relaunch (#15652); a view's resume drops it too.
  const captured = dropRetiredAgentModel(agentId, { agentLaunchFlags: record?.agentLaunchFlags })
    .launch.agentLaunchFlags;
  const flags = reconcileResumeLaunchFlagsWith({ agentId, agentLaunchFlags: captured }, settings);
  // Only a captured launch is kept for restart and restore to replay: flags
  // reconciled into an empty one are no whole configuration.
  const savedFlags = captured?.length ? flags : undefined;
  const command = buildResumeCommand(
    agentId,
    sessionId,
    flags,
    // The executable a fresh launch finds, so a CLI outside the shell's PATH resumes too.
    resolveAgentLaunchBaseCommandFor(
      agentConfig.command,
      cliDetail,
      deps.hostPlatform.shellDialect,
      undefined
    )
  );
  if (!command) {
    return refused(
      "no-resume-support",
      `${agentConfig.name} can't reopen a conversation by its session id.`
    );
  }
  const layers = await deps.getLaunchEnvLayers(project.id).catch((err: unknown) => {
    console.warn("[Viewless] Could not read environment variables for a resume:", err);
    return null;
  });
  const panelCount = await countProjectPanels(project, deps);

  // Last before the spawn, so as little as possible can change in between:
  // the spawn handler would launch a vanished directory's session from the
  // project root, and a pane resumed meanwhile would share its transcript.
  if (!(await runtime.isDirectory(cwd).catch(() => false))) {
    return refused("worktree-gone", "The directory that session ran in no longer exists.");
  }
  const held = await findPaneHoldingSession(project.id, worktreeId, sessionId, deps);
  if (held.status === "unavailable") return refused("terminals-unavailable", held.message);
  if (held.status === "found") {
    return { status: "existing", projectId: project.id, worktreeId, terminalId: held.terminalId };
  }

  const defaults = computeHardwareDefaults(deps.hostPlatform.totalMemoryBytes);
  const panelLimit = buildPanelLimitSnapshot(panelCount, {
    softWarningLimit: defaults.soft,
    confirmationLimit: defaults.confirm,
    hardLimit: defaults.hard,
  });
  if (panelLimit.tier === "hard") {
    return refused("panel-limit", "This project is at its panel limit.");
  }
  if (cliDetail && !isAgentLaunchable(cliDetail.state)) {
    return refused("missing-cli", `${agentConfig.name} can't be launched on this machine.`);
  }

  const terminalId = `terminal-${randomUUID()}`;
  const title = agentConfig.name;
  const env = mergeTerminalLaunchEnv(layers?.global, layers?.project, undefined);
  const actionContext = paneLaunchContext(agentId, project.id, worktreeId, terminalId, title);
  let started: boolean;
  try {
    started = await runtime.confirmSpawn(terminalId, async () => {
      await deps.invoke<string>(project.id, CHANNELS.TERMINAL_SPAWN, [
        {
          id: terminalId,
          kind: "terminal",
          projectId: project.id,
          cwd,
          cols: 80,
          rows: 24,
          title,
          command,
          ...(env !== undefined ? { env } : {}),
          worktreeId,
          launchAgentId: agentId,
          agentLaunchFlags: savedFlags,
          agentSessionId: sessionId,
          ...(actionContext !== undefined ? { actionContext } : {}),
        },
      ]);
    });
  } catch (err) {
    console.warn("[Viewless] Resume launch failed:", formatErrorMessage(err, "unknown"));
    started = false;
  }
  if (!started) return refused("spawn-failed", "The resumed session's terminal didn't start.");

  const snapshot: PanelSnapshot = {
    id: terminalId,
    kind: "terminal",
    title,
    worktreeId,
    // The stable handle restore follows a `git worktree move` by (#11388).
    ...(worktree.gitDir ? { worktreeGitDir: worktree.gitDir } : {}),
    location: "grid",
    ...serializePtyPanel({
      cwd,
      launchAgentId: agentId,
      command,
      agentSessionId: sessionId,
      agentLaunchFlags: savedFlags,
    }),
  };
  let savedInLayout = true;
  try {
    await recordViewlessTerminal(deps.stateWriter, project.id, snapshot);
  } catch (err) {
    console.warn(
      `[Viewless] Could not record resumed agent ${terminalId.slice(0, 8)} in project state:`,
      err
    );
    savedInLayout = false;
  }
  return {
    status: "launched",
    projectId: project.id,
    worktreeId,
    terminalId,
    cwd,
    savedInLayout,
  };
}

type HeldSession =
  | { status: "none" }
  | { status: "found"; terminalId: string }
  | { status: "unavailable"; message: string };

/**
 * The live pane of this worktree that already holds the session, by the rule
 * a view's `findLiveResumePanelId` applies: trash and dialogs never count, a
 * pane parked in the background does. Read off the pty-host, so a pane only
 * a window holds is found too; where it sits comes from the saved layout, or
 * from main having started it. A holder neither places is reported rather
 * than launched beside: it may be a dialog, or a pane its window hasn't saved
 * yet, and either way a second agent on its transcript is what this prevents.
 */
async function findPaneHoldingSession(
  projectId: string,
  worktreeId: string,
  sessionId: string,
  deps: ViewlessDeps
): Promise<HeldSession> {
  const unavailable = (message: string): HeldSession => ({ status: "unavailable", message });
  const pty = deps.getPtyReader();
  if (!pty) {
    return unavailable(
      "The terminal host isn't running, so whether a pane already holds this session can't be read."
    );
  }
  let terminals: ViewlessTerminalRecord[];
  try {
    if (pty.getAllTerminalsWithCompletenessAsync) {
      const inventory = await pty.getAllTerminalsWithCompletenessAsync();
      if (inventory.degraded) {
        return unavailable(
          "Not every terminal host answered, so whether a pane already holds this session can't be read."
        );
      }
      terminals = inventory.terminals;
    } else {
      terminals = await pty.getAllTerminalsAsync();
    }
  } catch {
    return unavailable(
      "The terminals couldn't be read, so whether a pane already holds this session can't be read."
    );
  }

  // The saved pane names the session a run resumed by hand (#15994), which
  // the pty-host's own record only ever names for the launched run.
  const state = await deps.getProjectState(projectId).catch(() => null);
  const savedPanes = new Map((state?.terminals ?? []).map((pane) => [pane.id, pane]));
  const launchedRunHolds = (terminal: ViewlessTerminalRecord) =>
    terminal.agentSessionId === sessionId &&
    // Not once another agent has taken the PTY over (#12535).
    (terminal.agentIncarnation ?? 0) === 0 &&
    (terminal.detectedAgentId === undefined || terminal.detectedAgentId === terminal.launchAgentId);
  const holders = terminals.filter(
    (terminal): terminal is ViewlessTerminalRecord & { id: string } =>
      typeof terminal.id === "string" &&
      (launchedRunHolds(terminal) || savedPanes.get(terminal.id)?.agentSessionId === sessionId) &&
      (terminal.worktreeId ?? null) === worktreeId &&
      terminal.isTrashed !== true &&
      terminal.isExited !== true &&
      terminal.hasPty !== false &&
      // A pane whose agent quit to its shell no longer runs the conversation.
      terminal.agentState !== "exited" &&
      terminal.isAssistantTerminal !== true &&
      (terminal.projectId ?? pty.getTerminalProjectId(terminal.id)) === projectId
  );
  if (holders.length === 0) return { status: "none" };

  const started = new Set(hostStartedTerminals(projectId).map((terminal) => terminal.id));
  let unplaced = false;
  for (const holder of holders) {
    const saved = savedPanes.get(holder.id);
    if (saved) {
      if (saved.location === "trash" || saved.location === "dialog") continue;
      return { status: "found", terminalId: holder.id };
    }
    if (started.has(holder.id)) return { status: "found", terminalId: holder.id };
    unplaced = true;
  }
  return unplaced
    ? unavailable(
        "A terminal already holds this session, but no saved pane places it yet. Try again once its window has saved."
      )
    : { status: "none" };
}
