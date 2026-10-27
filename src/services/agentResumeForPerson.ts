import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { resolveResumeLaunchTarget } from "@/utils/resumeLaunch";
import { resumeSessionIntoPanel, type ResumeSessionOutcome } from "./agentResume";

/** The session's recorded worktree is not among this view's: there is nowhere to resume it. */
export class ResumeWorktreeGoneError extends Error {
  constructor() {
    super("That session's worktree has been removed.");
    this.name = "ResumeWorktreeGoneError";
  }
}

/**
 * Resume a closed session for a person: the policy every human resume surface
 * shares, the Resume Sessions palette and Canopy's Trash alike.
 *
 *  1. **Its own directory** — the CLI locates a conversation from the launch
 *     cwd (#4781), so the target comes from the session's recorded
 *     cwd/worktree via {@link resolveResumeLaunchTarget}, not whatever
 *     worktree is active. A recorded worktree this view no longer has is
 *     refused, never spawned into.
 *  2. **In the grid** — `addPanel` backgrounds a grid panel whose worktree
 *     differs from the active one, so the session's worktree is selected
 *     before spawning. An agent-dispatched resume deliberately does not move
 *     the view; this one does.
 *  3. **Once** — {@link resumeSessionIntoPanel} focuses a pane already running
 *     the session, and overlapping resumes share one launch.
 *
 * `worktrees` is this view's worktree list, id to path. Throws when it can't
 * resume; reporting that is the caller's.
 */
export async function resumeSessionForPerson(
  session: AgentSessionRecord,
  worktrees: ReadonlyMap<string, string>
): Promise<ResumeSessionOutcome> {
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  const currentProject = useProjectStore.getState().currentProject;
  const activePath = activeWorktreeId ? worktrees.get(activeWorktreeId) : undefined;
  const defaultTerminalCwd = activePath ?? currentProject?.path ?? "";

  // Live worktree paths let a null-worktree record re-home by cwd, keeping the
  // launch target consistent with the group the row was shown under.
  const target = resolveResumeLaunchTarget(
    session,
    { defaultTerminalCwd, activeWorktreeId },
    [...worktrees].map(([id, path]) => ({ id, path }))
  );
  if (target.worktreeId && !worktrees.has(target.worktreeId)) {
    throw new ResumeWorktreeGoneError();
  }

  const revealTargetWorktree = () => {
    const current = useWorktreeSelectionStore.getState();
    if (target.worktreeId && target.worktreeId !== current.activeWorktreeId) {
      current.selectWorktree(target.worktreeId, { source: "user" });
    }
  };

  // Switch BEFORE spawning so the resumed grid panel isn't backgrounded; this
  // callback only runs on the spawning path.
  const resumed = await resumeSessionIntoPanel(session, target, {
    onBeforeSpawn: revealTargetWorktree,
  });
  // Again after the fact, because `onBeforeSpawn` is the STARTER's callback: a
  // person joining a resume an agent already started never reaches it, and
  // would otherwise be left with the pane in another worktree. Selecting the
  // worktree already active is a no-op.
  revealTargetWorktree();
  return resumed;
}
