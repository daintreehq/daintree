import path from "node:path";

/** Names an ssh binary to run instead of the `ssh` found on PATH. */
export const SSH_EXECUTABLE_ENV = "DAINTREE_SSH";

/**
 * The ssh every Remote Hosts call runs: `ssh` from PATH, or the absolute path
 * in `DAINTREE_SSH`. PATH alone can't choose it, because startup replaces
 * PATH with the login shell's, where macOS's path_helper puts /usr/bin first.
 * A relative or empty value is ignored rather than resolved against the cwd.
 */
export function sshExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SSH_EXECUTABLE_ENV]?.trim();
  return configured && path.isAbsolute(configured) ? configured : "ssh";
}
