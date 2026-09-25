import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import type {
  ActionContext,
  ActionDispatchResult,
  ActionErrorCode,
} from "../../../shared/types/actions.js";
import type { PanelSnapshot, Project, ProjectState } from "../../../shared/types/project.js";
import type { WorktreeCreateResult } from "../../../shared/types/worktree.js";
import { getDefaultPanelTitle, panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import {
  readDispatchTerminalCommand,
  readDispatchTerminalCwd,
  TERMINAL_LAUNCH_ACTION_ID,
} from "../../../shared/utils/dispatchTerminalCommand.js";
import { appendHandbackInstruction, mintHandbackCode } from "../../../shared/utils/handback.js";
import { buildTerminalSendCommandReceipt } from "../../../shared/utils/terminalSendCommandResult.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { recordViewlessTerminal, type ProjectStateWriter } from "./projectStateAuthoring.js";

const TERMINAL_SEND_COMMAND_ACTION_ID = "terminal.sendCommand";
const WORKTREE_CREATE_ACTION_ID = "worktree.create";

/**
 * The actions the host can run itself when no frontend is attached to their
 * project: the ones agents use to keep working — open a terminal, submit to
 * one, make a worktree. Everything else is a question for a renderer, and is
 * refused as "no frontend attached" rather than guessed at.
 *
 * `terminal.sendCommandOwned` needs no entry: main delegates it to
 * `terminal.sendCommand` after its ownership check, and the delegate is what
 * reaches this executor.
 */
export const VIEWLESS_ACTION_IDS: ReadonlySet<string> = new Set([
  TERMINAL_LAUNCH_ACTION_ID,
  TERMINAL_SEND_COMMAND_ACTION_ID,
  WORKTREE_CREATE_ACTION_ID,
]);

export function hasViewlessImplementation(actionId: string): boolean {
  return VIEWLESS_ACTION_IDS.has(actionId);
}

/** The pty-host reads a viewless action needs, as `PtyClient` answers them. */
export interface ViewlessPtyReader {
  getTerminalProjectId(id: string): string | null;
  getTerminalAsync(id: string): Promise<{
    kind?: string;
    launchAgentId?: string;
    detectedAgentId?: string;
    agentState?: string;
    everDetectedAgent?: boolean;
    isTrashed?: boolean;
    hasPty?: boolean;
  } | null>;
}

/** The workspace-host calls a viewless worktree creation needs. */
export interface ViewlessWorkspaceHosts {
  getHostForProject(projectPath: string): unknown;
  prewarmProject(projectPath: string): void;
  waitForReady(): Promise<void>;
  isWorktreeOwnedByProject(
    worktreeId: string,
    projectPath: string,
    expectedProjectId: string
  ): Promise<boolean | null>;
}

export interface ViewlessDeps {
  getProject(projectId: string): Project | null;
  getProjectState(projectId: string): Promise<ProjectState | null>;
  stateWriter: ProjectStateWriter;
  getPtyReader(): ViewlessPtyReader | null;
  getWorkspaceHosts(): ViewlessWorkspaceHosts | null;
  invoke<T>(projectId: string, channel: string, args: unknown[]): Promise<T>;
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
}

function failure(code: ActionErrorCode, message: string, details?: unknown): ActionDispatchResult {
  return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

function validationFailure(actionId: string, error: z.ZodError): ActionDispatchResult {
  return failure(
    "VALIDATION_ERROR",
    `Invalid arguments for ${actionId}: ${z.prettifyError(error)}`
  );
}

const TerminalNewArgsSchema = z
  .object({
    spawnedBy: z.unknown().optional(),
    focusPolicy: z.unknown().optional(),
    cwd: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
  })
  .optional();

const TerminalSendCommandArgsSchema = z.object({
  terminalId: z.string().min(1).max(512),
  command: z.string().min(1),
  handback: z.boolean().optional(),
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

  // The same two arguments the renderer elevates to "confirm" for an agent
  // dispatch, read by the same readers so the two can never disagree.
  const launchArg =
    readDispatchTerminalCommand(request.args) !== undefined
      ? "command"
      : readDispatchTerminalCwd(request.args) !== undefined
        ? "cwd"
        : undefined;
  if (launchArg !== undefined && !request.confirmed) {
    return failure(
      "CONFIRMATION_REQUIRED",
      `Action '${request.actionId}' was called with a '${launchArg}', so it would start a shell and ` +
        `requires confirmation, but no Daintree frontend is attached to this project to ask. The ` +
        `action was not run.`,
      { confirmationChannel: "unavailable" }
    );
  }

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
  if (!info) return failure("EXECUTION_ERROR", "Terminal not found");
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
  if (!hasViewlessImplementation(request.actionId)) return null;
  const project = deps.getProject(request.workspaceId);
  if (!project) return null;
  switch (request.actionId) {
    case TERMINAL_LAUNCH_ACTION_ID:
      return runTerminalNew(request, project, deps);
    case TERMINAL_SEND_COMMAND_ACTION_ID:
      return runTerminalSendCommand(request, project, deps);
    case WORKTREE_CREATE_ACTION_ID:
      return runWorktreeCreate(request, project, deps);
    default:
      return null;
  }
}
