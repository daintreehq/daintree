import { execFile } from "node:child_process";
import { diffCodeNames } from "./voiceCodeNames.js";

// A branch's whole diff, read once per dictation; one past this is too big to
// say much about what the speaker is on right now.
const MAX_DIFF_BYTES = 2_000_000;

function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_DIFF_BYTES, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

/**
 * The code names a worktree's work in progress names (`diffCodeNames`): its
 * working tree against where it left the remote's default branch, committed
 * and uncommitted changes alike, or its uncommitted changes alone when there
 * is no such branch or that diff is too big. None on any failure.
 */
export async function readWorktreeDiffNames(cwd: string, timeoutMs = 800): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  try {
    const base = (
      await git(cwd, ["merge-base", "HEAD", "origin/HEAD"], left()).catch(() => "")
    ).trim();
    const diffArgs = (from: string) => ["diff", "-U0", "--no-color", "--no-ext-diff", from, "--"];
    const diff = await git(cwd, diffArgs(base || "HEAD"), left()).catch((error: unknown) => {
      if (!base) throw error;
      return git(cwd, diffArgs("HEAD"), left());
    });
    return diffCodeNames(diff);
  } catch {
    return [];
  }
}
