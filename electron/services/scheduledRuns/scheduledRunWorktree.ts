import type { Project } from "../../../shared/types/project.js";
import type {
  ScheduleNewWorktree,
  ScheduledRunNewWorktree,
} from "../../../shared/types/scheduledRuns.js";
import type { WorktreeSetupStatus, WorktreeState } from "../../../shared/types/worktree.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { LAUNCH_SETUP_WAIT_MAX_MS } from "../../../shared/utils/launchInNewWorktree.js";
import { scheduledRunBranchName } from "../../../shared/utils/scheduledRuns.js";
import type { ScheduledRunRecorder } from "./ScheduledRunRecorder.js";

/** The workspace host, as a run of a new-worktree schedule needs it (#16369). */
export interface ScheduledRunWorktreeHost {
  /** The project's worktrees; null with no host to ask. */
  list: (project: Project) => Promise<readonly RunWorktreeListing[] | null>;
  /**
   * Creates the worktree on exactly this branch, refusing a name already taken,
   * and answers its id. Rejects with why it couldn't, which can also mean the
   * host didn't answer in time and may yet make it.
   */
  create: (
    project: Project,
    request: { branch: string; baseBranch: string; fromRemote: boolean }
  ) => Promise<string>;
}

export type RunWorktreeListing = Pick<
  WorktreeState,
  "id" | "path" | "branch" | "setupStatus" | "isMainWorktree"
>;

export type RunWorktreePreparation =
  | { status: "ready"; worktree: ScheduledRunNewWorktree; worktreeId: string; path: string }
  /** The run won't launch, for this reason; `worktree` is null when no branch was claimed. */
  | { status: "refused"; worktree: ScheduledRunNewWorktree | null; message: string }
  /** `shouldStop` said so, and nothing further happens for this attempt. */
  | { status: "stopped"; worktree: ScheduledRunNewWorktree };

/**
 * Nobody is waiting on an unattended run, so it waits as long as any caller may
 * for setup; the host's own command timeouts usually settle it long before.
 */
const SETUP_WAIT_MS = LAUNCH_SETUP_WAIT_MAX_MS;
const SETUP_POLL_MS = 1_000;
const CREATE_ERROR_MAX_LENGTH = 500;

const STAGE_WORDS: Record<NonNullable<WorktreeSetupStatus["stage"]>, string> = {
  "copy-config": "copying its config",
  submodules: "initializing submodules",
  "setup-script": "running its setup commands",
  "plugin-steps": "running a plugin's setup steps",
};

/** Why a setup that isn't ready and has stopped moving holds the launch back. */
function setupRefusal(status: WorktreeSetupStatus | undefined): string {
  const stage = status?.stage ? ` while ${STAGE_WORDS[status.stage]}` : "";
  const detail = status?.error ? `: ${status.error}.` : ".";
  switch (status?.state) {
    case "failed":
      return `The new worktree's setup failed${stage}, so the agent wasn't launched${detail}`;
    case "timed-out":
      return `The new worktree's setup timed out${stage}, so the agent wasn't launched${detail}`;
    case "needs-approval":
      return "The new worktree's setup is waiting for you to approve its commands, so the agent wasn't launched.";
    default:
      // Setup status lives in the host's memory: Daintree or the host stopped
      // since it started, and a worktree of unknown setup is never called ready.
      return "Daintree can't tell whether the new worktree's setup finished, so the agent wasn't launched.";
  }
}

/**
 * Gets a run of a new-worktree schedule its worktree, set up and ready, or says
 * why it can't (#16369). Nothing here falls back to any other folder.
 *
 * The run is registered only at its terminal's spawn, so what a crash, a quit
 * or a scheduler retry leaves between here and there is no record at all, and
 * the next launch can name a different occurrence. So the branch is written down
 * first, as the schedule's claim, and any later launch takes that branch: it
 * finds the worktree if there is one, and otherwise creates it under that exact
 * name, which git refuses if it's taken. Recording the run consumes the claim in
 * the same transaction. Polling stops once `shouldStop` says so; nothing is left
 * running here to launch anything later, whatever the host finishes after.
 */
export async function prepareRunWorktree(input: {
  project: Project;
  scheduleId: string;
  scheduleName: string;
  base: ScheduleNewWorktree;
  recorder: Pick<ScheduledRunRecorder, "worktreeClaim" | "saveWorktreeClaim">;
  host: ScheduledRunWorktreeHost;
  newId: () => string;
  shouldStop: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<RunWorktreePreparation> {
  const { project, scheduleId, scheduleName, base, recorder, host, shouldStop } = input;
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const claim = (): { branch: string; claimedEarlier: boolean } => {
    const held = recorder.worktreeClaim(scheduleId);
    // A base edited since it was claimed isn't what this run was asked for, so
    // the earlier attempt's worktree, if it got one, stays behind for review.
    if (held?.baseBranch === base.baseBranch && held.fromRemote === base.fromRemote) {
      return { branch: held.branch, claimedEarlier: true };
    }
    const next = scheduledRunBranchName(scheduleName, now(), input.newId());
    recorder.saveWorktreeClaim({
      scheduleId,
      projectId: project.id,
      branch: next,
      baseBranch: base.baseBranch,
      fromRemote: base.fromRemote,
    });
    return { branch: next, claimedEarlier: false };
  };
  let claimed: { branch: string; claimedEarlier: boolean };
  try {
    claimed = claim();
  } catch {
    return {
      status: "refused",
      worktree: null,
      message: "The run's new worktree couldn't be noted down, so nothing was created.",
    };
  }
  const { branch, claimedEarlier } = claimed;

  let worktree: ScheduledRunNewWorktree = {
    branch,
    baseBranch: base.baseBranch,
    worktreeId: null,
  };
  const refused = (message: string): RunWorktreePreparation => ({
    status: "refused",
    worktree,
    message,
  });
  const listWorktrees = async (): Promise<readonly RunWorktreeListing[] | string> => {
    try {
      return (await host.list(project)) ?? "The project's workspace service isn't available";
    } catch (error) {
      return formatErrorMessage(error, "The project's worktrees couldn't be read");
    }
  };

  if (claimedEarlier) {
    const listed = await listWorktrees();
    if (typeof listed === "string") {
      return refused(`${listed}, so the run's new worktree couldn't be found.`);
    }
    const found = listed.find((candidate) => candidate.branch === branch);
    // Someone switched the main checkout to the run's branch since. It's the one
    // place a run in this mode must never start, whatever its setup reads.
    if (found?.isMainWorktree) {
      return refused(
        "The run's branch is checked out in the main checkout now, so the agent wasn't launched."
      );
    }
    if (found) worktree = { ...worktree, worktreeId: found.id };
  }
  if (shouldStop()) return { status: "stopped", worktree };

  if (worktree.worktreeId === null) {
    try {
      const worktreeId = await host.create(project, {
        branch,
        baseBranch: base.baseBranch,
        fromRemote: base.fromRemote,
      });
      worktree = { ...worktree, worktreeId };
    } catch (error) {
      const reason = formatErrorMessage(error, "the create failed").slice(
        0,
        CREATE_ERROR_MAX_LENGTH
      );
      return refused(
        `The new worktree couldn't be created, so the agent wasn't launched: ${reason}`
      );
    }
  }
  const worktreeId = worktree.worktreeId;
  if (worktreeId === null) return refused("The new worktree couldn't be created.");

  const deadline = now() + SETUP_WAIT_MS;
  for (;;) {
    if (shouldStop()) return { status: "stopped", worktree };
    const listed = await listWorktrees();
    if (typeof listed === "string") {
      return refused(`${listed}, so the new worktree's setup couldn't be followed.`);
    }
    const found = listed.find((candidate) => candidate.id === worktreeId);
    if (!found) return refused("The new worktree went away before its setup finished.");
    const state = found.setupStatus?.state;
    if (state === "ready") {
      return { status: "ready", worktree, worktreeId, path: found.path };
    }
    if (state !== "pending" && state !== "running") return refused(setupRefusal(found.setupStatus));
    if (now() >= deadline) {
      return refused(
        `The new worktree's setup was still running after ${Math.round(SETUP_WAIT_MS / 60_000)} minutes, so the agent wasn't launched.`
      );
    }
    await sleep(SETUP_POLL_MS);
  }
}
