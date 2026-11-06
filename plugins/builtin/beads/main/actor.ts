import { execFile } from "node:child_process";
import { userInfo } from "node:os";

const GIT_TIMEOUT_MS = 5_000;

function gitUserName(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["config", "--global", "user.name"],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null)
    );
  });
}

function osUserName(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}

let cached: Promise<string> | null = null;

/**
 * Who Daintree acts as on a Beads server. A `bd serve` token carries no
 * identity, so the actor is the one `bd` itself would record on this machine:
 * `BEADS_ACTOR`, then git's `user.name`, then the OS user. The host's "me"
 * takes no project, so git's global name is read, not a repository's own.
 */
export function resolveActor(): Promise<string> {
  cached ??= (async () => {
    const fromEnv = process.env.BEADS_ACTOR?.trim() || process.env.BD_ACTOR?.trim();
    if (fromEnv) return fromEnv;
    return (await gitUserName()) ?? osUserName() ?? "daintree";
  })();
  return cached;
}

export function clearActorCache(): void {
  cached = null;
}
