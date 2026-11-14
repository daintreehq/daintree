import type {
  CommandInput,
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "./commandRunner.js";
import { buildExitArgs, noteSshMaster, shellQuote, sshCommonArgs } from "./sshTransport.js";
import { sshExecutable } from "./sshExecutable.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

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
  return [...sshCommonArgs(controlPath), "--", target, `sh -c ${shellQuote(script)}`];
}

/**
 * `-S` so a copy runs the same ssh as everything else (`DAINTREE_SSH`), not
 * scp's built-in one, with the same options: a copy may start the host's
 * master when the probe's has gone, and a master it starts must not carry the
 * user's agent, X11 or configured forwards any more than one ssh starts.
 */
export function scpArgs(
  target: string,
  controlPath: string,
  localPath: string,
  remotePath: string,
  sshPath: string
): string[] {
  return [
    "-q",
    "-S",
    sshPath,
    ...sshCommonArgs(controlPath),
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
  const ssh = params.sshPath ?? sshExecutable();
  // Any command here may start the host's master; it goes when the app quits.
  const noteMaster = () =>
    noteSshMaster(target, controlPath, async (timeoutMs) => {
      await run(ssh, buildExitArgs(target, controlPath), { timeoutMs });
    });
  const exec = (script: string, options?: CommandOptions) => {
    noteMaster();
    return run(ssh, remoteShellArgs(target, controlPath, script), options);
  };
  const execWithInput = (script: string, input: CommandInput, options?: CommandOptions) => {
    noteMaster();
    return run(ssh, remoteShellArgs(target, controlPath, script), { ...options, input });
  };
  return {
    exec,
    execWithInput,
    async sendFile(localPath, remotePath, options) {
      const copied = await run(
        params.scpPath ?? "scp",
        scpArgs(target, controlPath, localPath, remotePath, ssh),
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

/**
 * A channel to a cloud machine: its ssh route is resolved before each command
 * (the machine's address and key can change with every start), then the
 * command runs over the ssh channel that route names. A machine that can't
 * be reached (stopped, not created, provider unreachable) answers the command
 * as ssh would, with the reason on stderr, so probe and setup report it as
 * they report any host ssh couldn't reach.
 */
export function createCloudCommandChannel(params: {
  resolve: (signal?: AbortSignal) => Promise<{ target: string; sshPath: string }>;
  controlPathFor: (target: string) => string;
  run: CommandRunner;
}): HostCommandChannel {
  const channel = async (options?: CommandOptions): Promise<HostCommandChannel | CommandResult> => {
    try {
      const route = await params.resolve(options?.signal);
      return createSshCommandChannel({
        target: route.target,
        controlPath: params.controlPathFor(route.target),
        run: params.run,
        sshPath: route.sshPath,
      });
    } catch (error) {
      const detail =
        (error as { detail?: unknown })?.detail ??
        formatErrorMessage(error, "The cloud machine couldn't be reached");
      return {
        code: 255,
        stdout: "",
        stderr:
          typeof detail === "string" && detail ? detail : "The cloud machine couldn't be reached",
        spawnError: null,
        timedOut: false,
      };
    }
  };
  const isResult = (value: HostCommandChannel | CommandResult): value is CommandResult =>
    "code" in value;
  return {
    async exec(script, options) {
      const ready = await channel(options);
      return isResult(ready) ? ready : ready.exec(script, options);
    },
    async execWithInput(script, input, options) {
      const ready = await channel(options);
      return isResult(ready) ? ready : ready.execWithInput(script, input, options);
    },
    async sendFile(localPath, remotePath, options) {
      const ready = await channel(options);
      return isResult(ready) ? ready : ready.sendFile(localPath, remotePath, options);
    },
  };
}
