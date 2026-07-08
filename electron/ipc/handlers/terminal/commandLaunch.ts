/**
 * Build the shell + args that run an agent launch command as shell startup
 * work instead of typing it into the PTY. Keeping the command out of the
 * input stream prevents the raw command from echoing across the buffer
 * before the agent starts, and (on POSIX) lets the launched CLI own the
 * PTY foreground process group so Ctrl-C reaches the agent.
 *
 * The function is pure: given a command string and the configured shell, it
 * returns the spawn options or `null` to signal "fall back to writing the
 * command into the PTY." `null` is returned when:
 *   - the command is empty, or
 *   - the shell isn't one we know how to launch through (e.g. fish on Linux,
 *     an unrecognized Windows shell).
 *
 * Trust boundary: `command` is interpolated raw into the shell payload. Shell
 * metacharacters (pipes, redirects, `$(...)`) are intentional — QuickRun and
 * resource-connect commands rely on them. Defenses upstream:
 *   (1) TerminalSpawnOptionsSchema rejects control characters at the IPC
 *       boundary.
 *   (2) The multiline guard in the spawn handler drops embedded `\n` / `\r`
 *       as defense-in-depth.
 *   (3) `WorktreeLifecycleService.substituteVariables` shell-quotes every
 *       templated fragment via `shellEscapeValue` before it reaches the
 *       `command` field.
 * Any new call site that interpolates user-controlled data into `command`
 * MUST quote the substituted fragment via `quoteCommandArg`, not rely on
 * this layer.
 */

import { getDefaultShell } from "../../../services/pty/terminalShell.js";
import { isCmdShell, isPowerShellShell } from "../../../../shared/utils/shellEscape.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function supportsPosixCommandLaunchShell(shell: string): boolean {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return (
    name === "zsh" ||
    name === "bash" ||
    name === "sh" ||
    name.endsWith("zsh") ||
    name.endsWith("bash") ||
    name.endsWith("sh")
  );
}

/**
 * Encode a PowerShell script as a `-EncodedCommand` payload: UTF-16LE bytes,
 * Base64-encoded. This sidesteps all quote-nesting through node-pty and
 * CreateProcess, which is fragile for paths with embedded quotes or
 * Windows-style backslash escaping. Works identically on pwsh (7+) and
 * powershell.exe (5.1).
 */
function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function buildCommandLaunchShell(
  command: string,
  configuredShell: string | undefined
): { shell: string; args: string[] } | null {
  if (command.length === 0) {
    return null;
  }

  const shell = configuredShell || getDefaultShell();

  if (process.platform === "win32") {
    if (isPowerShellShell(shell)) {
      // -NoExit keeps the shell interactive after the command finishes so the
      // user can keep working in the same pane. -EncodedCommand takes a
      // UTF-16LE-Base64 payload, completely bypassing PowerShell's argument
      // parser and CommandLineToArgvW — quoting inside `command` (paths with
      // spaces, embedded quotes) survives intact. -NoLogo matches the
      // banner-free spawn behaviour we use elsewhere.
      return {
        shell,
        args: ["-NoLogo", "-NoExit", "-EncodedCommand", encodePowerShellCommand(command)],
      };
    }
    if (isCmdShell(shell)) {
      // cmd /K runs <command> and then returns to an interactive prompt.
      // node-pty's Windows agent joins the args array into a command-line
      // string for CreateProcess, and cmd.exe then parses everything after
      // `/K` — `%VAR%` expansion and `^` escape sequences apply. Upstream
      // is responsible for embedding only cmd-safe values via
      // `quoteCommandArg` (double-quote escaping); we do not re-quote here.
      return { shell, args: ["/K", command] };
    }
    return null;
  }

  if (!supportsPosixCommandLaunchShell(shell)) {
    return null;
  }

  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const execInteractiveShell =
    name.includes("zsh") || name.includes("bash")
      ? `exec ${shellQuote(shell)} -l`
      : `exec ${shellQuote(shell)}`;

  // Run the command as interactive shell startup work instead of typing it into
  // the PTY. This prevents the tail of long absolute launch commands from being
  // echoed while preserving job control: zsh/bash only move the launched CLI
  // into the PTY foreground process group when the shell is interactive. The
  // foreground-pgid detector relies on that, and agent CLIs rely on it for raw
  // input. The wrapper shell traps SIGINT so Ctrl-C reaches the foreground
  // agent without killing the wrapper before it can exec the follow-up shell.
  // Use a no-op trap rather than SIG_IGN so child CLIs don't inherit ignored
  // SIGINT.
  const script = `trap : INT\n${command}\ntrap - INT\n${execInteractiveShell}`;
  // The historical macOS `sleep 0.05` deferral wrapper (added when early
  // shell/agent bytes could race the PTY data listeners) is gone: fresh
  // spawns attach a BufferedPtyDataHandoff synchronously with pty.spawn and
  // the renderer registers its data callback at prewarm, before the spawn
  // IPC is even sent — no consumer attaches late any more, and the wrapper
  // taxed every agent launch 50ms plus an extra shell exec.
  const args =
    name.includes("zsh") || name.includes("bash") ? ["-lic", script] : ["-i", "-c", script];

  return { shell, args };
}
