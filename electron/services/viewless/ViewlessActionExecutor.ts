import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import { CHANNEL_LEASE_POLICY } from "../../ipc/channelLeasePolicy.js";
import { isAssistantTerminalRecord } from "../assistantTerminal.js";
import type {
  ActionContext,
  ActionDispatchResult,
  ActionDanger,
} from "../../../shared/types/actions.js";
import type { PanelSnapshot, Project, ProjectState } from "../../../shared/types/project.js";
import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import type { AgentSettings } from "../../../shared/types/agentSettings.js";
import type { AgentToolbarPins } from "../../../shared/types/ipc/agentToolbarPins.js";
import type { AgentAvailabilityState, AgentCliDetail } from "../../../shared/types/ipc/system.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalStatusResult } from "../../../shared/types/terminalStatus.js";
import { resolveEffectiveActionDanger } from "../../../shared/utils/effectiveActionDanger.js";
import type {
  WorktreeCreateResult,
  WorktreeTeardownPreview,
} from "../../../shared/types/worktree.js";
import type { WorktreeChanges } from "../../../shared/types/git.js";
import type { SubmoduleDeleteRisk } from "../../../shared/types/submodule.js";
import type { WorktreeDeleteNotesReport } from "../../../shared/types/plugin.js";
import { getDefaultPanelTitle, panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import {
  readDispatchTerminalCommand,
  readDispatchTerminalCwd,
  TERMINAL_LAUNCH_ACTION_ID,
} from "../../../shared/utils/dispatchTerminalCommand.js";
import { appendHandbackInstruction, mintHandbackCode } from "../../../shared/utils/handback.js";
import { buildTerminalSendCommandReceipt } from "../../../shared/utils/terminalSendCommandResult.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { NotifyReplyLinesSchema } from "../../../shared/types/terminalNotify.js";
import { WaitForReplySchema, WaitSecondsSchema } from "../../../shared/types/replyWait.js";
import {
  mergeTerminalLaunchEnv,
  spawnSourceForMcpOrigin,
} from "../../../shared/utils/terminalLaunchOptions.js";
import type {
  McpDispatchAuthorization,
  McpSessionOrigin,
} from "../../../shared/types/ipc/mcpServer.js";
import { recordViewlessTerminal, type ProjectStateWriter } from "./projectStateAuthoring.js";
import { VIEWLESS_ACTIONS } from "./viewlessActionCatalog.js";
import {
  viewlessFailure as failure,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";
import {
  runTerminalClose,
  runTerminalGetOutput,
  runTerminalGetStatus,
  runTerminalInterrupt,
  runTerminalList,
  runTerminalSendKeys,
} from "./viewlessTerminals.js";
import {
  runAgentLaunch,
  runAgentListAvailable,
  runAgentListModels,
  runAgentListPresets,
} from "./viewlessAgents.js";
import { runSlashCommandsList } from "./viewlessSlashCommands.js";
import {
  previewWorktreeDelete,
  runWorktreeDelete,
  runWorktreeList,
  runWorktreeWaitForPullRequest,
  runWorktreeWaitUntilReady,
} from "./viewlessWorktrees.js";
import { runProjectDetectRunners, runProjectGetAll, runWorkspaceList } from "./viewlessProjects.js";
import { runRecipeList } from "./viewlessRecipes.js";
import { runForgeRead } from "./viewlessForge.js";
import { runProjectPulse, runSessionHistoryList } from "./viewlessHistory.js";
import {
  runActionsGetContext,
  runActionsGetSchema,
  runActionsList,
  runActionsSearch,
} from "./viewlessIntrospection.js";
import { refuseRecipeWithNoView, runWorktreeCreateWithRecipe } from "./viewlessWorktreeCreation.js";

const TERMINAL_SEND_COMMAND_ACTION_ID = "terminal.sendCommand";
const WORKTREE_CREATE_ACTION_ID = "worktree.create";

export const VIEWLESS_ACTION_IDS: ReadonlySet<string> = new Set(Object.keys(VIEWLESS_ACTIONS));

export function hasViewlessImplementation(actionId: string): boolean {
  return VIEWLESS_ACTION_IDS.has(actionId);
}

/** A pty-host terminal record, as much of it as the viewless actions read. */
export interface ViewlessTerminalRecord {
  id?: string;
  projectId?: string;
  kind?: string;
  title?: string;
  cwd?: string;
  worktreeId?: string;
  launchAgentId?: string;
  detectedAgentId?: string;
  /** The conversation the agent was launched or resumed with, as the spawn recorded it. */
  agentSessionId?: string;
  agentState?: AgentState | string;
  waitingReason?: WaitingReason;
  everDetectedAgent?: boolean;
  isTrashed?: boolean;
  isExited?: boolean;
  hasPty?: boolean;
  isAssistantTerminal?: boolean;
}

/** The pty-host reads a viewless action needs, as `PtyClient` answers them. */
export interface ViewlessPtyReader {
  getTerminalProjectId(id: string): string | null;
  /** `strict` rejects on a live host that did not answer, rather than resolving null. */
  getTerminalAsync(
    id: string,
    submissionToken?: string,
    options?: { strict?: boolean }
  ): Promise<ViewlessTerminalRecord | null>;
  /** Every terminal the pty-host holds, trashed ones included. */
  getAllTerminalsAsync(): Promise<ViewlessTerminalRecord[]>;
  /** The same, saying whether every pty-host shard answered. */
  getAllTerminalsWithCompletenessAsync?(): Promise<{
    terminals: ViewlessTerminalRecord[];
    degraded: boolean;
  }>;
  /**
   * A project's live terminals, ownership inferred where unstamped; no trash.
   * `strict` rejects on a host that didn't answer, rather than resolving `[]`.
   */
  getTerminalsForProjectAsync(projectId: string, options?: { strict?: boolean }): Promise<string[]>;
  getSerializedStateAsync(
    id: string,
    options?: { tailRows: number }
  ): Promise<{ data: string; partial?: true } | null>;
}

/** The workspace-host calls a viewless worktree action needs. */
export interface ViewlessWorkspaceHosts {
  getHostForProject(projectPath: string): unknown;
  prewarmProject(projectPath: string): void;
  waitForReady(): Promise<void>;
  isWorktreeOwnedByProject(
    worktreeId: string,
    projectPath: string,
    expectedProjectId: string
  ): Promise<boolean | null>;
  /**
   * What deleting the worktree would discard and run, read fresh; each part
   * null once the worktree is gone and `unreadable` when its read failed.
   * Null when the project has no host running.
   */
  getDeletePreview(
    projectPath: string,
    expectedProjectId: string,
    worktreeId: string
  ): Promise<{
    changes: WorktreeChanges | null | "unreadable";
    risk: SubmoduleDeleteRisk | null | "unreadable";
    teardown: WorktreeTeardownPreview | null | "unreadable";
  } | null>;
}

/** The ambient environment layers a terminal launch merges under its own. */
export interface ViewlessLaunchEnvLayers {
  global: Record<string, string>;
  project: Record<string, string>;
}

/**
 * Where a viewless agent launch reads what a view's launcher reads from its
 * stores: the user's agent settings, discovered and repository presets, and
 * the CLI probe. Each is the host-side source the view's store is fed from.
 */
export interface ViewlessAgentSources {
  getSettings(): Promise<AgentSettings | null>;
  /** This machine's toolbar pins: with no view, there is no other screen to describe (#14702). */
  getToolbarPins(): Promise<AgentToolbarPins>;
  getCcrPresets(agentId: string): Promise<AgentPreset[] | undefined>;
  getProjectPresets(projectPath: string): Promise<Record<string, AgentPreset[]>>;
  getCliDetail(agentId: string): Promise<AgentCliDetail | undefined>;
  /** The probe's per-agent states, and whether a live probe has completed. */
  getAvailability(): Promise<{
    availability: Record<string, AgentAvailabilityState | undefined>;
    live: boolean;
  }>;
}

/** The host machine a viewless launch runs on. */
export interface ViewlessHostPlatform {
  shellDialect: "posix" | "windows";
  tmpDir: string;
  totalMemoryBytes: number;
}

export interface ViewlessDeps {
  getProject(projectId: string): Project | null;
  /** Global and project environment variables, as the renderer's launch reads them. */
  getLaunchEnvLayers(projectId: string): Promise<ViewlessLaunchEnvLayers>;
  getProjectState(projectId: string): Promise<ProjectState | null>;
  stateWriter: ProjectStateWriter;
  getPtyReader(): ViewlessPtyReader | null;
  getWorkspaceHosts(): ViewlessWorkspaceHosts | null;
  invoke<T>(projectId: string, channel: string, args: unknown[]): Promise<T>;
  /** One-way IPC, for what a view sends with `ipcRenderer.send`. */
  send(projectId: string, channel: string, args: unknown[]): void;
  agents: ViewlessAgentSources;
  /** The pty-host `terminal.getStatus` answer main already serves with no view. */
  readTerminalStatus(args: unknown, projectId: string): Promise<TerminalStatusResult>;
  hostPlatform: ViewlessHostPlatform;
  /** Pacing for key presses and readiness polls; real timers outside tests. */
  sleep(ms: number): Promise<void>;
  /** The plugins' notes on a worktree about to be deleted, each bounded by its deadline (#13805). */
  collectWorktreeDeleteNotes(
    projectId: string,
    worktreeId: string
  ): Promise<WorktreeDeleteNotesReport[]>;
}

export interface ViewlessActionRequest {
  workspaceId: string;
  actionId: string;
  args: unknown;
  /**
   * Whether main already holds the approval a `danger: "confirm"` dispatch
   * needs (a native grant, an auto-confirming tier, the user's answer). With no
   * frontend there is nobody to ask, so an unapproved confirm-gated call is
   * refused rather than run.
   */
  confirmed: boolean;
  /** An agent pane's launch-time context, which names its own worktree. */
  context?: ActionContext;
  /** How the dispatching MCP session authenticated; decides the spawn's provenance. */
  sessionOrigin?: McpSessionOrigin;
  /**
   * Where `confirmed` came from. Only the assistant's skip preference stands
   * in for a typed-name confirmation, as it does in a view; any other approval
   * covers the ordinary dialog and nothing more.
   */
  authorization?: McpDispatchAuthorization;
  /**
   * Asked as an action that writes is admitted, and again right before each
   * host call it makes: null to go on, or the error that is the call's answer,
   * thrown unchanged. `changed` says whether an earlier call already changed
   * something. Absent, the call is the host's own and passes, as it always
   * has: the drive lease was already consulted on the way here. A call relayed
   * from another machine (#13493) supplies one that checks that machine's
   * standing on the project, so a view that takes the lease while it runs
   * stops it before its next change (#13501).
   */
  checkWrite?: (changed: boolean) => Error | null;
  /**
   * Asks the person, somewhere other than a view here, about this one
   * confirm-gated call (#13501): the Shell a relayed call came from, in its
   * own window. Absent, or answering `unavailable`, an unapproved call is
   * refused as it always was.
   */
  requestApproval?: (ask: ViewlessApprovalAsk) => Promise<ViewlessApprovalDecision>;
}

/** What the person is asked about a call the host would run itself. */
export interface ViewlessApprovalAsk {
  actionId: string;
  /** Exactly the arguments the action runs with once approved. */
  args: unknown;
  /** What the dialog's question names, such as the worktree's branch. */
  subject?: string;
  /** What the call would do, read on this host from the target it will act on. */
  lines: string[];
}

/**
 * The person's answer. An approval covers this call until `deadline` (this
 * host's clock), and nothing after it: a change the call has not reached by
 * then is refused. `skip-preference` marks one nobody was asked for, under the
 * asking assistant's own "Never ask" (#15698), which covers the call the same way.
 */
export type ViewlessApprovalDecision =
  | { decision: "approved"; deadline: number; authorization?: "skip-preference" }
  | { decision: "rejected" | "timeout" | "unavailable" };

/** A preview to put to the person, or the answer the call gets without asking. */
export type ViewlessApprovalPreview =
  { ok: true; subject?: string; lines: string[] } | { ok: false; result: ActionDispatchResult };

const TerminalNewArgsSchema = z
  .object({
    spawnedBy: z.unknown().optional(),
    focusPolicy: z.unknown().optional(),
    cwd: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
  })
  .optional();

// The renderer action's argument shape. Main consumes `notify` and the reply
// wait before dispatch, but a malformed one is forwarded for the action to
// refuse, so it is checked here too rather than stripped and ignored.
const TerminalSendCommandArgsSchema = z.object({
  terminalId: z.string().min(1).max(512),
  command: z.string().min(1),
  handback: z.boolean().optional(),
  generation: z.number().int().min(0).optional(),
  notify: z.boolean().optional(),
  replyLines: NotifyReplyLinesSchema,
  waitForReply: WaitForReplySchema,
  waitSeconds: WaitSecondsSchema,
});

const WorktreeCreateArgsSchema = z.object({
  options: z.record(z.string(), z.unknown()),
  worktreeId: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  rootPath: z.string().min(1).optional(),
});

/**
 * The context's worktree fields, but only when they describe this project: a
 * snapshot naming another one would open the terminal somewhere this project
 * does not own.
 */
function contextWorktree(
  context: ActionContext | undefined,
  projectId: string
): { worktreeId?: string; worktreePath?: string } {
  if (!context) return {};
  if (context.projectId !== undefined && context.projectId !== projectId) return {};
  return {
    ...(context.activeWorktreeId ? { worktreeId: context.activeWorktreeId } : {}),
    ...(context.activeWorktreePath ? { worktreePath: context.activeWorktreePath } : {}),
  };
}

async function runTerminalNew(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = TerminalNewArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);

  const { cwd: requestedCwd, command } = parsed.data ?? {};
  const state = await deps.getProjectState(project.id).catch(() => null);
  const fromContext = contextWorktree(request.context, project.id);
  const worktreeId = fromContext.worktreeId ?? state?.activeWorktreeId;
  // A worktree id is its root path, so it doubles as the default directory when
  // nothing more specific is known. The spawn handler still validates the
  // directory and falls back to the project root if it is gone.
  const cwd =
    requestedCwd ??
    fromContext.worktreePath ??
    (worktreeId !== undefined && isAbsolute(worktreeId) ? worktreeId : undefined) ??
    project.path;
  const title = getDefaultPanelTitle("terminal");
  const id = randomUUID();
  // The dispatch source is authoritative, never the caller's `spawnedBy`, as
  // the renderer's bridge stamps it.
  const spawnedBy = spawnSourceForMcpOrigin(request.sessionOrigin);
  // A failed read spawns with what is known, as the renderer does.
  const layers = await deps.getLaunchEnvLayers(project.id).catch((err: unknown) => {
    console.warn("[Viewless] Could not read environment variables for a launch:", err);
    return null;
  });
  const env = mergeTerminalLaunchEnv(layers?.global, layers?.project, undefined);

  try {
    await deps.invoke<string>(project.id, CHANNELS.TERMINAL_SPAWN, [
      {
        id,
        kind: "terminal",
        projectId: project.id,
        cwd,
        cols: 80,
        rows: 24,
        title,
        ...(worktreeId !== undefined ? { worktreeId } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(env !== undefined ? { env } : {}),
      },
    ]);
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to spawn terminal"));
  }

  // Recorded after the spawn landed, and never fatal: the PTY is running
  // either way, and hydration still finds it through the pty-host. The
  // snapshot is what gives it a place in the layout. The command is left off
  // on purpose — a snapshot's command is re-run when the panel is respawned,
  // and a one-shot command an agent asked for should not run again unseen.
  const snapshot: PanelSnapshot = {
    id,
    kind: "terminal",
    title,
    cwd,
    location: "grid",
    spawnedBy,
    ...(worktreeId !== undefined ? { worktreeId } : {}),
  };
  try {
    await recordViewlessTerminal(deps.stateWriter, project.id, snapshot);
  } catch (err) {
    console.warn(`[Viewless] Could not record terminal ${id.slice(0, 8)} in project state:`, err);
  }

  return { ok: true, result: { terminalId: id } };
}

/**
 * Whether the pty-host's record describes an agent pane. The renderer asks the
 * same of its panel: live detection wins, and a launch hint counts until the
 * pane has visibly stopped being one.
 */
function isAgentRecord(
  info: NonNullable<Awaited<ReturnType<ViewlessPtyReader["getTerminalAsync"]>>>
) {
  if (info.detectedAgentId || info.agentState) return true;
  return Boolean(info.launchAgentId) && info.everDetectedAgent !== true && info.hasPty !== false;
}

async function runTerminalSendCommand(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = TerminalSendCommandArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { terminalId, command, handback } = parsed.data;

  const pty = deps.getPtyReader();
  if (!pty) return failure("EXECUTION_ERROR", "Terminal service is not available");

  // A renderer only sees its own project's panels, so a terminal owned by any
  // other project answers exactly as one that does not exist.
  const owner = pty.getTerminalProjectId(terminalId);
  const info = owner === project.id ? await pty.getTerminalAsync(terminalId) : null;
  // An assistant is addressed only through main's assistant path (#13496),
  // never as a pane here, so it answers as no terminal at all.
  if (!info || isAssistantTerminalRecord({ ...info, id: terminalId })) {
    return failure("EXECUTION_ERROR", "Terminal not found");
  }
  if (info.isTrashed) {
    return failure("EXECUTION_ERROR", "Cannot send commands to trashed terminals");
  }
  const kind = (info.kind ?? "terminal") as Parameters<typeof panelKindHasPty>[0];
  if (!panelKindHasPty(kind)) {
    return failure("EXECUTION_ERROR", `Terminal kind "${kind}" does not support command execution`);
  }
  if (info.hasPty === false) {
    return failure("EXECUTION_ERROR", "Terminal does not have PTY capability");
  }
  if (handback === true && !isAgentRecord(info)) {
    return failure(
      "VALIDATION_ERROR",
      `handback needs an agent pane, and terminal '${terminalId}' has no agent running. Send without handback.`
    );
  }

  const submissionToken = randomUUID();
  try {
    if (handback === true) {
      const handbackCode = mintHandbackCode();
      await deps.invoke<void>(project.id, CHANNELS.TERMINAL_SUBMIT, [
        terminalId,
        appendHandbackInstruction(command, handbackCode),
        submissionToken,
        handbackCode,
      ]);
    } else {
      await deps.invoke<void>(project.id, CHANNELS.TERMINAL_SUBMIT, [
        terminalId,
        command,
        submissionToken,
      ]);
    }
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to submit to terminal"));
  }

  return {
    ok: true,
    result: buildTerminalSendCommandReceipt(terminalId, command, submissionToken),
  };
}

async function runWorktreeCreate(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = WorktreeCreateArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { options, worktreeId, worktreePath, rootPath: legacyRootPath } = parsed.data;

  // The same precedence the renderer's location args apply — an id wins over a
  // path — with a worktree id read as the root path it is. There is no
  // active-worktree fallback: this tool never had one.
  const rootPath = worktreeId ?? worktreePath ?? legacyRootPath;
  if (rootPath === undefined) {
    return failure(
      "VALIDATION_ERROR",
      `Invalid arguments for ${request.actionId}: supply a worktree id or path to create from.`
    );
  }
  if (!isAbsolute(rootPath)) {
    return failure(
      "VALIDATION_ERROR",
      `Invalid arguments for ${request.actionId}: the worktree to create from must be an absolute path.`
    );
  }

  const hosts = deps.getWorkspaceHosts();
  if (!hosts) return failure("EXECUTION_ERROR", "Workspace service is not available");

  try {
    // With no window there is no project load to piggyback on, so start the
    // project's workspace host on its own. The pool reclaims it after its
    // dormant grace period like any other host no window holds.
    if (hosts.getHostForProject(project.path) === undefined) {
      hosts.prewarmProject(project.path);
    }
    await hosts.waitForReady();
    if (rootPath !== project.path) {
      const owned = await hosts.isWorktreeOwnedByProject(rootPath, project.path, project.id);
      // Only a proven owner will do: the create handler routes by path alone,
      // so an unverified path could be another repository entirely.
      if (owned !== true) {
        return failure(
          "VALIDATION_ERROR",
          `'${rootPath}' could not be confirmed as a worktree of this project, so ${request.actionId} will not create from it.`
        );
      }
    }
    const created = await deps.invoke<WorktreeCreateResult>(project.id, CHANNELS.WORKTREE_CREATE, [
      { rootPath, options },
    ]);
    if (!created?.worktreeId) {
      return failure(
        "EXECUTION_ERROR",
        "Failed to create worktree: no worktreeId returned from backend"
      );
    }
    return { ok: true, result: created };
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to create worktree"));
  }
}

/**
 * Whether a viewless call may run unattended. A `danger: "confirm"` action, and
 * a safe one whose arguments raise it (a `terminal.new` with a command or cwd,
 * any `recipeId`), runs only with an approval main already holds: with no
 * frontend there is nobody to ask, so an unapproved one is refused rather than
 * run. The same resolver the renderer's dispatch reads decides, so a call is
 * never confirm-gated on one side and not the other.
 */
function admit(request: ViewlessActionRequest, danger: ActionDanger): ActionDispatchResult | null {
  const effective = resolveEffectiveActionDanger(request.actionId, danger, "agent", request.args);
  if (effective === "safe" || request.confirmed) return null;
  const launchArg =
    request.actionId === TERMINAL_LAUNCH_ACTION_ID
      ? readDispatchTerminalCommand(request.args) !== undefined
        ? "command"
        : readDispatchTerminalCwd(request.args) !== undefined
          ? "cwd"
          : undefined
      : undefined;
  const why =
    launchArg !== undefined
      ? `was called with a '${launchArg}', so it would start a shell and requires confirmation`
      : "requires confirmation";
  return failure(
    "CONFIRMATION_REQUIRED",
    `Action '${request.actionId}' ${why}, but no Daintree frontend is attached to this project to ` +
      `ask. The action was not run.`,
    { confirmationChannel: "unavailable" }
  );
}

/**
 * Run one agent-facing action in main for a project with no frontend attached.
 *
 * Resolves `null` when the host cannot act for this workspace on its own —
 * an action with no viewless form, or a workspace that is not a registered
 * project (a scratch has no path the host could open a terminal or a
 * worktree in). The caller then reports that no frontend is attached.
 */
export async function executeViewlessAction(
  request: ViewlessActionRequest,
  deps: ViewlessDeps
): Promise<ActionDispatchResult | null> {
  const entry = Object.hasOwn(VIEWLESS_ACTIONS, request.actionId)
    ? VIEWLESS_ACTIONS[request.actionId]
    : undefined;
  if (!entry) return null;
  const project = deps.getProject(request.workspaceId);
  if (!project) return null;

  const checkWrite = entry.writes ? request.checkWrite : undefined;
  const admitted = checkWrite?.(false);
  if (admitted) throw admitted;
  if (request.actionId === "worktree.createWithRecipe") {
    const recipe = refuseRecipeWithNoView(request);
    if (recipe) return recipe;
  }

  let approvedUntil: number | undefined;
  const refusal = admit(request, entry.danger);
  if (refusal) {
    const asked = await askForApproval(request, project, deps);
    if (asked === null) return refusal;
    if (asked.kind === "answered") return asked.result;
    approvedUntil = asked.deadline;
  }

  if (checkWrite === undefined && approvedUntil === undefined) {
    return runAction(request, project, deps);
  }
  const guarded = guardWrites(deps, (changed) => {
    if (approvedUntil !== undefined && Date.now() > approvedUntil) {
      return new ViewlessRefusal(
        failure(
          "CONFIRMATION_TIMEOUT",
          `The approval for ${request.actionId} ran out before the host reached it, so ${
            changed ? "it stopped before changing anything more" : "nothing was changed"
          }. Ask again.`
        )
      );
    }
    return checkWrite?.(changed) ?? null;
  });
  const result = await runAction(request, project, guarded.deps).catch((err: unknown) => {
    if (guarded.stopped() === null) throw err;
    return null;
  });
  // A stop is the call's answer, whatever the action made of the error it
  // was handed: it never ran the change it stopped.
  const stopped = guarded.stopped();
  if (stopped instanceof ViewlessRefusal) return stopped.result;
  if (stopped !== null) throw stopped;
  return result;
}

/** A stop that answers the call with a result rather than an error. */
class ViewlessRefusal extends Error {
  constructor(readonly result: ActionDispatchResult) {
    super(result.ok ? "" : result.error.message);
    this.name = "ViewlessRefusal";
  }
}

/**
 * The deps an action runs with when its standing has to be checked right
 * before each change (#13501): every host call it makes asks first, at the
 * boundary the drive lease holds every caller to — the dispatcher's own gate
 * admits a driving view's call there too, and a call admitted is the change
 * under way. A refusal, returned or thrown, is kept rather than left to the
 * action's own error handling, which would report it as a failure of the call
 * it stopped. A call that reaches a channel which changes a project counts as
 * a change for the next ask, and so does a write to the saved layout. That
 * write is checked only while it is the call's first change: recording a
 * change that already landed is never stopped, or the next view would hydrate
 * a layout missing a process that runs.
 */
function guardWrites(
  deps: ViewlessDeps,
  check: (changed: boolean) => Error | null
): { deps: ViewlessDeps; stopped(): Error | null } {
  let stopped: Error | null = null;
  let changed = false;
  const ask = (changes: boolean): void => {
    let refusal: Error | null;
    try {
      refusal = stopped ?? check(changed);
    } catch (err) {
      refusal = err instanceof Error ? err : new Error(String(err));
    }
    if (refusal !== null) {
      stopped = refusal;
      throw refusal;
    }
    if (changes) changed = true;
  };
  return {
    deps: {
      ...deps,
      invoke: <T>(projectId: string, channel: string, args: unknown[]): Promise<T> => {
        try {
          ask(!isFreeLeaseChannel(channel));
        } catch (err) {
          return Promise.reject(err);
        }
        return deps.invoke<T>(projectId, channel, args);
      },
      send: (projectId, channel, args) => {
        ask(!isFreeLeaseChannel(channel));
        deps.send(projectId, channel, args);
      },
      stateWriter: {
        enqueueProjectStateUpdate: (projectId, updater) => {
          if (!changed) {
            try {
              ask(true);
            } catch (err) {
              return Promise.reject(err);
            }
          }
          return deps.stateWriter.enqueueProjectStateUpdate(projectId, updater);
        },
      },
    },
    stopped: () => stopped,
  };
}

/**
 * Channels the drive lease leaves free that still change a project's files:
 * the project recipe read reconciles .daintree/recipes on the way (#14139).
 */
const CHANGING_FREE_CHANNELS: ReadonlySet<string> = new Set([CHANNELS.PROJECT_GET_RECIPES]);

/** Whether a host channel only reads, by the drive lease's own account of it. */
function isFreeLeaseChannel(channel: string): boolean {
  if (CHANGING_FREE_CHANNELS.has(channel)) return false;
  return (CHANNEL_LEASE_POLICY as Readonly<Record<string, string>>)[channel] === "free";
}

/**
 * Put a confirm-gated call to the person through `requestApproval`, with a
 * preview read on this host from the target it would act on. Null when it
 * can't be asked about: no one to ask, an action with no preview here, or
 * an asker that answered `unavailable`. A preview that finds the call
 * couldn't run answers with that, before anyone is asked.
 */
async function askForApproval(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<
  { kind: "approved"; deadline: number } | { kind: "answered"; result: ActionDispatchResult } | null
> {
  const ask = request.requestApproval;
  const preview = Object.hasOwn(VIEWLESS_APPROVAL_PREVIEWS, request.actionId)
    ? VIEWLESS_APPROVAL_PREVIEWS[request.actionId]
    : undefined;
  if (ask === undefined || preview === undefined) return null;
  const built = await preview(request, project, deps);
  if (!built.ok) return { kind: "answered", result: built.result };
  const answer = await ask({
    actionId: request.actionId,
    args: request.args,
    ...(built.subject !== undefined ? { subject: built.subject } : {}),
    lines: built.lines,
  });
  switch (answer.decision) {
    case "approved":
      return { kind: "approved", deadline: answer.deadline };
    case "rejected":
      return {
        kind: "answered",
        result: failure("USER_REJECTED", "User rejected the confirmation request."),
      };
    case "timeout":
      return {
        kind: "answered",
        result: failure(
          "CONFIRMATION_TIMEOUT",
          "Confirmation request timed out before the user responded."
        ),
      };
    case "unavailable":
      return null;
  }
}

/** The confirm-gated actions the host can put to someone else, each with its preview. */
const VIEWLESS_APPROVAL_PREVIEWS: Readonly<
  Record<
    string,
    (
      request: ViewlessActionRequest,
      project: Project,
      deps: ViewlessDeps
    ) => Promise<ViewlessApprovalPreview>
  >
> = {
  "worktree.delete": previewWorktreeDelete,
};

async function runAction(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult | null> {
  switch (request.actionId) {
    case TERMINAL_LAUNCH_ACTION_ID:
      return runTerminalNew(request, project, deps);
    case TERMINAL_SEND_COMMAND_ACTION_ID:
      return runTerminalSendCommand(request, project, deps);
    case WORKTREE_CREATE_ACTION_ID:
      return runWorktreeCreate(request, project, deps);
    case "terminal.list":
      return runTerminalList(request, project, deps);
    case "terminal.getOutput":
      return runTerminalGetOutput(request, project, deps);
    case "terminal.getStatus":
      return runTerminalGetStatus(request, project, deps);
    case "terminal.close":
      return runTerminalClose(request, project, deps);
    case "terminal.interrupt":
      return runTerminalInterrupt(request, project, deps);
    case "terminal.sendKeys":
      return runTerminalSendKeys(request, project, deps);
    case "agent.launch":
      return runAgentLaunch(request, project, deps);
    case "agent.listAvailable":
      return runAgentListAvailable(request, project, deps);
    case "slashCommands.list":
      return runSlashCommandsList(request, project, deps);
    case "worktree.list":
      return runWorktreeList(request, project, deps);
    case "worktree.waitUntilReady":
      return runWorktreeWaitUntilReady(request, project, deps);
    case "worktree.delete":
      return runWorktreeDelete(request, project, deps);
    case "project.getAll":
      return runProjectGetAll(request, project, deps);
    case "project.detectRunners":
      return runProjectDetectRunners(request, project, deps);
    case "workspace.list":
      return runWorkspaceList(request, project, deps);
    case "worktree.createWithRecipe":
      return runWorktreeCreateWithRecipe(request, project, deps);
    case "actions.list":
      return runActionsList(request);
    case "actions.search":
      return runActionsSearch(request);
    case "actions.getSchema":
      return runActionsGetSchema(request);
    case "actions.getContext":
      return runActionsGetContext(request, project, deps);
    case "agent.listPresets":
      return runAgentListPresets(request, project, deps);
    case "agent.listModels":
      return runAgentListModels(request, project, deps);
    case "recipe.list":
      return runRecipeList(request, project, deps);
    case "worktree.waitForPullRequest":
      return runWorktreeWaitForPullRequest(request, project, deps);
    case "agentSessionHistory.list":
      return runSessionHistoryList(request, project, deps);
    case "git.getProjectPulse":
      return runProjectPulse(request, project, deps);
    default:
      return runForgeRead(request, project, deps);
  }
}
