import path from "path";
import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";

/**
 * Git config overrides that neutralize dangerous .git/config directives.
 * Passed as -c flags to every git command, taking precedence over repo config.
 */
export const HARDENED_GIT_CONFIG = [
  "core.fsmonitor=false",
  "core.pager=cat",
  "core.askpass=",
  "credential.helper=",
  "protocol.ext.allow=never",
  "core.sshCommand=",
  "core.gitProxy=",
  "core.hooksPath=",
  "diff.external=",
] as const;

export function validateCwd(cwd: unknown): asserts cwd is string {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("Working directory must be an absolute path");
  }
}

export const GIT_BLOCK_TIMEOUT_MS = 30_000;

export function createHardenedGit(cwd: string): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    config: [...HARDENED_GIT_CONFIG],
    timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    unsafe: {
      allowUnsafeProtocolOverride: true,
      allowUnsafeSshCommand: true,
      allowUnsafeGitProxy: true,
      allowUnsafeHooksPath: true,
      allowUnsafeDiffExternal: true,
    },
  });
}
