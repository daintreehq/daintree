import { runGitForBytes } from "./runGit.js";
import type { ReviewPoint } from "../../../../shared/types/reviewPoint.js";
import type { ReviewMarkMismatch } from "../../../../shared/types/ipc/reviewMarks.js";

/**
 * Which worktree, repository and branch a path is right now, read the way a
 * review point records them, so a point can be checked against the worktree it
 * would be stored for (#14584). Two read-only git commands; nothing is
 * captured again.
 */
export interface WorktreeIdentity {
  worktreePath: string;
  gitDir: string;
  commonDir: string;
  /** The full ref HEAD points at, or null when HEAD is detached. */
  headRef: string | null;
}

const IDENTITY_OUTPUT_BYTES = 64 * 1024;

export async function readWorktreeIdentity(
  cwd: string,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<WorktreeIdentity> {
  const run = (args: string[], okExitCodes?: number[]) =>
    runGitForBytes(cwd, args, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxStdoutBytes: IDENTITY_OUTPUT_BYTES,
      okExitCodes,
    });
  const [located, head] = await Promise.all([
    run([
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ]),
    // Exit 1 with no output is a detached HEAD; an unborn branch still names its ref.
    run(["symbolic-ref", "-q", "HEAD"], [1]),
  ]);
  const lines = located.stdout.toString("utf8").split("\n");
  if (lines.length !== 4 || lines[3] !== "") throw new Error("Unexpected rev-parse output");
  const [worktreePath, gitDir, commonDir] = lines as [string, string, string];
  const headRef = head.exitCode === 0 ? head.stdout.toString("utf8").replace(/\n$/, "") : null;
  return { worktreePath, gitDir, commonDir, headRef };
}

/**
 * What a review point names that the worktree doesn't match, or null when it
 * is this worktree, in this repository, on the branch it was captured on.
 */
export function reviewPointMismatch(
  point: Pick<ReviewPoint, "worktreePath" | "gitDir" | "commonDir" | "head">,
  identity: WorktreeIdentity
): ReviewMarkMismatch | null {
  if (point.commonDir !== identity.commonDir) return "repository";
  if (point.worktreePath !== identity.worktreePath || point.gitDir !== identity.gitDir) {
    return "worktree";
  }
  const wanted = point.head.kind === "detached" ? null : `refs/heads/${point.head.branch}`;
  return wanted === identity.headRef ? null : "branch";
}
