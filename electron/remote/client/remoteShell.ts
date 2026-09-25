import type { CommandOptions, CommandResult, CommandRunner } from "./commandRunner.js";
import { shellQuote, sshCommonArgs } from "./sshTransport.js";

/**
 * One-off commands on a host over the same ControlMaster the link uses, so a
 * probe, an install and the connection that follows share one SSH login.
 * Scripts run under `sh -c`, whatever the user's login shell is, and are kept
 * to one line so csh-family shells accept the quoted argument.
 */

export interface RemoteShell {
  exec(script: string, options?: CommandOptions): Promise<CommandResult>;
  /** Copy a local file to an absolute path on the host. */
  upload(localPath: string, remotePath: string, options?: CommandOptions): Promise<CommandResult>;
}

export function remoteShellArgs(target: string, controlPath: string, script: string): string[] {
  if (script.includes("\n")) throw new Error("Remote scripts must be a single line");
  return [
    ...sshCommonArgs(controlPath),
    "-o",
    "ConnectTimeout=10",
    "--",
    target,
    `sh -c ${shellQuote(script)}`,
  ];
}

export function scpArgs(
  target: string,
  controlPath: string,
  localPath: string,
  remotePath: string
): string[] {
  return [
    "-q",
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath}`,
    "--",
    localPath,
    `${target}:${remotePath}`,
  ];
}

export function createRemoteShell(params: {
  target: string;
  controlPath: string;
  run: CommandRunner;
  sshPath?: string;
  scpPath?: string;
}): RemoteShell {
  const { target, controlPath, run } = params;
  return {
    exec: (script, options) =>
      run(params.sshPath ?? "ssh", remoteShellArgs(target, controlPath, script), options),
    upload: (localPath, remotePath, options) =>
      run(params.scpPath ?? "scp", scpArgs(target, controlPath, localPath, remotePath), options),
  };
}

/** ssh's own words when a command failed, else a generic line. Never the command's stdout. */
export function failureDetail(result: CommandResult, fallback: string): string {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return `${fallback} (timed out)`;
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr.split("\n").slice(-3).join("\n") : fallback;
}
