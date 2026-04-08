import path from "path";
import { simpleGit } from "simple-git";
import type { SimpleGit, SimpleGitProgressEvent } from "simple-git";

const SAFE_GIT_CONFIG = [
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  "protocol.ext.allow=never",
  "core.gitProxy=",
  "core.hooksPath=",
] as const;

/**
 * Git config overrides that neutralize dangerous .git/config directives.
 * Passed as -c flags to every git command, taking precedence over repo config.
 */
export const HARDENED_GIT_CONFIG = [
  ...SAFE_GIT_CONFIG,
  "core.askpass=",
  "credential.helper=",
  "core.sshCommand=",
] as const;

export const AUTHENTICATED_GIT_CONFIG = [...SAFE_GIT_CONFIG] as const;

const UNSAFE_FLAGS = {
  allowUnsafeProtocolOverride: true,
  allowUnsafeSshCommand: true,
  allowUnsafeGitProxy: true,
  allowUnsafeHooksPath: true,
} as const;

export function validateCwd(cwd: unknown): asserts cwd is string {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Invalid working directory");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("Working directory must be an absolute path");
  }
}

export const GIT_BLOCK_TIMEOUT_MS = 30_000;

export function createHardenedGit(cwd: string, signal?: AbortSignal): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    config: [...HARDENED_GIT_CONFIG],
    timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    ...(signal ? { abort: signal } : {}),
    unsafe: UNSAFE_FLAGS,
  });
}

export interface AuthenticatedGitOptions {
  signal?: AbortSignal;
  progress?: (data: SimpleGitProgressEvent) => void;
  extraConfig?: string[];
}

export function createAuthenticatedGit(cwd: string, opts: AuthenticatedGitOptions = {}): SimpleGit {
  const { signal, progress, extraConfig } = opts;
  return simpleGit({
    baseDir: cwd,
    config: [...AUTHENTICATED_GIT_CONFIG, ...(extraConfig ?? [])],
    timeout: { block: 0 },
    ...(signal ? { abort: signal } : {}),
    ...(progress ? { progress } : {}),
    unsafe: UNSAFE_FLAGS,
  }).env({
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh",
  });
}
