import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../ipc/channels.js";
import type { PanelSnapshot, Project } from "../../../shared/types/project.js";
import type { AgentSessionPaneRefusal } from "../../../shared/types/agentSessionSchemas.js";
import type { AgentSessionRecord } from "../../../shared/types/ipc/agentSessionHistory.js";
import { getEffectiveAgentConfig, type AgentPreset } from "../../../shared/config/agentRegistry.js";
import {
  buildResumeCommand,
  dropRetiredAgentModel,
  type AgentSettings,
} from "../../../shared/types/agentSettings.js";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability.js";
import {
  isAccountId,
  resolveLaunchAccount,
  type LaunchAccountResolution,
} from "../../../shared/utils/agentAccounts.js";
import { resolveAgentLaunchBaseCommandFor } from "../../../shared/utils/agentLaunchCommand.js";
import {
  buildLaunchIdentity,
  composeAgentLaunchEnv,
  findUnloadedLaunchPreset,
} from "../../../shared/utils/agentLaunchPlan.js";
import { getMergedPreset, getMergedPresetIdentities } from "../../../shared/utils/agentPresets.js";
import { unknownAgentIdMessage } from "../../../shared/utils/agentLaunchValidation.js";
import { reconcileResumeLaunchFlagsWith } from "../../../shared/utils/agentResumeFlags.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { conversationStoreFor } from "../../../shared/utils/conversationStore.js";
import {
  buildPanelLimitSnapshot,
  computeHardwareDefaults,
} from "../../../shared/utils/panelLimit.js";
import { serializePtyPanel } from "../../../shared/utils/ptyPanelSnapshot.js";
import { mergeTerminalLaunchEnv } from "../../../shared/utils/terminalLaunchOptions.js";
import type { ViewlessDeps, ViewlessTerminalRecord } from "./ViewlessActionExecutor.js";
import { hostStartedTerminals } from "./hostStartedTerminals.js";
import { recordViewlessTerminal } from "./projectStateAuthoring.js";
import { paneLaunchContext, readPresetSources } from "./viewlessAgents.js";
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
  /**
   * Abandons the launch when aborted before the spawn. A spawn already sent
   * finishes as a saved pane. A concurrent identical call joins this one's
   * launch, signal and all.
   */
  signal?: AbortSignal;
  /**
   * Asked right before the spawn is sent, after every read, so a view that
   * takes the project's lease during those reads still stops the launch
   * (#16341). A message refuses. Only the call that launches is asked: one that
   * joins it isn't, which is how a caller tells its pane from a pane it joined.
   */
  authorizeSpawn?: () => string | null;
}

export type { AgentSessionPaneRefusal };

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
      /**
       * A live pane of this project already holds the session; nothing was
       * launched. `worktreeId` is where that pane is filed, which a live move
       * can have made another worktree than the one asked for (#18009), and
       * `null` for a pane filed under none.
       */
      status: "existing";
      projectId: string;
      worktreeId: string | null;
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
 * Resumes keyed by project and session, as the duplicate scan matches: two
 * calls aiming one session at different worktrees would put two agents on
 * one transcript just as two aimed at the same one would. The scan alone
 * can't stop concurrent calls each launching one: the second scans inside the
 * first one's awaits, before its terminal exists. A joiner gets the first
 * call's result, unless that was a refusal only the first call's own request
 * earned.
 */
const inFlight = new Map<
  string,
  { request: AgentSessionPaneRequest; run: Promise<AgentSessionPaneResult> }
>();

/**
 * Reopen a saved agent session as a new pane in its own worktree, from main
 * and with no view involved (#16000): spawned through the same handler a
 * view's launch reaches, so the pane gets its launch-time MCP config, a fresh
 * bearer and a fresh launch generation, and recorded in the project's saved
 * layout, so the next view to open the project shows it (#14473).
 *
 * The resume is built as a view's resume builds it: the journaled launch
 * flags reconciled against the current settings, the agent's name as the
 * title. Its environment is a launch's, composed from the preset and account
 * the record names, read again from the settings (#18191), and never the
 * caller env the launch was given. It never falls back to "the latest"
 * conversation: an agent that can't reopen one by id is refused. Nor to a
 * new one: a Claude conversation the CLI never wrote fails the spawn
 * (`exactResume`) rather than starting afresh under its id.
 *
 * A live pane of the project already holding the session is returned instead
 * of a second agent on one transcript, wherever it is filed (#18009), as
 * `findLiveResumePanelId` does in a view.
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

  const key = JSON.stringify([project.id, sessionId]);
  const pending = inFlight.get(key);
  if (pending) {
    const joined = await pending.run;
    const otherTarget =
      pending.request.worktreeId !== request.worktreeId ||
      pending.request.agentId !== request.agentId ||
      pending.request.cwd !== request.cwd;
    // The pane another target's call launched is, to this call, one that was
    // already holding the session.
    if (joined.status === "launched" && otherTarget) return existingPane(project.id, joined);
    const refusedOnlyItsCaller =
      joined.status === "refused" &&
      (joined.reason === "cancelled" || joined.reason === "not-authorized" || otherTarget);
    if (!refusedOnlyItsCaller || request.signal?.aborted) return joined;
    // Abandoned by its own caller, or refused to it, not this one: launch again once it has gone.
    if (inFlight.get(key) === pending) inFlight.delete(key);
    return resumeAgentSessionAsPane(request, deps, runtime);
  }
  const entry = {
    request,
    run: Promise.resolve().then(() =>
      launchResumedPane(project, { ...request, sessionId }, agentConfig, deps, runtime)
    ),
  };
  inFlight.set(key, entry);
  try {
    return await entry.run;
  } finally {
    if (inFlight.get(key) === entry) inFlight.delete(key);
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

  // A pane already holding the session answers before anything that only
  // decides where a NEW agent may start: it may be filed under another
  // worktree than the one asked for, or one whose recorded directory has gone.
  // Checked again right before the spawn, for a pane that arrives meanwhile.
  const holding = await findPaneHoldingSession(project.id, sessionId, deps);
  if (holding.status === "found") return existingPane(project.id, holding);

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
  const choice = await readResumeLaunchChoice(
    project,
    record,
    agentId,
    agentConfig.name,
    worktreeId,
    deps
  );
  const { settings, preset, account } = choice;
  // A retired model fails the relaunch (#15652); a view's resume drops it too.
  const captured = dropRetiredAgentModel(agentId, { agentLaunchFlags: record?.agentLaunchFlags })
    .launch.agentLaunchFlags;
  const flags = reconcileResumeLaunchFlagsWith(
    { agentId, agentLaunchFlags: captured },
    settings,
    preset
  );
  // Only a captured launch is kept for restart and restore to replay: flags
  // reconciled into an empty one are no whole configuration.
  const savedFlags = captured?.length ? flags : undefined;
  // A conversation recorded in another account's folder reopens from there (#17087).
  const conversationStore = conversationStoreFor(record?.conversationStore, sessionId);
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
  const held = await findPaneHoldingSession(project.id, sessionId, deps);
  if (held.status === "unavailable") return refused("terminals-unavailable", held.message);
  if (held.status === "found") return existingPane(project.id, held);

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
  if (request.signal?.aborted) return refused("cancelled", "The resume was abandoned.");
  // After the holder scan and cancellation, as the refusals only a new launch
  // earns are, so a joiner still retries a launch its leader abandoned.
  if (choice.refusal) return refused(choice.refusal.reason, choice.refusal.message);
  const denied = request.authorizeSpawn?.();
  if (denied) return refused("not-authorized", denied);

  const terminalId = `terminal-${randomUUID()}`;
  const title = agentConfig.name;
  const launchEnv = composeAgentLaunchEnv(
    settings?.agents?.[agentId] ?? {},
    preset,
    undefined,
    account
  );
  const env = mergeTerminalLaunchEnv(layers?.global, layers?.project, launchEnv);
  const accountId = account.kind === "account" ? account.account.id : undefined;
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
          // A conversation the CLI never wrote is refused, never started afresh under its id.
          exactResume: true,
          ...(conversationStore !== undefined ? { conversationStore } : {}),
          // So the session this pane captures names them again (#18191).
          ...(preset !== undefined
            ? {
                agentPresetId: preset.id,
                agentPresetColor: preset.color,
                originalAgentPresetId: preset.id,
              }
            : {}),
          ...(accountId !== undefined ? { agentAccountId: accountId } : {}),
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
      conversationStore,
      // As a launch records them, so a restart keeps the account's folder and
      // the preset's env: the env is the launch's own layer, never the caller's.
      agentPresetId: preset?.id,
      agentPresetColor: preset?.color,
      originalPresetId: preset?.id,
      env: launchEnv,
      agentAccountId: accountId,
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

interface ResumeLaunchChoice {
  settings: AgentSettings | null;
  preset: AgentPreset | undefined;
  account: LaunchAccountResolution;
  /** Set when the session can't be resumed on what it launched on. */
  refusal?: { reason: AgentSessionPaneRefusal; message: string };
}

/** Launchable preset ids, as `sanitizePreset` admits them. */
const PRESET_ID = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * The preset and account a session's record says it launched on (#18191), read
 * again from the settings as they are now: the record keeps ids, never env. A
 * record naming neither resumes on no preset and the default login, as before,
 * whatever this worktree would launch on today. One naming a preset or account
 * that is gone, or that the settings couldn't be read to find, is refused
 * rather than resumed on the default.
 */
async function readResumeLaunchChoice(
  project: Project,
  record: AgentSessionRecord | undefined,
  agentId: string,
  agentName: string,
  worktreeId: string,
  deps: ViewlessDeps
): Promise<ResumeLaunchChoice> {
  // `unknown`: the journal is a JSON file read loosely, so a row can hold anything.
  const presetId: unknown = record?.agentPresetId;
  const accountId: unknown = record?.agentAccountId;
  let settingsRead = true;
  let settings: AgentSettings | null;
  let sources: Awaited<ReturnType<typeof readPresetSources>> | undefined;
  if (presetId === undefined) {
    settings = await deps.agents.getSettings().catch(() => {
      settingsRead = false;
      return null;
    });
  } else {
    sources = await readPresetSources(agentId, project.path, deps, { strict: true });
    ({ settings, settingsRead } = sources);
  }
  const choice: ResumeLaunchChoice = { settings, preset: undefined, account: { kind: "default" } };
  const refuse = (reason: AgentSessionPaneRefusal, message: string): ResumeLaunchChoice => ({
    ...choice,
    refusal: { reason, message },
  });
  if (presetId === undefined && accountId === undefined) return choice;
  const unreadable = (what: string) =>
    refuse("settings-unavailable", `${what}, so what that session launched on can't be confirmed.`);
  if (!settingsRead) return unreadable("The agent settings couldn't be read");

  let accountGone: string | undefined;
  if (accountId !== undefined) {
    const account = isAccountId(accountId)
      ? resolveLaunchAccount(agentId, settings?.agents?.[agentId], worktreeId, accountId)
      : undefined;
    // `default` too: an agent whose accounts were taken away can't put the
    // session back on the one it ran on, and the default login isn't it.
    if (account?.kind === "account") choice.account = account;
    else accountGone = isAccountId(accountId) ? `the account "${accountId}"` : "its account";
  }

  let presetGone: string | undefined;
  if (sources !== undefined) {
    if (typeof presetId !== "string" || !PRESET_ID.test(presetId)) {
      presetGone = "its preset";
    } else {
      // An id a higher source might hold, unread, isn't the one a lower source
      // has. A repository read that skipped a file of this agent's confirms
      // only the user's own presets: the skipped file may be the repository's
      // copy of the id, ahead of another of its own or a route's.
      let unsettled: string | undefined;
      let preset: AgentPreset | undefined;
      try {
        const custom = settings?.agents?.[agentId]?.customPresets;
        const confirmable =
          sources.presetInventory.project ||
          getMergedPresetIdentities(
            agentId,
            custom,
            sources.ccrPresets,
            sources.projectPresets
          ).find((identity) => identity.id === presetId)?.source === "custom";
        unsettled = !confirmable
          ? presetId
          : findUnloadedLaunchPreset({
              agentId,
              isAgent: true,
              worktreeId,
              settings,
              ccrPresets: sources.ccrPresets,
              projectPresets: sources.projectPresets,
              presetInventory: sources.presetInventory,
              options: { presetId },
            });
        preset =
          unsettled === undefined
            ? getMergedPreset(
                agentId,
                presetId,
                settings?.agents?.[agentId]?.customPresets,
                sources.ccrPresets,
                sources.projectPresets
              )
            : undefined;
      } catch {
        // A saved preset list this build can't read (a hand-edited entry).
        return unreadable("The saved presets couldn't be read");
      }
      if (unsettled !== undefined) return unreadable("Not every preset source could be read");
      if (preset) choice.preset = preset;
      else presetGone = `the preset "${presetId}"`;
    }
  }

  // Both named when both are gone, so one fix doesn't only uncover the other.
  if (accountGone !== undefined) {
    const also = presetGone !== undefined ? `, and ${presetGone} isn't one of its presets` : "";
    return refuse(
      "missing-account",
      `That session launched on ${accountGone}, which isn't one of ${agentName}'s saved accounts any more${also}.`
    );
  }
  if (presetGone !== undefined) {
    return refuse(
      "missing-preset",
      `That session launched on ${presetGone}, which isn't one of ${agentName}'s presets any more.`
    );
  }
  return choice;
}

type HeldSession =
  | { status: "none" }
  | { status: "found"; terminalId: string; worktreeId: string | null }
  | { status: "unavailable"; message: string };

function existingPane(
  projectId: string,
  held: { terminalId: string; worktreeId: string | null }
): AgentSessionPaneResult {
  return {
    status: "existing",
    projectId,
    worktreeId: held.worktreeId,
    terminalId: held.terminalId,
  };
}

/**
 * The live pane of this project that already holds the session, wherever it
 * is filed (#18009), by the rule a view's `findLiveResumePanelId` applies:
 * trash and dialogs never count, a pane parked in the background does. Read off the pty-host, so a pane only
 * a window holds is found too; where it sits comes from the saved layout, or
 * from main having started it. A holder neither places is reported rather
 * than launched beside: it may be a dialog, or a pane its window hasn't saved
 * yet, and either way a second agent on its transcript is what this prevents.
 */
async function findPaneHoldingSession(
  projectId: string,
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

  const state = await deps.getProjectState(projectId).catch(() => undefined);
  if (state === undefined) {
    return unavailable(
      "The saved layout couldn't be read, so whether a pane already holds this session can't be read."
    );
  }
  const savedPanes = new Map((state?.terminals ?? []).map((pane) => [pane.id, pane]));
  const live = terminals.filter(
    (terminal): terminal is ViewlessTerminalRecord & { id: string } =>
      typeof terminal.id === "string" &&
      terminal.isTrashed !== true &&
      terminal.isExited !== true &&
      terminal.hasPty !== false &&
      // A pane being closed is quitting the conversation, not holding it.
      terminal.isClosing !== true &&
      // A pane whose agent quit to its shell no longer runs the conversation.
      terminal.agentState !== "exited" &&
      terminal.isAssistantTerminal !== true &&
      (terminal.projectId ?? pty.getTerminalProjectId(terminal.id)) === projectId
  );
  const launchedRunHolds = (terminal: ViewlessTerminalRecord) =>
    terminal.agentSessionId === sessionId &&
    // Not once another agent has taken the PTY over (#12535).
    (terminal.agentIncarnation ?? 0) === 0 &&
    (terminal.detectedAgentId === undefined || terminal.detectedAgentId === terminal.launchAgentId);
  const shown = (terminalId: string) => {
    const location = savedPanes.get(terminalId)?.location;
    return location !== "trash" && location !== "dialog";
  };

  // Filed where the host says, as a listing reads it: the live PTY's own
  // filing, then the saved pane's.
  const found = (holder: ViewlessTerminalRecord & { id: string }): HeldSession => ({
    status: "found",
    terminalId: holder.id,
    worktreeId: holder.worktreeId ?? savedPanes.get(holder.id)?.worktreeId ?? null,
  });
  const started = new Set(hostStartedTerminals(projectId).map((terminal) => terminal.id));
  let unplaced = false;
  for (const holder of live.filter(launchedRunHolds)) {
    if (savedPanes.has(holder.id)) {
      if (shown(holder.id)) return found(holder);
      continue;
    }
    if (started.has(holder.id)) return found(holder);
    unplaced = true;
  }
  if (unplaced) {
    return unavailable(
      "A terminal already holds this session, but no saved pane places it yet. Try again once its window has saved."
    );
  }
  // A run resumed by hand names its session only on the saved pane (#15994),
  // which keeps naming it after that run quits and another starts there, so
  // the pane is neither handed back nor launched beside.
  const claimed = live.some(
    (terminal) =>
      !launchedRunHolds(terminal) &&
      savedPanes.get(terminal.id)?.agentSessionId === sessionId &&
      shown(terminal.id)
  );
  return claimed
    ? unavailable(
        "A pane's saved record names this session, but whether the agent running there now is that session can't be confirmed."
      )
    : { status: "none" };
}
