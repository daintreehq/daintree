/** The one git capability this needs; a simple-git client satisfies it. */
export interface RawGitRunner {
  raw(args: string[]): Promise<string>;
}

/** Upper bound on one `ls-remote` read of a branch tip. */
export const REMOTE_BRANCH_TIP_TIMEOUT_MS = 4000;

/**
 * The branch's tip according to the REMOTE itself, or `undefined` when the
 * remote could not be asked.
 *
 * `null` is a real answer — the remote replied and has no such branch.
 * `undefined` is "no answer" (unreachable, timed out, unparseable), which a
 * caller must treat as unverified rather than as absence.
 *
 * Bounded and swallowed on purpose: callers run this while a dialog waits, so
 * a slow or unreachable remote must degrade precision, never hold it open.
 */
export async function readRemoteBranchTip(
  git: RawGitRunner,
  remote: string,
  branch: string,
  timeoutMs: number = REMOTE_BRANCH_TIP_TIMEOUT_MS
): Promise<string | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      // `--` before the remote so a remote whose name survived the argv guard
      // still cannot be read as an option, and the ref given in full.
      git.raw(["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ls-remote timed out")), timeoutMs);
      }),
    ]);
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!line) return null;
    const sha = line.split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
