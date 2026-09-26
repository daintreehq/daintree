import type {
  CommandInput,
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "./commandRunner.js";
import { shellQuote, sshCommonArgs } from "./sshTransport.js";

/**
 * How setup reaches a host's shell: run one line of `sh`, feed a script its
 * stdin, and put a local file at a path there. Probe, install and the Host
 * mode bootstrap speak only this, so another way into a machine can stand in
 * for ssh without touching them. SSH is the only one today.
 */
export interface HostCommandChannel {
  /** Run one line of `sh` on the host. */
  exec(script: string, options?: CommandOptions): Promise<CommandResult>;
  /** Run one line of `sh` with its stdin fed from local text or a local file. */
  execWithInput(
    script: string,
    input: CommandInput,
    options?: CommandOptions
  ): Promise<CommandResult>;
  /** Copy a local file to an absolute path on the host. */
  sendFile(localPath: string, remotePath: string, options?: CommandOptions): Promise<CommandResult>;
}

/**
 * One-off commands on a host over the same ControlMaster the link uses, so a
 * probe, an install and the connection that follows share one SSH login.
 * Scripts run under `sh -c`, whatever the user's login shell is, and are kept
 * to one line so csh-family shells accept the quoted argument.
 */
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

function sq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Writes stdin to `remotePath`: the copy used when scp can't (no sftp subsystem, scp disabled). */
export function streamToFileScript(remotePath: string): string {
  return `umask 077; cat > ${sq(remotePath)}`;
}

export function createSshCommandChannel(params: {
  target: string;
  controlPath: string;
  run: CommandRunner;
  sshPath?: string;
  scpPath?: string;
}): HostCommandChannel {
  const { target, controlPath, run } = params;
  const ssh = params.sshPath ?? "ssh";
  const exec = (script: string, options?: CommandOptions) =>
    run(ssh, remoteShellArgs(target, controlPath, script), options);
  const execWithInput = (script: string, input: CommandInput, options?: CommandOptions) =>
    run(ssh, remoteShellArgs(target, controlPath, script), { ...options, input });
  return {
    exec,
    execWithInput,
    async sendFile(localPath, remotePath, options) {
      const copied = await run(
        params.scpPath ?? "scp",
        scpArgs(target, controlPath, localPath, remotePath),
        options
      );
      // A host without an sftp subsystem refuses modern scp; the same ssh
      // login can still take the bytes on stdin. A stop or deadline is final.
      if (copied.code === 0 || copied.timedOut || options?.signal?.aborted) return copied;
      return execWithInput(streamToFileScript(remotePath), { file: localPath }, options);
    },
  };
}

/** ssh's own words when a command failed, else a generic line. Never the command's stdout. */
export function failureDetail(result: CommandResult, fallback: string): string {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return `${fallback} (timed out)`;
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr.split("\n").slice(-3).join("\n") : fallback;
}
