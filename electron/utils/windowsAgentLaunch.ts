import { WINDOWS_PS_UTF8_BOOTSTRAP } from "../services/pty/terminalShell.js";
import { quotePowerShellArg } from "../../shared/utils/shellEscape.js";
import { cliSpawnTarget, type WindowsCliResolveOptions } from "./windowsCliSpawn.js";

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

/** Inherit the PTY handles while avoiding both cmd.exe and PowerShell's native binder. */
export function buildWindowsAgentLaunchScript(
  command: string,
  options: WindowsCliResolveOptions = {}
): string {
  const [file, ...args] = parseWindowsAgentCommand(command);
  const target = cliSpawnTarget(file, args, "win32", options);
  if (target.windowsVerbatimArguments) {
    throw new Error("Windows agent launches need a native executable or an npm shim");
  }
  return [
    WINDOWS_PS_UTF8_BOOTSTRAP,
    "& {",
    "  $start = [System.Diagnostics.ProcessStartInfo]::new()",
    `  $start.FileName = ${quotePowerShellArg(target.command)}`,
    `  $start.Arguments = ${quotePowerShellArg(serializeWindowsArgv(target.args))}`,
    "  $start.UseShellExecute = $false",
    "  $start.WorkingDirectory = (Get-Location).ProviderPath",
    "  $child = [System.Diagnostics.Process]::Start($start)",
    "  try { $child.WaitForExit(); $global:LASTEXITCODE = $child.ExitCode } finally { $child.Dispose() }",
    "}",
  ].join("\n");
}
