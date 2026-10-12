import { WINDOWS_PS_UTF8_BOOTSTRAP } from "../services/pty/terminalShell.js";
import { quotePowerShellArg } from "../../shared/utils/shellEscape.js";
import {
  cliSpawnTarget,
  type CliSpawnTarget,
  type WindowsCliResolveOptions,
} from "./windowsCliSpawn.js";

/** Decode generated argv literals without evaluating any PowerShell source. */
export function parseWindowsAgentCommand(command: string): string[] {
  let source = command.trim();
  if (source.startsWith("& ")) source = source.slice(2).trimStart();
  const words: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    while (/\s/.test(source[offset] ?? "") && offset < source.length) offset++;
    if (offset === source.length) break;
    let word = "";
    const quote = source[offset];
    if (quote === "'" || quote === '"') {
      offset++;
      let closed = false;
      while (offset < source.length) {
        const char = source[offset++];
        const delimiter = char === quote || (quote === "'" && /[\u2018-\u201b]/.test(char));
        if (delimiter) {
          if (source[offset] === char) {
            word += char;
            offset++;
          } else {
            closed = true;
            break;
          }
        } else word += char;
      }
      if (!closed || (offset < source.length && !/\s/.test(source[offset]))) {
        throw new Error("Invalid quoted Windows agent argument");
      }
    } else {
      const start = offset;
      while (offset < source.length && !/\s/.test(source[offset])) offset++;
      word = source.slice(start, offset);
      if (!/^[A-Za-z0-9_./:\\=+-]+$/.test(word)) {
        throw new Error("Windows agent arguments must be literal values");
      }
    }
    if (word.includes("\0")) throw new Error("Invalid Windows agent argument");
    words.push(word);
  }
  if (!words.length) throw new Error("Missing Windows agent command");
  return words;
}

/** Windows CRT argv serialization, used directly by ProcessStartInfo.Arguments. */
export function serializeWindowsArgv(args: readonly string[]): string {
  return args
    .map((arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`)
    .join(" ");
}

/**
 * A batch file we cannot unwrap may only reach cmd.exe with inert arguments,
 * because cmd.exe re-parses the line; anything else is refused with a way out.
 */
function agentLaunchTarget(
  file: string,
  args: readonly string[],
  options: WindowsCliResolveOptions
): CliSpawnTarget {
  try {
    return cliSpawnTarget(file, args, "win32", options);
  } catch (error) {
    // Only the arguments differ between the calls, so a bare cmd.exe target
    // means they were the reason.
    let bare: CliSpawnTarget | undefined;
    try {
      bare = cliSpawnTarget(file, [], "win32", options);
    } catch {
      // The original failure stands.
    }
    if (!bare?.windowsVerbatimArguments) throw error;
    const shim = (error as NodeJS.ErrnoException).path ?? file;
    throw new Error(
      `Cannot pass these launch arguments through ${shim}: Daintree cannot unwrap this batch file, and cmd.exe would rewrite them. Install the CLI with npm or as a native executable, or launch it without a prompt.`,
      { cause: error }
    );
  }
}

/** Inherit the PTY handles while avoiding both cmd.exe and PowerShell's native binder. */
export function buildWindowsAgentLaunchScript(
  command: string,
  options: WindowsCliResolveOptions = {}
): string {
  const [file, ...args] = parseWindowsAgentCommand(command);
  const target = agentLaunchTarget(file, args, options);
  // A cmd.exe target already holds its exact command line (`/d /s /v:off /c ""shim" args"`).
  const commandLine = target.windowsVerbatimArguments
    ? target.args.join(" ")
    : serializeWindowsArgv(target.args);
  return [
    WINDOWS_PS_UTF8_BOOTSTRAP,
    "& {",
    "  $start = [System.Diagnostics.ProcessStartInfo]::new()",
    `  $start.FileName = ${quotePowerShellArg(target.command)}`,
    `  $start.Arguments = ${quotePowerShellArg(commandLine)}`,
    "  $start.UseShellExecute = $false",
    "  $start.WorkingDirectory = (Get-Location).ProviderPath",
    // What an unwrapped shim would have set (NODE_PATH, a PATH prepend).
    ...Object.entries(target.env ?? {}).map(
      ([name, value]) =>
        `  $start.Environment[${quotePowerShellArg(name)}] = ${quotePowerShellArg(value)}`
    ),
    "  $child = [System.Diagnostics.Process]::Start($start)",
    "  try { $child.WaitForExit(); $global:LASTEXITCODE = $child.ExitCode } finally { $child.Dispose() }",
    "}",
  ].join("\n");
}
