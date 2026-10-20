/**
 * The only inherited `GIT_*` variables that reach git; every other one is
 * dropped. simple-git refuses an instance whose env carries a `GIT_*` key it
 * was not told to allow, and the rest either redirect git (GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE), reconfigure it (GIT_CONFIG_PARAMETERS,
 * GIT_CONFIG_COUNT, GIT_EXEC_PATH), or contradict the profile — git hard-fails
 * when GIT_GLOB_PATHSPECS or GIT_ICASE_PATHSPECS meets our
 * GIT_LITERAL_PATHSPECS. These label commits, choose the TLS trust and client
 * certificate, keep git-lfs from transferring objects, or narrow where git
 * looks for config and repositories — none names a program for git to run.
 * GIT_ALLOW_PROTOCOL stays out deliberately: it would override
 * `protocol.ext.allow=never`.
 */
export const INHERITED_GIT_ENV_PASSTHROUGH = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_CERT",
  "GIT_SSL_KEY",
  "GIT_LFS_SKIP_SMUDGE",
  "GIT_LFS_SKIP_PUSH",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CEILING_DIRECTORIES",
] as const;

const INHERITED_GIT_ENV_PASSTHROUGH_SET: ReadonlySet<string> = new Set(
  INHERITED_GIT_ENV_PASSTHROUGH
);

/** Non-`GIT_` variables git reads as a program to run. */
const BLOCKED_INHERITED_ENV_KEYS = new Set(["EDITOR", "PAGER", "PREFIX", "SSH_ASKPASS", "VISUAL"]);

/**
 * The process env without any inherited `GIT_*` outside the passthrough list or
 * any of the blocked program variables. Every hardened git profile and the raw
 * rev-parse probes in gitUtils spawn with it, so they resolve one repository.
 */
export function getSanitizedProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.trim().toUpperCase();
    const blocked = normalizedKey.startsWith("GIT_")
      ? !INHERITED_GIT_ENV_PASSTHROUGH_SET.has(normalizedKey)
      : BLOCKED_INHERITED_ENV_KEYS.has(normalizedKey);
    if (blocked) delete env[key];
  }
  return env;
}
