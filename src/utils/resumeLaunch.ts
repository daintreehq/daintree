import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

/**
 * Resolve the directory + worktree a resume should launch in.
 *
 * Session resume is directory-coupled — `claude --resume`/Gemini fail if the
 * cwd doesn't match the original session's project path (#4781) — so once the
 * resume list is browsable across worktrees (#10851), the launch MUST use the
 * session's own recorded cwd/worktree, not whatever worktree happens to be
 * active in the UI. Records that predate these fields fall back to the
 * active-worktree defaults so older history still resumes as before.
 */
export function resolveResumeLaunchTarget(
  session: Pick<AgentSessionRecord, "cwd" | "worktreeId">,
  fallback: { defaultTerminalCwd: string; activeWorktreeId: string | null | undefined }
): { cwd: string; worktreeId: string | undefined } {
  return {
    cwd: session.cwd ?? fallback.defaultTerminalCwd,
    worktreeId: session.worktreeId ?? fallback.activeWorktreeId ?? undefined,
  };
}
