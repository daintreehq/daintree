import type { ActionError } from "../../../shared/types/actions.js";
import type {
  TerminalExitObservation,
  TerminalWaitForExitResult,
} from "../../../shared/types/terminalExitWait.js";
import type { WorktreeRetireOwnedResult } from "../../../shared/types/worktreeRetirement.js";
import { pluralize } from "../../../shared/utils/pluralize.js";
import {
  HOST_MATCH_OPTIONS,
  describeTerminal,
  terminalsInWorktree,
  type TerminalAttribution,
  type TerminalProcessRecord,
  type WorktreeLiveTerminal,
  type WorktreeMatchOptions,
} from "./worktreeProcessGuard.js";
import type { WorktreeGitObservation } from "./worktreeRetirementGit.js";

/** What the calling session is to a terminal in the worktree, for a retirement. */
export interface RetirementAttribution extends TerminalAttribution {
  /** This session's close of the run now under the id is on record, so it may wait for that run. */
  closedByThisSession: boolean;
}

/** A pane a retirement closes, and the run the checks found under its id. */
export interface RetirementClose {
  terminalId: string;
  /** Undefined when the host could not say; the close then rests on the ledger alone, as `terminal.closeOwned` does. */
  launchGeneration: number | undefined;
}

/** What a retirement does to the worktree's terminals before the delete. */
export interface RetirementPlan {
  /** This session's panes still open in the worktree, exited or running. */
  close: RetirementClose[];
  /** Processes that must be seen to exit: the running panes closed above, and this session's panes already in their trash grace. */
  awaitExit: string[];
}

/** The checks that refuse before anything changes, as a refusal's `details.check` names them. */
export type RetirementCheck = "clean" | "pushed" | "processes";

const notRetired = (worktreeId: string) => `Worktree '${worktreeId}' was not retired:`;

function refusal(
  worktreeId: string,
  check: RetirementCheck,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {}
): ActionError {
  return {
    code: "DISABLED",
    message: `${notRetired(worktreeId)} ${message}`,
    details: { check, reason, worktreeId, ...extra },
  };
}

/** A refusal from before anything was touched, saying so. */
export function untouched(error: ActionError): ActionError {
  return { ...error, message: `${error.message} Nothing was closed or deleted.` };
}

/** The status or commit read failed, so neither check could be answered. */
export function gitUnreadableRefusal(worktreeId: string): ActionError {
  return {
    code: "EXECUTION_ERROR",
    message:
      `${notRetired(worktreeId)} git could not report whether it is clean and pushed. ` +
      `Try again shortly.`,
    details: { check: "clean", reason: "worktree-git-unreadable", worktreeId },
  };
}

/**
 * Why the worktree is not clean and pushed, or `undefined` when it is. Clean
 * is asked first: uncommitted work is what a delete can never bring back.
 * "Pushed" is read off the remote-tracking refs as of the last fetch, which
 * the refusal says, so a caller that just pushed elsewhere knows to fetch.
 */
export function refuseUnlessCleanAndPushed(
  worktreeId: string,
  git: WorktreeGitObservation
): ActionError | undefined {
  const { staged, unstaged, untracked, conflicted, hiddenFromStatus } = git;
  if (staged + unstaged + untracked + conflicted > 0) {
    const parts = [
      staged > 0 ? pluralize(staged, "staged change") : undefined,
      unstaged > 0 ? pluralize(unstaged, "unstaged change") : undefined,
      untracked > 0 ? pluralize(untracked, "untracked entry", "untracked entries") : undefined,
      conflicted > 0 ? pluralize(conflicted, "conflicted path") : undefined,
    ].filter((part): part is string => part !== undefined);
    return refusal(
      worktreeId,
      "clean",
      "worktree-not-clean",
      `it has ${parts.join(", ")}. Commit or remove them first.`,
      { staged, unstaged, untracked, conflicted }
    );
  }
  // Edits there never reach status, so nothing above could see them.
  if (hiddenFromStatus > 0) {
    return refusal(
      worktreeId,
      "clean",
      "worktree-has-unchecked-files",
      `${pluralize(hiddenFromStatus, "tracked file is", "tracked files are")} marked ` +
        `assume-unchanged, or skip-worktree while present, so git does not check them for ` +
        `changes. Clear the flags and commit what they hide first.`,
      { hiddenFromStatus }
    );
  }
  if (git.headOid === null || git.unpushedCommits === null) {
    return refusal(
      worktreeId,
      "pushed",
      "worktree-head-unborn",
      "its branch has no commit, so there is nothing to tell pushed from unpushed.",
      { branch: git.branch }
    );
  }
  if (git.unpushedCommits > 0) {
    return refusal(
      worktreeId,
      "pushed",
      "worktree-not-pushed",
      `${pluralize(git.unpushedCommits, "commit")} reachable from ${git.headOid.slice(0, 12)} ` +
        `${git.unpushedCommits === 1 ? "is" : "are"} on no remote-tracking ref (as of the last ` +
        `fetch). Push the branch first.`,
      { headOid: git.headOid, branch: git.branch, unpushedCommits: git.unpushedCommits }
    );
  }
  return undefined;
}

function unconfirmedProcesses(worktreeId: string): ActionError {
  return untouched({
    code: "EXECUTION_ERROR",
    message:
      `${notRetired(worktreeId)} which terminal processes are running in it could not be ` +
      `confirmed. Try again shortly.`,
    details: { check: "processes", reason: "terminal-processes-unreadable", worktreeId },
  });
}

/**
 * What a retirement closes and waits for, or why it must not start (#15737).
 *
 * Read from the pty host, like the owned delete's guard, so the answer is the
 * same with no window open. Every running terminal in the worktree has to be
 * the caller's to stop: an open pane it can still close, or one it already
 * closed whose run is still in its trash grace. Anything else — a terminal it
 * never created, one it created but no longer holds, a trashed one it has no
 * close on record for — refuses before anything is closed, and so does a
 * census that could not place every terminal, since the one it missed could
 * be someone else's.
 *
 * The caller's own panes whose process already exited are closed too, since
 * they are still panes in the worktree; other exited terminals hold nothing
 * and are left as the owned delete leaves them.
 */
export async function planWorktreeRetirement(
  worktreeId: string,
  readTerminalProcesses: (() => Promise<readonly TerminalProcessRecord[]>) | undefined,
  attribute: (terminalId: string, launchGeneration: number | undefined) => RetirementAttribution,
  options: WorktreeMatchOptions = HOST_MATCH_OPTIONS
): Promise<{ plan: RetirementPlan } | { refusal: ActionError }> {
  let records: readonly TerminalProcessRecord[];
  try {
    if (readTerminalProcesses === undefined) throw new Error("No terminal host reader.");
    records = await readTerminalProcesses();
  } catch {
    return { refusal: unconfirmedProcesses(worktreeId) };
  }
  const attributions = new Map<TerminalProcessRecord, RetirementAttribution>();
  const attributionOf = (record: TerminalProcessRecord) => {
    let attribution = attributions.get(record);
    if (attribution === undefined) {
      attribution = attribute(record.id, record.launchGeneration);
      attributions.set(record, attribution);
    }
    return attribution;
  };
  // Running records first, so an id two shards report is named by its live one.
  const running = records.filter((record) => record.isExited !== true);
  const exitedOwnPanes = records.filter(
    (record) =>
      record.isExited === true &&
      record.isTrashed !== true &&
      attributionOf(record).closableByThisSession
  );
  const { terminals, complete } = await terminalsInWorktree(
    [...running, ...exitedOwnPanes],
    worktreeId,
    options
  );
  const close: RetirementClose[] = [];
  const awaitExit: string[] = [];
  const blockers: WorktreeLiveTerminal[] = [];
  for (const record of terminals) {
    const attribution = attributionOf(record);
    const trashed = record.isTrashed === true;
    const planned = { terminalId: record.id, launchGeneration: record.launchGeneration };
    if (record.isExited === true) {
      close.push(planned);
    } else if (trashed ? attribution.closedByThisSession : attribution.closableByThisSession) {
      if (!trashed) close.push(planned);
      awaitExit.push(record.id);
    } else {
      blockers.push({
        terminalId: record.id,
        createdByThisSession: attribution.createdByThisSession,
        closableByThisSession: attribution.closableByThisSession,
        trashed,
        trashExpiresAt:
          trashed && typeof record.trashExpiresAt === "number" ? record.trashExpiresAt : null,
      });
    }
  }
  if (blockers.length > 0) {
    const what =
      blockers.length === 1
        ? "a terminal this session cannot stop is running in it"
        : `${blockers.length} terminals this session cannot stop are running in it`;
    return {
      refusal: untouched(
        refusal(
          worktreeId,
          "processes",
          "worktree-has-running-terminals",
          `${what}: ${blockers.map(describeTerminal).join(", ")}. Leave it to whoever runs them.`,
          { terminals: blockers }
        )
      ),
    };
  }
  if (!complete) return { refusal: unconfirmedProcesses(worktreeId) };
  return { plan: { close, awaitExit } };
}

/** What a retirement had already done when it stopped. */
export interface RetirementProgress {
  closedTerminalIds: string[];
  processes: TerminalExitObservation[];
}

/** Where a retirement stopped after it could have changed something. */
export type RetirementStep = "close" | "wait" | "recheck" | "delete";

/** Whether the call changed anything before it stopped: a pane closed, or a trash grace ended early. */
export function retirementChangedSomething(progress: RetirementProgress): boolean {
  return (
    progress.closedTerminalIds.length > 0 ||
    progress.processes.some((process) => process.graceEnded === true)
  );
}

/**
 * The answer for a retirement that stopped at `step` (#15737). With nothing
 * seen to change it is the cause itself, so a caller reads the refusal it
 * would have got from the step alone; it does not claim nothing was closed,
 * since a close that answered with an error may still have trashed its pane.
 * Once a pane was reported closed or a grace ended, it is `PARTIAL_SUCCESS`
 * naming what was done, what the processes did, whether the delete was
 * attempted, and the cause in full, so a caller retrying knows its panes are
 * already gone and a confirmation timeout reads apart from a rejection.
 */
export function retirementStopped(
  worktreeId: string,
  step: RetirementStep,
  progress: RetirementProgress,
  cause: ActionError
): ActionError {
  if (!retirementChangedSomething(progress)) {
    return step === "delete"
      ? cause
      : { ...cause, message: `${cause.message} No delete was sent.` };
  }
  const closed = progress.closedTerminalIds;
  const running = progress.processes.filter((process) => process.outcome !== "exited");
  const done = [
    closed.length > 0
      ? `closed ${pluralize(closed.length, "pane")} of this session's there (${closed
          .map((id) => `'${id}'`)
          .join(", ")})`
      : "ended the trash grace of this session's closed panes there",
    progress.processes.length === 0
      ? undefined
      : running.length === 0
        ? "their processes exited"
        : `${pluralize(running.length, "process", "processes")} not seen to exit (${running
            .map((process) => `'${process.terminalId}' ${process.outcome}`)
            .join(", ")})`,
  ].filter((part): part is string => part !== undefined);
  const deleteAttempted = step === "delete";
  const reason = cause.message.trim();
  return {
    code: "PARTIAL_SUCCESS",
    message:
      `${reason.startsWith(notRetired(worktreeId)) ? reason : `${notRetired(worktreeId)} ${reason}`} ` +
      `Already done: ${done.join("; ")}. ${
        deleteAttempted ? "The delete was attempted and did not complete." : "No delete was sent."
      } The branch was kept.`,
    details: {
      failedStep: step,
      worktreeId,
      deleteAttempted,
      closedTerminalIds: closed,
      processes: progress.processes,
      cause,
    },
  };
}

/** One step of the teardown, as the session server runs it. */
export interface RetirementTeardownSteps {
  signal: AbortSignal;
  /** Close one pane, refusing a run other than the planned one; undefined once its close reported it closed. */
  closePane(pane: RetirementClose): Promise<ActionError | undefined>;
  waitForExits(
    terminalIds: readonly string[]
  ): Promise<{ result: TerminalWaitForExitResult } | { error: ActionError }>;
  /** The clean, pushed and process checks again, just before the delete. */
  recheck(): Promise<ActionError | undefined>;
}

function cancelled(worktreeId: string): ActionError {
  return {
    code: "EXECUTION_ERROR",
    message: `The call retiring '${worktreeId}' was cancelled before it finished.`,
  };
}

function thrown(error: unknown, fallback: string): ActionError {
  return {
    code: "EXECUTION_ERROR",
    message: error instanceof Error && error.message.length > 0 ? error.message : fallback,
  };
}

/**
 * Close the caller's panes in order, wait for their processes, and check the
 * worktree again, stopping at the first thing that fails (#15737). A cancelled
 * call starts nothing more. Every process has to be seen to exit: `running`
 * and `unknown` both stop it, since neither shows the directory is free.
 */
export async function tearDownForRetirement(
  worktreeId: string,
  plan: RetirementPlan,
  steps: RetirementTeardownSteps
): Promise<{ ok: true; progress: RetirementProgress } | { ok: false; error: ActionError }> {
  const progress: RetirementProgress = { closedTerminalIds: [], processes: [] };
  const stop = (step: RetirementStep, cause: ActionError) => ({
    ok: false as const,
    error: retirementStopped(worktreeId, step, progress, cause),
  });
  for (const pane of plan.close) {
    if (steps.signal.aborted) return stop("close", cancelled(worktreeId));
    let failure: ActionError | undefined;
    try {
      failure = await steps.closePane(pane);
    } catch (error) {
      failure = thrown(error, `Closing '${pane.terminalId}' failed.`);
    }
    if (failure !== undefined) return stop("close", failure);
    progress.closedTerminalIds.push(pane.terminalId);
  }
  if (plan.awaitExit.length > 0) {
    if (steps.signal.aborted) return stop("wait", cancelled(worktreeId));
    let waited: Awaited<ReturnType<RetirementTeardownSteps["waitForExits"]>>;
    try {
      waited = await steps.waitForExits(plan.awaitExit);
    } catch (error) {
      waited = { error: thrown(error, "Waiting for the closed panes' processes failed.") };
    }
    if ("error" in waited) return stop("wait", waited.error);
    progress.processes = waited.result.processes;
    const notExited = progress.processes.filter((process) => process.outcome !== "exited");
    if (notExited.length > 0) {
      return stop("wait", {
        code: "DISABLED",
        message:
          `${pluralize(notExited.length, "process was", "processes were")} not seen to exit in ` +
          `time, so the directory may still be in use. Retry once they exit.`,
        details: { reason: "terminal-exit-not-observed", worktreeId },
      });
    }
  }
  if (steps.signal.aborted) return stop("recheck", cancelled(worktreeId));
  let late: ActionError | undefined;
  try {
    late = await steps.recheck();
  } catch (error) {
    late = thrown(error, "Checking the worktree again failed.");
  }
  if (late !== undefined) return stop("recheck", late);
  if (steps.signal.aborted) return stop("recheck", cancelled(worktreeId));
  return { ok: true, progress };
}

/** The success answer, once the delegated delete reported success. */
export function retirementResult(
  worktreeId: string,
  progress: RetirementProgress,
  git: WorktreeGitObservation & { headOid: string }
): WorktreeRetireOwnedResult {
  return {
    worktreeId,
    closedTerminalIds: progress.closedTerminalIds,
    processes: progress.processes,
    headOid: git.headOid,
    branch: git.branch,
  };
}
