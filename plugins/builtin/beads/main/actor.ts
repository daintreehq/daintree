import { execFile } from "node:child_process";
import { userInfo } from "node:os";

const GIT_TIMEOUT_MS = 5_000;

async function gitUserName(): Promise<string | null> {
  let git: string;
  try {
    // On Windows a bare name would search the working directory first.
    const { resolveExecutableForSpawn } =
      await import("../../../../electron/utils/windowsExecutable.js");
    git = await resolveExecutableForSpawn("git");
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    execFile(
      git,
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

let cached: string | null = null;
/** Bumps on clear, so a git lookup started before can't refill the cache. */
let cacheGeneration = 0;

/**
 * Who Daintree acts as on a Beads server. A `bd serve` token carries no
 * identity, so the actor is the one `bd` itself would record on this machine:
 * `BEADS_ACTOR`, then git's `user.name`, then the OS user. The host's "me"
 * takes no project, so git's global name is read, not a repository's own.
 * Only a name from the environment or git is kept; the OS-user fallback is
 * asked again next time, so a git that wasn't ready yet still gets its turn.
 */
export async function resolveActor(): Promise<string> {
  const fromEnv = process.env.BEADS_ACTOR?.trim() || process.env.BD_ACTOR?.trim();
  if (fromEnv) return fromEnv;
  if (cached) return cached;
  const started = cacheGeneration;
  const fromGit = await gitUserName();
  if (fromGit) {
    if (started === cacheGeneration) cached = fromGit;
    return fromGit;
  }
  return osUserName() ?? "daintree";
}

export function clearActorCache(): void {
  cached = null;
  cacheGeneration++;
}
