import type { AgentCliDetail } from "../types/ipc/system.js";
import { escapeShellArgOptional, isWindows, quotePowerShellArg } from "./shellEscape.js";

/**
 * `~` and `~/rest` with the host's home in place of the tilde. Quoting would
 * otherwise hand the host's shell a literal `~`, which it never expands. With
 * no home reported yet the tilde is left bare and only the rest is quoted, so
 * the host's shell still expands it.
 */
function escapeHomeRelativePosix(path: string, homeDir: string | null): string | null {
  if (path !== "~" && !path.startsWith("~/")) return null;
  const rest = path.slice(1);
  if (homeDir) return escapeShellArgOptional(homeDir.replace(/\/+$/, "") + rest, "posix");
  return rest.length > 1 ? `~/${escapeShellArgOptional(rest.slice(1), "posix")}` : "~";
}

/**
 * The executable an agent launch starts: the CLI's probed path when the probe
 * found a launchable one, otherwise the registry command, quoted for the shell
 * of the host the command runs on. A copy the user chose is started even when
 * the check couldn't confirm it, so the launch fails there instead of starting
 * whichever copy PATH reaches first.
 *
 * `dialect` names that shell; omitted, this process's platform stands in for
 * it. `homeDir` is the home a leading `~` stands for on the host; omitted, a
 * tilde is left for the host's shell to expand.
 */
export function resolveAgentLaunchBaseCommandFor(
  registryCommand: string,
  detail: AgentCliDetail | undefined,
  dialect: "posix" | "windows" | undefined,
  homeDir: string | null | undefined
): string {
  const resolvedPath =
    (detail &&
    detail.state !== "missing" &&
    detail.state !== "blocked" &&
    detail.state !== "installed"
      ? detail.resolvedPath?.trim()
      : undefined) ||
    detail?.chosenPath?.trim() ||
    undefined;

  const effective = resolvedPath ?? registryCommand;
  const isPathLike = effective.includes("/") || effective.includes("\\");
  if (!resolvedPath && !isPathLike) return registryCommand;

  const useWindows = dialect ? dialect === "windows" : isWindows();
  if (useWindows) {
    return `& ${quotePowerShellArg(effective)}`;
  }

  if (homeDir !== undefined) {
    const expanded = escapeHomeRelativePosix(effective, homeDir);
    if (expanded !== null) return expanded;
  }
  return escapeShellArgOptional(effective, "posix");
}

const WINDOWS_LAUNCH_EXTENSION = /\.(?:cmd|exe|bat|com|ps1)$/i;
const POWERSHELL_QUOTE = /['‘-‛]/;

/**
 * The executable a saved launch command starts and the rest of it, read back
 * from the forms {@link resolveAgentLaunchBaseCommandFor} writes: a bare word, a
 * POSIX word with `'…'` and `\x` parts, or PowerShell's `& '…'`. Null for
 * anything else, which is never guessed at.
 */
function splitLeadingExecutable(command: string): { executable: string; rest: string } | null {
  if (command.startsWith("& '")) {
    let executable = "";
    for (let i = 3; i < command.length; i++) {
      const char = command[i]!;
      if (!POWERSHELL_QUOTE.test(char)) {
        executable += char;
        continue;
      }
      if (command[i + 1] === char) {
        executable += char;
        i++;
        continue;
      }
      const rest = command.slice(i + 1);
      return rest === "" || /^\s/.test(rest) ? { executable, rest } : null;
    }
    return null;
  }

  let executable = "";
  let i = 0;
  while (i < command.length && !/\s/.test(command[i]!)) {
    const char = command[i]!;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      executable += command.slice(i + 1, end);
      i = end + 1;
    } else if (char === "\\") {
      if (i + 1 >= command.length) return null;
      executable += command[i + 1];
      i += 2;
    } else if (char === '"') {
      return null;
    } else {
      executable += char;
      i++;
    }
  }
  return executable ? { executable, rest: command.slice(i) } : null;
}

/** Whether `executable` is a copy of the agent whose registry command is `registryCommand`. */
function namesAgentExecutable(executable: string, registryCommand: string): boolean {
  if (executable === registryCommand) return true;
  // An absolute plugin command names its one file.
  if (/[\\/]/.test(registryCommand)) return false;
  const name = executable.split(/[\\/]/).pop() ?? "";
  if (name === registryCommand) return true;
  return (
    WINDOWS_LAUNCH_EXTENSION.test(name) &&
    name.replace(WINDOWS_LAUNCH_EXTENSION, "").toLowerCase() === registryCommand.toLowerCase()
  );
}

/**
 * A saved launch command started again with `base`, the executable a launch of
 * its agent starts now, keeping everything after the executable verbatim. A
 * command that doesn't start with a copy of this agent is returned unchanged,
 * so a wrapper or anything Daintree didn't write is never rewritten.
 */
export function rebaseAgentLaunchCommand(
  command: string,
  registryCommand: string,
  base: string
): string {
  const split = splitLeadingExecutable(command);
  if (!split || !namesAgentExecutable(split.executable, registryCommand)) return command;
  return base + split.rest;
}
