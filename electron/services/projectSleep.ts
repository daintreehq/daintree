import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { projectStore } from "./ProjectStore.js";
import { getHibernationService } from "./HibernationService.js";
import { helpSessionService } from "./HelpSessionService.js";
import { writeHibernatedMarker } from "./pty/terminalSessionPersistence.js";
import {
  gracefulTeardownAndJournalProject,
  type ProjectTeardownSnapshot,
} from "./pty/projectSessionJournal.js";
import { notifyProjectPluginsClosed } from "../window/projectPluginLifecycle.js";
import { readPanelRecoveryHold, type PanelRecoveryHold } from "./panelRecoveryQuery.js";
import type { ProjectViewManagersProvider } from "../window/activeProjectIds.js";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { PluginWorkStopped, ProjectSleepResult } from "../../shared/types/ipc/project.js";
import { summarizePluginWorkStopped, type ProjectPluginWork } from "./plugin/projectPluginWork.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { AppError } from "../utils/errorTypes.js";
import { logError, logInfo } from "../utils/logger.js";

/** Thrown when the PTY host can't confirm the kills — see {@link sleepProject}. */
const UNCONFIRMED_TEARDOWN_MESSAGE =
  "Couldn't confirm the project's terminals stopped. The project was left open.";

export interface SleepProjectDependencies {
  ptyClient: PtyClient | null | undefined;
  /** Journals each agent's branch, and owns the workspace host Sleep evicts. */
  workspaceClient?: WorkspaceClient | null;
  /** Every window's view manager, read lazily — windows open and close mid-sleep. */
  projectViewManagers: ProjectViewManagersProvider;
  /**
   * The project's plugin work, read once just before the commit so the result
   * can say what the unload is about to stop (#14093). A policy keeps its own
   * hold on that work through `isStillEligible`.
   */
  pluginWork?: (projectId: string) => readonly ProjectPluginWork[];
}

/**
 * Who decided this project should sleep.
 *
 * `"user"` is someone asking — the switcher's Sleep, the idle reminder's
 * button. It goes through whatever the project is doing, the view on screen
 * included, because that is what was asked for.
 *
 * `"policy"` is the app deciding on its own (idle auto-close). It never
 * destroys a view an MCP dispatch is waiting on or a dictation still needs,
 * and it re-asks the policy at every await, so a project the user picks up mid-sleep is left alone. The
 * policy owns its own eligibility; Sleep only owns the order it is asked in.
 */
export type SleepProjectOptions =
  | { initiator: "user" }
  | {
      initiator: "policy";
      /** Still a candidate? Synchronous, asked before each step that can't be undone. */
      isStillEligible: () => boolean;
      /** Do the terminals the kill is about to take still permit it? */
      allowsTerminals: (snapshot: ProjectTeardownSnapshot) => boolean;
      /** Stamped on the `closed` row so the switcher can say the app parked it. */
      autoParkedAt?: number;
    };

/** Why a policy can't go on right now. */
type PolicyRefusal = ViewRefusal | "ineligible" | PanelRecoveryHold;

/** What a project's view is doing that an automatic teardown waits out. */
type ViewRefusal = "mcp-dispatch" | "dictation";

export type SleepProjectOutcome =
  | ({ status: "slept" } & ProjectSleepResult)
  | { status: "already-closed" }
  | {
      status: "skipped";
      /**
       * `in-flight`: another sleep of this project is already running.
       * `mcp-dispatch`: an MCP dispatch is waiting on one of its views.
       * `dictation`: a dictation session, or the cleanup after its stop, still
       * needs one of its views.
       * `ineligible`: the policy said no at a later check.
       * `panel-unrecoverable` / `panel-unknown`: a view holds work recovery
       * storage would not bring back, or could not say whether it does.
       */
      reason: "in-flight" | PolicyRefusal;
      /**
       * Terminals the kill already took when the refusal came after it; the
       * project stays open without them. Absent when nothing was killed.
       */
      terminalsKilled?: number;
    };

/**
 * One sleep per project at a time. Two can otherwise both pass the `closed`
 * check — it is read before the first await — and revoke, kill and journal
 * the same project twice.
 */
const inFlight = new Map<string, Promise<SleepProjectOutcome>>();

/**
 * Put ONE project to sleep the way quitting puts them all to sleep: a
 * graceful, session-preserving kill of its terminals, each captured
 * `agentSessionId` written back into the saved panel snapshots, a resume
 * record journaled per agent, hibernation markers written, the cached renderer
 * views and the workspace host reclaimed, its plugins closed, and the row left
 * `closed` so a reopen restores the layout and resumes the agents. Deliberately
 * does NOT call `clearProjectState` (that is Close's job — it destroys the
 * layout) or `killByProject` (destructive — it discards the sessions this
 * exists to keep).
 *
 * The one teardown every caller shares (#13845): `project:sleep`, the idle
 * reminder's Sleep button and idle auto-close all end here, so none of them
 * leaves a project half-stopped. The dev preview's pre-kill cancellation rides
 * along for free — it hangs off the PtyClient's confirmed project kill, which
 * the journal helper is the one caller of here.
 *
 * Accepts the project that is on screen (for a user). It does NOT tear down
 * that window's view: the window's React renderer IS the project's
 * `WebContentsView`, and destroying it leaves a blank window rather than the
 * picker. The renderer drops to the no-project state itself on `project:slept`
 * instead, and `evictProjectRenderer` reclaims the CACHED views in every other
 * window.
 *
 * Throws (plain `Error`) on a missing or unknown project id, and `AppError`
 * otherwise — `INTERNAL` both for an unconfirmed kill, which leaves the row
 * open, and for anything unexpected before the kill is confirmed.
 */
export async function sleepProject(
  projectId: string,
  options: SleepProjectOptions,
  deps: SleepProjectDependencies
): Promise<SleepProjectOutcome> {
  // An absent/blank id must fail as invalid, never quietly resolve to
  // "whatever project is current" — a silent fallback on a teardown is how the
  // wrong project gets torn down (#7880).
  if (typeof projectId !== "string" || !projectId) {
    throw new Error("Invalid project ID");
  }

  // A user waits for the sleep ahead of it and then decides afresh: that one
  // usually finished the job (its own `closed` check then returns), and a
  // policy run that backed off leaves the project for this one to sleep. A
  // policy run just skips — the next sweep comes round soon enough.
  for (let pending = inFlight.get(projectId); pending; pending = inFlight.get(projectId)) {
    if (options.initiator === "policy") return { status: "skipped", reason: "in-flight" };
    await pending.catch(() => {});
  }

  const run = runSleep(projectId, options, deps);
  inFlight.set(projectId, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(projectId) === run) inFlight.delete(projectId);
  }
}

async function runSleep(
  projectId: string,
  options: SleepProjectOptions,
  deps: SleepProjectDependencies
): Promise<SleepProjectOutcome> {
  const project = projectStore.getProjectById(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  // Already asleep — nothing resident to reclaim, and re-killing would walk an
  // empty scope. Idempotent so a re-broadcast or a double click can't
  // double-journal.
  if (project.status === "closed") {
    return { status: "already-closed" };
  }

  const policy = options.initiator === "policy" ? options : null;
  /** Why the policy can't go on right now, or null. Asked again at every step. */
  const policyRefusal = (): PolicyRefusal | null => {
    if (!policy) return null;
    if (!policy.isStillEligible()) return "ineligible";
    return viewRefusal(projectId, deps.projectViewManagers);
  };
  // A user's Sleep goes through unsaved work on purpose; an automatic one has
  // no one to have asked, so it waits for the view to say it holds nothing a
  // destroyed view would lose.
  const panelRefusal = async (): Promise<PolicyRefusal | null> =>
    policy ? readPanelRecoveryHold(projectId, deps.projectViewManagers) : null;
  const skip = (reason: PolicyRefusal, terminalsKilled?: number): SleepProjectOutcome => {
    logInfo("project-sleep-skipped", { projectId, initiator: options.initiator, reason });
    return terminalsKilled === undefined
      ? { status: "skipped", reason }
      : { status: "skipped", reason, terminalsKilled };
  };

  // Before the first side effect, so a project an MCP client is driving is
  // never even revoked (claim-then-act, #10820).
  const refusedUpFront = policyRefusal();
  if (refusedUpFront) return skip(refusedUpFront);
  const panelHoldUpFront = await panelRefusal();
  if (panelHoldUpFront) return skip(panelHoldUpFront);
  const refusedAfterPanelRead = policyRefusal();
  if (refusedAfterPanelRead) return skip(refusedAfterPanelRead);

  try {
    const ptyClient = deps.ptyClient;
    if (!ptyClient) {
      throw new Error("The terminal host isn't available");
    }

    // Capture the assistant's session BEFORE the project-wide teardown:
    // `revokeSession` needs the assistant's PTY still alive to read its resume
    // id, and the generic kill below would already have taken it. Deliberately
    // ahead of the `confirmed` gate too — an unconfirmed teardown leaves the
    // row open, and a captured pending entry is what lets a panel that reopens
    // there resume rather than start cold (#12181).
    //
    // Best-effort: losing the resume entry must not fail the sleep.
    try {
      await helpSessionService.revokeByProjectId(projectId);
    } catch (revokeError) {
      logError("project-sleep-help-revoke-failed", revokeError, { projectId });
    }

    // The revoke's graceful kill can take seconds — long enough for the user
    // to switch to this project, or an MCP client to start a call against it.
    // Bailing here is safe: the revoke already persisted the assistant's
    // pending entry, so a reopened panel still resumes.
    const refusedAfterRevoke = policyRefusal();
    if (refusedAfterRevoke) return skip(refusedAfterRevoke);

    // Graceful, session-preserving kill + snapshot writeback + journal, in that
    // order — the same three steps a quit performs per project. A policy gets
    // the last word against the helper's own pre-kill snapshot, which it reads
    // after one more await.
    const killGate: { refusal: PolicyRefusal | null } = { refusal: null };
    const beforeKill = policy
      ? (snapshot: ProjectTeardownSnapshot): boolean => {
          killGate.refusal =
            policyRefusal() ?? (policy.allowsTerminals(snapshot) ? null : "ineligible");
          return killGate.refusal === null;
        }
      : undefined;
    const { confirmed, aborted, terminalsKilled, sessions } =
      await gracefulTeardownAndJournalProject(
        projectId,
        ptyClient,
        deps.workspaceClient ?? undefined,
        { preserveSession: true, writeBackSessionIds: true, beforeKill }
      );
    if (aborted) return skip(killGate.refusal ?? "ineligible");

    // Fail closed: an unconfirmed kill means a live host never acknowledged,
    // so its agents may still be running. Marking the row `closed` now would
    // hide still-running work behind a "reopen to resume" affordance that has
    // nothing to resume (#11340).
    if (!confirmed) {
      throw new AppError({
        code: "INTERNAL",
        message: UNCONFIRMED_TEARDOWN_MESSAGE,
        context: { projectId },
      });
    }

    for (const session of sessions) {
      try {
        writeHibernatedMarker(session.id);
      } catch (markerError) {
        // Costs this terminal its restore banner, nothing else.
        console.warn(`[ProjectSleep] marker failed for ${session.id}:`, markerError);
      }
    }

    // A draft can start in the seconds the kill took, and the view it lives in
    // is about to be destroyed. The terminals are already gone, so a hold here
    // leaves the project open with the same restore markers a refusal after
    // the kill always leaves.
    const panelHoldBeforeEviction = await panelRefusal();
    if (panelHoldBeforeEviction) {
      logInfo("project-sleep-panel-hold-after-kill", { projectId, terminalsKilled });
      return skip(panelHoldBeforeEviction, terminalsKilled);
    }

    // A policy asks once more after the slowest await of all. A project picked
    // up (or leased) meanwhile keeps its markers — its PTYs are gone either
    // way, and the markers let the panels restore — but is not evicted, closed
    // or unloaded under whoever picked it up (#13570). Nothing awaits between
    // here and the status write, so neither can slip in after this check.
    const refusedAfterKill = policyRefusal();
    if (refusedAfterKill) {
      logInfo("project-sleep-ineligible-after-kill", { projectId, terminalsKilled });
      return skip(refusedAfterKill, terminalsKilled);
    }

    // Synchronous, and nothing awaits between here and the unload being
    // queued, so this is the work that unload will stop.
    let pluginWorkStopped: PluginWorkStopped | null = null;
    try {
      pluginWorkStopped = deps.pluginWork
        ? summarizePluginWorkStopped(deps.pluginWork(projectId))
        : null;
    } catch (pluginWorkError) {
      logError("project-sleep-plugin-work-read-failed", pluginWorkError, { projectId });
    }
    if (pluginWorkStopped) {
      logInfo("project-sleep-plugin-work-stopped", {
        projectId,
        initiator: options.initiator,
        tasks: pluginWorkStopped.tasks.length,
        processes: pluginWorkStopped.processes,
      });
    }

    // Past this point the terminals are gone and the kill is confirmed, so the
    // operation is COMMITTED: every remaining step is reclamation or
    // bookkeeping, and letting one of them throw would strand the row as
    // "open" with dead terminals behind it. Each is isolated, and the status
    // write + broadcast below always run.
    let rendererViewsEvicted = 0;
    try {
      // Skips a window where the project is on screen (guarded inside the
      // service) — that window's renderer transitions itself.
      const hibernation = getHibernationService();
      rendererViewsEvicted = policy
        ? hibernation.evictProjectRenderer(projectId, { protectMcpDispatch: true })
        : hibernation.evictProjectRenderer(projectId);
    } catch (evictError) {
      console.warn(`[ProjectSleep] renderer eviction failed:`, evictError);
    }

    let workspaceEvicted = false;
    try {
      // `evictProject` refuses while any window still holds the project
      // (refCount > 0), and a window showing it holds one — so release those
      // references first. Without this, sleeping the project on screen would
      // leave its workspace host resident.
      const workspaceClient = deps.workspaceClient;
      if (workspaceClient) {
        releaseWorkspaceRefsForProject(deps, workspaceClient, projectId, project.path);
        workspaceEvicted = workspaceClient.evictProject(project.path);
      }
    } catch (workspaceError) {
      console.warn(`[ProjectSleep] workspace eviction failed:`, workspaceError);
    }

    // Keep the project in the list as `closed` WITHOUT clearProjectState, so
    // its panel/terminal layout survives for a non-destructive reopen.
    if (policy?.autoParkedAt !== undefined) {
      projectStore.updateProjectStatus(projectId, "closed", { autoParkedAt: policy.autoParkedAt });
    } else {
      projectStore.updateProjectStatus(projectId, "closed");
    }

    // Sleep is a close as far as plugins are concerned, so it owes them the
    // same unload cascade `project:close` runs. Fire-and-forget and
    // self-logging, so it cannot fail this already-committed teardown; the
    // controller's next-switch sweep stays as defence in depth.
    notifyProjectPluginsClosed(projectId);

    // Read the pointer fresh rather than from a snapshot taken before the
    // awaits above: another window can switch projects while the kill is in
    // flight, and clearing on a stale read would wipe a DIFFERENT project's
    // pointer.
    if (projectId === projectStore.getCurrentProjectId()) {
      projectStore.clearCurrentProject();
    }

    // Each broadcast on its own: a window closing mid-send must not swallow
    // the other one.
    try {
      const updated = projectStore.getProjectById(projectId);
      if (updated) {
        broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
      }
    } catch (broadcastError) {
      console.warn(`[ProjectSleep] project update broadcast failed:`, broadcastError);
    }

    // Its OWN event, not an inference from the `closed` status above:
    // relocation, project adoption and idle auto-close reach `closed` too, and
    // a window blanking itself on those would be wrong. This is what tells a
    // window showing the project to drop to the no-project state — main
    // deliberately leaves its view alive. A user sleep only: a policy never
    // sleeps a project that is on screen, so all its event could reach is a
    // view that outlived the eviction — a remote Shell revealing its cached
    // view before the visibility report lands — and blank it.
    if (!policy) {
      try {
        broadcastToRenderer(CHANNELS.PROJECT_SLEPT, projectId);
      } catch (broadcastError) {
        console.warn(`[ProjectSleep] project slept broadcast failed:`, broadcastError);
      }
    }

    console.log(
      `[ProjectSleep] ${projectId} (${options.initiator}) — killed ${terminalsKilled} terminal(s), ` +
        `evicted ${rendererViewsEvicted} renderer view(s), workspace host ${
          workspaceEvicted ? "evicted" : "retained"
        }`
    );

    return {
      status: "slept",
      terminalsKilled,
      rendererViewsEvicted,
      workspaceEvicted,
      ...(pluginWorkStopped ? { pluginWorkStopped } : {}),
    };
  } catch (error) {
    console.error(`[ProjectSleep] Failed for ${projectId}:`, error);
    // Rethrow an AppError as-is so a guard rejection (the unconfirmed teardown
    // above) isn't relabelled.
    if (error instanceof AppError) throw error;
    throw new AppError({
      code: "INTERNAL",
      message: formatErrorMessage(error, "Failed to sleep project"),
      context: { projectId },
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/**
 * What this project's view in any window is still doing that destroying it
 * would end: an MCP dispatch waiting on it, or a dictation whose session or
 * post-stop cleanup writes into it (#15920). Eviction and freezing already
 * leave a dictation's view alone. A window list or a window that can't be
 * read counts as a dispatch that can't be ruled out: the only caller that
 * asks is a policy, and a policy can always try again next sweep.
 */
function viewRefusal(projectId: string, provider: ProjectViewManagersProvider): ViewRefusal | null {
  let managers;
  try {
    managers = provider();
  } catch (error) {
    logError("project-sleep-window-provider-failed", error, { projectId });
    return "mcp-dispatch";
  }
  for (const manager of managers) {
    try {
      if (manager.isMcpDispatchProtected(projectId)) return "mcp-dispatch";
      if (manager.isDictationHeld(projectId)) return "dictation";
    } catch {
      return "mcp-dispatch";
    }
  }
  return null;
}

/**
 * Drop every window's workspace-host reference to `projectId`, so the host can
 * actually be evicted.
 *
 * `WorkspaceHostPool.evictProject` refuses a host any window still holds, and
 * a window with the project on screen holds one. Sleep leaves that window's
 * view alive on purpose — destroying it would blank the window — so nothing
 * else releases the reference, and the host would survive a sleep of the only
 * project using it. Releasing is safe here: the view is about to render the
 * welcome screen, and a later reopen re-registers through `loadProject`.
 *
 * Per-window and best-effort: a disposing window can throw, and one failure
 * must not skip the rest.
 */
function releaseWorkspaceRefsForProject(
  deps: SleepProjectDependencies,
  workspaceClient: WorkspaceClient,
  projectId: string,
  projectPath: string
): void {
  let managers;
  try {
    managers = deps.projectViewManagers();
  } catch (error) {
    logError("project-sleep-window-provider-failed", error, { projectId });
    return;
  }

  for (const manager of managers) {
    try {
      // Only windows bound to this project. Both halves are load-bearing: the
      // view's active project narrows it to the right windows, and the
      // path-guarded release is what makes it SAFE — during a cold switch the
      // pool's window→project mapping can still name the outgoing project
      // while the view already reports the incoming one, and an unguarded
      // release would drop a different project's still-needed worktree feed.
      if (manager.getActiveProjectId() !== projectId) continue;
      if (manager.win.isDestroyed()) continue;
      workspaceClient.releaseWindowForProject(manager.win.id, projectPath);
    } catch (error) {
      logError("project-sleep-window-release-failed", error, { projectId });
    }
  }
}
