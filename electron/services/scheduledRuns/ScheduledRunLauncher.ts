import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { Project } from "../../../shared/types/project.js";
import type { ScheduleRunNowOutcome } from "../../../shared/types/ipc/schedules.js";
import type { Schedule, ScheduledRunOrigin } from "../../../shared/types/scheduledRuns.js";
import type { ScheduledRunRef } from "../../../shared/types/scheduledRunRef.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { pathComparisonKey } from "../../../shared/utils/path.js";
import type { ScheduledRunRecorder } from "./ScheduledRunRecorder.js";
import { reserveScheduledLaunch } from "./scheduledRunAdmission.js";

/** The `agent.launch` arguments a scheduled run launches with; never its provenance. */
export interface ScheduledLaunchArgs {
  agentId: string;
  prompt: string;
  /** The run reports back through Daintree's handback marker. */
  handback: true;
  /** Null launches with no preset, never the agent's default one. */
  presetId: string | null;
  /** Empty is the project's main checkout, never whichever worktree is active. */
  worktreeId: string;
  location: "grid";
  /** Never takes focus from whatever the user is doing. */
  focusPolicy: "preserve";
  /** The terminal id the run reserved. */
  requestedId: string;
}

export interface ScheduledLaunchRequest {
  args: ScheduledLaunchArgs;
  scheduledRun: ScheduledRunRef;
}

/** Why the view launching a run gave no answer: it closed, or took too long. */
export class ScheduledLaunchUnansweredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledLaunchUnansweredError";
  }
}

export interface ScheduledRunLauncherDeps<View> {
  getRecorder: () => Promise<ScheduledRunRecorder | null>;
  /** Null when the schedule, or the project it belonged to, is gone. */
  getSchedule: (projectId: string, scheduleId: string) => Promise<Schedule | null>;
  getProject: (projectId: string) => Project | null;
  folderExists: (path: string) => Promise<boolean>;
  isProjectSleeping: (projectId: string) => boolean;
  /** A run started in a project nothing shows: it mustn't read as closed while it runs. */
  markProjectRunning: (projectId: string) => void;
  /** The local view showing the project, preferring the one named, or null. */
  findView: (projectId: string, preferredWebContentsId?: number) => View | null;
  /**
   * Asks the view to dispatch `agent.launch` with the run as host-stamped
   * provenance. Throws {@link ScheduledLaunchUnansweredError} when the view
   * closes or doesn't answer.
   */
  launchInView: (view: View, request: ScheduledLaunchRequest) => Promise<ActionDispatchResult>;
  launchWithoutView: (
    project: Project,
    request: ScheduledLaunchRequest
  ) => Promise<ActionDispatchResult>;
  newId: () => string;
  /** How long a launch that answered to have started waits for its spawn. */
  spawnTimeoutMs?: number;
  /** How long main's own launch, with no view, may take before it's given up. */
  answerTimeoutMs?: number;
  logWarn?: (message: string, error?: unknown) => void;
}

export interface ScheduledRunLaunchInput {
  projectId: string;
  scheduleId: string;
  origin: ScheduledRunOrigin;
  /** The view that asked (Run now), launched in when it shows the project. */
  preferredWebContentsId?: number;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 60_000;
const DEFAULT_ANSWER_TIMEOUT_MS = 60_000;

const CASE_INSENSITIVE_PATHS = process.platform === "darwin" || process.platform === "win32";

function samePath(a: string, b: string): boolean {
  const options = { caseInsensitive: CASE_INSENSITIVE_PATHS };
  return pathComparisonKey(a, options) === pathComparisonKey(b, options);
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ScheduledLaunchUnansweredError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const DECLINE_REASONS: Record<string, string> = {
  "panel-limit": "The project already has as many panels as it can hold.",
  "missing-cli": "The agent isn't installed or can't start.",
  "already-launching": "Another launch of the agent was still starting.",
  "spawn-failed": "The agent's terminal couldn't start.",
  unavailable: "The window showing the project couldn't launch agents.",
  "presets-loading": "The agent's presets couldn't be read.",
};

/** Whether `agent.launch` answered that it started a terminal. */
function launchedTerminal(result: ActionDispatchResult): boolean {
  if (!result.ok) return false;
  const value = result.result;
  return typeof value === "object" && value !== null && Reflect.get(value, "launched") === true;
}

/** Why `agent.launch` started nothing, in the words the history keeps. */
function declineReason(result: ActionDispatchResult): string {
  if (!result.ok) return result.error.message;
  const value = result.result;
  const status =
    typeof value === "object" && value !== null ? Reflect.get(value, "spawnStatus") : undefined;
  return (typeof status === "string" && DECLINE_REASONS[status]) || DECLINE_REASONS["spawn-failed"];
}

/**
 * Launches a schedule's agent as a tracked run (#15978): the agent, preset,
 * prompt and worktree the schedule names, with Daintree's handback
 * instruction after the prompt, as an ordinary agent terminal of the project.
 *
 * It launches where the project is shown, so the pane appears in that
 * window's grid at once and its persistence saves it; with no window it runs
 * in main, which records the pane in the saved layout for the next window to
 * open the project. Either way the run is registered at the spawn itself, from
 * the values the terminal starts with (see `scheduledRunAdmission.ts`), and a
 * launch refused before it spawns is recorded as a failed run with its reason.
 *
 * Every trigger goes through here: Run now today, the scheduler (#15979) with
 * its own origins.
 */
export async function launchScheduledRun<View>(
  input: ScheduledRunLaunchInput,
  deps: ScheduledRunLauncherDeps<View>
): Promise<ScheduleRunNowOutcome> {
  const logWarn = deps.logWarn ?? console.warn;
  const { projectId, scheduleId, origin } = input;
  const recorder = await deps.getRecorder();
  if (!recorder) {
    return {
      status: "failed",
      runId: null,
      message: "The run history isn't available, so the run couldn't be recorded.",
    };
  }
  const schedule = await deps.getSchedule(projectId, scheduleId).catch((error: unknown) => {
    logWarn(`[ScheduledRuns] Couldn't read schedule ${scheduleId}:`, error);
    return null;
  });
  if (!schedule) return { status: "not-found" };
  // Removing a project removes its schedules and their history with them.
  const project = deps.getProject(projectId);
  if (!project) return { status: "not-found" };

  const runId = deps.newId();
  const terminalId = `terminal-${deps.newId()}`;
  const { launch } = schedule;
  const target = launch.worktreeId ?? project.path;
  // Reserved in the same turn the schedule was read, so a removal of the
  // schedule or project from here on cancels it (`cancelScheduledLaunches`).
  const reserved = reserveScheduledLaunch({
    runId,
    scheduleId,
    projectId,
    terminalId,
    agentId: launch.agentId,
    admit: (resume) => {
      // A launcher falls back from a preset it can't find, and a launch with
      // no worktree list from a worktree it can't place; a run that would
      // start differently from its schedule doesn't start.
      if (launch.presetId !== null && resume.agentPresetId !== launch.presetId) {
        throw new Error("The schedule's preset isn't available any more.");
      }
      if (launch.worktreeId !== null && resume.worktreeId !== launch.worktreeId) {
        throw new Error("The schedule's worktree isn't part of the project any more.");
      }
      if (!samePath(resume.cwd, target)) {
        throw new Error(
          launch.worktreeId !== null
            ? "The schedule's worktree couldn't be found."
            : "The project's folder couldn't be found."
        );
      }
      if (deps.isProjectSleeping(projectId)) throw new Error("The project was going to sleep.");
      recorder.registerLaunch({ id: runId, scheduleId, projectId, origin, terminalId, resume });
      try {
        deps.markProjectRunning(projectId);
      } catch (error) {
        logWarn(`[ScheduledRuns] Couldn't mark project ${projectId} as running:`, error);
      }
    },
  });

  const launchReserved = async (): Promise<ScheduleRunNowOutcome> => {
    const failed = (
      message: string,
      reservedId: string | null = terminalId
    ): ScheduleRunNowOutcome => {
      // A removed schedule or project has no history left to write into.
      if (reserved.removed() || !deps.getProject(projectId)) return { status: "not-found" };
      try {
        recorder.registerRefusedLaunch({
          id: runId,
          scheduleId,
          projectId,
          origin,
          terminalId: reservedId,
          message,
        });
        return { status: "failed", runId, message };
      } catch (error) {
        logWarn(`[ScheduledRuns] Couldn't record run ${runId}'s refused launch:`, error);
        return { status: "failed", runId: null, message };
      }
    };
    // Nothing was asked for yet, so no spawn can come for it.
    const refuseBeforeLaunch = (message: string): ScheduleRunNowOutcome => {
      reserved.withdraw();
      return failed(message, null);
    };

    if (project.status === "missing" || !(await deps.folderExists(project.path))) {
      return refuseBeforeLaunch("The project's folder is missing.");
    }
    if (deps.isProjectSleeping(projectId))
      return refuseBeforeLaunch("The project was going to sleep.");
    if (reserved.state().kind !== "pending") return { status: "not-found" };

    const request: ScheduledLaunchRequest = {
      args: {
        agentId: launch.agentId,
        prompt: launch.prompt,
        handback: true,
        presetId: launch.presetId,
        worktreeId: launch.worktreeId ?? "",
        location: "grid",
        focusPolicy: "preserve",
        requestedId: terminalId,
      },
      scheduledRun: { scheduleId, runId },
    };

    let result: ActionDispatchResult | null = null;
    let unanswered: string | null = null;
    const view = deps.findView(projectId, input.preferredWebContentsId);
    try {
      // A view's bridge keeps its own deadline; main's launch waits on the
      // workspace host, which nothing else bounds.
      result = view
        ? await deps.launchInView(view, request)
        : await withDeadline(
            deps.launchWithoutView(project, request),
            deps.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS,
            "The launch didn't finish in time."
          );
    } catch (error) {
      unanswered = formatErrorMessage(error, "The launch didn't answer.");
    }

    // A view answers once its pane is committed, which can be before the
    // terminal's spawn reaches main; the run is registered only then.
    if (result !== null && launchedTerminal(result) && reserved.state().kind === "pending") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        reserved.admitted.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    }

    const state = reserved.state();
    if (state.kind === "cancelled") return { status: "not-found" };
    if (state.kind === "refused") return failed(state.message);
    if (state.kind === "pending") {
      reserved.giveUp();
      if (unanswered !== null) return failed(unanswered);
      if (result !== null && !launchedTerminal(result)) return failed(declineReason(result));
      return failed("The agent's terminal didn't start in time.");
    }
    if (result !== null && !launchedTerminal(result)) {
      // Registered, then the launch failed: the spawn threw after its admission.
      const message = declineReason(result);
      const run = recorder.get(runId);
      if (run?.process.pty.state === "not-started") {
        recorder.settle(runId, { kind: "launch-error", message });
      }
      return { status: "failed", runId, message };
    }
    // The PTY host can refuse a spawn as it's sent (too many terminals), which
    // the history has already settled while the launch still answers started.
    const settlement = recorder.get(runId)?.settlement;
    if (settlement?.state === "settled" && settlement.evidence.kind === "launch-error") {
      return { status: "failed", runId, message: settlement.evidence.message };
    }
    return { status: "started", runId, terminalId };
  };

  try {
    return await launchReserved();
  } finally {
    reserved.finish();
  }
}
