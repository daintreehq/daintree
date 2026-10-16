import type { CommandInput, CommandOptions, CommandRunner } from "./commandRunner.js";
import type { HostCommandChannel } from "./remoteShell.js";
import { streamToFileScript } from "./remoteShell.js";
import { WSL_ENV, withWslDiagnostics, wslExecArgs, wslExecutable } from "./wslCommand.js";

/**
 * Setup's way into a WSL distro: each script runs as `/bin/sh -c <script>`
 * through `wsl.exe --exec`, so it reaches sh as one argv element with no
 * quoting layer, and files go over stdin. Every command first asks for the
 * distro to be kept up: a probe, an install and the start that follows are
 * separate wsl.exe runs, and WSL stops a distro seconds after its last one
 * exits, taking a just-started Host with it.
 */
export function createWslCommandChannel(params: {
  distro: string;
  run: CommandRunner;
  /** Holds the distro up for as long as this Shell wants it (see WslKeepalive). */
  keepalive?: (distro: string) => void;
  wslPath?: string;
}): HostCommandChannel {
  const { distro, run } = params;
  const wsl = params.wslPath ?? wslExecutable();
  const exec = async (script: string, options?: CommandOptions, input?: CommandInput) => {
    params.keepalive?.(distro);
    const result = await run(wsl, wslExecArgs(distro, ["/bin/sh", "-c", script]), {
      ...options,
      ...(input && { input }),
      env: { ...options?.env, ...WSL_ENV },
    });
    return withWslDiagnostics(result);
  };
  return {
    exec: (script, options) => exec(script, options),
    execWithInput: (script, input, options) => exec(script, options, input),
    sendFile: (localPath, remotePath, options) =>
      exec(streamToFileScript(remotePath), options, { file: localPath }),
  };
}
