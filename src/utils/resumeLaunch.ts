import { inferWorktreeIdFromCwd } from "@/utils/worktreePaths";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

/**
 * Resolve the directory + worktree a resume should launch in.
 *
 * Session resume is directory-coupled — `claude --resume`/Gemini fail if the
 * cwd doesn't match the original session's project path (#4781) — so once the
 * resume list is browsable across worktrees (#10851), the launch MUST use the
 * session's own recorded cwd/worktree, not whatever worktree happens to be
 * active in the UI.
 *
 * Records journaled without a worktreeId are re-homed by cwd against the live
 * worktree list — matching the resume list's grouping, so a session displayed
 * under a worktree actually launches into it instead of silently attaching to
 * the active one. Records that predate cwd/worktree fields fall back to the
 * active-worktree defaults so older history still resumes as before.
 */
export function resolveResumeLaunchTarget(
  session: Pick<AgentSessionRecord, "cwd" | "worktreeId">,
  fallback: { defaultTerminalCwd: string; activeWorktreeId: string | null | undefined },
  worktrees?: ReadonlyArray<{ id: string; path: string }>
): { cwd: string; worktreeId: string | undefined } {
  return {
    cwd: session.cwd ?? fallback.defaultTerminalCwd,
    worktreeId:
      session.worktreeId ??
      inferWorktreeIdFromCwd(session.cwd, worktrees) ??
      fallback.activeWorktreeId ??
      undefined,
  };
}
