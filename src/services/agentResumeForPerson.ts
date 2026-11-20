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
 *  1. **Once** — {@link resumeSessionIntoPanel} brings forward a pane already
 *     running the session, whatever worktree it is filed under (#18009), and
 *     overlapping resumes share one launch. That pane's worktree is selected,
 *     not the record's: a live move can have refiled it since.
 *  2. **Its own directory** — the CLI locates a conversation from the launch
 *     cwd (#4781), so a new launch's target comes from the session's recorded
 *     cwd/worktree via {@link resolveResumeLaunchTarget}, not whatever
 *     worktree is active. A recorded worktree this view no longer has is
 *     refused, never spawned into.
 *  3. **In the grid** — `addPanel` backgrounds a grid panel whose worktree
 *     differs from the active one, so the session's worktree is selected
 *     before spawning. An agent-dispatched resume deliberately does not move
 *     the view; this one does.
 *
 * `worktrees` is this view's worktree list, id to path, or null where the
 * view has none to offer (a scratch, a project with no worktrees, one whose
 * list hasn't come): the record's own place is then trusted, and the caller
 * must already know it is there. Throws when it can't resume; reporting that
 * is the caller's.
 */
export async function resumeSessionForPerson(
  session: AgentSessionRecord,
  worktrees: ReadonlyMap<string, string> | null
): Promise<ResumeSessionOutcome> {
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  const currentProject = useProjectStore.getState().currentProject;
  const activePath = activeWorktreeId ? worktrees?.get(activeWorktreeId) : undefined;
  const defaultTerminalCwd = activePath ?? currentProject?.path ?? "";

  // Live worktree paths let a null-worktree record re-home by cwd, keeping the
  // launch target consistent with the group the row was shown under.
  const target = resolveResumeLaunchTarget(
    session,
    { defaultTerminalCwd, activeWorktreeId },
    worktrees ? [...worktrees].map(([id, path]) => ({ id, path })) : undefined
  );
  // Only a new launch needs the recorded worktree: a pane already running the
  // session answers wherever it is filed.
  const recordedWorktreeGone =
    worktrees !== null && target.worktreeId !== undefined && !worktrees.has(target.worktreeId);

  const showWorktree = (worktreeId: string | undefined) => {
    const current = useWorktreeSelectionStore.getState();
    if (worktreeId && worktreeId !== current.activeWorktreeId) {
      current.selectWorktree(worktreeId, { source: "user" });
    }
  };

  // Switch BEFORE spawning so the resumed grid panel isn't backgrounded; this
  // callback only runs on the spawning path.
  const selectedAtStart = activeWorktreeId;
  const resumed = await resumeSessionIntoPanel(session, target, {
    validateSpawn: () => {
      if (recordedWorktreeGone) throw new ResumeWorktreeGoneError();
    },
    onBeforeSpawn: () => showWorktree(target.worktreeId),
    showWorktree,
  });
  // Again after the fact, because the callbacks are the STARTER's: a person
  // joining a resume an agent already started never reaches them, and would
  // otherwise be left with the pane in another worktree. A selection moved
  // elsewhere meanwhile is a newer choice, and stands.
  const selectedNow = useWorktreeSelectionStore.getState().activeWorktreeId;
  const paneWorktreeId = resumed.worktreeId ?? undefined;
  if (selectedNow === selectedAtStart || selectedNow === paneWorktreeId) {
    showWorktree(paneWorktreeId);
  }
  return resumed;
}
